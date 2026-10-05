import { randomUUID } from "node:crypto";
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { Logger } from "../../lib/logger.js";
import type { ChatAdapter, ComponentEvent, ElicitationCardPost } from "../../platforms/chat-adapter.js";
import type { ConfigMutationInput, ConfigProposal } from "../config-mutation.js";
import type { SessionRecord } from "../types.js";
import type { ActionCardStore, PermissionCardRecord, ProposalCardRecord } from "./store.js";

const denied: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };
type OwnerState = { state: "pending" | "answered" | "gone"; pid: number };
type PermissionBinding = { attemptId: string; location: string; slot: number };

/** Internal facades keep persistence and process control out of plugin contexts. */
export interface ActionCardDependencies {
  store: ActionCardStore;
  adapter: ChatAdapter;
  logger: Logger;
  binding(session: SessionRecord, acpSessionId: string): PermissionBinding;
  owner(record: Pick<PermissionCardRecord, "location" | "slot" | "requestId" | "acpSessionId" | "ownerPid" | "request">,
    response?: RequestPermissionResponse): Promise<OwnerState>;
  isAttemptOpen(id: string): boolean;
  apply(record: ProposalCardRecord, actor: { id: string; name: string }): { auditId: string; message: string };
  afterApply(record: ProposalCardRecord): Promise<void>;
}

export class ActionCardManager {
  private readonly waiters = new Map<string, (response: RequestPermissionResponse) => void>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private detached = false;

  constructor(private readonly deps: ActionCardDependencies) {}

  async requestPermission(session: SessionRecord, request: RequestPermissionRequest, requestId: string | number | null): Promise<RequestPermissionResponse> {
    const binding = this.deps.binding(session, request.sessionId);
    const probe = { ...binding, requestId, acpSessionId: request.sessionId, ownerPid: 0, request };
    const owner = await this.deps.owner(probe);
    if (owner.state !== "pending") return denied;
    const identity = JSON.stringify([binding.location, binding.slot, owner.pid, request.sessionId, requestId, request.toolCall.toolCallId]);
    let row = this.deps.store.findPermission(identity);
    if (!row) {
      row = {
        kind: "permission", id: randomUUID(), identity, sessionId: session.id,
        channel: { platform: session.platform, id: session.channelRef, ...(session.parentRef ? { parentId: session.parentRef } : {}) },
        messageId: null, expiresUtc: new Date(Date.now() + 5 * 60_000).toISOString(), detail: null,
        ...binding, requestId, acpSessionId: request.sessionId, ownerPid: owner.pid,
        request: { sessionId: request.sessionId, options: request.options,
          toolCall: { toolCallId: request.toolCall.toolCallId, title: request.toolCall.title, kind: request.toolCall.kind } },
        status: "open", response: null, delivered: false,
      };
      this.deps.store.save(row);
    }
    if (row.status !== "open") return row.response ?? denied;
    const decision = new Promise<RequestPermissionResponse>(resolve => this.waiters.set(row!.id, resolve));
    try {
      if (!row.messageId) {
        const message = await this.deps.adapter.sendElicitationCard!(row.channel, this.permissionCard(row));
        row.messageId = message.id;
        this.deps.store.save(row);
      }
      this.arm(row);
    } catch (error) {
      await this.resolvePermission(row, "cancelled", denied, `Permission card could not be posted: ${String(error)}`);
      throw error;
    }
    return decision;
  }

  async propose(session: SessionRecord, input: ConfigMutationInput, proposal: ConfigProposal): Promise<void> {
    if (!this.deps.adapter.sendElicitationCard) throw new Error("This platform cannot render a confirmation card, so no change can be proposed.");
    const { apply: _apply, ...data } = proposal;
    const row: ProposalCardRecord = {
      kind: "proposal", id: randomUUID(), sessionId: session.id,
      channel: { platform: session.platform, id: session.channelRef, ...(session.parentRef ? { parentId: session.parentRef } : {}) },
      messageId: null, expiresUtc: new Date(Date.now() + 10 * 60_000).toISOString(), detail: null,
      input, proposal: data, status: "open", auditId: null,
    };
    this.deps.store.save(row);
    try {
      row.messageId = (await this.deps.adapter.sendElicitationCard(row.channel, this.proposalCard(row))).id;
      this.deps.store.save(row);
      this.arm(row);
    } catch (error) {
      this.deps.store.decideProposal(row.id, "failed", `Confirmation card could not be posted: ${String(error)}`, Date.now());
      throw error;
    }
  }

  async handlePermission(evt: ComponentEvent): Promise<void> {
    const [, id, index] = evt.customId.split(":");
    const row = this.deps.store.getPermission(id ?? "");
    if (!row || row.channel.id !== evt.channel.id || row.messageId !== evt.messageId) {
      await this.stale(evt, "This permission request is no longer available."); return;
    }
    await this.reconcilePermission(row);
    const current = this.deps.store.getPermission(row.id)!;
    if (current.status !== "open") {
      await evt.followUpEphemeral(`This permission request is ${current.status}. ${current.detail ?? ""}`); return;
    }
    const option = /^\d+$/.test(index ?? "") ? current.request.options[Number(index)] : undefined;
    if (!option || Number(index) >= 5) { await evt.followUpEphemeral("That option was not offered by this permission card."); return; }
    await this.resolvePermission(current, "answered", { outcome: { outcome: "selected", optionId: option.optionId } },
      `${evt.userName} chose: ${option.name}`);
    await evt.followUpEphemeral(this.deps.store.getPermission(row.id)!.detail!);
  }

  async handleProposal(evt: ComponentEvent): Promise<void> {
    const [, action, id] = evt.customId.split(":");
    const row = this.deps.store.getProposal(id ?? "");
    if (!row || row.channel.id !== evt.channel.id || row.messageId !== evt.messageId) {
      await this.stale(evt, "This config proposal is no longer available."); return;
    }
    if (action !== "apply" && action !== "reject") { await evt.replyEphemeral("Unknown config proposal action."); return; }
    const decided = this.deps.store.decideProposal(row.id, action === "apply" ? "applied" : "rejected",
      `Rejected by ${evt.userName}.`, Date.now(), action === "apply" ? record => this.deps.apply(record, { id: evt.userId, name: evt.userName }) : undefined);
    const current = decided ?? this.deps.store.getProposal(row.id)!;
    this.disarm(row.id);
    await this.edit(current);
    await evt.followUpEphemeral(decided ? current.detail! : `This proposal was already ${current.status}. ${current.detail ?? ""}`);
    if (decided?.status === "applied") await this.deps.afterApply(decided);
  }

  async recover(location?: string): Promise<void> {
    if (this.detached) return;
    for (const row of this.deps.store.permissions()) {
      if (location && row.location !== location) continue;
      if (row.status !== "open" && row.delivered) continue;
      try { await this.reconcilePermission(row); }
      catch (error) { this.deps.logger.warn({ err: error, cardId: row.id, location: row.location }, "pending permission recovery awaits bridge"); }
    }
    if (location) return;
    for (const row of this.deps.store.proposals()) {
      if (row.status !== "open") continue;
      if (Date.parse(row.expiresUtc) <= Date.now()) {
        const expired = this.deps.store.decideProposal(row.id, "expired", "Expired — not applied.", Date.now());
        if (expired) await this.edit(expired);
      } else this.arm(row);
    }
  }

  async cancelForSession(sessionId: string, detail: string): Promise<number> {
    const rows = this.deps.store.permissions(sessionId).filter(row => row.status === "open");
    for (const row of rows) await this.resolvePermission(row, "cancelled", denied, detail);
    return rows.length;
  }

  async finishAttempt(attemptId: string): Promise<void> {
    for (const row of this.deps.store.permissions().filter(row => row.attemptId === attemptId && row.status === "open")) {
      await this.resolvePermission(row, "gone", denied, "This turn ended; the permission request is no longer pending.");
    }
  }

  detach(): void {
    this.detached = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.waiters.clear();
  }

  private async reconcilePermission(row: PermissionCardRecord): Promise<void> {
    if (row.status !== "open") { await this.deliver(row); await this.edit(row); return; }
    if (Date.parse(row.expiresUtc) <= Date.now()) {
      await this.resolvePermission(row, "expired", denied, "Expired — auto-denied."); return;
    }
    const owner = await this.deps.owner(row);
    if (owner.state !== "pending" || !this.deps.isAttemptOpen(row.attemptId)) {
      await this.resolvePermission(row, "gone", denied, "This request is no longer pending in its original agent process.");
    } else this.arm(row);
  }

  private async resolvePermission(row: PermissionCardRecord, status: PermissionCardRecord["status"], response: RequestPermissionResponse, detail: string): Promise<void> {
    const decided = this.deps.store.decidePermission(row.id, status, response, detail, Date.now());
    if (!decided) return;
    this.disarm(row.id);
    try { await this.deliver(decided); }
    finally { await this.edit(decided); }
  }

  private async deliver(row: PermissionCardRecord): Promise<void> {
    if (!row.response || row.delivered || this.detached) return;
    const waiter = this.waiters.get(row.id);
    if (waiter) {
      this.waiters.delete(row.id);
      waiter(row.response);
      return;
    }
    const result = await this.deps.owner(row, row.response);
    row.delivered = result.state !== "pending";
    this.deps.store.save(row);
  }

  private arm(row: PermissionCardRecord | ProposalCardRecord): void {
    this.disarm(row.id);
    if (this.detached) return;
    const timer = setTimeout(() => {
      this.timers.delete(row.id);
      const expired = row.kind === "permission"
        ? this.resolvePermission(row, "expired", denied, "Expired — auto-denied.")
        : (async () => {
          const record = this.deps.store.decideProposal(row.id, "expired", "Expired — not applied.", Date.now());
          if (record) await this.edit(record);
        })();
      void expired.catch(error => this.deps.logger.error({ err: error, cardId: row.id }, "action card expiry failed"));
    }, Math.max(0, Date.parse(row.expiresUtc) - Date.now()));
    timer.unref?.();
    this.timers.set(row.id, timer);
  }

  private disarm(id: string): void { clearTimeout(this.timers.get(id)); this.timers.delete(id); }
  private async edit(row: PermissionCardRecord | ProposalCardRecord): Promise<void> {
    if (!row.messageId || this.detached) return;
    await this.deps.adapter.editElicitationCard?.({ channel: row.channel, id: row.messageId }, row.kind === "permission" ? this.permissionCard(row) : this.proposalCard(row))
      .catch(error => this.deps.logger.warn({ err: error, cardId: row.id }, "action card edit failed"));
  }
  private async stale(evt: ComponentEvent, text: string): Promise<void> {
    await evt.replyEphemeral(text);
    await this.deps.adapter.editElicitationCard?.({ channel: evt.channel, id: evt.messageId },
      { panel: { color: 0x777777, title: text, fields: [] }, buttons: [] });
  }

  private permissionCard(row: PermissionCardRecord): ElicitationCardPost {
    return {
      panel: { color: 0xfaa61a, title: "🔐 Permission requested",
        description: `The agent wants to run **${row.request.toolCall.title ?? row.request.toolCall.kind ?? "a tool"}**.`,
        fields: [{ name: "Call ID", value: row.request.toolCall.toolCallId }],
        footer: row.detail ?? `Auto-denies at ${row.expiresUtc}.` },
      buttons: row.status === "open" ? row.request.options.slice(0, 5).map((option, index) => ({
        customId: `seam-perm:${row.id}:${index}`, label: option.name.slice(0, 80),
        style: option.kind.startsWith("reject") ? "danger" : "success",
      })) : [],
    };
  }
  private proposalCard(row: ProposalCardRecord): ElicitationCardPost {
    return {
      panel: { color: 0x5865f2, title: `🧩 ${row.proposal.title}`,
        description: row.proposal.restartsSession ? "Applying this restarts the session so the change takes effect." : undefined,
        fields: [...row.proposal.fields.slice(0, 20).map(field => ({ name: field.label, value: `\`${field.before}\` → \`${field.after}\``.slice(0, 1024) })),
          ...(row.proposal.warnings.length ? [{ name: "⚠ Notes", value: row.proposal.warnings.join("\n").slice(0, 1024) }] : [])],
        footer: row.detail ?? `Nothing changes until you click Apply · expires at ${row.expiresUtc}.` },
      buttons: row.status === "open" ? [
        { customId: `seam-cfg:apply:${row.id}`, label: "Apply", style: "success" },
        { customId: `seam-cfg:reject:${row.id}`, label: "Reject", style: "secondary" },
      ] : [],
    };
  }
}

import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Logger } from "../lib/logger.js";
import type { ChannelRef } from "../platforms/chat-adapter.js";
import type { MutationActor } from "./config-mutation.js";
import type { ConfigDescription, SessionRouter } from "./session-router.js";
import type { SessionStore } from "./session-store.js";
import type { RuntimeTransition } from "./runtime-transition.js";
import type { SessionRecord } from "./types.js";

const fields = ["agent", "location", "model", "effort", "cwd", "permission", "role", "disableThreadPrefix",
  "fastMode", "detached", "tts", "ttsVoice", "ttsPace", "ttsStyle", "statusCardStyle", "simpleCardGif"] as const;
function differences(before: ConfigDescription, after: ConfigDescription): string[] {
  const changes = fields.flatMap(key => before[key].value === after[key].value ? []
    : [`${key}: ${JSON.stringify(before[key].value)} → ${JSON.stringify(after[key].value)}`]);
  if (JSON.stringify(before.rider ?? {}) !== JSON.stringify(after.rider ?? {})) changes.push("rider: source and destination differ");
  return changes;
}
function channel(record: SessionRecord): ChannelRef {
  return { platform: record.platform, id: record.channelRef, ...(record.parentRef ? { parentId: record.parentRef } : {}) };
}

/** Operator move; the existing row, runtime cache and MCP token keep their identity. */
export class GoogleChatSessionMove {
  constructor(private readonly deps: {
    store: SessionStore; router: SessionRouter; runtime: Pick<RuntimeTransition, "applySavedSelection" | "applyPermissionMode" | "retire">;
    isChannelBusy(channel: string): boolean;
    sendMessage(channel: ChannelRef, text: string): Promise<unknown>;
    identityCommitted(session: string): Promise<void>;
    logger: Logger;
  }) {}

  private preflight(sessionId: string, destination: string, adopt: boolean) {
    const { store, router } = this.deps;
    const source = store.get(sessionId);
    if (!source) throw new Error(`Session ${JSON.stringify(sessionId)} does not exist.`);
    if (source.platform !== "google-chat" || source.parentRef === null) throw new Error(`${sessionId} is not a legacy Google Chat thread session.`);
    const target = store.getByChannel("google-chat", destination);
    if (!target || target.parentRef !== null) throw new Error(`Destination ${JSON.stringify(destination)} is not a bound Google Chat session Space root.`);
    if (target.acpSessionId) throw new Error(`Destination ${destination} already has ACP session ${target.acpSessionId}.`);
    for (const record of [source, target]) {
      const inbound = store.listInboundNonterminal().find(row => row.sessionRecordId === record.id);
      if (inbound) throw new Error(`Inbound ${inbound.messageId} is ${inbound.state} in ${record.channelRef}.`);
      const refs = new Set([record.channelRef, record.id.slice("google-chat:".length)]);
      const attempt = [...store.turnAttempts.list("pending"), ...store.turnAttempts.list("active"),
        ...store.turnAttempts.list("suspended"), ...store.turnAttempts.listUnsettledCompletions()]
        .find(row => refs.has(row.spec.target));
      if (attempt) throw new Error(`Attempt ${attempt.id} is ${attempt.state} in ${record.channelRef}; delivery is not settled.`);
      if (router.isBusy(record.id) || this.deps.isChannelBusy(record.channelRef)) throw new Error(`${record.channelRef} still has live or queued work.`);
    }
    if (router.hasRuntime(target.id)) throw new Error(`Destination ${destination} has a live runtime; it is not an empty placeholder.`);
    const before = router.describeConfig(source), desired = router.describeConfig(target);
    const changes = differences(before, desired);
    const sourceConfig = store.readConfig(source), targetConfig = store.readConfig(target);
    for (const key of ["mode", "availableTools", "excludedTools", "mcpServers"] as const) {
      if (JSON.stringify(sourceConfig[key]) !== JSON.stringify(targetConfig[key])) {
        changes.push(`${key}: ${JSON.stringify(sourceConfig[key])} → ${JSON.stringify(targetConfig[key])}`);
      }
    }
    if (changes.length && !adopt) throw new Error(`Effective configs differ: ${changes.join("; ")}. Use adopt-destination-config explicitly to accept its runtime consequences.`);
    return { source, target, before, desired, changes };
  }

  async move(input: { sessionId: string; destination: string; adoptDestinationConfig?: boolean; actor: MutationActor }) {
    const destination = input.destination.replace(/^spaces\//, "");
    const first = this.preflight(input.sessionId, destination, input.adoptDestinationConfig === true);
    const backup = path.join(path.dirname(this.deps.store.dbPath), "backups", `seam.db.pre-chat-move-${randomUUID()}.sqlite`);
    await this.deps.store.backup(backup);
    const next = this.preflight(input.sessionId, destination, input.adoptDestinationConfig === true);
    if (JSON.stringify(first) !== JSON.stringify(next)) throw new Error("Session or effective config changed during backup. Run the move again against its current state.");
    const { source, target, before, desired, changes } = next;
    const cfg = this.deps.store.readConfig(source);
    if (changes.length) {
      const destinationConfig = this.deps.store.readConfig(target);
      Object.assign(cfg, { model: desired.model.value, permissionPolicy: desired.permission.value,
        disableThreadPrefix: desired.disableThreadPrefix.value, statusCardStyle: desired.statusCardStyle.value,
        simpleCardGif: desired.simpleCardGif.value, sessionCwdExplicit: true });
      if (desired.effort.value === null) delete cfg.reasoningEffort; else cfg.reasoningEffort = desired.effort.value;
      if (desired.role.value === null) delete cfg.role; else cfg.role = desired.role.value;
      for (const key of ["mode", "availableTools", "excludedTools", "mcpServers"] as const) {
        delete cfg[key]; if (destinationConfig[key] !== undefined) Object.assign(cfg, { [key]: destinationConfig[key] });
      }
      delete cfg.autoApprovePermissions;
    }
    const selected = changes.length ? { agentId: desired.agent.value, repoPath: desired.cwd.value,
      configJson: this.deps.store.writeConfig(cfg) } : undefined;
    const candidate = { ...source, ...selected, channelRef: destination, parentRef: null };
    const after = this.deps.router.describeConfig(candidate);
    const remaining = differences(desired, after);
    if (remaining.length) throw new Error(`Destination config would be shadowed after the move: ${remaining.join("; ")}.`);
    this.deps.store.moveChannel(source, target, input.actor, selected);
    let record = this.deps.store.get(source.id)!;
    this.deps.logger.info({ sessionId: record.id, from: source.channelRef, to: record.channelRef, backup,
      acpSessionId: record.acpSessionId, changes }, "operator moved Google Chat session");
    try {
      if (changes.length) {
        if (before.location.value !== desired.location.value || before.fastMode.value !== desired.fastMode.value
          || changes.some(change => change.startsWith("mode:") || change.startsWith("mcpServers:"))) {
          await this.deps.router.transitionWhenIdle(record.id, () => this.deps.runtime.retire(record.id, {
            clearAcpSession: true, operatorIntent: "replace-session", clearStartFailure: true,
            bindingChange: { source: "GoogleChatSessionMove", cause: "operator adopted destination host, Fast mode or session-start settings" },
          }));
        } else await this.deps.runtime.applySavedSelection(record, before);
        if (before.permission.value !== desired.permission.value) await this.deps.runtime.applyPermissionMode(record);
      }
      record = this.deps.store.get(source.id)!;
      this.deps.router.bindRecordLocation(record);
      await this.deps.identityCommitted(record.id);
      await this.deps.sendMessage(channel(source), `This conversation moved to https://chat.google.com/room/${destination}. Continue there.`);
      await this.deps.sendMessage(channel(record), `Conversation moved here from ${source.channelRef}. ${record.acpSessionId === source.acpSessionId
        ? "The same agent session and context continue here." : "The destination configuration was adopted; the agent session was reset by its normal configuration rules."}`);
    } catch (err) {
      this.deps.logger.error({ err, sessionId: source.id, destination, backup }, "Google Chat session moved; follow-up failed");
      throw new Error(`Session ${source.id} moved to ${destination}; follow-up failed: ${err instanceof Error ? err.message : String(err)}. Backup: ${backup}`, { cause: err });
    }
    return { record, backup, changes, sessionReset: record.acpSessionId !== source.acpSessionId };
  }
}

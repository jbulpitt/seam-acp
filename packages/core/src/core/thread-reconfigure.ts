import { isDeepStrictEqual } from "node:util";
import type { Config } from "../config.js";
import type { ChatAdapter } from "../platforms/chat-adapter.js";
import type { SessionStore } from "./session-store.js";
import type { SessionRouter } from "./session-router.js";
import type { ConfigApplyPlan } from "./config-apply-plan.js";
import type { RuntimeTransition } from "./runtime-transition.js";
import type { Actor, BulkPlan, BulkRequest, BulkRow, BulkSnapshot, BulkPorts } from "../plugins/thread-reconfigure/ports.js";
import type { SessionRecord } from "./types.js";

const cause = (error: unknown) => error instanceof Error ? error.message : String(error);
const same = isDeepStrictEqual;

/** Trusted controller facade. Plugins see projections and operations, never runtime owners. */
export class ThreadReconfiguration implements BulkPorts {
  constructor(private readonly deps: {
    config: Config; store: SessionStore; router: SessionRouter; adapter: ChatAdapter;
    plan(): ConfigApplyPlan; runtime(): RuntimeTransition;
    allowed(actor: Actor, parent: string): boolean;
    busy(ref: string): boolean;
  }) {}

  private managed(parent: string) {
    const { config, store } = this.deps;
    return !config.DISCORD_ALLOWED_CHANNEL_IDS || config.DISCORD_ALLOWED_CHANNEL_IDS.has(parent)
      || store.getActiveProject(parent)?.enabled === true;
  }
  private permitted(actor: Actor, parent: string) {
    return this.deps.config.DISCORD_ALLOWED_USER_IDS.has(actor.id)
      && this.managed(parent) && this.deps.allowed(actor, parent);
  }
  private busy(record: SessionRecord) {
    // Raw RPC ownership also covers a silent/stalled prompt; diagnostics alone do not end it.
    return this.deps.busy(record.channelRef) || this.deps.router.getRuntime(record.id)?.busy === true;
  }
  private async snapshot(record: SessionRecord): Promise<BulkSnapshot | undefined> {
    const meta = await this.deps.adapter.configurationThread?.({ platform: "discord", id: record.channelRef });
    if (!meta) return undefined;
    return { id: record.channelRef, name: meta.name, parentId: meta.parentId, guildId: meta.guildId,
      identity: this.identity(record), preset: this.deps.store.presets.getApplication(record.id) };
  }
  private identity(record: SessionRecord) {
    const described = this.deps.router.describeConfig(record);
    return { agent: described.agent.value, model: described.model.value, location: described.location.value,
      effort: described.effort.value ?? "auto", role: described.role.value ?? "auto",
      disableThreadPrefix: described.disableThreadPrefix.value, fastMode: described.fastMode.value };
  }

  private matches(snapshot: BulkSnapshot, request: BulkRequest) {
    return (request.scope !== "guild" || snapshot.guildId === request.scopeId)
      && (request.scope !== "channel" || snapshot.parentId === request.scopeId)
      && (request.agent === undefined || snapshot.identity.agent === request.agent)
      && (request.model === undefined || snapshot.identity.model === request.model)
      && (request.role === undefined || snapshot.identity.role === request.role)
      && (request.name === undefined || snapshot.name.toLowerCase().includes(request.name.toLowerCase()))
      && (request.preset === undefined || (snapshot.preset?.id === request.preset
        && snapshot.preset.projectRef === (request.presetScope ?? null)));
  }
  private async prepare(record: SessionRecord, before: BulkSnapshot, request: BulkRequest): Promise<BulkRow> {
    const input = { model: request.targetModel, ...(request.targetAgent ? { agent: request.targetAgent } : {}) };
    const p = await this.deps.runtime().prepareSelection(record, input);
    if (!p.ok) return { before, status: "failed", reason: p.error };
    const after = { ...p.plannedIdentity, location: before.identity.location };
    const changed = !same(before.identity, after);
    const reload = p.modelChanged && (p.catalogModel?.applicationMode ?? "reload") === "reload"
      || p.plannedChanges.effort.changed && (!p.catalogModel || p.effortMechanism === "meta" || p.effortMechanism === "spawnArgs");
    return { before, after, status: changed ? "eligible" : "unchanged", verification: p.selection.verification,
      warnings: p.warnings, consequence: !changed ? "none" : p.reset.sessionReset ? "reset" : reload ? "reload" : "live-apply" };
  }
  async preview(actor: Actor, request: BulkRequest) {
    if (!["all", "guild", "channel"].includes(request.scope) || request.scope !== "all" && !request.scopeId) {
      throw new Error("Choose all, guild + scope-id, or channel + scope-id.");
    }
    if (!request.targetModel?.trim() || request.targetAgent !== undefined && (!request.targetAgent.trim() || request.targetAgent.includes("@"))) {
      throw new Error("Provide a target model and, optionally, a bare agent id; each thread keeps its host.");
    }
    if (!this.deps.adapter.configParentChannels || !this.deps.adapter.configurationThread) throw new Error("Thread configuration metadata is unavailable on this platform.");
    const parents = (await this.deps.adapter.configParentChannels()).filter(p => this.permitted(actor, p.id)
      && (request.scope !== "guild" || p.guildId === request.scopeId) && (request.scope !== "channel" || p.id === request.scopeId));
    const allowed = new Set(parents.map(p => p.id));
    const rows: BulkRow[] = []; const notes: string[] = [];
    for (const record of this.deps.store.listSessionsUncapped()) {
      if (record.platform !== "discord" || !record.parentRef || !allowed.has(record.parentRef)) continue;
      try {
        const before = await this.snapshot(record);
        if (!before) { notes.push(`${record.channelRef}: gone or not a thread`); continue; }
        // A moved thread must not disclose its new metadata outside the selected authority.
        if (!allowed.has(before.parentId)) { notes.push(`${record.channelRef}: parent changed`); continue; }
        if (!this.matches(before, request)) continue;
        const live = await this.deps.adapter.getThreadLiveState?.({ platform: "discord", id: before.id });
        const skip = !live ? "liveness unknown" : live.archived ? "archived" 
          : this.deps.router.describeConfig(record).detached.value ? "detached" : this.busy(record) ? "busy/admitted/recovering work" : undefined;
        rows.push(skip ? { before, status: "skipped", reason: skip } : await this.prepare(record, before, request));
      } catch (error) { notes.push(`${record.channelRef}: discovery incomplete: ${cause(error)}`); }
    }
    notes.push("Bound managed Discord threads only; archived/detached excluded; quiet active threads included. Defaults and named presets are not changed. Preset means last explicit application; older provenance is UNKNOWN.");
    return { rows, notes };
  }
  async apply(actor: Actor, plan: BulkPlan): Promise<BulkRow[]> {
    const results: BulkRow[] = [];
    for (const row of plan.rows) {
      if (row.status !== "eligible") { results.push(row); continue; }
      let saved: boolean | undefined = false;
      try {
        const before = row.before;
        const record = this.deps.store.getByChannel("discord", before.id);
        if (!record || !this.permitted(actor, before.parentId)) {
          results.push({ ...row, status: "skipped", reason: "no longer eligible/authorized" }); continue;
        }
        const current = await this.snapshot(record);
        const live = await this.deps.adapter.getThreadLiveState?.({ platform: "discord", id: before.id });
        if (!current || !same(current, before) || !this.matches(current, plan.request)) {
          results.push({ ...row, status: "skipped", reason: "preview changed; preview again" }); continue;
        }
        if (!live || live.archived || this.deps.router.describeConfig(record).detached.value) {
          results.push({ ...row, status: "skipped", reason: "no longer live/attached/unarchived" }); continue;
        }
        const prepared = await this.prepare(record, current, plan.request);
        if (prepared.status !== "eligible" || !same(prepared.after, row.after) || prepared.consequence !== row.consequence) {
          results.push({ ...prepared, status: "skipped", reason: prepared.reason ?? "selection changed; preview again" }); continue;
        }
        // Re-read after I/O. No await separates eligibility from the audited write.
        const fresh = this.deps.store.get(record.id);
        if (!fresh || fresh.configJson !== record.configJson || fresh.agentId !== record.agentId || fresh.acpSessionId !== record.acpSessionId
          || !this.permitted(actor, before.parentId) || this.busy(fresh)) {
          results.push({ ...row, status: "skipped", reason: "busy or changed during preparation" }); continue;
        }
        this.deps.router.assertAgentAllowedForRecord(fresh, prepared.after!.agent);
        const described = this.deps.router.describeConfig(fresh);
        if (!same(this.identity(fresh), before.identity)
          || !same(this.deps.store.presets.getApplication(fresh.id), before.preset)) {
          results.push({ ...row, status: "skipped", reason: "effective selection changed during preparation" }); continue;
        }
        const after = prepared.after!;
        saved = undefined; // A throwing write can have partially committed.
        const changed = this.deps.plan().applyTargetIdentity(fresh, {
          ...(after.agent !== before.identity.agent ? { agent: after.agent } : {}),
          ...(after.model !== before.identity.model || after.agent !== before.identity.agent ? { model: after.model,
            effort: after.effort === "auto" ? null : after.effort } : {}),
          ...(after.fastMode !== before.identity.fastMode ? { fastMode: after.fastMode } : {}),
        }, actor);
        if (!changed.ok) throw new Error(changed.error);
        saved = true;
        const committed = this.deps.store.get(fresh.id)!;
        await this.deps.runtime().applySavedSelection(committed, described);
        await this.deps.runtime().publishIdentity(committed);
        const pending = this.deps.router.hasPendingRuntimeTransition(committed.id);
        const runtime = pending ? undefined : this.deps.router.getRuntime(committed.id);
        const fallback = runtime?.getLastModelFallbackNotice();
        const fastMode = runtime?.getFastModeOutcome();
        results.push({ ...prepared, status: "changed", saved: true,
          warnings: [...(prepared.warnings ?? []), ...(fallback ? [fallback] : [])],
          // A cached owner is not confirmation of the requested identity.
          runtime: pending ? "pending" : runtime ? "unverified" : "next-acquisition",
          ...(runtime ? { runtimeSelection: { model: runtime.getSessionInfo()?.currentModelId,
            ...(fastMode ? { fastMode: { ...fastMode } } : {}) } } : {}) });
      } catch (error) {
        results.push({ ...row, status: "failed", saved, runtime: saved !== false ? "unverified" : undefined, reason: cause(error) });
      }
    }
    return results;
  }
}

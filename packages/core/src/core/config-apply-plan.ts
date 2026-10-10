import { resolveThreadLocation, threadPresetKey } from "../config.js";
import type { Config } from "../config.js";
import type { ChannelRef } from "../platforms/chat-adapter.js";
import type { Logger } from "../lib/logger.js";
import type { SessionStore } from "./session-store.js";
import type { SessionRouter } from "./session-router.js";
import type { BridgeHub } from "./bridge-hub.js";
import type { ModelCatalogService } from "./model-catalog/service.js";
import type { ThreadSessionControlDeps } from "./runtime-transition.js";
import { RuntimeTransition } from "./runtime-transition.js";
import { type ConfigMutationService, type ConfigMutationInput, type ConfigProposal, type MutationActor, type ConfigMutationTier, type ProposedField, type ChannelPresetChanges, type ThreadPresetChanges } from "./config-mutation.js";
import { configTarget, configOverrideFields, CONFIG_DEFAULT_FIELDS, type ConfigDefaultField, type OverrideCounts } from "./config-target.js";
import { parseStatusCardStyle, parseSimpleCardGif, type SessionRecord, type SessionConfigState, type PermissionPolicyMode, type StatusCardStyle, type Preset } from "./types.js";
import { parseAgentAtLocation } from "./location.js";
import { isWithinRoot } from "./path-utils.js";
import { bindSessionLocation } from "./location-bind.js";
import { buildSavePlan, snapshotFromDescribe, fastModeWillResetSession, willVerifyFastMode, type ThreadConfigDraft } from "../platforms/discord/config-editor.js";
import { FAST_MODE_CONFIG_ID, settleFastMode, fastModeRetirementFailure } from "./fast-mode.js";

export interface TargetIdentityChanges {
  agent?: string;
  model?: string;
  effort?: string | null;
  role?: string | null;
  disableThreadPrefix?: boolean;
  fastMode?: boolean;
  /** Agent-only changes discard old-agent pins rather than creating new ones. */
  inheritSelection?: boolean;
}

export type RuntimeConsequence = "none" | "live-apply" | "reset" | "rebuild";
export interface ValidatedConfigPlan {
  diff: ProposedField[];
  target: { kind: ConfigMutationTier; id: string };
  audit: { actor: MutationActor; scope: string; correlationId: string; tier: ConfigMutationTier };
  consequence: RuntimeConsequence;
  proposal: ConfigProposal;
}

interface ConfigApplyDeps {
  mutation: ThreadSessionControlDeps["mutation"];
  store: ThreadSessionControlDeps["store"];
}
export interface ConfigApplySettings {
  store: SessionStore;
  router: SessionRouter;
  config: Config;
  logger: Logger;
  modelCatalog: ModelCatalogService;
  bridgeHub?: BridgeHub;
  runtime: RuntimeTransition;
  identityCommitted: (sessionId?: string) => Promise<void>;
  persistConfig: (record: SessionRecord, cfg: SessionConfigState) => void;
  repoDisplay: (repo: string | null) => string;
  unregisteredAgentMessage: (id: string, fallback: string) => string;
  resolveRequestedRepoPath?: (channel: ChannelRef, requested: string, location: string) => Promise<string>;
}

export const CONFIG_SET_FIELD_NAMES = [
  "agent",
  "model",
  "effort",
  "repo",
  "role",
  "permissions",
  "card",
  "gif",
] as const;
export type ConfigSetFieldName = (typeof CONFIG_SET_FIELD_NAMES)[number];
export type ConfigSetRequest = {
  scope?: string | null;
  json: string | null;
  rebuild: boolean;
  values: Record<ConfigSetFieldName, string | null>;
  supplied: ConfigSetFieldName[];
};
export type PreparedConfigSet =
  | { kind: "overlay"; changes: ThreadPresetChanges; permission?: PermissionPolicyMode }
  | { kind: "json"; cfg: SessionConfigState }
  | {
      kind: "named";
      parsedAgent?: ReturnType<typeof parseAgentAtLocation>;
      nextAgentId: string;
      nextLocation: string;
      model: string;
      pinnedEffort?: string;
      requestedRole?: string;
      permission?: string;
      card?: string;
      gif?: string;
      resolvedRepo?: string;
      restartRequested: boolean;
      inheritSelection: boolean;
    };


export function configSetRequestError(request: ConfigSetRequest): string | null {
  if (request.json !== null && request.supplied.length > 0) {
    return "Use either `json:` or named fields, not both.";
  }
  if (request.json === null && request.supplied.length === 0) {
    return "Provide `json:` or at least one named field.";
  }
  return null;
}


/** Internal configuration writes and their existing runtime consequences. */
export class ConfigApplyPlan {
  constructor(private readonly deps: ConfigApplyDeps, private readonly settings?: ConfigApplySettings) {}
  private get mutation() { return this.deps.mutation; }
  private get configMutation() { return this.deps.mutation as ConfigMutationService; }
  private get store() { return this.deps.store; }
  private get router() { return this.settings!.router; }
  private get runtime() { return this.settings!.runtime; }
  private get config() { return this.settings!.config; }
  private get logger() { return this.settings!.logger; }
  private get modelCatalog() { return this.settings!.modelCatalog; }
  private get bridgeHub() { return this.settings!.bridgeHub; }
  private get identityEffects() { return { flush: this.settings!.identityCommitted }; }
  private publishChannelIdentity() {
    // Channel naming can wait on Discord; the configuration is already committed.
    void this.identityEffects.flush().catch(err => this.logger.error({ err }, "channel identity publication failed"));
  }
  private persistConfig(record: SessionRecord, cfg: SessionConfigState) { this.settings!.persistConfig(record, cfg); }
  private repoDisplay(repo: string | null) { return this.settings!.repoDisplay(repo); }
  private refuseUnregisteredAgent(id: string, fallback: string) { return this.settings!.unregisteredAgentMessage(id, fallback); }

  prepare(record: SessionRecord, input: ConfigMutationInput, actor: MutationActor, intent: { rebuild?: boolean } = {}): { ok: true; plan: ValidatedConfigPlan } | { ok: false; error: string } {
    const built = this.configMutation.buildProposal(record, input);
    if (!built.ok) return built;
    const proposal = built.proposal;
    const changes = input.session ?? input.threadPreset ?? input.channelPreset;
    const before = this.router.describeConfig(record);
    const nextAgentId = changes?.agent ?? before.agent.value;
    const nextModel = changes?.model ?? before.model.value;
    const consequence = RuntimeTransition.consequence({
      previousAgentId: before.agent.value,
      nextAgentId,
      modelChanged: nextModel !== before.model.value,
      modelApplicationMode: this.modelCatalog.model({ agentId: nextAgentId, location: before.location.value }, nextModel)?.applicationMode,
      fastModeChanged: input.threadPreset?.fastMode !== undefined && input.threadPreset.fastMode !== before.fastMode?.value,
      runtimeTouched: proposal.restartsSession || input.session?.permission !== undefined || input.session?.mode !== undefined,
      rebuild: intent.rebuild,
    });
    return { ok: true, plan: {
      diff: proposal.fields,
      target: { kind: proposal.tier, id: proposal.scope },
      audit: { actor, scope: proposal.scope, correlationId: proposal.id, tier: proposal.tier },
      consequence,
      proposal,
    } };
  }

  buildProposal(record: SessionRecord, input: ConfigMutationInput) {
    const built = this.prepare(record, input, { id: null, name: null });
    return built.ok ? { ok: true as const, proposal: built.plan.proposal } : built;
  }

  apply(plan: ValidatedConfigPlan) { return plan.proposal.apply(plan.audit.actor); }
  applySessionConfig(...args: Parameters<ThreadSessionControlDeps["mutation"]["applySessionConfig"]>) { return this.mutation.applySessionConfig(...args); }
  applyThreadOverlay(...args: Parameters<ConfigMutationService["applyThreadOverlay"]>) { return this.configMutation.applyThreadOverlay(...args); }
  applyChannelOverlay(...args: Parameters<ConfigMutationService["applyChannelOverlay"]>) { return this.configMutation.applyChannelOverlay(...args); }
  applyThreadLocation(...args: Parameters<ConfigMutationService["applyThreadLocation"]>) { return this.configMutation.applyThreadLocation(...args); }
  readThreadPresetEntry(...args: Parameters<ConfigMutationService["readThreadPresetEntry"]>) { return this.configMutation.readThreadPresetEntry(...args); }
  readPresetsSnapshot() { return this.configMutation.readPresetsSnapshot(); }
  restoreThreadPresetEntry(...args: Parameters<ConfigMutationService["restoreThreadPresetEntry"]>) { return this.configMutation.restoreThreadPresetEntry(...args); }

  describeTarget(channel: ChannelRef, scope?: string | null) {
    const target = configTarget(channel, scope);
    const record = target.kind === "channel"
      ? this.router.previewSessionRecord({ platform: channel.platform, channelRef: channel.id, parentRef: target.id, cwd: this.config.REPOS_ROOT })
      : this.router.ensureSessionRecord({ platform: channel.platform, channelRef: channel.id, parentRef: channel.parentId, cwd: this.config.REPOS_ROOT });
    return this.router.describeConfig(record, target.kind === "channel" ? { inherit: true } : {});
  }

  snapshot(channel: ChannelRef) {
    const target = configTarget(channel);
    const record = target.kind === "thread"
      ? this.router.ensureSessionRecord({ platform: channel.platform, channelRef: channel.id,
          ...(channel.parentId ? { parentRef: channel.parentId } : {}), cwd: this.config.REPOS_ROOT })
      : this.router.previewSessionRecord({ platform: channel.platform, channelRef: channel.id, cwd: this.config.REPOS_ROOT });
    const chan = this.config.channelPresets.get(target.kind === "channel" ? target.id : target.parentRef!);
    const inherited = this.router.describeConfig(record, { inherit: true });
    return { desc: this.describeTarget(channel), withoutThread: {
      location: inherited.location.value, agent: inherited.agent.value, model: inherited.model.value,
      effort: inherited.effort.value, cwd: inherited.cwd.value, permission: inherited.permission.value,
      detached: inherited.detached.value, fastMode: inherited.fastMode.value,
      statusCardStyle: inherited.statusCardStyle.value, simpleCardGif: inherited.simpleCardGif.value,
      role: inherited.role.value, disableThreadPrefix: inherited.disableThreadPrefix.value,
    }, threadOverrides: target.kind === "thread" ? this.threadOverrideFields(record) : [], channelPins: {
      ...(chan?.agent?.value ? { agent: chan.agent.value } : {}), ...(chan?.model?.value ? { model: chan.model.value } : {}),
      ...(chan?.cwd?.value ? { cwd: chan.cwd.value } : {}), ...(chan?.effort?.value ? { effort: chan.effort.value } : {}),
      ...(chan?.role?.value ? { role: chan.role.value } : {}), ...(chan?.disableThreadPrefix ? { disableThreadPrefix: chan.disableThreadPrefix.value } : {}),
      ...(chan?.statusCardStyle ? { statusCardStyle: chan.statusCardStyle.value } : {}), ...(chan?.simpleCardGif ? { simpleCardGif: chan.simpleCardGif.value } : {}),
    } };
  }

  overrideCounts(channelId: string, fields: readonly ConfigDefaultField[] = CONFIG_DEFAULT_FIELDS): OverrideCounts {
    const records = this.settings!.store.listSessionsByParentInCreationOrder("discord", channelId);
    const overrides = records.map(record => this.threadOverrideFields(record));
    const counts: OverrideCounts = {};
    for (const field of configOverrideFields(fields)) {
      counts[field] = overrides.filter(entry => entry.includes(field)).length;
    }
    return counts;
  }

  /** Persisted overrides include legacy mirrors hidden by a channel default. */
  threadOverrideFields(record: SessionRecord): ConfigDefaultField[] {
    const cfg = this.store.readConfig(record);
    const pins = this.config.threadPresets.get(record.channelRef);
    return CONFIG_DEFAULT_FIELDS.filter(field => {
      if (pins?.[field] !== undefined) return true;
      if (field === "agent") return record.agentId !== this.router.describeConfig(record, { inherit: true }).agent.value;
      if (field === "cwd") return cfg.sessionCwdExplicit === true && record.repoPath !== null;
      return (field === "effort" ? "reasoningEffort" : field) in cfg;
    });
  }

  clearLegacyOverrides(record: SessionRecord, changes: ChannelPresetChanges): SessionRecord {
    const cfg = this.store.readConfig(record);
    const next = { ...record };
    for (const [field, value] of Object.entries(changes)) {
      if (field === "agent") next.agentId = value as string ?? this.router.describeConfig(record, { inherit: true }).agent.value;
      else if (value === null) {
        if (field === "cwd") { next.repoPath = null; delete cfg.sessionCwdExplicit; }
        else delete (cfg as Record<string, unknown>)[field === "effort" ? "reasoningEffort" : field];
      }
    }
    next.configJson = this.store.writeConfig(cfg);
    this.store.upsert(next);
    return next;
  }

  async followChannel(channelId: string, fields: readonly ConfigDefaultField[], actor: MutationActor) {
    const records = this.settings!.store.listSessionsByParentInCreationOrder("discord", channelId);
    const ids = new Set(records.map(row => row.channelRef));
    const changes = Object.fromEntries(configOverrideFields(fields).map(field => [field, null])) as ChannelPresetChanges;
    for (const id of ids) {
      const row = records.find(record => record.channelRef === id);
      const before = row ? this.router.describeConfig(row) : undefined;
      const result = this.applyThreadOverlay({ threadId: id, parentRef: channelId, changes, actor });
      if (!result.ok && !result.error.includes("No effective change")) throw new Error(result.error);
      if (row && before) await this.runtime.applySavedSelection(this.clearLegacyOverrides(row, changes), before);
    }
    await this.identityEffects.flush();
    return ids.size;
  }

  async clearThreadOverrides(channel: ChannelRef, fields: readonly ConfigDefaultField[], actor: MutationActor) {
    const record = this.router.ensureSessionRecord({ platform: channel.platform, channelRef: channel.id, parentRef: channel.parentId, cwd: this.config.REPOS_ROOT });
    const before = this.router.describeConfig(record);
    const changes = Object.fromEntries(configOverrideFields(fields).map(field => [field, null])) as ChannelPresetChanges;
    const result = this.applyThreadOverlay({ threadId: channel.id, parentRef: channel.parentId, changes, actor,
      ...(channel.platform !== "discord" ? { platform: channel.platform } : {}) });
    if (!result.ok && !result.error.includes("No effective change")) throw new Error(result.error);
    const current = this.clearLegacyOverrides(record, changes);
    await this.runtime.applySavedSelection(current, before);
    await this.identityEffects.flush(record.id);
    return this.router.describeConfig(this.settings!.store.get(record.id) ?? current);
  }

  async prepareChannelSet(channel: ChannelRef, request: ConfigSetRequest) {
    const requestError = configSetRequestError(request);
    if (requestError) return { ok: false as const, message: requestError };
    if (request.json !== null || request.rebuild || request.values.permissions !== null) {
      return { ok: false as const, message: "Session JSON, permissions and rebuild belong to a thread, not channel defaults." };
    }
    const changes: ChannelPresetChanges = {};
    for (const field of request.supplied) {
      const value = request.values[field]!.trim();
      const clear = value === "__inherit__" || value === "inherit" || (["effort", "card", "gif"].includes(field) && value === "default") || (field === "role" && value === "auto");
      if (field === "repo") {
        const location = resolveThreadLocation(this.config, channel.id);
        changes.cwd = clear ? null : await this.settings!.resolveRequestedRepoPath!(channel, value, location);
        const root = this.bridgeHub?.get(location)?.host.workspaceRoot;
        if (changes.cwd && root && !isWithinRoot(changes.cwd, root)) return { ok: false as const, message: `Repo \`${changes.cwd}\` is outside host \`${location}\` workspace root (\`${root}\`).` };
      }
      else if (field === "card") {
        if (!clear && value !== "full" && value !== "simple") return { ok: false as const, message: "`card` must be full, simple or default." };
        changes.statusCardStyle = clear ? null : value as StatusCardStyle;
      } else if (field === "gif") {
        if (!clear && value !== "on" && value !== "off") return { ok: false as const, message: "`gif` must be on, off or default." };
        changes.simpleCardGif = clear ? null : value === "on";
      } else if (field !== "permissions") Object.assign(changes, { [field]: clear ? null : field === "agent" ? parseAgentAtLocation(value).agentId : value });
    }
    if (changes.agent !== undefined && (changes.agent === null || changes.agent !== this.describeTarget(channel, "channel").agent.value)) {
      if (!request.supplied.includes("model")) changes.model = null;
      if (!request.supplied.includes("effort")) changes.effort = null;
    }
    return { ok: true as const, prepared: { kind: "channel" as const, channelId: configTarget(channel, "channel").id, changes } };
  }

  async applyChannelSet(channel: ChannelRef, prepared: { channelId: string; changes: ChannelPresetChanges }, actor: MutationActor) {
    const result = this.applyChannelOverlay({ channelId: prepared.channelId, changes: prepared.changes, actor, location: resolveThreadLocation(this.config, channel.id) });
    if (!result.ok && !result.error.includes("No effective change")) return { ok: false as const, message: result.error, rollbackError: "" };
    this.publishChannelIdentity();
    return { ok: true as const, effective: this.describeTarget(channel, "channel"), restartRequested: false };
  }

  applyTargetIdentity(
    target: SessionRecord,
    changes: TargetIdentityChanges,
    actor: { id: string | null; name: string | null }
  ): { ok: true } | { ok: false; error: string } {
    const overlay = this.mutation.applyThreadOverlay({
      threadId: target.channelRef,
      ...(target.platform !== "discord" ? { platform: target.platform } : {}),
      ...(target.parentRef ? { parentRef: target.parentRef } : {}),
      changes: {
        ...(changes.agent !== undefined ? { agent: changes.agent } : {}),
        ...(changes.inheritSelection ? { model: null, effort: null } : {}),
        ...(changes.model !== undefined ? { model: changes.model } : {}),
        // `auto` is an explicit thread-level sentinel: it shadows a channel
        // effort pin while telling the router to use the backend default.
        ...(changes.effort !== undefined
          ? { effort: changes.effort === null ? "auto" : changes.effort }
          : {}),
        ...(changes.role !== undefined ? { role: changes.role } : {}),
        ...(changes.disableThreadPrefix !== undefined
          ? { disableThreadPrefix: changes.disableThreadPrefix }
          : {}),
        // #37: thread-preset only — there is no session-config mirror to keep
        // in sync, so the overlay below is the single source of truth.
        ...(changes.fastMode !== undefined ? { fastMode: changes.fastMode } : {}),
      },
      actor,
    });
    if (!overlay.ok) return overlay;

    const current = this.store.get(target.id) ?? target;
    const cfg = this.store.readConfig(current);
    if (changes.inheritSelection) {
      delete cfg.model;
      delete cfg.reasoningEffort;
      delete cfg.lastContextUsage;
    }
    if (changes.model !== undefined) {
      cfg.model = changes.model;
      cfg.lastContextUsage = undefined;
    }
    if (changes.effort !== undefined) {
      if (changes.effort === null) delete cfg.reasoningEffort;
      else cfg.reasoningEffort = changes.effort;
    }
    if (changes.role !== undefined) {
      if (changes.role === null) delete cfg.role;
      else cfg.role = changes.role;
    }
    if (changes.disableThreadPrefix !== undefined) {
      if (changes.disableThreadPrefix) cfg.disableThreadPrefix = true;
      else delete cfg.disableThreadPrefix;
    }
    this.store.upsert({
      ...current,
      ...(changes.agent !== undefined ? { agentId: changes.agent } : {}),
      configJson: this.store.writeConfig(cfg),
      updatedUtc: new Date().toISOString(),
    });
    return { ok: true };
  }

  private validateSessionConfigJson(cfg: SessionConfigState): string | null {
    if (cfg.model !== undefined && (typeof cfg.model !== "string" || !cfg.model.trim())) {
      return "`model` must be a non-empty id.";
    }
    if (
      cfg.reasoningEffort !== undefined &&
      (typeof cfg.reasoningEffort !== "string" || !cfg.reasoningEffort.trim())
    ) {
      return "`reasoningEffort` must be a non-empty level.";
    }
    if (cfg.role !== undefined && (typeof cfg.role !== "string" || cfg.role.trim().length > 64)) {
      return "`role` must be a string of at most 64 characters.";
    }
    if (
      cfg.permissionPolicy !== undefined &&
      cfg.permissionPolicy !== "always" &&
      cfg.permissionPolicy !== "ask" &&
      cfg.permissionPolicy !== "deny"
    ) {
      return "`permissionPolicy` must be `always`, `ask`, or `deny`.";
    }
    if (cfg.statusCardStyle !== undefined && !parseStatusCardStyle(cfg.statusCardStyle)) {
      return "`statusCardStyle` must be `full` or `simple`.";
    }
    if (cfg.simpleCardGif !== undefined && typeof cfg.simpleCardGif !== "boolean") {
      return "`simpleCardGif` must be a boolean.";
    }
    if (cfg.disableThreadPrefix !== undefined && typeof cfg.disableThreadPrefix !== "boolean") {
      return "`disableThreadPrefix` must be a boolean.";
    }
    if (cfg.sessionCwdExplicit !== undefined && typeof cfg.sessionCwdExplicit !== "boolean") {
      return "`sessionCwdExplicit` must be a boolean.";
    }
    for (const key of ["availableTools", "excludedTools"] as const) {
      const value = cfg[key];
      if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) {
        return `\`${key}\` must be an array of strings.`;
      }
    }
    return null;
  }

  async prepareConfigSet(
    record: SessionRecord,
    channel: ChannelRef,
    request: ConfigSetRequest
  ): Promise<{ ok: true; prepared: PreparedConfigSet } | { ok: false; message: string }> {
    const { json, values, supplied } = request;
    const requestError = configSetRequestError(request);
    if (requestError) return { ok: false, message: requestError };

    if (json === null && supplied.some(field => values[field] === "inherit" || values[field] === "__inherit__" ||
      (["effort", "card", "gif"].includes(field) && values[field] === "default") || (field === "role" && values[field] === "auto"))) {
      const changes: ThreadPresetChanges = {};
      let permission: PermissionPolicyMode | undefined;
      for (const field of supplied) {
        const value = values[field]!.trim();
        const clear = value === "inherit" || value === "__inherit__" || (["effort", "card", "gif"].includes(field) && value === "default") || (field === "role" && value === "auto");
        if (field === "agent") {
          const parsed = parseAgentAtLocation(value);
          changes.agent = clear ? null : parsed.agentId;
          changes.location = clear ? null : parsed.explicit ? parsed.location : null;
          if (!supplied.includes("model")) changes.model = null;
          if (!supplied.includes("effort")) changes.effort = null;
        } else if (field === "repo") {
          changes.cwd = clear ? null : await this.settings!.resolveRequestedRepoPath!(channel, value, resolveThreadLocation(this.config, channel.id));
          const location = resolveThreadLocation(this.config, channel.id);
          const root = this.bridgeHub?.get(location)?.host.workspaceRoot;
          if (changes.cwd && root && !isWithinRoot(changes.cwd, root)) return { ok: false, message: `Repo \`${changes.cwd}\` is outside host \`${location}\` workspace root (\`${root}\`).` };
        } else if (field === "card") {
          if (!clear && value !== "full" && value !== "simple") return { ok: false, message: "`card` must be full, simple or default." };
          changes.statusCardStyle = clear ? null : value as StatusCardStyle;
        } else if (field === "gif") {
          if (!clear && value !== "on" && value !== "off") return { ok: false, message: "`gif` must be on, off or default." };
          changes.simpleCardGif = clear ? null : value === "on";
        } else if (field === "permissions") {
          if (!["always", "ask", "deny"].includes(value)) return { ok: false, message: "`permissions` must be always, ask or deny." };
          permission = value as PermissionPolicyMode;
        } else Object.assign(changes, { [field]: clear ? null : value });
      }
      return { ok: true, prepared: { kind: "overlay", changes, permission } };
    }

    if (json !== null) {
      let cfg: SessionConfigState;
      try {
        const parsed = JSON.parse(json) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("not an object");
        }
        cfg = { ...(parsed as SessionConfigState) };
      } catch (err) {
        return { ok: false, message: `Invalid JSON: ${(err as Error).message}` };
      }
      const shapeError = this.validateSessionConfigJson(cfg);
      if (shapeError) return { ok: false, message: `Invalid JSON: ${shapeError}` };
      const description = this.router.describeConfig(record);
      if (!cfg.model) cfg.model = description.model.value;
      try {
        const selected = this.modelCatalog.resolve(
          { agentId: description.agent.value, location: description.location.value },
          { model: cfg.model, effort: cfg.reasoningEffort }
        );
        cfg.model = selected.normalized.model;
        cfg.reasoningEffort = selected.normalized.effort;
      } catch (err) {
        return {
          ok: false,
          message: `Invalid catalog selection: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      return { ok: true, prepared: { kind: "json", cfg } };
    }

    const requestedAgent = values.agent?.trim();
    if (values.agent !== null && !requestedAgent) {
      return { ok: false, message: "`agent` must be a non-empty profile id." };
    }
    const parsedAgent = requestedAgent ? parseAgentAtLocation(requestedAgent) : undefined;
    const describedBefore = this.router.describeConfig(record);
    const nextAgentId = parsedAgent?.agentId ?? describedBefore.agent.value;
    const currentLocation = resolveThreadLocation(this.config, channel.id);
    const nextLocation = parsedAgent?.explicit ? parsedAgent.location : currentLocation;
    if (!this.router.getProfile(nextAgentId, nextLocation)) {
      return {
        ok: false,
        message: this.refuseUnregisteredAgent(nextAgentId, `Unknown agent \`${nextAgentId}\`.`),
      };
    }

    const requestedModel = values.model?.trim();
    if (values.model !== null && !requestedModel) {
      return { ok: false, message: "`model` must be a non-empty id." };
    }
    const requestedEffort = values.effort?.trim().toLowerCase();
    const clearEffort = requestedEffort === "default" || requestedEffort === "auto";
    if (values.effort !== null && !requestedEffort) {
      return { ok: false, message: "`effort` must be a level or `default`." };
    }
    const requestedRole = values.role?.trim();
    if (requestedRole && requestedRole.length > 64) {
      return { ok: false, message: "`role` must be at most 64 characters." };
    }
    const permission = values.permissions?.trim().toLowerCase();
    if (
      values.permissions !== null &&
      (!permission || (permission !== "always" && permission !== "ask" && permission !== "deny"))
    ) {
      return { ok: false, message: "`permissions` must be `always`, `ask`, or `deny`." };
    }
    const card = values.card?.trim().toLowerCase();
    if (values.card !== null && (!card || (card !== "default" && !parseStatusCardStyle(card)))) {
      return { ok: false, message: "`card` must be `full`, `simple`, or `default`." };
    }
    const gif = values.gif?.trim().toLowerCase();
    if (values.gif !== null && (!gif || (gif !== "default" && parseSimpleCardGif(gif) === undefined))) {
      return { ok: false, message: "`gif` must be `on`, `off`, or `default`." };
    }

    const agentChanged = nextAgentId !== describedBefore.agent.value;
    const inheritSelection = agentChanged && values.model === null && values.effort === null;
    const inherited = this.router.describeConfig(record, { inherit: true, agent: nextAgentId, location: nextLocation });
    const candidateModel = requestedModel ?? (agentChanged ? inherited.model.value : describedBefore.model.value);
    const catalogModel = this.modelCatalog.model(
      { agentId: nextAgentId, location: nextLocation },
      candidateModel
    );
    if (!catalogModel) {
      return {
        ok: false,
        message:
          `Model \`${candidateModel}\` is unavailable in the cached catalog for ` +
          `\`${nextAgentId}@${nextLocation}\`; refresh the catalog and retry.`,
      };
    }
    const effortChoices = catalogModel.effort.choices.map((choice) => choice.id);
    const pinnedEffort = values.effort !== null
      ? (clearEffort ? catalogModel.effort.selectionDefault : requestedEffort)
      : (inheritSelection ? inherited.effort.value ?? undefined : catalogModel.id !== describedBefore.model.value || agentChanged
          ? catalogModel.effort.selectionDefault
          : undefined);
    if (pinnedEffort && !effortChoices.includes(pinnedEffort)) {
      return {
        ok: false,
        message:
          `Effort \`${pinnedEffort}\` is not supported by \`${nextAgentId}/${catalogModel.id}\`. ` +
          `Choose ${effortChoices.map((value) => `\`${value}\``).join(", ")}.`,
      };
    }
    let resolvedRepo: string | undefined;
    if (values.repo !== null) {
      const requestedRepo = values.repo?.trim();
      if (!requestedRepo) return { ok: false, message: "`repo` must be a non-empty path." };
      try {
        resolvedRepo = await this.settings!.resolveRequestedRepoPath!(channel, requestedRepo, nextLocation);
      } catch (err) {
        return {
          ok: false,
          message: `Invalid repo: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      const root = this.bridgeHub?.get(nextLocation)?.host.workspaceRoot;
      if (root && !isWithinRoot(resolvedRepo, root)) {
        return {
          ok: false,
          message: `Repo \`${resolvedRepo}\` is outside host \`${nextLocation}\` workspace root (\`${root}\`).`,
        };
      }
    }
    return {
      ok: true,
      prepared: {
        kind: "named",
        parsedAgent,
        nextAgentId,
        nextLocation,
        model: catalogModel.id,
        inheritSelection,
        ...(pinnedEffort !== undefined ? { pinnedEffort } : {}),
        ...(requestedRole !== undefined ? { requestedRole } : {}),
        ...(permission !== undefined ? { permission } : {}),
        ...(card !== undefined ? { card } : {}),
        ...(gif !== undefined ? { gif } : {}),
        ...(resolvedRepo !== undefined ? { resolvedRepo } : {}),
        restartRequested: supplied.some((name) =>
          name === "agent" || name === "model" || name === "effort" || name === "repo"
        ),
      },
    };
  }

  async applyPreparedConfigSet(
    record: SessionRecord,
    channel: ChannelRef,
    request: ConfigSetRequest,
    prepared: PreparedConfigSet,
    actor: { id: string; name: string },
    opts: { retireRuntime: boolean; applyName: boolean }
  ): Promise<
    | { ok: true; record: SessionRecord; effective: ReturnType<SessionRouter["describeConfig"]>; restartRequested: boolean }
    | { ok: false; message: string; rollbackError: string }
  > {
    if (prepared.kind === "overlay") {
      const before = this.router.describeConfig(record);
      const source = { ...(this.store.get(record.id) ?? record) };
      const overlay = this.readThreadPresetEntry(threadPresetKey(channel.platform, channel.id));
      try {
        const result = this.applyThreadOverlay({ threadId: channel.id, parentRef: channel.parentId, changes: prepared.changes, actor,
          ...(channel.platform !== "discord" ? { platform: channel.platform } : {}) });
        if (!result.ok && !result.error.includes("No effective change")) throw new Error(result.error);
        let current = this.clearLegacyOverrides(source, prepared.changes);
        const changes = prepared.changes;
        if (prepared.permission || changes.role != null || changes.statusCardStyle != null || changes.simpleCardGif != null) {
          const cfg = this.store.readConfig(current);
          if (changes.role != null) cfg.role = changes.role;
          if (changes.statusCardStyle != null) cfg.statusCardStyle = changes.statusCardStyle;
          if (changes.simpleCardGif != null) cfg.simpleCardGif = changes.simpleCardGif;
          if (prepared.permission) {
            cfg.permissionPolicy = prepared.permission;
            delete cfg.autoApprovePermissions;
          }
          this.persistConfig(current, cfg);
          current = this.store.get(record.id) ?? current;
        }
        if (prepared.permission) await this.runtime.applyPermissionMode(current);
        await this.runtime.applySavedSelection(current, before);
        if (opts.applyName) await this.identityEffects.flush(record.id);
        const committed = this.store.get(record.id) ?? current;
        return { ok: true, record: committed, effective: this.router.describeConfig(committed), restartRequested: false };
      } catch (err) {
        const restored = this.restoreThreadPresetEntry(threadPresetKey(channel.platform, channel.id), overlay);
        this.store.upsert(source, { source: "ConfigApplyPlan.applyPreparedConfigSet",
          cause: `config rollback: ${err instanceof Error ? err.message : String(err)}` });
        return { ok: false, message: err instanceof Error ? err.message : String(err), rollbackError: restored.ok ? "" : ` Overlay rollback failed: ${restored.error}` };
      }
    }
    let sessionBefore: SessionRecord | undefined;
    let overlayBefore: unknown | undefined;
    let mutationStarted = false;
    const rollback = (cause: string): string => {
      if (!mutationStarted || !sessionBefore) return "";
      const restored = this.configMutation.restoreThreadPresetEntry(threadPresetKey(channel.platform, channel.id), overlayBefore);
      this.store.upsert(sessionBefore, { source: "ConfigApplyPlan.applyPreparedConfigSet", cause: `config rollback: ${cause}` });
      return restored.ok ? "" : ` Overlay rollback also failed: ${restored.error}`;
    };
    try {
      const restartRequested = prepared.kind === "json" || prepared.restartRequested;
      if (opts.retireRuntime && restartRequested) {
        if (prepared.kind === "named") {
          await this.runtime.retire(record.id, { clearAcpSession: false });
        } else {
          await this.runtime.retire(record.id);
        }
      }
      const live = this.store.get(record.id) ?? record;
      sessionBefore = { ...live };
      overlayBefore = this.configMutation.readThreadPresetEntry(threadPresetKey(channel.platform, channel.id));

      if (prepared.kind === "json") {
        mutationStarted = true;
        this.persistConfig(live, prepared.cfg);
      } else {
        const liveDescription = this.router.describeConfig(live);
        const appliedAgentId = prepared.parsedAgent?.agentId ?? liveDescription.agent.value;
        const storedAgentId = prepared.parsedAgent?.agentId ?? live.agentId;
        if (!this.router.getProfile(appliedAgentId, prepared.nextLocation)) {
          throw new Error(this.refuseUnregisteredAgent(appliedAgentId, `Unknown agent \`${appliedAgentId}\`.`));
        }
        const cfg = this.store.readConfig(live);
        const agentChanged = appliedAgentId !== liveDescription.agent.value;
        const locationChanged = prepared.nextLocation !== liveDescription.location.value;
        if (prepared.inheritSelection) {
          delete cfg.model;
          delete cfg.reasoningEffort;
        } else cfg.model = prepared.model;
        if (request.values.model !== null || agentChanged) delete cfg.lastContextUsage;
        if (!prepared.inheritSelection && prepared.pinnedEffort !== undefined) cfg.reasoningEffort = prepared.pinnedEffort;
        if (request.values.role !== null) {
          if (!prepared.requestedRole || prepared.requestedRole.toLowerCase() === "auto") delete cfg.role;
          else cfg.role = prepared.requestedRole;
        }
        if (request.values.permissions !== null) {
          cfg.permissionPolicy = prepared.permission as PermissionPolicyMode;
          delete cfg.autoApprovePermissions;
        }
        if (request.values.card !== null) {
          if (!prepared.card || prepared.card === "default") delete cfg.statusCardStyle;
          else cfg.statusCardStyle = prepared.card as StatusCardStyle;
        }
        if (request.values.gif !== null) {
          if (!prepared.gif || prepared.gif === "default") delete cfg.simpleCardGif;
          else cfg.simpleCardGif = parseSimpleCardGif(prepared.gif);
        }
        if (prepared.resolvedRepo !== undefined) cfg.sessionCwdExplicit = true;
        const updated: SessionRecord = {
          ...live,
          agentId: storedAgentId,
          ...(prepared.resolvedRepo !== undefined ? { repoPath: prepared.resolvedRepo } : {}),
          ...(agentChanged || locationChanged ? { acpSessionId: "" } : {}),
          configJson: this.store.writeConfig(cfg),
          updatedUtc: new Date().toISOString(),
        };
        mutationStarted = true;
        this.store.upsert(updated, agentChanged || locationChanged ? {
          source: "ConfigApplyPlan.applyPreparedConfigSet", cause: `operator selected ${appliedAgentId}@${prepared.nextLocation}`,
        } : undefined);

        const overlayChanges: { agent?: string; model?: string | null; effort?: string | null; location?: string } = {};
        if (request.values.agent !== null) {
          overlayChanges.agent = appliedAgentId;
          overlayChanges.model = prepared.inheritSelection ? null : prepared.model;
          if (prepared.parsedAgent?.explicit) overlayChanges.location = prepared.nextLocation;
        } else if (request.values.model !== null) {
          overlayChanges.model = prepared.model;
        }
        if (prepared.inheritSelection) overlayChanges.effort = null;
        else if (prepared.pinnedEffort !== undefined) overlayChanges.effort = prepared.pinnedEffort;
        if (Object.keys(overlayChanges).length > 0) {
          const overlaid = this.configMutation.applyThreadOverlay({
            threadId: channel.id,
            ...(channel.platform !== "discord" ? { platform: channel.platform } : {}),
            ...(channel.parentId ? { parentRef: channel.parentId } : {}),
            changes: overlayChanges,
            actor,
          });
          if (!overlaid.ok) throw new Error(overlaid.error);
        }
      }

      const committed = this.store.get(record.id) ?? record;
      if (prepared.kind === "named" && request.values.permissions !== null) {
        await this.runtime.applyPermissionMode(committed);
      }
      const effective = this.router.describeConfig(committed);
      if (prepared.kind === "named") {
        const mismatch =
          (request.values.agent !== null && effective.agent.value !== prepared.nextAgentId) ||
          ((request.values.model !== null || prepared.nextAgentId !== this.router.describeConfig(sessionBefore).agent.value) &&
            effective.model.value !== prepared.model) ||
          (prepared.pinnedEffort !== undefined && effective.effort.value !== prepared.pinnedEffort) ||
          (prepared.parsedAgent?.explicit === true && effective.location.value !== prepared.nextLocation);
        if (mismatch) {
          throw new Error("the effective agent/model/effort/location did not match the requested values");
        }
        if (prepared.parsedAgent?.explicit) {
          bindSessionLocation(this.bridgeHub, committed.id, prepared.nextLocation);
        }
      }
      mutationStarted = false;
      if (opts.applyName) await this.identityEffects.flush(committed.id);
      return { ok: true, record: committed, effective, restartRequested };
    } catch (err) {
      let rollbackError = "";
      try {
        rollbackError = rollback(err instanceof Error ? err.message : String(err));
      } catch (rollbackFailure) {
        rollbackError = ` Rollback failed: ${
          rollbackFailure instanceof Error ? rollbackFailure.message : String(rollbackFailure)
        }`;
      }
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        rollbackError,
      };
    }
  }
  async applyPresetToSession(
    channel: ChannelRef,
    record: SessionRecord,
    preset: Preset,
    options: { fresh?: boolean } = {}
  ): Promise<string> {
    const changes: string[] = [];
    const notes: string[] = [];
    const before = this.router.describeConfig(record);
    const identityChanges: { agent?: string; model?: string | null; effort?: string | null; cwd?: string } = {};

    // Explicit preset fields belong to the thread, above inherited defaults.
    if (preset.agentId) {
      const binding = {
        agentId: preset.agentId,
        location: before.location.value,
      };
      const profile = this.router.getProfile(preset.agentId, binding.location);
      if (!profile) {
        notes.push(
          `⚠️ ${this.refuseUnregisteredAgent(preset.agentId, `Unknown agent \`${preset.agentId}\``)} — agent left unchanged.`
        );
      } else {
        const inherited = this.router.describeConfig(record, { inherit: true, agent: preset.agentId, location: binding.location });
        const inheritedModel = this.modelCatalog.model(binding, inherited.model.value);
        if (!inheritedModel) {
          notes.push(`⚠️ Catalog for \`${preset.agentId}@${binding.location}\` is warming/unavailable — agent left unchanged.`);
        } else {
          identityChanges.agent = preset.agentId;
          if (preset.agentId !== before.agent.value) {
            await this.runtime.retire(record.id);
            const cfg = this.store.readConfig(record);
            delete cfg.model;
            delete cfg.reasoningEffort;
            identityChanges.model = null;
            identityChanges.effort = null;
            cfg.lastContextUsage = undefined;
            this.store.upsert({
              ...record,
              agentId: preset.agentId,
              acpSessionId: "",
              configJson: this.store.writeConfig(cfg),
              updatedUtc: new Date().toISOString(),
            }, { source: "ConfigApplyPlan.applyPresetToSession", cause: `preset switched agent to ${preset.agentId}` });
            record = this.store.get(record.id) ?? record;
            changes.push(
              `Agent → \`${preset.agentId}\` (model \`${inheritedModel.id}\`, effort \`${inherited.effort.value ?? inheritedModel.effort.selectionDefault}\`)`
            );
          }
        }
      }
    }

    const cfg = this.store.readConfig(record);
    const binding = {
      agentId: identityChanges.agent ?? before.agent.value,
      location: before.location.value,
    };

    if (preset.model) {
      const catalogModel = this.modelCatalog.model(binding, preset.model);
      if (!catalogModel) {
        notes.push(`⚠️ Model \`${preset.model}\` skipped — unavailable in the cached catalog.`);
      } else {
        cfg.model = catalogModel.id;
        identityChanges.model = catalogModel.id;
        if (!preset.effort) {
          cfg.reasoningEffort = catalogModel.effort.selectionDefault;
          identityChanges.effort = catalogModel.effort.selectionDefault;
        }
        cfg.lastContextUsage = undefined;
        changes.push(`Model → \`${catalogModel.id}\``);
        if (!preset.effort) changes.push(`Effort → ${catalogModel.effort.selectionDefault}`);
      }
    }

    if (preset.effort) {
      // Gate on the *effective* agent's capability, exactly like /seam effort —
      // otherwise the summary would claim a change that silently does nothing.
      const selected = this.router.describeConfig(record, { agent: binding.agentId, model: preset.model ?? undefined });
      const selectedModel = this.modelCatalog.model(binding, selected.model.value);
      const supported = selectedModel?.effort.choices.map((choice) => choice.id) ?? [];
      if (supported.includes(preset.effort)) {
        cfg.reasoningEffort = preset.effort;
        identityChanges.effort = preset.effort;
        changes.push(`Effort → ${preset.effort}`);
      } else if (selectedModel?.effort.mechanism === "modelBaked") {
        notes.push(
          `⚠️ Effort \`${preset.effort}\` skipped — \`${binding.agentId}\` bakes effort into the model choice.`
        );
      } else {
        notes.push(
          `⚠️ Effort \`${preset.effort}\` skipped — \`${binding.agentId}\` has no settable reasoning effort.`
        );
      }
    }

    if (preset.role) {
      cfg.role = preset.role;
      changes.push(`Role → \`${preset.role}\``);
    }
    if (preset.disableThreadPrefix !== null) {
      if (preset.disableThreadPrefix) cfg.disableThreadPrefix = true;
      else delete cfg.disableThreadPrefix;
      changes.push(`Auto-name → ${preset.disableThreadPrefix ? "disabled" : "enabled"}`);
    }

    if (preset.permission) {
      cfg.permissionPolicy = preset.permission;
      // Drop the deprecated flag so it can't win the legacy fallback.
      delete cfg.autoApprovePermissions;
      changes.push(`Permission → ${preset.permission}`);
    }
    if (preset.toolsAllow) {
      cfg.availableTools = preset.toolsAllow;
      changes.push(`Tools allow → ${preset.toolsAllow.join(", ")}`);
    }
    if (preset.toolsExclude) {
      cfg.excludedTools = preset.toolsExclude;
      changes.push(`Tools exclude → ${preset.toolsExclude.join(", ")}`);
    }
    if (preset.statusCardStyle === "full" || preset.statusCardStyle === "simple") {
      if (preset.statusCardStyle === "full") {
        delete cfg.statusCardStyle;
      } else {
        cfg.statusCardStyle = "simple";
      }
      changes.push(`Status card → ${preset.statusCardStyle}`);
    }

    if (preset.repoPath) {
      identityChanges.cwd = preset.repoPath;
      delete cfg.sessionCwdExplicit;
    }
    this.store.upsert({
      ...record,
      ...(identityChanges.agent ? { agentId: identityChanges.agent } : {}),
      ...(preset.repoPath ? { repoPath: null } : {}),
      configJson: this.store.writeConfig(cfg),
      updatedUtc: new Date().toISOString(),
    });
    if (Object.keys(identityChanges).length) {
      const written = this.configMutation.applyThreadOverlay({ threadId: channel.id,
        ...(channel.platform !== "discord" ? { platform: channel.platform } : {}),
        ...(record.parentRef ? { parentRef: record.parentRef } : {}), changes: identityChanges,
        actor: { id: null, name: "preset-apply" } });
      if (!written.ok) throw new Error(written.error);
    }
    if (preset.repoPath) {
      changes.push(`Repo → \`${this.repoDisplay(preset.repoPath)}\``);
    }

    if (preset.instructions) {
      notes.push(
        "ℹ️ Instructions are injected as the worker's `<seam-worker-identity>` when this preset " +
          "runs as a handoff/dispatch worker."
      );
    }

    // Drop the runtime so the next message picks up every change above.
    await this.runtime.retire(record.id);

    await this.identityEffects.flush(record.id);

    const body =
      changes.length > 0
        ? changes.map((c) => `• ${c}`).join("\n")
        : "_(no overrides — all fields use defaults)_";
    return notes.length > 0 ? `${body}\n${notes.join("\n")}` : body;
  }
  async saveEditor(draft: ThreadConfigDraft, actor: MutationActor, canEditChannelPreset: (parent: string) => boolean) {
    const channel: ChannelRef = { platform: "discord", id: draft.threadId,
      ...(!draft.channelOnly && draft.parentRef ? { parentId: draft.parentRef } : {}) };
    const bound = draft.channelOnly ? null : this.settings!.store.getByChannel("discord", draft.threadId);
    const before = bound ? this.router.describeConfig(bound) : undefined;
    // Compare touched fields with the latest save, so a revert cancels a pending selection.
    const plan = buildSavePlan(before ? { ...draft, snapshot: {
      ...snapshotFromDescribe(before, draft.snapshot.withoutThread), channelPins: draft.snapshot.channelPins,
      threadOverrides: this.threadOverrideFields(bound!),
    } } : draft);
    const hasPreset = Object.keys(plan.threadPreset).length > 0;
    if (hasPreset) {
      const written = this.configMutation.applyThreadOverlay({
        threadId: draft.threadId,
        ...(draft.parentRef ? { parentRef: draft.parentRef } : {}),
        changes: plan.threadPreset,
        actor,
      });
      if (!written.ok && !written.error.includes("No effective change")) {
        return { ok: false as const, error: `Could not save: ${written.error}` };
      }
      if (bound) this.clearLegacyOverrides(bound, plan.threadPreset);
    }
    if (plan.channelPreset && Object.keys(plan.channelPreset).length > 0) {
      if (!draft.parentRef) {
        return { ok: false as const, error: "Could not save: this thread has no parent channel to pin a channel-wide setting on." };
      }
      if (
        !canEditChannelPreset(draft.parentRef)
      ) {
        return { ok: false as const, error: "Could not save: channel-preset edits need a config admin (locked channels refuse non-admins)." };
      }
      const written = this.configMutation.applyChannelOverlay({
        channelId: draft.parentRef,
        changes: plan.channelPreset,
        actor,
        location: before?.location.value ?? resolveThreadLocation(this.config, draft.threadId),
      });
      if (!written.ok) {
        return { ok: false as const, error: `Could not save: ${written.error}` };
      }
    }
    if (draft.channelOnly) {
      this.publishChannelIdentity();
      return { ok: true as const, draft, snapshot: this.snapshot(channel), fastRefusal: undefined, fastRetireFailed: false };
    }
    if (plan.permission !== undefined || plan.statusCardStyle !== undefined || plan.simpleCardGif !== undefined) {
      const record = this.router.ensureSessionRecord({
        platform: "discord",
        channelRef: draft.threadId,
        ...(draft.parentRef ? { parentRef: draft.parentRef } : {}),
        cwd: this.config.REPOS_ROOT,
      });
      const cfg = this.store.readConfig(record);
      if (plan.permission !== undefined) {
        if (plan.permission === null) {
          delete cfg.permissionPolicy;
        } else {
          cfg.permissionPolicy = plan.permission;
        }
        delete cfg.autoApprovePermissions;
      }
      if (plan.statusCardStyle !== undefined) {
        if (plan.statusCardStyle === null) {
          delete cfg.statusCardStyle;
        } else {
          cfg.statusCardStyle = plan.statusCardStyle;
        }
      }
      if (plan.simpleCardGif !== undefined) {
        if (plan.simpleCardGif === null) {
          delete cfg.simpleCardGif;
        } else {
          cfg.simpleCardGif = plan.simpleCardGif;
        }
      }
      this.persistConfig(record, cfg);
      if (plan.permission !== undefined) await this.runtime.applyPermissionMode(record);
    }
    // Fast changes, including model changes with Fast enabled, need a fresh
    // session. Verify it and roll the flag back if that session refuses Fast.
    let fastRefusal: string | undefined;
    let retireUnverifiedSession = false;
    // Set when a possibly-Fast session could NOT be discarded — the card must
    // not read like an ordinary successful save.
    let fastRetireFailed = false;
    const fastNeedsFreshSession = fastModeWillResetSession(draft);
    if (fastNeedsFreshSession) {
      if (bound) {
        await this.runtime
          .retire(bound.id, {
            clearAcpSession: true,
            bindingChange: { source: "ConfigApplyPlan.saveEditor", cause: "saved Fast-mode selection requires fresh session" },
            clearStartFailure: true,
            operatorIntent: "replace-session",
          })
          .catch((err) =>
            this.logger.warn({ err, threadId: draft.threadId }, "fast-mode session reset failed")
          );
        if (willVerifyFastMode(draft)) {
          try {
            const fresh = this.store.get(bound.id) ?? bound;
            const runtime = await this.router.getOrStartRuntime(fresh);
            const described = this.router.describeConfig(fresh);
            const settled = settleFastMode({
              outcome: runtime.getFastModeOutcome(),
              agentId: described.agent.value,
              model: described.model.value,
              advertised: runtime.getConfigSelectValues(FAST_MODE_CONFIG_ID),
            });
            if (!settled.ok) {
              fastRefusal = settled.refusal;
              retireUnverifiedSession = settled.retireSession;
            }
          } catch (err) {
            fastRefusal =
              `Fast mode could not be verified — the replacement session failed to start: ` +
              `${err instanceof Error ? err.message : String(err)}`;
            this.logger.warn({ err, threadId: draft.threadId }, "fast-mode verification failed");
          }
          if (fastRefusal) {
            // Roll back both the saved flag and the card draft.
            const reverted = this.configMutation.applyThreadOverlay({
              threadId: draft.threadId,
              ...(draft.parentRef ? { parentRef: draft.parentRef } : {}),
              changes: { fastMode: false },
              actor,
            });
            if (!reverted.ok) {
              this.logger.error(
                { err: reverted.error, threadId: draft.threadId },
                "fast-mode rollback failed; persisted flag may be stale"
              );
            }
            draft = { ...draft, overlay: { ...draft.overlay, fastMode: false } };
            if (retireUnverifiedSession) {
              // Retire the fresh session if its Fast state is unconfirmed.
              try {
                await this.runtime.retire(bound.id, {
                  clearAcpSession: true,
                  bindingChange: { source: "ConfigApplyPlan.saveEditor", cause: fastRefusal ?? "provider did not confirm Fast-mode state" },
                  clearStartFailure: true,
                });
              } catch (err) {
                // Report failed retirement in the saved card.
                this.logger.error(
                  { err, threadId: draft.threadId },
                  "could not retire unverified fast-mode session"
                );
                fastRefusal = fastModeRetirementFailure(
                  err instanceof Error ? err.message : String(err)
                );
                fastRetireFailed = true;
              }
            }
          }
        }
      }
    } else if (bound && before) {
      await this.runtime.applySavedSelection(this.store.get(bound.id) ?? bound, before);
    }

    await this.identityEffects.flush(`discord:${draft.threadId}`);
    return { ok: true as const, draft, snapshot: this.snapshot(channel), fastRefusal, fastRetireFailed };
  }
}


export interface ConfigFacadeEnvironment extends Omit<ConfigApplySettings, "runtime"> {
  store: SessionStore;
  mutation: ConfigMutationService;
}

export function createConfigFacades(environment: ConfigFacadeEnvironment): { plan: ConfigApplyPlan; runtime: RuntimeTransition } {
  const mutation = new ConfigApplyPlan({ store: environment.store, mutation: environment.mutation });
  const runtime = new RuntimeTransition({
    store: environment.store, router: environment.router, mutation,
    modelCatalog: environment.modelCatalog,
    identityCommitted: environment.identityCommitted,
  }, { ...environment, mutation });
  return {
    runtime,
    plan: new ConfigApplyPlan({ store: environment.store, mutation: environment.mutation }, { ...environment, runtime }),
  };
}

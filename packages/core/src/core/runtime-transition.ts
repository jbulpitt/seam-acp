import { resolveThreadLocation, threadPresetKey } from "../config.js";
import type { Config } from "../config.js";
import type { SessionStore, SessionBindingChange } from "./session-store.js";
import type { SessionRouter } from "./session-router.js";
import type { BridgeHub } from "./bridge-hub.js";
import type { ChannelRef } from "../platforms/chat-adapter.js";
import type { Logger } from "../lib/logger.js";
import { logger as journal } from "../lib/logger.js";
import type { MutationActor } from "./config-mutation.js";
import { ConfigApplyPlan, type TargetIdentityChanges } from "./config-apply-plan.js";
import { bindSessionLocation } from "./location-bind.js";
import { parseAgentAtLocation, formatAgentAtLocation } from "./location.js";

import type { AgentProfile } from "@seam/adapters";
import {
  detectSessionReset,
  type ConfigMutationService,
  type AppliedSessionConfig,
  type SessionConfigChanges,
} from "./config-mutation.js";
import type { ConfigDescription, ConfigResolution, SessionInvalidationOptions } from "./session-router.js";
import {
  FAST_MODE_COST_WARNING,
  FAST_MODE_CONFIG_ID,
  FAST_MODE_ON,
  checkFastModeEligibility,
  fastModeNeedsFreshSession,
  fastModeRetirementFailure,
  settleFastMode,
  type FastModeOutcome,
} from "./fast-mode.js";
import type { SessionConfigState, SessionRecord } from "./types.js";
import { assessModelSelection, type CatalogBinding, type ModelCatalogService, type ModelVerification } from "./model-catalog/service.js";

export interface ConfigureThreadInput {
  agent?: string;
  model?: string;
  effort?: string;
  /** Free-form naming role; empty/auto clears the session override. */
  role?: string;
  /** Thread-local automatic naming opt-out. False re-enables future exact passes. */
  disableThreadPrefix?: boolean;
  /**
   * Claude Fast mode (#37). `true` is refused outright for agents without Fast
   * or when the environment kill switch is set — never silently ignored.
   * Changing it always forges a fresh session before Fast is applied.
   */
  fastMode?: boolean;
}

export interface MigrateSelfInput extends Omit<ConfigureThreadInput, "role"> {
  manifest: string;
}

/** Durable requested target carried by the post-turn dispatch. */
export interface PreparedSelfMigration {
  agent: string;
  model: string;
  effort?: string;
  previousAgent: string;
  previousModel: string;
  previousSessionId: string;
  inheritSelection?: boolean;
}

export type PrepareSelfMigrationOutcome =
  | { ok: true; migration: PreparedSelfMigration; warnings?: string[] }
  | { ok: false; error: string };

export type ExecuteSelfMigrationOutcome =
  | {
      ok: true;
      record: SessionRecord;
      agent: string;
      model: string;
      effort: string;
      newSessionId: string;
      warnings: string[];
    }
  | { ok: false; error: string };

export interface ConfigureThreadSuccess {
  verification?: ModelVerification;
  ok: true;
  /** Exact effective identity after the operation. Never a partial/vague diff. */
  applied: ThreadConfigurationIdentity;
  /** Exact before/after status for every identity field, including no-ops. */
  changes: ThreadConfigurationChanges;
  sessionReset: boolean;
  resetReason?: "agent-switch" | "model-switch" | "fast-mode-switch";
  newSessionId?: string;
  /** The ACP session survived, but its process was reloaded to apply spawn/meta effort. */
  runtimeReloaded: boolean;
  /** Filled by the platform presentation hook after the core mutation succeeds. */
  confirmationPosted?: boolean;
  /** Filled by the platform presentation hook when an agent icon/name update was attempted. */
  threadIdentityUpdated?: boolean;
  warnings: string[];
}

export interface ThreadConfigurationIdentity {
  agent: string;
  model: string;
  /** Explicit level, or `auto` when no override is active. */
  effort: string;
  /** Effective naming role, or `auto` when no role is active. */
  role: string;
  disableThreadPrefix: boolean;
  /** Claude Fast mode (#37): the state that is actually in force. */
  fastMode: boolean;
}

export interface ThreadConfigurationFieldChange {
  before: string;
  after: string;
  changed: boolean;
}

export interface ThreadConfigurationChanges {
  agent: ThreadConfigurationFieldChange;
  model: ThreadConfigurationFieldChange;
  effort: ThreadConfigurationFieldChange;
  role: ThreadConfigurationFieldChange;
  disableThreadPrefix: ThreadConfigurationFieldChange;
  fastMode: ThreadConfigurationFieldChange;
}

export type ConfigureThreadOutcome =
  | ConfigureThreadSuccess
  | { ok: false; error: string };

export type ResetThreadSessionOutcome =
  | { ok: true; sessionReset: true; newSessionId: string; agent: string; model: string }
  | { ok: false; error: string };

export interface SessionControlRuntime {
  getSessionInfo(): { sessionId: string; availableModels: ReadonlyArray<{ modelId: string }> } | undefined;
  getConfigSelectValues(configId: string): ReadonlyArray<string>;
  /** #37: what Fast actually resolved to on the live session, if determined. */
  getFastModeOutcome?(): FastModeOutcome | undefined;
  getLastModelFallbackNotice?(): string | undefined;
  setModel(modelId: string, opts?: { effort?: string }): Promise<void>;
  setConfigOption(configId: string, value: string | boolean): Promise<void>;
}

export interface SessionConfigMutation {
  applySessionConfig(
    record: SessionRecord,
    changes: SessionConfigChanges,
    actor: { id: string | null; name: string | null },
    opts?: { effortValues?: ReadonlyArray<string> }
  ):
    | { ok: true; result: AppliedSessionConfig }
    | { ok: false; error: string };
}

export interface ThreadSessionControlDeps {
  store: {
    get(id: string): SessionRecord | null | undefined;
    readConfig(record: SessionRecord): SessionConfigState;
    writeConfig(config: SessionConfigState): string;
    upsert(record: SessionRecord, binding?: SessionBindingChange): void;
    compareAndSwapAcpSession: SessionStore["compareAndSwapAcpSession"];
  };
  router: {
    describeConfig(record: SessionRecord, selection?: ConfigResolution): ConfigDescription;
    getProfile(agentId: string, location?: string): AgentProfile | undefined;
    assertAgentAllowedForRecord(record: SessionRecord, agentId: string): void;
    unregisteredAgentMessage?(agentId: string, fallback: string): string;
    getOrStartRuntime(record: SessionRecord): Promise<SessionControlRuntime>;
    invalidate(
      sessionId: string,
      opts?: SessionInvalidationOptions
    ): Promise<void>;
  };
  mutation: SessionConfigMutation & {
    readThreadPresetEntry: ConfigMutationService["readThreadPresetEntry"];
    restoreThreadPresetEntry: ConfigMutationService["restoreThreadPresetEntry"];
    applyThreadOverlay(opts: {
      threadId: string;
      platform?: string;
      parentRef?: string;
      changes: {
        agent?: string | null;
        model?: string | null;
        effort?: string | null;
        role?: string | null;
        disableThreadPrefix?: boolean | null;
        fastMode?: boolean;
      };
      actor: { id: string | null; name: string | null };
    }): { ok: true; message: string; auditId: string } | { ok: false; error: string };
  };
  modelCatalog: Pick<ModelCatalogService, "models" | "model" | "effortChoices" | "resolve">;
  /** Await effects of committed identity changes without invoking a feature. */
  identityCommitted?: (sessionId: string) => Promise<void>;
}

export interface RuntimeSettingsDeps {
  store: SessionStore;
  router: SessionRouter;
  config: Config;
  mutation: ConfigApplyPlan;
  modelCatalog: ModelCatalogService;
  logger: Logger;
  bridgeHub?: BridgeHub;
  identityCommitted: (sessionId?: string) => Promise<void>;
  unregisteredAgentMessage: (id: string, fallback: string) => string;
  persistConfig: (record: SessionRecord, cfg: SessionConfigState) => void;
}


/**
 * Immediate session control behind seam-MCP's same-channel addressing gate.
 * The mutation engine receives only the already-resolved target record, so its
 * ordinary caller-derived/self-scope API remains unchanged.
 */
export class RuntimeTransition {
  constructor(private readonly deps: ThreadSessionControlDeps, private readonly settings?: RuntimeSettingsDeps) {}

  static consequence(input: Parameters<typeof detectSessionReset>[0] & { runtimeTouched: boolean; rebuild?: boolean }): "none" | "live-apply" | "reset" | "rebuild" {
    if (input.rebuild) return "rebuild";
    if (detectSessionReset(input).sessionReset) return "reset";
    return input.runtimeTouched ? "live-apply" : "none";
  }

  /** Retire a process with the caller's existing context/reset policy. */
  async retire(sessionId: string, opts?: SessionInvalidationOptions): Promise<void> {
    await this.deps.router.invalidate(sessionId, opts);
  }

  async applyPermissionMode(record: SessionRecord): Promise<void> {
    await this.settings!.router.applyPermissionMode(record);
  }

  /** Apply an editor's already-audited selection to the retained runtime. */
  async applySavedSelection(record: SessionRecord, before: ConfigDescription): Promise<void> {
    // D10: Save never aborts a live turn. Transition before its next acquisition.
    await this.router.transitionWhenIdle(record.id, () =>
      this.applySavedSelectionNow(this.deps.store.get(record.id) ?? record, before)
    );
  }

  /** Adopt a seeded migration without replacing its context or interrupting a turn. */
  async adoptMigratedSession(target: SessionRecord, selection: {
    agent: string; model: string; effort: string; acpSessionId: string;
  }, actor: MutationActor): Promise<void> {
    const applied = this.applyTargetIdentity(target, {
      agent: selection.agent, model: selection.model, effort: selection.effort || null,
    }, actor);
    if (!applied.ok) throw new Error(applied.error);
    const current = this.deps.store.get(target.id) ?? target;
    this.deps.store.upsert({ ...current, acpSessionId: selection.acpSessionId, updatedUtc: new Date().toISOString() }, {
      source: "RuntimeTransition.adoptMigratedSession", cause: "attach migrated provider session",
    });
    Object.assign(target, this.deps.store.get(target.id) ?? current);
    const migrated = this.deps.router.describeConfig(target);
    // D10: retire the source only after its prompt; load the seeded target next.
    await this.router.transitionWhenIdle(target.id, async () => {
      await this.retire(target.id, { clearAcpSession: false, clearStartFailure: true });
      await this.applySavedSelectionNow(this.deps.store.get(target.id) ?? target, migrated);
    }, { replacePending: true });
    await this.deps.identityCommitted?.(target.id);
  }

  private async applySavedSelectionNow(record: SessionRecord, before: ConfigDescription): Promise<void> {
    const after = this.deps.router.describeConfig(record);
    const agentChanged = before.agent.value !== after.agent.value;
    const modelChanged = before.model.value !== after.model.value;
    const effortChanged = before.effort.value !== after.effort.value;
    if (!agentChanged && !modelChanged && !effortChanged) return;

    const binding = { agentId: after.agent.value, location: after.location.value };
    const model = this.deps.modelCatalog.model(binding, after.model.value);
    const reset = detectSessionReset({
      previousAgentId: before.agent.value,
      nextAgentId: after.agent.value,
      modelChanged,
      modelApplicationMode: model?.applicationMode ?? "reload",
    });
    if (reset.sessionReset) {
      await this.retire(record.id, {
        clearAcpSession: true,
        bindingChange: { source: "RuntimeTransition.applySavedSelection", cause: `saved selection requires ${reset.resetReason}` },
        clearStartFailure: true,
        operatorIntent: "replace-session",
      });
      const current = this.deps.store.get(record.id) ?? record;
      this.deps.store.upsert({ ...current, acpSessionId: "", updatedUtc: new Date().toISOString() }, {
        source: "RuntimeTransition.applySavedSelection", cause: `saved selection requires ${reset.resetReason}`,
      });
      return;
    }

    const mechanism = model?.effort.mechanism;
    if (
      (modelChanged && (model?.applicationMode ?? "reload") === "reload") ||
      (effortChanged && (!model || mechanism === "meta" || mechanism === "spawnArgs" || after.effort.value === null))
    ) {
      await this.retire(record.id, { clearAcpSession: false });
      return;
    }

    const runtime = this.router.getRuntime(record.id);
    if (runtime) {
      const selection = this.deps.modelCatalog.resolve(binding, {
        model: after.model.value,
        effort: after.effort.value ?? undefined,
      });
      if (modelChanged) await runtime.setModel(selection.raw.model, { effort: selection.raw.effort });
      if ((modelChanged || effortChanged) && mechanism === "configOption" && selection.raw.effort) {
        await runtime.setConfigOption(model!.effort.configId!, selection.raw.effort);
      }
    }
  }

  async setPermission(record: SessionRecord, policy: "always" | "ask" | "deny"): Promise<void> {
    const cfg = this.store.readConfig(record);
    cfg.permissionPolicy = policy;
    delete cfg.autoApprovePermissions;
    this.persistConfig(record, cfg);
    await this.applyPermissionMode(record);
  }

  async setMode(record: SessionRecord, id: string): Promise<void> {
    const cfg = this.store.readConfig(record);
    cfg.mode = id;
    this.persistConfig(record, cfg);
    if (this.settings!.router.hasRuntime(record.id)) {
      try {
        const runtime = await this.settings!.router.getOrStartRuntime(record);
        await runtime.setMode(id);
      } catch (err) {
        this.settings!.logger.warn({ err }, "live mode set failed");
      }
    }
  }

  private get store() { return this.settings!.store; }
  private get router() { return this.settings!.router; }
  private get config() { return this.settings!.config; }
  private get configMutation() { return this.settings!.mutation; }
  private get modelCatalog() { return this.settings!.modelCatalog; }
  private get logger() { return this.settings!.logger; }
  private get bridgeHub() { return this.settings!.bridgeHub; }
  private get identityEffects() { return { flush: this.settings!.identityCommitted }; }
  private refuseUnregisteredAgent(id: string, fallback: string) { return this.settings!.unregisteredAgentMessage(id, fallback); }
  private persistConfig(record: SessionRecord, cfg: SessionConfigState): void {
    this.settings!.persistConfig(record, cfg);
  }


  /**
   * Validate a self-migration without mutating the caller's live session. The
   * returned target is embedded in a durable dispatch that executes only after
   * the current turn releases the channel FIFO.
   */
  async prepareSelfMigration(
    target: SessionRecord,
    input: MigrateSelfInput
  ): Promise<PrepareSelfMigrationOutcome> {
    if (input.agent === undefined && input.model === undefined) {
      return { ok: false, error: "Provide at least one of `agent` or `model`." };
    }
    if (!input.manifest.trim()) {
      return { ok: false, error: "`manifest` must be a non-empty string." };
    }

    const before = this.deps.router.describeConfig(target);
    const location = before.location?.value ?? "local";
    const requestedAgent = input.agent?.trim();
    if (input.agent !== undefined && !requestedAgent) {
      return { ok: false, error: "`agent` must be a non-empty string." };
    }
    const nextAgent = requestedAgent ?? before.agent.value;
    // #308: protects migration staging from selecting an agent barred from this
    // channel; deleting it lets a later post-turn migration bypass the rule.
    try {
      this.deps.router.assertAgentAllowedForRecord(target, nextAgent);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const profile = this.deps.router.getProfile(nextAgent, location);
    if (!profile) {
      const fallback = `Unknown agent "${nextAgent}".`;
      return {
        ok: false,
        error: this.deps.router.unregisteredAgentMessage?.(nextAgent, fallback) ?? fallback,
      };
    }

    const agentChanged = nextAgent !== before.agent.value;
    const requestedModel = input.model?.trim();
    if (input.model !== undefined && !requestedModel) {
      return { ok: false, error: "`model` must be a non-empty string." };
    }
    const inherited = this.deps.router.describeConfig(target, { inherit: true, agent: nextAgent, location });
    const inheritSelection = agentChanged && input.model === undefined && input.effort === undefined;
    const requestedTargetModel = requestedModel ?? (agentChanged ? inherited.model.value : before.model.value);
    if (!requestedTargetModel) {
      return {
        ok: false,
        error: `Model catalog for ${nextAgent}@${location} is warming/unavailable.`,
      };
    }
    if (!agentChanged && requestedTargetModel === before.model.value) {
      return {
        ok: false,
        error: "Migration requires a different agent or model; the requested target already matches.",
      };
    }

    const binding = { agentId: nextAgent, location };
    const selection = assessModelSelection(this.deps.modelCatalog, binding, requestedTargetModel);
    if (!selection.allowed) {
      return {
        ok: false,
        error: `Model "${requestedTargetModel}" is unavailable in the cached catalog for ${nextAgent}@${location}.`,
      };
    }
    const catalogModel = selection.model;

    const requestedEffort = normalizeEffort(input.effort);
    if (input.effort !== undefined && !requestedEffort) {
      return { ok: false, error: "`effort` must be a non-empty string or `auto`." };
    }

    const desiredEffort = requestedEffort === "auto"
      ? catalogModel?.effort.selectionDefault
      : requestedEffort ?? (inheritSelection ? inherited.effort.value ?? catalogModel?.effort.selectionDefault : catalogModel?.effort.selectionDefault);
    if (catalogModel && !catalogModel.effort.choices.some((choice) => choice.id === desiredEffort)) {
      return {
        ok: false,
        error: `Effort "${desiredEffort}" is not supported for ${nextAgent}/${catalogModel.id}.`,
      };
    }
    return {
      ok: true,
      ...(selection.verification === "unverified" ? { warnings: [unverifiedModelWarning(selection.id, binding)] } : {}),
      migration: {
        agent: nextAgent,
        model: selection.id,
        effort: desiredEffort,
        previousAgent: before.agent.value,
        previousModel: before.model.value,
        previousSessionId: target.acpSessionId,
        ...(inheritSelection ? { inheritSelection: true } : {}),
      },
    };
  }

  /**
   * Activate a prepared migration after the invoking turn has ended. Any
   * replacement-session or live effort failure restores the exact prior
   * durable record (including its ACP session id) before returning.
   */
  async executeSelfMigration(
    target: SessionRecord,
    prepared: PreparedSelfMigration
  ): Promise<ExecuteSelfMigrationOutcome> {
    const current = this.deps.store.get(target.id);
    if (!current) return { ok: false, error: "Calling session disappeared before migration." };
    const before = this.deps.router.describeConfig(current);
    if (
      before.agent.value !== prepared.previousAgent ||
      before.model.value !== prepared.previousModel ||
      current.acpSessionId !== prepared.previousSessionId
    ) {
      return {
        ok: false,
        error: "Calling session changed after migration was staged; refusing to overwrite newer state.",
      };
    }

    const snapshot: SessionRecord = { ...current };
    const overlayBefore = this.deps.mutation.readThreadPresetEntry(threadPresetKey(current.platform, current.channelRef));
    const desiredEffort = prepared.effort;
    const binding = { agentId: prepared.agent, location: before.location.value };
    const warnings: string[] = assessModelSelection(this.deps.modelCatalog, binding, prepared.model).verification === "unverified"
      ? [unverifiedModelWarning(prepared.model, binding)] : [];

    try {
      const staged = this.applyTargetIdentity(
        current,
        {
          ...(prepared.agent !== before.agent.value ? { agent: prepared.agent } : {}),
          ...(prepared.inheritSelection ? { inheritSelection: true } : {
            model: prepared.model, effort: desiredEffort ?? null,
          }),
        },
        { id: null, name: `seam-mcp:self:${current.channelRef}` }
      );
      if (!staged.ok) throw new Error(staged.error);

      const effective = this.deps.router.describeConfig(
        this.deps.store.get(current.id) ?? current
      );
      if (effective.agent.value !== prepared.agent || effective.model.value !== prepared.model) {
        throw new Error(
          `Target is shadowed by configuration: effective ${effective.agent.value}/${effective.model.value}.`
        );
      }

      const forged = await this.forgeFreshSession(current.id, "operator requested self migration");
      const info = forged.runtime.getSessionInfo();
      if (!info?.sessionId) throw new Error("Fresh runtime did not report a session id.");
      const fresh = this.deps.store.get(current.id);
      if (!fresh) throw new Error("Calling session disappeared after migration.");
      await this.deps.identityCommitted?.(fresh.id);
      return {
        ok: true,
        record: fresh,
        agent: prepared.agent,
        model: prepared.model,
        effort: desiredEffort ?? "auto",
        newSessionId: info.sessionId,
        warnings,
      };
    } catch (err) {
      // A candidate runtime may already exist. Retire it before restoring the
      // old durable session so no process can keep writing stale target state.
      await this.retire(current.id, { clearStartFailure: true }).catch(() => {});
      const restored = this.deps.mutation.restoreThreadPresetEntry(threadPresetKey(current.platform, current.channelRef), overlayBefore);
      this.deps.store.upsert(snapshot, {
        source: "RuntimeTransition.commitSelfMigration", cause: `migration rollback: ${err instanceof Error ? err.message : String(err)}`,
      });
      return {
        ok: false,
        error: `${err instanceof Error ? err.message : String(err)}${restored.ok ? "" : ` Overlay rollback failed: ${restored.error}`}`,
      };
    }
  }

  async configure(
    caller: SessionRecord,
    target: SessionRecord,
    input: ConfigureThreadInput
  ): Promise<ConfigureThreadOutcome> {
    const supplied = input.agent !== undefined || input.model !== undefined || input.effort !== undefined || input.role !== undefined || input.disableThreadPrefix !== undefined || input.fastMode !== undefined;
    if (!supplied) return { ok: false, error: "Provide at least one of agent, model, effort, role, disableThreadPrefix, or fastMode." };

    const before = this.deps.router.describeConfig(target);
    const location = before.location?.value ?? "local";
    const previousAgentId = before.agent.value;
    const requestedAgent = input.agent?.trim();
    if (input.agent !== undefined && !requestedAgent) {
      return { ok: false, error: "`agent` must be a non-empty string." };
    }
    const nextAgentId = requestedAgent ?? previousAgentId;
    // #308: protects configure_thread before it persists a barred agent; deleting
    // it makes reconfiguration an immediate bypass of the channel allowlist.
    try {
      this.deps.router.assertAgentAllowedForRecord(target, nextAgentId);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const profile = this.deps.router.getProfile(nextAgentId, location);
    if (!profile) {
      const fallback = `Unknown agent "${nextAgentId}".`;
      return {
        ok: false,
        error: this.deps.router.unregisteredAgentMessage?.(nextAgentId, fallback) ?? fallback,
      };
    }

    const agentChanged = nextAgentId !== previousAgentId;
    const requestedModel = input.model?.trim();
    if (input.model !== undefined && !requestedModel) {
      return { ok: false, error: "`model` must be a non-empty string." };
    }
    const inherited = this.deps.router.describeConfig(target, { inherit: true, agent: nextAgentId, location });
    const inheritSelection = agentChanged && input.model === undefined && input.effort === undefined;
    const requestedTargetModel = requestedModel ?? (agentChanged ? inherited.model.value : before.model.value);
    if (!requestedTargetModel) {
      return {
        ok: false,
        error: `Model catalog for ${nextAgentId}@${location} is warming/unavailable.`,
      };
    }

    const requestedEffort = normalizeEffort(input.effort);
    if (input.effort !== undefined && !requestedEffort) {
      return { ok: false, error: "`effort` must be a non-empty string or `auto`." };
    }
    const selection = assessModelSelection(this.deps.modelCatalog,
      { agentId: nextAgentId, location },
      requestedTargetModel
    );
    // Refuse only a positively retired/unavailable model. Unlisted typed ids
    // keep this registered agent usable and are passed to its provider unchanged.
    if (!selection.allowed) {
      return {
        ok: false,
        error: `Model "${requestedTargetModel}" is unavailable in the cached catalog for ${nextAgentId}@${location}.`,
      };
    }
    const catalogModel = selection.model;
    const nextModel = selection.id;
    const modelChanged = nextModel !== before.model.value;
    const effortMechanism = catalogModel?.effort.mechanism;
    const staticEffortValues = catalogModel?.effort.choices.map((choice) => choice.id) ?? [];
    let desiredEffort = requestedEffort === "auto"
      ? catalogModel?.effort.selectionDefault
      : requestedEffort ??
        (inheritSelection ? inherited.effort.value ?? catalogModel?.effort.selectionDefault : (modelChanged || agentChanged)
          ? catalogModel?.effort.selectionDefault
          : normalizeStoredEffort(before.effort.value ?? undefined));
    const requestedRole = input.role?.trim();
    const nextRole = input.role === undefined
      ? undefined
      : !requestedRole || requestedRole.toLowerCase() === "auto"
        ? null
        : requestedRole;
    const nextDisableThreadPrefix = input.disableThreadPrefix
      ?? before.disableThreadPrefix?.value
      ?? false;

    // #37 Fast mode. Eligibility (agent declares it, environment permits it) is
    // a HARD refusal, not a warning: confirming a Fast change that can never
    // apply is exactly the false confirmation this feature must not produce.
    const warnings: string[] = selection.verification === "unverified"
      ? [unverifiedModelWarning(nextModel, { agentId: nextAgentId, location })] : [];
    const eligible = checkFastModeEligibility({
      requested: input.fastMode === true,
      agentId: nextAgentId,
      descriptor: profile.fastMode,
    });
    if (!eligible.ok) return { ok: false, error: eligible.error };
    let nextFastMode = input.fastMode ?? before.fastMode?.value ?? false;
    if (nextFastMode && !profile.fastMode) {
      // Inherited-on + agent switched to one without Fast: force it off rather
      // than carrying a flag the new agent can never honor. (An EXPLICIT `true`
      // for such an agent was already refused above.)
      warnings.push(
        `Fast mode was on for this thread but "${nextAgentId}" has no Fast mode; turning it off.`
      );
      nextFastMode = false;
    }
    const fastModeChanged = nextFastMode !== (before.fastMode?.value ?? false);
    // Shared rule (#37): Fast is validated per session AND per model, so a
    // model/agent change under an active Fast setting needs a fresh session
    // even though the Fast setting itself did not change.
    const reset = detectSessionReset({
      previousAgentId,
      nextAgentId,
      modelChanged,
      modelApplicationMode: catalogModel?.applicationMode ?? "reload",
      fastModeChanged: fastModeNeedsFreshSession({
        nextFastMode,
        fastModeChanged,
        modelChanged,
        agentChanged,
      }),
    });
    const effortTouched = input.effort !== undefined || modelChanged || agentChanged;
    if (
      catalogModel && desiredEffort &&
      (((effortMechanism === "none" || effortMechanism === "modelBaked") &&
        desiredEffort !== catalogModel.effort.selectionDefault) ||
        !staticEffortValues.includes(desiredEffort))
    ) {
      return {
        ok: false,
        error:
          `Effort "${desiredEffort}" is not supported for ${nextAgentId}/${nextModel}. ` +
          `Valid values: ${staticEffortValues.length ? staticEffortValues.join(", ") : "none"}.`,
      };
    }

    const beforeIdentity = identityFromDescription(before);
    const plannedIdentity: ThreadConfigurationIdentity = {
      agent: nextAgentId,
      model: nextModel,
      effort: desiredEffort ?? "auto",
      role: input.role === undefined ? before.role.value ?? "auto" : nextRole ?? "auto",
      disableThreadPrefix: nextDisableThreadPrefix,
      fastMode: nextFastMode,
    };
    const plannedChanges = diffIdentity(beforeIdentity, plannedIdentity);

    // A successful set is still useful when it is a no-op: return the complete
    // identity with explicit `(no change)` state and do not perturb the runtime.
    if (
      !plannedChanges.agent.changed &&
      !plannedChanges.model.changed &&
      !plannedChanges.effort.changed &&
      !plannedChanges.role.changed &&
      !plannedChanges.disableThreadPrefix.changed &&
      !plannedChanges.fastMode.changed
    ) {
      const threadIdentityUpdated = await this.applyNaming(target);
      return {
        ok: true,
        verification: selection.verification,
        applied: beforeIdentity,
        changes: plannedChanges,
        sessionReset: false,
        runtimeReloaded: false,
        threadIdentityUpdated,
        warnings,
      };
    }

    const actor = { id: null, name: `seam-mcp:${caller.channelRef}` };
    const persisted = this.applyTargetIdentity(
      target,
      {
        ...(agentChanged ? { agent: nextAgentId } : {}),
        ...(inheritSelection ? { inheritSelection: true } : {
          ...(modelChanged || agentChanged ? { model: nextModel } : {}),
          ...(effortTouched ? { effort: desiredEffort ?? null } : {}),
        }),
        ...(input.role !== undefined ? { role: nextRole } : {}),
        ...(input.disableThreadPrefix !== undefined
          ? { disableThreadPrefix: input.disableThreadPrefix }
          : {}),
        ...(fastModeChanged ? { fastMode: nextFastMode } : {}),
      },
      actor
    );
    if (!persisted.ok) return persisted;

    const onlyNaming = (input.role !== undefined || input.disableThreadPrefix !== undefined)
      && input.agent === undefined
      && input.model === undefined
      && input.effort === undefined
      && !fastModeChanged;
    if (onlyNaming) {
      const current = this.deps.store.get(target.id);
      if (!current) return { ok: false, error: "Target session disappeared after configuration." };
      const threadIdentityUpdated = await this.applyNaming(current);
      const effectiveIdentity = identityFromDescription(this.deps.router.describeConfig(current));
      return {
        ok: true,
        verification: selection.verification,
        applied: effectiveIdentity,
        changes: diffIdentity(beforeIdentity, effectiveIdentity),
        sessionReset: false,
        runtimeReloaded: false,
        threadIdentityUpdated,
        warnings,
      };
    }

    let runtime: SessionControlRuntime;
    let runtimeReloaded = false;
    let newSessionId: string | undefined;
    // Set when an unverifiable Fast enable forced us to throw the replacement
    // session away — the reported session id would otherwise be a dead id.
    let retiredUnverifiedSession = false;

    if (reset.sessionReset) {
      const forged = await this.forgeFreshSession(target.id, `configuration requires ${reset.resetReason}`);
      runtime = forged.runtime;
      newSessionId = runtime.getSessionInfo()?.sessionId;
    } else if (
      modelChanged && (catalogModel?.applicationMode ?? "reload") === "reload"
    ) {
      await this.retire(target.id, { clearAcpSession: false });
      const current = this.deps.store.get(target.id);
      if (!current) return { ok: false, error: "Target session disappeared while reloading model." };
      runtime = await this.deps.router.getOrStartRuntime(current);
      runtimeReloaded = true;
    } else if (
      plannedChanges.effort.changed &&
      (!catalogModel || effortMechanism === "meta" ||
        effortMechanism === "spawnArgs" ||
        desiredEffort === undefined)
    ) {
      // Meta/spawn effort is consumed while creating or loading the runtime,
      // not via set_config_option. `auto` likewise requires a reload to remove
      // a previously-live config option. Preserve the ACP session and context.
      await this.retire(target.id, { clearAcpSession: false });
      const current = this.deps.store.get(target.id);
      if (!current) return { ok: false, error: "Target session disappeared while reloading effort." };
      runtime = await this.deps.router.getOrStartRuntime(current);
      runtimeReloaded = true;
    } else {
      const current = this.deps.store.get(target.id) ?? target;
      runtime = await this.deps.router.getOrStartRuntime(current);
      if (modelChanged) {
        const selection = this.deps.modelCatalog.resolve(
          { agentId: nextAgentId, location },
          { model: nextModel, effort: desiredEffort }
        );
        await runtime.setModel(selection.raw.model, { effort: selection.raw.effort });
      }
    }

    const fallbackNotice = runtime.getLastModelFallbackNotice?.();
    if (fallbackNotice && (modelChanged || runtimeReloaded || reset.sessionReset)) warnings.push(fallbackNotice);

    // Config-option agents may advertise a model-dependent subset. Validate
    // against the live session before claiming success. Claude never enters
    // this branch: its effort is `_meta` and was applied by the reload above.
    if (catalogModel && effortTouched && desiredEffort && effortMechanism === "configOption") {
      const configId = catalogModel.effort.configId;
      if (!configId) {
        return { ok: false, error: `Catalog is missing the config id for ${nextAgentId}/${nextModel}.` };
      }
      const rawEffort = this.deps.modelCatalog.resolve(
        { agentId: nextAgentId, location },
        { model: nextModel, effort: desiredEffort }
      ).raw.effort;
      const liveValues = runtime.getConfigSelectValues(configId);
      if (!rawEffort || liveValues.includes(rawEffort)) {
        if (!reset.sessionReset || plannedChanges.effort.changed) {
          if (rawEffort) await runtime.setConfigOption(configId, rawEffort);
        }
      } else {
        return {
          ok: false,
          error:
            `Runtime/catalog drift: effort "${desiredEffort}" is not advertised by the live ` +
            `${nextAgentId}/${nextModel} session. Valid runtime values: ` +
            `${liveValues.length ? liveValues.join(", ") : "none"}.`,
        };
      }
    }

    // Verify Fast on every fresh session; support can change with the model.
    if (reset.sessionReset && nextFastMode) {
      const settled = settleFastMode({
        outcome: runtime.getFastModeOutcome?.(),
        agentId: nextAgentId,
        model: nextModel,
        advertised: runtime.getConfigSelectValues(FAST_MODE_CONFIG_ID),
      });
      if (!settled.ok) {
        warnings.push(settled.refusal);
        const reverted = this.applyTargetIdentity(
          this.deps.store.get(target.id) ?? target,
          { fastMode: false },
          actor
        );
        if (!reverted.ok) return reverted;
        nextFastMode = false;
        if (settled.retireSession) {
          // Discard a fresh session whose Fast state could not be confirmed.
          try {
            await this.retire(target.id, { clearAcpSession: true,
              bindingChange: { source: "RuntimeTransition.configure", cause: settled.refusal } });
            retiredUnverifiedSession = true;
          } catch (err) {
            // A failed retirement must not confirm Fast is off.
            return {
              ok: false,
              error: fastModeRetirementFailure(
                err instanceof Error ? err.message : String(err)
              ),
            };
          }
        }
      } else {
        warnings.push(FAST_MODE_COST_WARNING);
      }
    }

    const current = this.deps.store.get(target.id);
    if (!current) return { ok: false, error: "Target session disappeared after configuration." };
    const threadIdentityUpdated = await this.applyNaming(current);
    const effectiveIdentity = identityFromDescription(this.deps.router.describeConfig(current),
      inheritSelection ? catalogModel?.effort.selectionDefault : undefined);
    const changes = diffIdentity(beforeIdentity, effectiveIdentity);
    return {
      ok: true,
      verification: selection.verification,
      applied: effectiveIdentity,
      changes,
      sessionReset: reset.sessionReset,
      ...(reset.resetReason ? { resetReason: reset.resetReason } : {}),
      ...(reset.sessionReset &&
      !retiredUnverifiedSession &&
      (newSessionId ?? runtime.getSessionInfo()?.sessionId)
        ? { newSessionId: newSessionId ?? runtime.getSessionInfo()!.sessionId }
        : {}),
      runtimeReloaded,
      threadIdentityUpdated,
      warnings,
    };
  }

  /**
   * Make a cross-thread set authoritative at the thread layer (so channel and
   * thread presets cannot silently shadow it), then mirror it into the session
   * record so legacy capability/status reads remain honest.
   */
  private applyTargetIdentity(
    target: SessionRecord,
    changes: TargetIdentityChanges,
    actor: MutationActor
  ): { ok: true } | { ok: false; error: string } {
    return new ConfigApplyPlan({ mutation: this.deps.mutation, store: this.deps.store }).applyTargetIdentity(target, changes, actor);
  }

  private captureSelection(record: SessionRecord, channel: ChannelRef, describedBefore: ConfigDescription, kind: "agent" | "model") {
    const sessionBefore = { ...(this.store.get(record.id) ?? record) };
    const overlayBefore = this.configMutation.readThreadPresetEntry(threadPresetKey(channel.platform, channel.id));
    const originalEffective = {
      agent: describedBefore.agent.value,
      model: describedBefore.model.value,
      location: describedBefore.location.value,
    };

    const rollback = (cause: string): { acpRestored: boolean } => {
      const overlayRestored = this.configMutation.restoreThreadPresetEntry(
        threadPresetKey(channel.platform, channel.id),
        overlayBefore
      );
      this.store.upsert({ ...sessionBefore, updatedUtc: new Date().toISOString() });
      const now = this.store.get(sessionBefore.id) ?? sessionBefore;
      const described = this.router.describeConfig(now);
      const canRestoreAcp =
        Boolean(sessionBefore.acpSessionId) &&
        described.agent.value === originalEffective.agent &&
        described.model.value === originalEffective.model &&
        described.location.value === originalEffective.location;
      this.store.upsert({ ...now, acpSessionId: canRestoreAcp ? sessionBefore.acpSessionId : "", updatedUtc: new Date().toISOString() }, {
        source: "RuntimeTransition.captureSelection.rollback", cause: `${kind} selection rollback: ${cause}`,
      });
      if (canRestoreAcp) return { acpRestored: true };
      if (!overlayRestored.ok) {
        this.logger.warn(
          { err: overlayRestored.error, threadId: channel.id },
          `${kind}-switch overlay rollback failed; ACP id left cleared`
        );
      }
      return { acpRestored: false };
    };
    return { sessionBefore, rollback };
  }

  async applyModelChange(channel: ChannelRef, record: SessionRecord, id: string, actor: MutationActor, respond: (message: string) => Promise<void>): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
    const fail = async (error: string): Promise<{ ok: false; error: string }> => {
      await respond(error.startsWith("Could not") ? error : `Could not set model: ${error}`);
      return { ok: false, error };
    };

    record = this.store.get(record.id) ?? record;
    const describedBefore = this.router.describeConfig(record);
    const binding = {
      agentId: describedBefore.agent.value,
      location: describedBefore.location.value,
    };
    const selection = assessModelSelection(this.modelCatalog, binding, id);
    if (!selection.allowed) {
      return fail(
        `model ${JSON.stringify(id)} is unavailable in the cached catalog for ${binding.agentId}@${binding.location}`
      );
    }
    const selected = selection.model;
    const canonicalId = selection.id;
    const defaultEffort = selected?.effort.selectionDefault;
    const current = describedBefore.model.value;
    if (canonicalId === current) {
      await this.identityEffects.flush(record.id);
      const message = `🧠 Model already set to \`${canonicalId}\` (no change).`;
      await respond(message);
      return { ok: true, message };
    }

    const { sessionBefore, rollback } = this.captureSelection(record, channel, describedBefore, "model");

    const mismatchSuffix = (rolled: { acpRestored: boolean }): string =>
      rolled.acpRestored
        ? ""
        : " Previous ACP session was not restored because the effective model no longer matches.";

    try {
      const live = this.store.get(record.id) ?? record;
      const cfg = this.store.readConfig(live);
      cfg.model = canonicalId;
      cfg.reasoningEffort = defaultEffort;
      delete cfg.lastContextUsage;
      this.store.upsert({
        ...live,
        configJson: this.store.writeConfig(cfg),
        updatedUtc: new Date().toISOString(),
      });

      const overlay = this.configMutation.applyThreadOverlay({
        threadId: channel.id,
        ...(channel.platform !== "discord" ? { platform: channel.platform } : {}),
        ...(channel.parentId ? { parentRef: channel.parentId } : {}),
        changes: { model: canonicalId, effort: defaultEffort ?? null },
        actor,
      });
      if (!overlay.ok) {
        const rolled = rollback(overlay.error);
        this.logger.warn(
          { err: overlay.error, threadId: channel.id },
          "thread model overlay write failed; mutation rolled back"
        );
        return fail(`${overlay.error}${mismatchSuffix(rolled)}`);
      }

      const verified = this.store.get(live.id) ?? live;
      const described = this.router.describeConfig(verified);
      const spawn = this.router.planRuntimeSpawn(verified);
      if (described.model.value !== canonicalId || spawn.model !== (selected?.runtimeId ?? canonicalId)) {
        const rolled = rollback("effective configuration did not match the requested model");
        return fail(
          `the effective configuration did not match the requested model.${mismatchSuffix(rolled)}`
        );
      }

      let message: string;
      const effortDescription = defaultEffort === undefined ? "" : ` with effort \`${defaultEffort}\``;
      if (this.router.hasRuntime(verified.id)) {
        // Model and its discovered default effort are one transaction. Retire
        // the warm runtime so no live model switch can leave the old effort.
        await this.retire(verified.id);
        message = `🧠 Model will be \`${canonicalId}\`${effortDescription} on the next turn (session respawn).`;
      } else {
        message = `🧠 Model will be \`${canonicalId}\`${effortDescription} on the next turn.`;
      }
      if (selection.verification === "unverified") message += ` ${unverifiedModelWarning(canonicalId, binding)}`;

      await this.identityEffects.flush(record.id);
      await respond(message);
      return { ok: true, message };
    } catch (err) {
      const rolled = rollback(err instanceof Error ? err.message : String(err));
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn({ err, threadId: channel.id }, "model switch threw; mutation rolled back");
      return fail(`${detail}${mismatchSuffix(rolled)}`);
    }
  }

  async applyAgentChange(channel: ChannelRef, record: SessionRecord, id: string, actor: MutationActor, respond: (message: string) => Promise<void>): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
    const parsed = parseAgentAtLocation(id);
    const fail = async (error: string): Promise<{ ok: false; error: string }> => {
      await respond(error.startsWith("Could not") ? error : `Could not switch agent: ${error}`);
      return { ok: false, error };
    };
    // Re-read after picker latency (or any concurrent command) so the write is
    // constructed from the live row, not the pre-picker snapshot.
    record = this.store.get(record.id) ?? record;
    const describedBefore = this.router.describeConfig(record);
    const currentLocation = resolveThreadLocation(this.config, channel.id);
    const nextLocation = parsed.explicit ? parsed.location : currentLocation;
    const profile = this.router.getProfile(parsed.agentId, nextLocation);
    if (!profile) {
      return fail(
        this.refuseUnregisteredAgent(parsed.agentId, `Unknown agent \`${parsed.agentId}\` at \`${nextLocation}\`.`)
      );
    }
    const sameAgent = describedBefore.agent.value === parsed.agentId;
    const sameLocation = currentLocation === nextLocation;
    if (sameAgent && sameLocation) {
      await this.identityEffects.flush(record.id);
      const msg = `Agent is already \`${formatAgentAtLocation(parsed.agentId, nextLocation)}\`.`;
      await respond(msg);
      return { ok: true, message: msg };
    }

    const { sessionBefore, rollback } = this.captureSelection(record, channel, describedBefore, "agent");

    try {
      const live = this.store.get(record.id) ?? record;
      const cfg = this.store.readConfig(live);
      const nextBinding = { agentId: parsed.agentId, location: nextLocation };
      const inherited = this.router.describeConfig(record, { inherit: true, agent: parsed.agentId, location: nextLocation });
      if (!sameAgent) {
        delete cfg.model;
        delete cfg.reasoningEffort;
        delete cfg.lastContextUsage;
      }
      const intendedModel = sameAgent ? describedBefore.model.value : inherited.model.value;
      const intendedEntry = this.modelCatalog.model(nextBinding, intendedModel);
      if (!intendedEntry) {
        throw new Error(`model ${intendedModel} is unavailable in the cached catalog for ${parsed.agentId}@${nextLocation}`);
      }
      const intendedSelection = this.modelCatalog.resolve(nextBinding, {
        model: intendedModel,
        effort: (sameAgent ? describedBefore.effort.value : inherited.effort.value) ?? undefined,
      });
      this.store.upsert({
        ...live,
        agentId: parsed.agentId,
        configJson: this.store.writeConfig(cfg),
        updatedUtc: new Date().toISOString(),
      });

      if (!sameLocation) {
        const written = this.configMutation.applyThreadLocation({
          threadId: channel.id,
          ...(channel.platform !== "discord" ? { platform: channel.platform } : {}),
          ...(channel.parentId ? { parentRef: channel.parentId } : {}),
          location: nextLocation,
          actor,
        });
        if (!written.ok) {
          const rolled = rollback(written.error);
          const suffix = rolled.acpRestored
            ? ""
            : " Previous ACP session was not restored because the effective agent/model/location no longer match.";
          return fail(`${written.error}${suffix}`);
        }
      }

      const overlay = this.configMutation.applyThreadOverlay({
        threadId: channel.id,
        ...(channel.platform !== "discord" ? { platform: channel.platform } : {}),
        ...(channel.parentId ? { parentRef: channel.parentId } : {}),
        changes: {
          agent: parsed.agentId,
          ...(!sameAgent ? { model: null, effort: null } : {}),
        },
        actor,
      });
      if (!overlay.ok) {
        const rolled = rollback(overlay.error);
        const suffix = rolled.acpRestored
          ? ""
          : " Previous ACP session was not restored because the effective agent/model/location no longer match.";
        this.logger.warn(
          { err: overlay.error, threadId: channel.id },
          "thread agent overlay write failed; mutation rolled back"
        );
        return fail(`${overlay.error}${suffix}`);
      }

      const verified = this.store.get(live.id) ?? live;
      const described = this.router.describeConfig(verified);
      const spawn = this.router.planRuntimeSpawn(verified);
      if (
        described.agent.value !== parsed.agentId ||
        described.model.value !== intendedModel ||
        spawn.agentId !== parsed.agentId ||
        spawn.model !== intendedSelection.raw.model ||
        spawn.effort !== intendedSelection.raw.effort
      ) {
        const rolled = rollback("effective configuration did not match the requested agent/model/location");
        const suffix = rolled.acpRestored
          ? ""
          : " Previous ACP session was not restored because the effective agent/model/location no longer match.";
        return fail(
          `the effective configuration did not match the requested selection ` +
          `(wanted ${parsed.agentId}@${nextLocation}/${intendedModel}/${intendedSelection.normalized.effort}; ` +
          `got ${described.agent.value}@${described.location.value}/${described.model.value}/` +
          `${described.effort.value ?? "default"}, runtime ${spawn.agentId}/${spawn.model}/${spawn.effort ?? "default"}).${suffix}`
        );
      }

      // A refused overlay must leave the old runtime and binding untouched.
      await this.retire(verified.id);
      const committed = this.store.get(verified.id) ?? verified;
      this.store.upsert({ ...committed, acpSessionId: "", updatedUtc: new Date().toISOString() }, {
        source: "RuntimeTransition.applyAgentChange", cause: `operator selected ${parsed.agentId}@${nextLocation}`,
      });
      bindSessionLocation(this.bridgeHub, verified.id, nextLocation);
      // The switch is now committed. Settling earlier would cancel old-session
      // work even when validation failed and rollback restored that session.
      this.store.turnAttempts.settleOperatorSessionReplacement(
        channel.id,
        sessionBefore.acpSessionId
      );
      await this.identityEffects.flush(record.id);
      const at = formatAgentAtLocation(parsed.agentId, nextLocation);
      const message = `🤖 Agent switched to \`${at}\` (${profile.displayName}), model \`${intendedModel}\`. Next message will start a fresh session.`;
      await respond(message);
      return { ok: true, message };
    } catch (err) {
      const rolled = rollback(err instanceof Error ? err.message : String(err));
      const detail = err instanceof Error ? err.message : String(err);
      const suffix = rolled.acpRestored
        ? ""
        : " Previous ACP session was not restored because the effective agent/model/location no longer match.";
      this.logger.warn({ err, threadId: channel.id }, "agent switch threw; mutation rolled back");
      return fail(`${detail}${suffix}`);
    }
  }

  async applyEffortChange(
    record: SessionRecord,
    level: string
  ): Promise<void> {
    const cfg = this.store.readConfig(record);
    cfg.reasoningEffort = level;
    this.persistConfig(record, cfg);
    const overlay = this.configMutation.applyThreadOverlay({
      threadId: record.channelRef,
      ...(record.platform !== "discord" ? { platform: record.platform } : {}),
      ...(record.parentRef ? { parentRef: record.parentRef } : {}),
      changes: { effort: level },
      actor: { id: null, name: null },
    });
    if (!overlay.ok) {
      this.logger.warn(
        { err: overlay.error, threadId: record.channelRef },
        "thread effort overlay write failed"
      );
    }
    // Effort is applied when the session is (re)built, per the agent's
    // mechanism: Claude via `_meta.claudeCode.options.effort` (set_config_option
    // for "effort" errors there); Copilot via the `reasoning_effort` config
    // option (AgentRuntime.applyConfigOptionEffort). Invalidate so the next turn
    // rebuilds with the new effort; preserve the ACP session id for context.
    if (this.router.hasRuntime(record.id)) {
      await this.retire(record.id, { clearAcpSession: false });
    }
    await this.identityEffects.flush(record.id);
  }

  async reset(target: SessionRecord): Promise<ResetThreadSessionOutcome> {
    const before = this.deps.router.describeConfig(target);
    const previous = this.deps.store.get(target.id) ?? target;
    let forged;
    try {
      forged = await this.forgeFreshSession(target.id, "operator requested fresh session reset");
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      const restored = this.deps.store.compareAndSwapAcpSession(target.id, "", previous.acpSessionId,
        { source: "RuntimeTransition.reset", cause: `fresh reset failed: ${cause}` });
      journal.warn({ sessionId: target.id, previousAcpSessionId: previous.acpSessionId, cause, restored },
        restored ? "fresh session replacement failed; restored previous binding"
          : "fresh session replacement failed; retained current binding");
      throw error;
    }
    const sessionId = forged.runtime.getSessionInfo()?.sessionId;
    if (!sessionId) return { ok: false, error: "Fresh runtime did not report a session id." };
    await this.deps.identityCommitted?.(target.id);
    return {
      ok: true,
      sessionReset: true,
      newSessionId: sessionId,
      agent: before.agent.value,
      model: before.model.value,
    };
  }

  private async forgeFreshSession(
    sessionId: string, cause: string
  ): Promise<{ record: SessionRecord; runtime: SessionControlRuntime }> {
    await this.retire(sessionId, { operatorIntent: "replace-session" });
    const current = this.deps.store.get(sessionId);
    if (!current) throw new Error("Target session disappeared while resetting.");
    this.deps.store.upsert({
      ...current,
      acpSessionId: "",
      updatedUtc: new Date().toISOString(),
    }, { source: "RuntimeTransition.forgeFreshSession", cause });
    const fresh = this.deps.store.get(sessionId);
    if (!fresh) throw new Error("Target session disappeared while forging its replacement.");
    try {
      const runtime = await this.deps.router.getOrStartRuntime(fresh);
      return { record: fresh, runtime };
    } catch (error) {
      journal.warn({ sessionId, previousAcpSessionId: current.acpSessionId,
        cause: error instanceof Error ? error.message : String(error) }, "fresh session replacement failed");
      throw error;
    }
  }

  private async applyNaming(record: SessionRecord): Promise<boolean> {
    await this.deps.identityCommitted?.(record.id);
    return this.deps.store.get(record.id)?.namePrefix != null;
  }
}

function unverifiedModelWarning(model: string, binding: CatalogBinding): string {
  return `Model ${JSON.stringify(model)} is unverified for ${binding.agentId}@${binding.location}; the provider will validate the typed id.`;
}

function normalizeEffort(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizeStoredEffort(value: string | undefined): string | undefined {
  return !value || value === "default" || value === "auto" ? undefined : value;
}

function identityFromDescription(value: ConfigDescription, defaultEffort = "auto"): ThreadConfigurationIdentity {
  return {
    agent: value.agent.value,
    model: value.model.value,
    effort: value.effort.value ?? defaultEffort,
    role: value.role?.value ?? "auto",
    disableThreadPrefix: value.disableThreadPrefix?.value ?? false,
    fastMode: value.fastMode?.value ?? false,
  };
}

function diffIdentity(
  before: ThreadConfigurationIdentity,
  after: ThreadConfigurationIdentity
): ThreadConfigurationChanges {
  const field = (from: string, to: string): ThreadConfigurationFieldChange => ({
    before: from,
    after: to,
    changed: from !== to,
  });
  return {
    agent: field(before.agent, after.agent),
    model: field(before.model, after.model),
    effort: field(before.effort, after.effort),
    role: field(before.role, after.role),
    disableThreadPrefix: field(
      before.disableThreadPrefix ? "disabled" : "enabled",
      after.disableThreadPrefix ? "disabled" : "enabled"
    ),
    fastMode: field(
      before.fastMode ? FAST_MODE_ON : "off",
      after.fastMode ? FAST_MODE_ON : "off"
    ),
  };
}

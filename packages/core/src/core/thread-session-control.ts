import type { AgentProfile } from "@seam/adapters";
import {
  detectSessionReset,
  type AppliedSessionConfig,
  type SessionConfigChanges,
} from "./config-mutation.js";
import type { ConfigDescription } from "./session-router.js";
import type { SessionConfigState, SessionRecord } from "./types.js";

export interface ConfigureThreadInput {
  agent?: string;
  model?: string;
  effort?: string;
  /** Free-form naming role; empty/auto clears the session override. */
  role?: string;
  /** Thread-local automatic naming opt-out. False re-enables future exact passes. */
  disableThreadPrefix?: boolean;
}

export interface MigrateSelfInput extends Omit<ConfigureThreadInput, "role"> {
  manifest: string;
}

/** Durable, validated target carried by the post-turn dispatch. */
export interface PreparedSelfMigration {
  agent: string;
  model: string;
  effort?: string;
  previousAgent: string;
  previousModel: string;
  previousSessionId: string;
}

export type PrepareSelfMigrationOutcome =
  | { ok: true; migration: PreparedSelfMigration }
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
  ok: true;
  /** Exact effective identity after the operation. Never a partial/vague diff. */
  applied: ThreadConfigurationIdentity;
  /** Exact before/after status for every identity field, including no-ops. */
  changes: ThreadConfigurationChanges;
  sessionReset: boolean;
  resetReason?: "agent-switch" | "model-switch";
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
  setModel(modelId: string): Promise<void>;
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
    upsert(record: SessionRecord): void;
  };
  router: {
    describeConfig(record: SessionRecord): ConfigDescription;
    getProfile(agentId: string): AgentProfile | undefined;
    getOrStartRuntime(record: SessionRecord): Promise<SessionControlRuntime>;
    invalidate(
      sessionId: string,
      opts?: { clearAcpSession?: boolean; clearStartFailure?: boolean }
    ): Promise<void>;
  };
  mutation: SessionConfigMutation & {
    applyThreadOverlay(opts: {
      threadId: string;
      parentRef?: string;
      changes: {
        agent?: string | null;
        model?: string | null;
        effort?: string | null;
        role?: string | null;
        disableThreadPrefix?: boolean | null;
      };
      actor: { id: string | null; name: string | null };
    }): { ok: true; message: string; auditId: string } | { ok: false; error: string };
  };
  /** Single naming funnel, injected by the Discord integration layer. */
  applyThreadName?: (record: SessionRecord) => Promise<unknown>;
}

/**
 * Immediate session control behind seam-MCP's same-channel addressing gate.
 * The mutation engine receives only the already-resolved target record, so its
 * ordinary caller-derived/self-scope API remains unchanged.
 */
export class ThreadSessionControlService {
  constructor(private readonly deps: ThreadSessionControlDeps) {}

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
    const requestedAgent = input.agent?.trim();
    if (input.agent !== undefined && !requestedAgent) {
      return { ok: false, error: "`agent` must be a non-empty string." };
    }
    const nextAgent = requestedAgent ?? before.agent.value;
    const profile = this.deps.router.getProfile(nextAgent);
    if (!profile) return { ok: false, error: `Unknown agent "${nextAgent}".` };

    const agentChanged = nextAgent !== before.agent.value;
    const requestedModel = input.model?.trim();
    if (input.model !== undefined && !requestedModel) {
      return { ok: false, error: "`model` must be a non-empty string." };
    }
    const nextModel = requestedModel ?? (agentChanged ? profile.defaultModel : before.model.value);
    if (!agentChanged && nextModel === before.model.value) {
      return {
        ok: false,
        error: "Migration requires a different agent or model; the requested target already matches.",
      };
    }

    const models = await this.advertisedModels(profile, target, agentChanged);
    if (models.length === 0) {
      return {
        ok: false,
        error: `Agent "${nextAgent}" did not advertise a model catalog; refusing an unvalidated model.`,
      };
    }
    if (!models.includes(nextModel)) {
      return {
        ok: false,
        error: `Model "${nextModel}" is not advertised by "${nextAgent}". Valid models: ${models.join(", ")}.`,
      };
    }

    const requestedEffort = normalizeEffort(input.effort);
    if (input.effort !== undefined && !requestedEffort) {
      return { ok: false, error: "`effort` must be a non-empty string or `auto`." };
    }

    return {
      ok: true,
      migration: {
        agent: nextAgent,
        model: nextModel,
        ...(requestedEffort ? { effort: requestedEffort } : {}),
        previousAgent: before.agent.value,
        previousModel: before.model.value,
        previousSessionId: target.acpSessionId,
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
    const stored = this.deps.store.readConfig(current);
    const desiredEffort = prepared.effort === "auto"
      ? undefined
      : prepared.effort ?? normalizeStoredEffort(stored.reasoningEffort);
    const warnings: string[] = [];

    try {
      const staged = this.deps.mutation.applySessionConfig(
        current,
        {
          ...(prepared.agent !== before.agent.value ? { agent: prepared.agent } : {}),
          model: prepared.model,
          effort: null,
        },
        { id: null, name: `seam-mcp:self:${current.channelRef}` }
      );
      if (!staged.ok) return staged;
      warnings.push(...staged.result.warnings);

      const effective = this.deps.router.describeConfig(
        this.deps.store.get(current.id) ?? current
      );
      if (effective.agent.value !== prepared.agent || effective.model.value !== prepared.model) {
        throw new Error(
          `Target is shadowed by configuration: effective ${effective.agent.value}/${effective.model.value}.`
        );
      }

      const forged = await this.forgeFreshSession(current.id);
      const effortValues = forged.runtime.getConfigSelectValues("reasoning_effort");
      let appliedEffort = "auto";
      if (desiredEffort && effortValues.includes(desiredEffort)) {
        await forged.runtime.setConfigOption("reasoning_effort", desiredEffort);
        const effortApplied = this.deps.mutation.applySessionConfig(
          forged.record,
          { effort: desiredEffort },
          { id: null, name: `seam-mcp:self:${current.channelRef}` },
          { effortValues }
        );
        if (!effortApplied.ok) throw new Error(effortApplied.error);
        warnings.push(...effortApplied.result.warnings);
        appliedEffort = desiredEffort;
      } else if (desiredEffort) {
        warnings.push(
          `Effort "${desiredEffort}" is not advertised for ${prepared.agent}/${prepared.model}; ` +
            `using auto. Valid values: ${effortValues.length ? effortValues.join(", ") : "none"}.`
        );
      }

      const info = forged.runtime.getSessionInfo();
      if (!info?.sessionId) throw new Error("Fresh runtime did not report a session id.");
      const fresh = this.deps.store.get(current.id);
      if (!fresh) throw new Error("Calling session disappeared after migration.");
      await this.deps.applyThreadName?.(fresh);
      return {
        ok: true,
        record: fresh,
        agent: prepared.agent,
        model: prepared.model,
        effort: appliedEffort,
        newSessionId: info.sessionId,
        warnings,
      };
    } catch (err) {
      // A candidate runtime may already exist. Retire it before restoring the
      // old durable session so no process can keep writing stale target state.
      await this.deps.router.invalidate(current.id, { clearStartFailure: true }).catch(() => {});
      this.deps.store.upsert(snapshot);
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async configure(
    caller: SessionRecord,
    target: SessionRecord,
    input: ConfigureThreadInput
  ): Promise<ConfigureThreadOutcome> {
    const supplied = input.agent !== undefined || input.model !== undefined || input.effort !== undefined || input.role !== undefined || input.disableThreadPrefix !== undefined;
    if (!supplied) return { ok: false, error: "Provide at least one of agent, model, effort, role, or disableThreadPrefix." };

    const before = this.deps.router.describeConfig(target);
    const previousAgentId = before.agent.value;
    const requestedAgent = input.agent?.trim();
    if (input.agent !== undefined && !requestedAgent) {
      return { ok: false, error: "`agent` must be a non-empty string." };
    }
    const nextAgentId = requestedAgent ?? previousAgentId;
    const profile = this.deps.router.getProfile(nextAgentId);
    if (!profile) return { ok: false, error: `Unknown agent "${nextAgentId}".` };

    const agentChanged = nextAgentId !== previousAgentId;
    const requestedModel = input.model?.trim();
    if (input.model !== undefined && !requestedModel) {
      return { ok: false, error: "`model` must be a non-empty string." };
    }
    const nextModel = requestedModel ?? (agentChanged ? profile.defaultModel : before.model.value);
    const modelChanged = nextModel !== before.model.value;

    if (requestedModel) {
      const models = await this.advertisedModels(profile, target, agentChanged);
      if (models.length === 0) {
        return {
          ok: false,
          error: `Agent "${nextAgentId}" did not advertise a model catalog; refusing an unvalidated model.`,
        };
      }
      if (!models.includes(requestedModel)) {
        return {
          ok: false,
          error: `Model "${requestedModel}" is not advertised by "${nextAgentId}". Valid models: ${models.join(", ")}.`,
        };
      }
    }

    const requestedEffort = normalizeEffort(input.effort);
    if (input.effort !== undefined && !requestedEffort) {
      return { ok: false, error: "`effort` must be a non-empty string or `auto`." };
    }
    const effortMechanism = profile.effort?.mechanism ?? "none";
    const staticEffortValues = profile.effort?.levels ?? [];
    let desiredEffort = requestedEffort === "auto"
      ? undefined
      : requestedEffort ?? normalizeStoredEffort(before.effort.value ?? undefined);
    const requestedRole = input.role?.trim();
    const nextRole = input.role === undefined
      ? undefined
      : !requestedRole || requestedRole.toLowerCase() === "auto"
        ? null
        : requestedRole;
    const nextDisableThreadPrefix = input.disableThreadPrefix
      ?? before.disableThreadPrefix?.value
      ?? false;
    const reset = detectSessionReset({ previousAgentId, nextAgentId, modelChanged });
    const warnings: string[] = [];
    const effortTouched = input.effort !== undefined || modelChanged || agentChanged;
    if (
      desiredEffort &&
      (effortMechanism === "none" ||
        effortMechanism === "modelBaked" ||
        !staticEffortValues.includes(desiredEffort))
    ) {
      warnings.push(
        `Effort "${desiredEffort}" is not supported for ${nextAgentId}/${nextModel}; ` +
          `using auto. Valid values: ${staticEffortValues.length ? staticEffortValues.join(", ") : "none"}.`
      );
      desiredEffort = undefined;
    }

    const beforeIdentity = identityFromDescription(before);
    const plannedIdentity: ThreadConfigurationIdentity = {
      agent: nextAgentId,
      model: nextModel,
      effort: desiredEffort ?? "auto",
      role: input.role === undefined ? before.role.value ?? "auto" : nextRole ?? "auto",
      disableThreadPrefix: nextDisableThreadPrefix,
    };
    const plannedChanges = diffIdentity(beforeIdentity, plannedIdentity);

    // A successful set is still useful when it is a no-op: return the complete
    // identity with explicit `(no change)` state and do not perturb the runtime.
    if (
      !plannedChanges.agent.changed &&
      !plannedChanges.model.changed &&
      !plannedChanges.effort.changed &&
      !plannedChanges.role.changed &&
      !plannedChanges.disableThreadPrefix.changed
    ) {
      const threadIdentityUpdated = await this.applyNaming(target);
      return {
        ok: true,
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
        ...(modelChanged || agentChanged ? { model: nextModel } : {}),
        ...(effortTouched ? { effort: desiredEffort ?? null } : {}),
        ...(input.role !== undefined ? { role: nextRole } : {}),
        ...(input.disableThreadPrefix !== undefined
          ? { disableThreadPrefix: input.disableThreadPrefix }
          : {}),
      },
      actor
    );
    if (!persisted.ok) return persisted;

    const onlyNaming = (input.role !== undefined || input.disableThreadPrefix !== undefined)
      && input.agent === undefined
      && input.model === undefined
      && input.effort === undefined;
    if (onlyNaming) {
      const current = this.deps.store.get(target.id);
      if (!current) return { ok: false, error: "Target session disappeared after configuration." };
      const threadIdentityUpdated = await this.applyNaming(current);
      const effectiveIdentity = identityFromDescription(this.deps.router.describeConfig(current));
      return {
        ok: true,
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

    if (reset.sessionReset) {
      const forged = await this.forgeFreshSession(target.id);
      runtime = forged.runtime;
      newSessionId = runtime.getSessionInfo()?.sessionId;
    } else if (
      plannedChanges.effort.changed &&
      (effortMechanism === "meta" ||
        effortMechanism === "spawnArgs" ||
        desiredEffort === undefined)
    ) {
      // Meta/spawn effort is consumed while creating or loading the runtime,
      // not via set_config_option. `auto` likewise requires a reload to remove
      // a previously-live config option. Preserve the ACP session and context.
      await this.deps.router.invalidate(target.id, { clearAcpSession: false });
      const current = this.deps.store.get(target.id);
      if (!current) return { ok: false, error: "Target session disappeared while reloading effort." };
      runtime = await this.deps.router.getOrStartRuntime(current);
      runtimeReloaded = true;
    } else {
      const current = this.deps.store.get(target.id) ?? target;
      runtime = await this.deps.router.getOrStartRuntime(current);
      if (modelChanged) await runtime.setModel(nextModel);
    }

    // Config-option agents may advertise a model-dependent subset. Validate
    // against the live session before claiming success. Claude never enters
    // this branch: its effort is `_meta` and was applied by the reload above.
    if (effortTouched && desiredEffort && effortMechanism === "configOption") {
      const configId = profile.effort?.configId ?? "reasoning_effort";
      const liveValues = runtime.getConfigSelectValues(configId);
      if (liveValues.includes(desiredEffort)) {
        if (!reset.sessionReset || plannedChanges.effort.changed) {
          await runtime.setConfigOption(configId, desiredEffort);
        }
      } else {
        warnings.push(
          `Effort "${desiredEffort}" is not advertised by the live ${nextAgentId}/${nextModel} session; ` +
            `using auto. Valid values: ${liveValues.length ? liveValues.join(", ") : "none"}.`
        );
        desiredEffort = undefined;
        const cleared = this.applyTargetIdentity(
          this.deps.store.get(target.id) ?? target,
          { effort: null },
          actor
        );
        if (!cleared.ok) return cleared;
        await this.deps.router.invalidate(target.id, { clearAcpSession: false });
        const current = this.deps.store.get(target.id);
        if (!current) return { ok: false, error: "Target session disappeared while clearing effort." };
        runtime = await this.deps.router.getOrStartRuntime(current);
        runtimeReloaded = true;
      }
    }

    const current = this.deps.store.get(target.id);
    if (!current) return { ok: false, error: "Target session disappeared after configuration." };
    const threadIdentityUpdated = await this.applyNaming(current);
    const effectiveIdentity = identityFromDescription(this.deps.router.describeConfig(current));
    const changes = diffIdentity(beforeIdentity, effectiveIdentity);
    return {
      ok: true,
      applied: effectiveIdentity,
      changes,
      sessionReset: reset.sessionReset,
      ...(reset.resetReason ? { resetReason: reset.resetReason } : {}),
      ...(reset.sessionReset && (newSessionId ?? runtime.getSessionInfo()?.sessionId)
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
    changes: {
      agent?: string;
      model?: string;
      effort?: string | null;
      role?: string | null;
      disableThreadPrefix?: boolean;
    },
    actor: { id: string | null; name: string | null }
  ): { ok: true } | { ok: false; error: string } {
    const overlay = this.deps.mutation.applyThreadOverlay({
      threadId: target.channelRef,
      ...(target.parentRef ? { parentRef: target.parentRef } : {}),
      changes: {
        ...(changes.agent !== undefined ? { agent: changes.agent } : {}),
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
      },
      actor,
    });
    if (!overlay.ok) return overlay;

    const current = this.deps.store.get(target.id) ?? target;
    const cfg = this.deps.store.readConfig(current);
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
    this.deps.store.upsert({
      ...current,
      ...(changes.agent !== undefined ? { agentId: changes.agent } : {}),
      configJson: this.deps.store.writeConfig(cfg),
      updatedUtc: new Date().toISOString(),
    });
    return { ok: true };
  }

  async reset(target: SessionRecord): Promise<ResetThreadSessionOutcome> {
    const before = this.deps.router.describeConfig(target);
    const forged = await this.forgeFreshSession(target.id);
    const sessionId = forged.runtime.getSessionInfo()?.sessionId;
    if (!sessionId) return { ok: false, error: "Fresh runtime did not report a session id." };
    await this.deps.applyThreadName?.(forged.record);
    return {
      ok: true,
      sessionReset: true,
      newSessionId: sessionId,
      agent: before.agent.value,
      model: before.model.value,
    };
  }

  private async advertisedModels(
    profile: AgentProfile,
    target: SessionRecord,
    agentChanged: boolean
  ): Promise<string[]> {
    if (profile.staticModels?.length) return profile.staticModels.map((model) => model.modelId);
    if (profile.listPickerModels) {
      const models = await profile.listPickerModels();
      if (models.length) return models.map((model) => model.modelId);
    }
    if (agentChanged) return [];
    const runtime = await this.deps.router.getOrStartRuntime(target);
    return runtime.getSessionInfo()?.availableModels.map((model) => model.modelId) ?? [];
  }

  private async forgeFreshSession(
    sessionId: string
  ): Promise<{ record: SessionRecord; runtime: SessionControlRuntime }> {
    await this.deps.router.invalidate(sessionId);
    const current = this.deps.store.get(sessionId);
    if (!current) throw new Error("Target session disappeared while resetting.");
    this.deps.store.upsert({
      ...current,
      acpSessionId: "",
      updatedUtc: new Date().toISOString(),
    });
    const fresh = this.deps.store.get(sessionId);
    if (!fresh) throw new Error("Target session disappeared while forging its replacement.");
    const runtime = await this.deps.router.getOrStartRuntime(fresh);
    return { record: fresh, runtime };
  }

  private async applyNaming(record: SessionRecord): Promise<boolean> {
    const result = await this.deps.applyThreadName?.(record);
    return !(
      result &&
      typeof result === "object" &&
      "status" in result &&
      (result as { status?: unknown }).status === "unmanaged"
    );
  }
}

function normalizeEffort(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizeStoredEffort(value: string | undefined): string | undefined {
  return !value || value === "default" || value === "auto" ? undefined : value;
}

function identityFromDescription(value: ConfigDescription): ThreadConfigurationIdentity {
  return {
    agent: value.agent.value,
    model: value.model.value,
    effort: value.effort.value ?? "auto",
    role: value.role?.value ?? "auto",
    disableThreadPrefix: value.disableThreadPrefix?.value ?? false,
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
  };
}

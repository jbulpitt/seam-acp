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
}

export interface MigrateSelfInput extends ConfigureThreadInput {
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
  applied: { agent?: string; model?: string; effort?: string };
  sessionReset: boolean;
  resetReason?: "agent-switch" | "model-switch";
  newSessionId?: string;
  warnings: string[];
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
  mutation: SessionConfigMutation;
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
    const supplied = input.agent !== undefined || input.model !== undefined || input.effort !== undefined;
    if (!supplied) return { ok: false, error: "Provide at least one of agent, model, or effort." };

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

    const stored = this.deps.store.readConfig(target);
    const requestedEffort = normalizeEffort(input.effort);
    if (input.effort !== undefined && !requestedEffort) {
      return { ok: false, error: "`effort` must be a non-empty string or `auto`." };
    }
    const desiredEffort = requestedEffort === "auto"
      ? undefined
      : requestedEffort ?? normalizeStoredEffort(stored.reasoningEffort);
    const reset = detectSessionReset({ previousAgentId, nextAgentId, modelChanged });
    const warnings: string[] = [];
    let runtime: SessionControlRuntime;
    let freshTarget = target;

    if (reset.sessionReset) {
      // Start the replacement session at backend defaults. Only after session/new
      // exposes the target model's live effort values may we send an effort.
      const staged: SessionConfigChanges = {
        ...(agentChanged ? { agent: nextAgentId } : {}),
        ...(modelChanged || agentChanged ? { model: nextModel } : {}),
        effort: null,
      };
      const applied = this.deps.mutation.applySessionConfig(
        target,
        staged,
        { id: null, name: `seam-mcp:${caller.channelRef}` }
      );
      if (!applied.ok) return applied;
      warnings.push(...applied.result.warnings);
      const forged = await this.forgeFreshSession(target.id);
      freshTarget = forged.record;
      runtime = forged.runtime;
    } else {
      runtime = await this.deps.router.getOrStartRuntime(target);
      if (modelChanged) await runtime.setModel(nextModel);
    }

    const effortTouched = input.effort !== undefined || modelChanged || agentChanged;
    const effortValues = runtime.getConfigSelectValues("reasoning_effort");
    let appliedEffort: string | undefined;
    let persistedEffort: string | null | undefined;
    if (effortTouched) {
      if (desiredEffort && effortValues.includes(desiredEffort)) {
        await runtime.setConfigOption("reasoning_effort", desiredEffort);
        appliedEffort = desiredEffort;
        persistedEffort = desiredEffort;
      } else {
        appliedEffort = "auto";
        persistedEffort = null;
        if (desiredEffort) {
          warnings.push(
            `Effort "${desiredEffort}" is not advertised for ${nextAgentId}/${nextModel}; ` +
              `using auto. Valid values: ${effortValues.length ? effortValues.join(", ") : "none"}.`
          );
        }
      }
    }

    if (!reset.sessionReset) {
      const changes: SessionConfigChanges = {
        ...(agentChanged ? { agent: nextAgentId } : {}),
        ...(modelChanged ? { model: nextModel } : {}),
        ...(persistedEffort !== undefined ? { effort: persistedEffort } : {}),
      };
      const applied = this.deps.mutation.applySessionConfig(
        target,
        changes,
        { id: null, name: `seam-mcp:${caller.channelRef}` },
        { effortValues }
      );
      if (!applied.ok) return applied;
      warnings.push(...applied.result.warnings);
    } else if (persistedEffort !== undefined && persistedEffort !== null) {
      const applied = this.deps.mutation.applySessionConfig(
        freshTarget,
        { effort: persistedEffort },
        { id: null, name: `seam-mcp:${caller.channelRef}` },
        { effortValues }
      );
      if (!applied.ok) return applied;
      warnings.push(...applied.result.warnings);
    }

    const info = runtime.getSessionInfo();
    return {
      ok: true,
      applied: {
        ...(agentChanged ? { agent: nextAgentId } : {}),
        ...(modelChanged || agentChanged ? { model: nextModel } : {}),
        ...(effortTouched && appliedEffort ? { effort: appliedEffort } : {}),
      },
      sessionReset: reset.sessionReset,
      ...(reset.resetReason ? { resetReason: reset.resetReason } : {}),
      ...(reset.sessionReset && info?.sessionId ? { newSessionId: info.sessionId } : {}),
      warnings,
    };
  }

  async reset(target: SessionRecord): Promise<ResetThreadSessionOutcome> {
    const before = this.deps.router.describeConfig(target);
    const forged = await this.forgeFreshSession(target.id);
    const sessionId = forged.runtime.getSessionInfo()?.sessionId;
    if (!sessionId) return { ok: false, error: "Fresh runtime did not report a session id." };
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
}

function normalizeEffort(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizeStoredEffort(value: string | undefined): string | undefined {
  return !value || value === "default" || value === "auto" ? undefined : value;
}

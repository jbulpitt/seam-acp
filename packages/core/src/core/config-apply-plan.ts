import { resolveThreadLocation } from "../config.js";
import type { Config } from "../config.js";
import type { ChannelRef } from "../platforms/chat-adapter.js";
import type { Logger } from "../lib/logger.js";
import type { SessionStore } from "./session-store.js";
import type { SessionRouter } from "./session-router.js";
import type { BridgeHub } from "./bridge-hub.js";
import type { ModelCatalogService } from "./model-catalog/service.js";
import type { SessionControlRuntime, ThreadSessionControlDeps } from "./runtime-transition.js";
import { RuntimeTransition } from "./runtime-transition.js";
import { type ConfigMutationService, type ConfigMutationInput, type ConfigProposal, type MutationActor, type ConfigMutationTier, type ProposedField } from "./config-mutation.js";
import { parseSimpleCardGif, type SessionRecord, type SessionConfigState, type PermissionPolicyMode, type StatusCardStyle, type Preset } from "./types.js";
import { parseAgentAtLocation } from "./location.js";
import { bindSessionLocation } from "./location-bind.js";
import { buildSavePlan, fastModeWillResetSession, willVerifyFastMode, type ThreadConfigDraft } from "../platforms/discord/config-editor.js";
import { FAST_MODE_CONFIG_ID, settleFastMode, fastModeRetirementFailure } from "./fast-mode.js";

export interface TargetIdentityChanges {
  agent?: string;
  model?: string;
  effort?: string | null;
  role?: string | null;
  disableThreadPrefix?: boolean;
  fastMode?: boolean;
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
  json: string | null;
  rebuild: boolean;
  values: Record<ConfigSetFieldName, string | null>;
  supplied: ConfigSetFieldName[];
};
export type PreparedConfigSet =
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
    };


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
  restoreThreadPresetEntry(...args: Parameters<ConfigMutationService["restoreThreadPresetEntry"]>) { return this.configMutation.restoreThreadPresetEntry(...args); }

  applyTargetIdentity(
    target: SessionRecord,
    changes: TargetIdentityChanges,
    actor: { id: string | null; name: string | null }
  ): { ok: true } | { ok: false; error: string } {
    const overlay = this.mutation.applyThreadOverlay({
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
        // #37: thread-preset only — there is no session-config mirror to keep
        // in sync, so the overlay below is the single source of truth.
        ...(changes.fastMode !== undefined ? { fastMode: changes.fastMode } : {}),
      },
      actor,
    });
    if (!overlay.ok) return overlay;

    const current = this.store.get(target.id) ?? target;
    const cfg = this.store.readConfig(current);
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
    let sessionBefore: SessionRecord | undefined;
    let overlayBefore: unknown | undefined;
    let mutationStarted = false;
    const rollback = (): string => {
      if (!mutationStarted || !sessionBefore) return "";
      const restored = this.configMutation.restoreThreadPresetEntry(channel.id, overlayBefore);
      this.store.upsert(sessionBefore);
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
      overlayBefore = this.configMutation.readThreadPresetEntry(channel.id);

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
        cfg.model = prepared.model;
        if (request.values.model !== null || agentChanged) delete cfg.lastContextUsage;
        if (prepared.pinnedEffort !== undefined) cfg.reasoningEffort = prepared.pinnedEffort;
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
        this.store.upsert(updated);

        const overlayChanges: { agent?: string; model?: string; effort?: string | null; location?: string } = {};
        if (request.values.agent !== null) {
          overlayChanges.agent = appliedAgentId;
          overlayChanges.model = prepared.model;
          if (prepared.parsedAgent?.explicit) overlayChanges.location = prepared.nextLocation;
        } else if (request.values.model !== null) {
          overlayChanges.model = prepared.model;
        }
        if (prepared.pinnedEffort !== undefined) overlayChanges.effort = prepared.pinnedEffort;
        if (Object.keys(overlayChanges).length > 0) {
          const overlaid = this.configMutation.applyThreadOverlay({
            threadId: channel.id,
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
        rollbackError = rollback();
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

    // Agent change first — mirrors applyAgentChange(): kill the runtime, reset
    // the model to the new agent's default, and clear the ACP session id so the
    // next message starts fresh against the new backend.
    if (preset.agentId && preset.agentId !== record.agentId) {
      const binding = {
        agentId: preset.agentId,
        location: resolveThreadLocation(this.config, channel.id),
      };
      const profile = this.router.getProfile(preset.agentId, binding.location);
      if (!profile) {
        notes.push(
          `⚠️ ${this.refuseUnregisteredAgent(preset.agentId, `Unknown agent \`${preset.agentId}\``)} — agent left unchanged.`
        );
      } else {
        const catalogDefault = this.modelCatalog.models(binding, { includeHidden: true }).find((model) => model.default);
        if (!catalogDefault) {
          notes.push(`⚠️ Catalog for \`${preset.agentId}@${binding.location}\` is warming/unavailable — agent left unchanged.`);
        } else {
          await this.runtime.retire(record.id);
          const cfg = this.store.readConfig(record);
          cfg.model = catalogDefault.id;
          cfg.reasoningEffort = catalogDefault.effort.selectionDefault;
          // Different agent → different context window; cached usage is invalid.
          cfg.lastContextUsage = undefined;
          this.store.upsert({
            ...record,
            agentId: preset.agentId,
            acpSessionId: "",
            configJson: this.store.writeConfig(cfg),
            updatedUtc: new Date().toISOString(),
          });
          record = this.store.get(record.id) ?? record;
          changes.push(
            `Agent → \`${preset.agentId}\` (model \`${catalogDefault.id}\`, effort \`${catalogDefault.effort.selectionDefault}\`)`
          );
        }
      }
    }

    const cfg = this.store.readConfig(record);
    const binding = {
      agentId: record.agentId,
      location: resolveThreadLocation(this.config, channel.id),
    };

    if (preset.model) {
      const catalogModel = this.modelCatalog.model(binding, preset.model);
      if (!catalogModel) {
        notes.push(`⚠️ Model \`${preset.model}\` skipped — unavailable in the cached catalog.`);
      } else {
      cfg.model = catalogModel.id;
      if (!preset.effort) cfg.reasoningEffort = catalogModel.effort.selectionDefault;
      // Usage was measured under the previous model — don't seed the panel with
      // mismatched numbers. The runtime invalidation below makes the new model
      // take effect on respawn (covers backends where setModel() is rejected).
      cfg.lastContextUsage = undefined;
      changes.push(`Model → \`${catalogModel.id}\``);
      if (!preset.effort) changes.push(`Effort → ${catalogModel.effort.selectionDefault}`);
      }
    }

    if (preset.effort) {
      // Gate on the *effective* agent's capability, exactly like /seam effort —
      // otherwise the summary would claim a change that silently does nothing.
      const selectedModel = this.modelCatalog.model(binding, cfg.model ?? "default");
      const supported = selectedModel?.effort.choices.map((choice) => choice.id) ?? [];
      if (supported.includes(preset.effort)) {
        cfg.reasoningEffort = preset.effort;
        changes.push(`Effort → ${preset.effort}`);
      } else if (selectedModel?.effort.mechanism === "modelBaked") {
        notes.push(
          `⚠️ Effort \`${preset.effort}\` skipped — \`${record.agentId}\` bakes effort into the model choice.`
        );
      } else {
        notes.push(
          `⚠️ Effort \`${preset.effort}\` skipped — \`${record.agentId}\` has no settable reasoning effort.`
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

    // One write for config + repo. `acp_session_id` is assigned out-of-band, so
    // re-read the authoritative value rather than trusting the in-memory record
    // (see persistConfig) — unless the agent switch above deliberately cleared it.
    if (preset.repoPath) cfg.sessionCwdExplicit = true;
    const live = this.store.get(record.id)?.acpSessionId;
    this.store.upsert({
      ...record,
      ...(live ? { acpSessionId: live } : {}),
      ...(preset.repoPath ? { repoPath: preset.repoPath } : {}),
      configJson: this.store.writeConfig(cfg),
      updatedUtc: new Date().toISOString(),
    });
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

    const plan = buildSavePlan(draft);
    const hasPreset = Object.keys(plan.threadPreset).length > 0;
    if (hasPreset) {
      const written = this.configMutation.applyThreadOverlay({
        threadId: draft.threadId,
        ...(draft.parentRef ? { parentRef: draft.parentRef } : {}),
        changes: plan.threadPreset,
        actor,
      });
      if (!written.ok) {
        return { ok: false as const, error: `Could not save: ${written.error}` };
      }
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
      });
      if (!written.ok) {
        return { ok: false as const, error: `Could not save: ${written.error}` };
      }
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
      const bound = this.settings!.store.getByChannel("discord", draft.threadId);
      if (bound) {
        await this.runtime
          .retire(bound.id, {
            clearAcpSession: true,
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
    }

    await this.identityEffects.flush(`discord:${draft.threadId}`);
    return { ok: true as const, draft, fastRefusal, fastRetireFailed };
  }
}


export interface ConfigFacadeEnvironment extends Omit<ConfigApplySettings, "runtime"> {
  store: SessionStore;
  mutation: ConfigMutationService;
  parkedSelectMessage: (id: string) => string | null;
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

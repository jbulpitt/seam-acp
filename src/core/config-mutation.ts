/**
 * Conversational configuration MUTATION (#58 P2 + P3).
 *
 * This is the security-critical half of #58. It turns a natural-language request
 * ("run this thread on Opus", "make me a reviewer preset") into a *proposed diff*
 * that a human must confirm before anything changes. It is platform-agnostic:
 * it computes and validates proposals and, on confirmation, applies them and
 * writes the audit ledger. The Discord layer renders the diff card and collects
 * the human click (D5); the seam-MCP tool layer enforces the channel lock (D2)
 * and resolves the caller's own scope (D3).
 *
 * Every method here honors the issue's decisions:
 *  - D3 self-scope: the caller is a `SessionRecord` resolved from the routing
 *    token; scope is derived from it, never from a caller-supplied thread id.
 *  - D5 propose-then-confirm: `buildProposal` is SIDE-EFFECT FREE — it writes
 *    nothing. Only `proposal.apply(actor)` mutates, and only the platform calls
 *    it after a human confirms.
 *  - D6 audit: `apply` writes one immutable `config_audit` row (actor / scope /
 *    before / after / correlation).
 *  - D7 validate Tier-C through `PresetsFileSchema`: a channel-presets.json write
 *    round-trips through the exact boot schema and is refused on failure, so a
 *    bad tool call can never become a boot-breaking outage.
 *  - Trap 1 (preset override wins): the apply result reports the EFFECTIVE value
 *    and which layer won — not the value written — so the model can't claim a
 *    change a channel/thread preset silently shadows.
 *  - Trap 2 (effort is agent-dependent): a requested effort the resolved agent
 *    can't honor is surfaced as a warning, never a false success.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PresetsFileSchema } from "../config.js";
import type { Logger } from "../lib/logger.js";
import type { AgentProfile } from "../agents/agent-profile.js";
import type { ConfigDescription } from "./session-router.js";
import { validateCron, describeCron } from "./scheduled-prompts/cron.js";
import type { ScheduledPrompt } from "./scheduled-prompts/types.js";
import type {
  ConfigAuditEntry,
  ConfigAuditInput,
  PermissionPolicyMode,
  Preset,
  SessionConfigState,
  SessionRecord,
} from "./types.js";

/** Config surface a single proposal touches. */
export type ConfigMutationTier =
  | "session"
  | "preset"
  | "channel-preset"
  | "thread-preset"
  | "schedule";

/** Tier A — the calling thread's own session config. */
export interface SessionConfigChanges {
  agent?: string;
  model?: string;
  /** `null` clears the session-level effort override. */
  effort?: string | null;
  cwd?: string;
  permission?: PermissionPolicyMode;
  /** ACP mode id (what `/seam mode` sets, e.g. an agent/plan/autopilot URI).
   *  `null` clears the session-level mode override. */
  mode?: string | null;
  /** Tool allowlist (`/seam tools allow`). Empty array or `null` clears it back
   *  to "all tools allowed". */
  availableTools?: string[] | null;
  /** Tool blocklist (`/seam tools exclude`). Empty array or `null` clears it. */
  excludedTools?: string[] | null;
}

/** Tier B — a preset in the calling thread's project scope.
 *
 *  `action` selects the operation: the default (undefined) upserts (create or
 *  update in place); `"delete"` removes the preset. Deletion is destructive, so
 *  it goes through the IDENTICAL confirm-card + audit path as any other mutation
 *  and records the full removed object in `before_json` (recoverable from the
 *  audit trail). `name` is always required — it is how the preset is targeted. */
export interface PresetChanges {
  /** undefined/"upsert" = create-or-update; "delete" = remove the named preset. */
  action?: "upsert" | "delete";
  name: string;
  agent?: string;
  model?: string;
  effort?: string | null;
  description?: string | null;
  permission?: PermissionPolicyMode;
  /** A preset worker's working directory — essential for a specialist that must
   *  run in a particular repo. `null` clears it (falls back to the caller's cwd). */
  repoPath?: string | null;
  /** Tool allowlist for the preset worker. `null`/empty clears it. */
  toolsAllow?: string[] | null;
  /** Tool blocklist for the preset worker. `null`/empty clears it. */
  toolsExclude?: string[] | null;
  /** The preset worker's identity/personality. IS injected: orchestrator prepends
   *  it as `<seam-worker-identity name="…">…</seam-worker-identity>` when the
   *  preset runs as a handoff/dispatch worker (#23). `null` clears it. */
  instructions?: string | null;
}

/** Tier C — the calling thread's OWN channel preset (channel-presets.json).
 *  A `null` value removes that field. `locked` is deliberately absent: the lock
 *  can never be changed through any tool (D2/P3), and cross-channel edits are
 *  structurally impossible because the target is always the caller's parent. */
export interface ChannelPresetChanges {
  agent?: string | null;
  model?: string | null;
  cwd?: string | null;
  effort?: string | null;
  rider?: string | null;
}

/** Tier C — the calling thread's OWN thread preset (channel-presets.json
 *  `threads` map, keyed on the caller's own thread id). Same fields as the
 *  channel branch; a `null` value removes that field. A thread preset OVERRIDES
 *  the channel preset per-field, so it is the right scope for a per-thread rider
 *  (#68): a channel-wide rider would leak across every sibling thread. `locked`
 *  is deliberately absent — it exists only on channel entries and can never be
 *  changed through any tool; cross-thread edits are structurally impossible
 *  because the target is always the caller's own thread (record.channelRef). */
export interface ThreadPresetChanges {
  agent?: string | null;
  model?: string | null;
  cwd?: string | null;
  effort?: string | null;
  rider?: string | null;
}

/** Tier D — a scheduled prompt bound to the calling thread (#69).
 *
 *  The cron is validated through the SAME `validateCron` the arm path uses, so a
 *  bad expression is refused at WRITE time rather than silently never firing.
 *  ATTACHMENTS ARE DELIBERATELY ABSENT: their bytes come from Discord uploads and
 *  are persisted at create-time on disk (`saveScheduledAttachment`), so they
 *  cannot be managed conversationally — everything else about a schedule can. */
export interface ScheduleChanges {
  /** create = new schedule; the rest target an EXISTING schedule by `id`. */
  action: "create" | "update" | "enable" | "disable" | "delete";
  /** Target schedule id. Required for update/enable/disable/delete; ignored on create. */
  id?: string;
  name?: string;
  /** The prompt the job runs each fire. Required on create. */
  promptText?: string;
  /** Standard cron expression (5/6-field croner syntax). Required on create.
   *  Translate the user's natural-language cadence into this; it is hard-
   *  validated so a bad expression is refused before it is ever persisted. */
  cron?: string;
  /** IANA timezone (e.g. "America/Chicago"). Defaults to the deployment default on create. */
  timezone?: string;
  /** Execution mode. "isolated" (default) = throwaway session; "live" = runs in
   *  this thread, in which case model/cwd/targetChannel/outputType are ignored. */
  sessionMode?: "isolated" | "live";
  /** Isolated-mode overrides. `null` clears back to the thread default. */
  model?: string | null;
  cwd?: string | null;
  targetChannel?: string | null;
  outputType?: "card" | "messages";
  /** Missed-fire catch-up window in seconds. 0 = never catch up. */
  catchupSeconds?: number;
}

/** A single `config_propose` request. Exactly one tier per call (D8: intent-
 *  shaped, not a table-mapped CRUD surface). */
export interface ConfigMutationInput {
  session?: SessionConfigChanges;
  preset?: PresetChanges;
  channelPreset?: ChannelPresetChanges;
  threadPreset?: ThreadPresetChanges;
  schedule?: ScheduleChanges;
}

/** Who authorized the change — the human who clicked confirm. The click carries
 *  a real, harness-stamped Discord user id (the #57 D4 trust anchor). */
export interface MutationActor {
  id: string | null;
  name: string | null;
}

/** One line of the rendered diff. */
export interface ProposedField {
  label: string;
  before: string;
  after: string;
}

export interface ConfigApplyResult {
  ok: boolean;
  /** Effective outcome, Trap-1 aware (reports which layer actually won). */
  message: string;
  auditId: string;
}

/** A validated, human-readable proposal. Nothing has been written yet — calling
 *  `apply` is the only thing that mutates state (D5). */
export interface ConfigProposal {
  id: string;
  tier: ConfigMutationTier;
  /** The thread/channel the change is scoped to (never caller-supplied; D3). */
  scope: string;
  title: string;
  fields: ProposedField[];
  warnings: string[];
  /** True when applying invalidates the runtime (model/agent/cwd/effort/Tier-C);
   *  the platform restarts the session so the change takes effect (Trap 3). */
  restartsSession: boolean;
  apply: (actor: MutationActor) => ConfigApplyResult;
}

export type BuildProposalResult =
  | { ok: true; proposal: ConfigProposal }
  | { ok: false; error: string };

/** Narrow slice of SessionStore the service needs (keeps it unit-testable). */
export interface ConfigMutationStore {
  readConfig(record: SessionRecord): SessionConfigState;
  writeConfig(cfg: SessionConfigState): string;
  upsert(record: SessionRecord): void;
  getPresetByNameScoped(name: string, projectRef: string | null): Preset | null;
  upsertPreset(p: Preset): void;
  deletePreset(id: string): void;
  recordConfigMutation(entry: ConfigAuditInput): ConfigAuditEntry;
  // Scheduled prompts (#69) — the Tier-D surface.
  getScheduled(id: string): ScheduledPrompt | null;
  listScheduledByChannel(platform: string, channelRef: string): ScheduledPrompt[];
  upsertScheduled(s: ScheduledPrompt): void;
  deleteScheduled(id: string): void;
}

export interface ConfigMutationDeps {
  store: ConfigMutationStore;
  /** Re-derives effective config + which layer won (Trap 1). */
  describeConfig: (record: SessionRecord) => ConfigDescription;
  profiles: Map<string, AgentProfile>;
  defaultModel: string;
  /** CHANNEL_PRESETS_FILE — undefined ⇒ Tier C has no file to write. */
  presetsFile: string | undefined;
  /** SEAM_CONFIG_MUTATION_TIER_C_ENABLED. */
  tierCEnabled: boolean;
  /** Hot-reload the live preset maps after a Tier-C write (P0). */
  reloadPresets: () => { ok: boolean; error?: string };
  /** (Re)arm the croner timer for a schedule after a Tier-D write (#69). Writing
   *  the DB row arms NOTHING — the manager owns the timers — so create/update/
   *  delete MUST call this or the row exists but never fires. Wired in the
   *  orchestrator to `scheduledManager.reschedule`. */
  reschedule: (id: string) => void;
  /** Deployment default IANA timezone for a schedule created without one (#69). */
  defaultTimezone: string;
  /** Best-effort removal of a deleted schedule's on-disk attachment dir (#69).
   *  Fire-and-forget; undefined ⇒ no attachment store to clean (e.g. tests). */
  cleanupScheduleAttachments?: (id: string) => void;
  logger: Logger;
}

const PERMISSIONS: PermissionPolicyMode[] = ["always", "ask", "deny"];

export class ConfigMutationService {
  private readonly deps: ConfigMutationDeps;
  private readonly logger: Logger;

  constructor(deps: ConfigMutationDeps) {
    this.deps = deps;
    this.logger = deps.logger.child({ comp: "config-mutation" });
  }

  /**
   * Validate a request and compute a proposal for the calling thread. Writes
   * NOTHING (D5). Returns a refusal string on any validation failure so the
   * agent gets a clear reason rather than a thrown error.
   */
  buildProposal(record: SessionRecord, input: ConfigMutationInput): BuildProposalResult {
    const tiers = [
      input.session ? "session" : null,
      input.preset ? "preset" : null,
      input.channelPreset ? "channel-preset" : null,
      input.threadPreset ? "thread-preset" : null,
      input.schedule ? "schedule" : null,
    ].filter((t): t is ConfigMutationTier => t !== null);

    if (tiers.length === 0) {
      return {
        ok: false,
        error:
          "Nothing to change. Provide exactly one of `session`, `preset`, `channelPreset`, `threadPreset`, or `schedule`.",
      };
    }
    if (tiers.length > 1) {
      return {
        ok: false,
        error:
          "One change at a time. A proposal must touch exactly one of `session`, " +
          "`preset`, `channelPreset`, `threadPreset`, or `schedule` so the confirmation is unambiguous.",
      };
    }

    const tier = tiers[0];
    if (tier === "session") return this.buildSessionProposal(record, input.session!);
    if (tier === "preset") return this.buildPresetProposal(record, input.preset!);
    if (tier === "thread-preset") return this.buildThreadPresetProposal(record, input.threadPreset!);
    if (tier === "schedule") return this.buildScheduleProposal(record, input.schedule!);
    return this.buildChannelPresetProposal(record, input.channelPreset!);
  }

  // --- Tier A: session config ---------------------------------------------

  private buildSessionProposal(
    record: SessionRecord,
    changes: SessionConfigChanges
  ): BuildProposalResult {
    const before = this.deps.describeConfig(record);
    const fields: ProposedField[] = [];
    const warnings: string[] = [];

    // agent — must be a registered profile, or the next start throws.
    let nextAgentId = record.agentId;
    if (changes.agent !== undefined) {
      if (!this.deps.profiles.has(changes.agent)) {
        return {
          ok: false,
          error: `Unknown agent "${changes.agent}". Pick a registered agent profile.`,
        };
      }
      nextAgentId = changes.agent;
      if (changes.agent !== before.agent.value) {
        fields.push({ label: "agent", before: before.agent.value, after: changes.agent });
      }
      if (before.agent.source !== "session config") {
        warnings.push(
          `agent is currently pinned by the ${before.agent.source} ` +
            `("${before.agent.value}") — that layer will still win after this write.`
        );
      }
    }

    const cfg = this.deps.store.readConfig(record);
    const nextCfg: SessionConfigState = { ...cfg };

    // model
    if (changes.model !== undefined) {
      const m = changes.model.trim();
      if (!m) return { ok: false, error: "`model` must be a non-empty string." };
      nextCfg.model = m;
      if (m !== before.model.value) {
        fields.push({ label: "model", before: before.model.value, after: m });
      }
      if (before.model.source === "thread preset" || before.model.source === "channel preset") {
        warnings.push(
          `model is currently pinned by the ${before.model.source} ` +
            `("${before.model.value}") — the write persists to session config but the ` +
            `preset still wins, so the effective model will not change.`
        );
      }
    }

    // effort — validate against the RESOLVED agent (Trap 2).
    if (changes.effort !== undefined) {
      if (changes.effort === null || changes.effort === "") {
        delete nextCfg.reasoningEffort;
        fields.push({ label: "effort", before: before.effort.value ?? "(none)", after: "(none)" });
      } else {
        const level = changes.effort;
        const profile = this.deps.profiles.get(nextAgentId);
        const usable =
          profile?.effort &&
          profile.effort.mechanism !== "none" &&
          profile.effort.levels.includes(level);
        if (!usable) {
          warnings.push(
            `agent "${nextAgentId}" does not support effort "${level}" — it will be ` +
              `ignored at runtime (Trap 2). Effort left unchanged.`
          );
        } else {
          nextCfg.reasoningEffort = level;
          if (level !== before.effort.value) {
            fields.push({ label: "effort", before: before.effort.value ?? "(none)", after: level });
          }
        }
      }
    }

    // permission
    if (changes.permission !== undefined) {
      if (!PERMISSIONS.includes(changes.permission)) {
        return {
          ok: false,
          error: `Invalid permission "${changes.permission}". One of: ${PERMISSIONS.join(", ")}.`,
        };
      }
      nextCfg.permissionPolicy = changes.permission;
      if (changes.permission !== before.permission.value) {
        fields.push({
          label: "permission",
          before: before.permission.value,
          after: changes.permission,
        });
      }
    }

    // cwd
    let nextRepoPath = record.repoPath;
    if (changes.cwd !== undefined) {
      const c = changes.cwd.trim();
      if (!c) return { ok: false, error: "`cwd` must be a non-empty path." };
      nextRepoPath = path.resolve(c);
      if (nextRepoPath !== before.cwd.value) {
        fields.push({ label: "cwd", before: before.cwd.value, after: nextRepoPath });
      }
      if (before.cwd.source === "thread preset" || before.cwd.source === "channel preset") {
        warnings.push(
          `cwd is currently pinned by the ${before.cwd.source} — the preset still wins.`
        );
      }
    }

    // mode — ACP mode id (`/seam mode`). Not layered by presets, so diff directly
    // against the stored config. `null`/"" clears the session-level override.
    if (changes.mode !== undefined) {
      const before = cfg.mode ?? "(none)";
      if (changes.mode === null || changes.mode === "") {
        delete nextCfg.mode;
        if (before !== "(none)") fields.push({ label: "mode", before, after: "(none)" });
      } else {
        const m = changes.mode.trim();
        if (!m) return { ok: false, error: "`mode` must be a non-empty string." };
        nextCfg.mode = m;
        if (m !== cfg.mode) fields.push({ label: "mode", before, after: m });
      }
    }

    // tool allow/exclude lists (`/seam tools`). `null`/[] clears the list.
    const toolListField = (
      label: string,
      current: string[] | undefined,
      change: string[] | null | undefined
    ): string[] | undefined => {
      if (change === undefined) return current;
      const next = change === null ? [] : change.map((t) => t.trim()).filter(Boolean);
      const norm = (l: string[] | undefined) => (l && l.length ? [...l].sort() : []);
      const b = norm(current);
      const a = norm(next);
      if (b.join(",") !== a.join(",")) {
        fields.push({
          label,
          before: b.length ? b.join(", ") : "(all allowed)",
          after: a.length ? a.join(", ") : "(all allowed)",
        });
      }
      return next.length ? next : undefined;
    };
    if (changes.availableTools !== undefined) {
      nextCfg.availableTools = toolListField("availableTools", cfg.availableTools, changes.availableTools);
    }
    if (changes.excludedTools !== undefined) {
      nextCfg.excludedTools = toolListField("excludedTools", cfg.excludedTools, changes.excludedTools);
    }

    if (fields.length === 0) {
      return {
        ok: false,
        error: "No effective change — the requested values already match (or were all ignored).",
      };
    }

    const restartsSession =
      changes.agent !== undefined ||
      changes.model !== undefined ||
      changes.cwd !== undefined ||
      changes.mode !== undefined ||
      changes.availableTools !== undefined ||
      changes.excludedTools !== undefined ||
      (changes.effort !== undefined && "reasoningEffort" in nextCfg) ||
      changes.effort === null;

    const id = randomUUID();
    const proposal: ConfigProposal = {
      id,
      tier: "session",
      scope: record.channelRef,
      title: `Session config for this thread`,
      fields,
      warnings,
      restartsSession,
      apply: (actor) => {
        const updated: SessionRecord = {
          ...record,
          agentId: nextAgentId,
          repoPath: nextRepoPath,
          configJson: this.deps.store.writeConfig(nextCfg),
          updatedUtc: new Date().toISOString(),
        };
        this.deps.store.upsert(updated);
        // Trap 1: report what actually takes effect, not what we wrote.
        const effective = this.deps.describeConfig(updated);
        const audit = this.writeAudit({
          tier: "session",
          scope: record.channelRef,
          correlationId: id,
          actor,
          summary: `session config: ${fields.map((f) => f.label).join(", ")}`,
          before: {
            ...this.effectiveSnapshot(before),
            mode: cfg.mode ?? null,
            availableTools: cfg.availableTools ?? null,
            excludedTools: cfg.excludedTools ?? null,
          },
          after: {
            ...this.effectiveSnapshot(effective),
            mode: nextCfg.mode ?? null,
            availableTools: nextCfg.availableTools ?? null,
            excludedTools: nextCfg.excludedTools ?? null,
          },
        });
        const eff =
          `Applied. Effective now: model ${effective.model.value} (from ${effective.model.source}), ` +
          `agent ${effective.agent.value} (from ${effective.agent.source}), ` +
          `effort ${effective.effort.value ?? "none"} (from ${effective.effort.source}).`;
        return { ok: true, message: eff, auditId: audit.id };
      },
    };
    return { ok: true, proposal };
  }

  // --- Tier B: preset ------------------------------------------------------

  private buildPresetProposal(
    record: SessionRecord,
    changes: PresetChanges
  ): BuildProposalResult {
    const name = changes.name?.trim();
    if (!name) return { ok: false, error: "`preset.name` is required." };

    // Project scope = the calling thread's channel (#21) — never global by
    // default (a conversationally-created preset lands where it was made).
    const projectRef = record.parentRef;

    if (changes.action === "delete") {
      return this.buildPresetDelete(record, name, projectRef);
    }

    if (changes.agent !== undefined && !this.deps.profiles.has(changes.agent)) {
      return { ok: false, error: `Unknown agent "${changes.agent}".` };
    }
    if (changes.permission !== undefined && !PERMISSIONS.includes(changes.permission)) {
      return { ok: false, error: `Invalid permission "${changes.permission}".` };
    }

    const existing = this.deps.store.getPresetByNameScoped(name, projectRef);
    const warnings: string[] = [];
    const fields: ProposedField[] = [];

    const nextAgentId = changes.agent ?? existing?.agentId ?? null;
    const nextModel = changes.model?.trim() || existing?.model || null;
    const nextEffort =
      changes.effort === null
        ? null
        : changes.effort !== undefined
          ? changes.effort
          : (existing?.effort ?? null);
    const nextDescription =
      changes.description === null
        ? null
        : changes.description !== undefined
          ? changes.description
          : (existing?.description ?? null);
    const nextPermission = changes.permission ?? existing?.permission ?? null;
    const nextRepoPath =
      changes.repoPath === null
        ? null
        : changes.repoPath !== undefined
          ? (changes.repoPath.trim() ? path.resolve(changes.repoPath.trim()) : null)
          : (existing?.repoPath ?? null);
    // Tool lists: `null`/[] clears; otherwise trim + drop blanks. `undefined`
    // leaves the existing list untouched.
    const resolveToolList = (
      change: string[] | null | undefined,
      prev: string[] | null
    ): string[] | null => {
      if (change === undefined) return prev;
      if (change === null) return null;
      const cleaned = change.map((t) => t.trim()).filter(Boolean);
      return cleaned.length ? cleaned : null;
    };
    const nextToolsAllow = resolveToolList(changes.toolsAllow, existing?.toolsAllow ?? null);
    const nextToolsExclude = resolveToolList(changes.toolsExclude, existing?.toolsExclude ?? null);
    const nextInstructions =
      changes.instructions === null
        ? null
        : changes.instructions !== undefined
          ? (changes.instructions.trim() || null)
          : (existing?.instructions ?? null);

    if (nextEffort) {
      const profile = nextAgentId ? this.deps.profiles.get(nextAgentId) : undefined;
      const usable =
        profile?.effort &&
        profile.effort.mechanism !== "none" &&
        profile.effort.levels.includes(nextEffort);
      if (nextAgentId && !usable) {
        warnings.push(
          `agent "${nextAgentId}" may not support effort "${nextEffort}" — it will be ignored when this preset runs.`
        );
      }
    }

    const field = (label: string, b: string | null, a: string | null) => {
      if ((b ?? "(unset)") !== (a ?? "(unset)")) {
        fields.push({ label, before: b ?? "(unset)", after: a ?? "(unset)" });
      }
    };
    const listStr = (l: string[] | null) => (l && l.length ? l.join(", ") : null);
    field("agent", existing?.agentId ?? null, nextAgentId);
    field("model", existing?.model ?? null, nextModel);
    field("effort", existing?.effort ?? null, nextEffort);
    field("permission", existing?.permission ?? null, nextPermission);
    field("description", existing?.description ?? null, nextDescription);
    field("repoPath", existing?.repoPath ?? null, nextRepoPath);
    field("toolsAllow", listStr(existing?.toolsAllow ?? null), listStr(nextToolsAllow));
    field("toolsExclude", listStr(existing?.toolsExclude ?? null), listStr(nextToolsExclude));
    // instructions can be long/multiline — compare the FULL value so a change past
    // the clip point isn't hidden, but show only a clipped one-liner in the diff.
    if ((existing?.instructions ?? null) !== nextInstructions) {
      fields.push({
        label: "instructions",
        before: existing?.instructions ? clip(existing.instructions, 200) : "(unset)",
        after: nextInstructions ? clip(nextInstructions, 200) : "(unset)",
      });
    }

    if (fields.length === 0) {
      return { ok: false, error: `Preset "${name}" already matches — nothing to change.` };
    }

    const id = randomUUID();
    const scopeLabel = projectRef ? `project ${projectRef}` : "global";
    const proposal: ConfigProposal = {
      id,
      tier: "preset",
      scope: record.channelRef,
      title: `${existing ? "Update" : "Create"} preset "${name}" (${scopeLabel})`,
      fields,
      warnings,
      restartsSession: false,
      apply: (actor) => {
        const now = new Date().toISOString();
        const row: Preset = {
          id: existing?.id ?? `pre_${randomUUID().slice(0, 8)}`,
          name,
          projectRef,
          description: nextDescription,
          agentId: nextAgentId,
          model: nextModel,
          effort: nextEffort,
          repoPath: nextRepoPath,
          permission: nextPermission,
          toolsAllow: nextToolsAllow,
          toolsExclude: nextToolsExclude,
          instructions: nextInstructions,
          createdBy: existing?.createdBy ?? (actor.id ?? "seam-mcp"),
          createdUtc: existing?.createdUtc ?? now,
          updatedUtc: now,
        };
        this.deps.store.upsertPreset(row);
        const audit = this.writeAudit({
          tier: "preset",
          scope: record.channelRef,
          correlationId: id,
          actor,
          summary: `${existing ? "update" : "create"} preset "${name}" (${scopeLabel})`,
          before: existing ? this.presetSnapshot(existing) : { preset: null },
          after: this.presetSnapshot(row),
        });
        return {
          ok: true,
          message:
            `Preset "${name}" ${existing ? "updated" : "created"} in ${scopeLabel}. ` +
            `It is now usable as a handoff target in this thread.`,
          auditId: audit.id,
        };
      },
    };
    return { ok: true, proposal };
  }

  /**
   * Delete a project-scoped preset (#72). Self-scoped like create/update: the
   * target is resolved by (name, caller's projectRef) — a caller can only ever
   * remove a preset in its own project, and an unknown name is refused rather
   * than silently succeeding. Destructive, so it reuses the IDENTICAL confirm-
   * card + audit path as every other mutation, and records the FULL removed
   * object in `before_json` so it is recoverable from the audit trail.
   */
  private buildPresetDelete(
    record: SessionRecord,
    name: string,
    projectRef: string | null
  ): BuildProposalResult {
    const existing = this.deps.store.getPresetByNameScoped(name, projectRef);
    const scopeLabel = projectRef ? `project ${projectRef}` : "global";
    if (!existing) {
      return {
        ok: false,
        error: `No preset "${name}" in ${scopeLabel}. List presets with config_describe.`,
      };
    }
    const id = randomUUID();
    const proposal: ConfigProposal = {
      id,
      tier: "preset",
      scope: record.channelRef,
      title: `Delete preset "${name}" (${scopeLabel})`,
      fields: [
        { label: "name", before: existing.name, after: "(deleted)" },
        { label: "agent", before: existing.agentId ?? "(unset)", after: "(deleted)" },
        { label: "model", before: existing.model ?? "(unset)", after: "(deleted)" },
      ],
      warnings: [
        "Deleting a preset is permanent — any handoff that names it will fail until it is recreated.",
      ],
      restartsSession: false,
      apply: (actor) => {
        this.deps.store.deletePreset(existing.id);
        const audit = this.writeAudit({
          tier: "preset",
          scope: record.channelRef,
          correlationId: id,
          actor,
          summary: `delete preset "${name}" (${scopeLabel})`,
          // Full removed object so the deletion is recoverable from the ledger.
          before: this.presetSnapshot(existing),
          after: { preset: null },
        });
        return {
          ok: true,
          message: `Preset "${name}" deleted from ${scopeLabel}. Its definition is preserved in the audit trail.`,
          auditId: audit.id,
        };
      },
    };
    return { ok: true, proposal };
  }

  // --- Tier C: channel-presets.json (flag-gated) ---------------------------

  private buildChannelPresetProposal(
    record: SessionRecord,
    changes: ChannelPresetChanges
  ): BuildProposalResult {
    if (!this.deps.tierCEnabled) {
      return {
        ok: false,
        error:
          "Channel-preset editing is disabled on this deployment " +
          "(SEAM_CONFIG_MUTATION_TIER_C_ENABLED is off). Session config and presets are still available.",
      };
    }
    const file = this.deps.presetsFile;
    if (!file) {
      return {
        ok: false,
        error: "No CHANNEL_PRESETS_FILE is configured, so there is no channel-presets file to edit.",
      };
    }
    // D3 + P3: the target is ALWAYS the caller's own parent channel. There is no
    // channel-id parameter, so a cross-channel edit is structurally impossible.
    const channelId = record.parentRef;
    if (!channelId) {
      return {
        ok: false,
        error:
          "This thread has no parent channel to scope a channel preset to " +
          "(channel presets are keyed on the parent channel id).",
      };
    }
    // D2/P3 belt-and-suspenders: the lock is NEVER editable through any tool.
    if ("locked" in (changes as unknown as Record<string, unknown>)) {
      return {
        ok: false,
        error:
          "The `locked` flag cannot be changed through any tool — unlocking is a deliberate " +
          "out-of-band act (edit the file + redeploy). That friction is the security property.",
      };
    }

    // Read the current file as raw JSON so we preserve every OTHER channel/thread
    // and this channel's existing `locked` value untouched.
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
    } catch (err) {
      // A missing/empty file is fine — start from an empty document.
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") raw = {};
      else return { ok: false, error: `Could not read channel-presets file: ${(err as Error).message}` };
    }
    const doc = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}) as {
      channels?: Record<string, Record<string, unknown>>;
      threads?: Record<string, unknown>;
    };
    const channels = { ...(doc.channels ?? {}) };
    const current = { ...(channels[channelId] ?? {}) };

    const keys: Array<keyof ChannelPresetChanges> = ["agent", "model", "cwd", "effort", "rider"];
    const fields: ProposedField[] = [];
    const next: Record<string, unknown> = { ...current };
    for (const key of keys) {
      const val = changes[key];
      if (val === undefined) continue; // field not part of this proposal
      const beforeVal = (current[key] as { value?: string } | undefined)?.value ?? null;
      if (val === null || val === "") {
        delete next[key];
        if (beforeVal !== null) fields.push({ label: key, before: beforeVal, after: "(removed)" });
      } else {
        const resolved = key === "cwd" ? path.resolve(val) : val;
        next[key] = { value: resolved };
        if (beforeVal !== resolved) {
          fields.push({ label: key, before: beforeVal ?? "(unset)", after: resolved });
        }
      }
    }
    // Preserve the existing lock exactly — never introduce or drop it here.
    if ("locked" in current) next.locked = current.locked;

    if (fields.length === 0) {
      return { ok: false, error: "No effective change to this channel's preset." };
    }

    channels[channelId] = next;
    const candidate = { ...doc, channels };

    // D7: the candidate MUST pass the exact boot schema or we refuse — an invalid
    // channel-presets.json throws at startup and would fail the next boot.
    const parsed = PresetsFileSchema.safeParse(candidate);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      return {
        ok: false,
        error: `Refused: the resulting channel-presets.json would be invalid (${issues}). Nothing written.`,
      };
    }

    const id = randomUUID();
    const proposal: ConfigProposal = {
      id,
      tier: "channel-preset",
      scope: channelId,
      title: `Channel preset for channel ${channelId}`,
      fields,
      warnings: [
        "This is a channel-wide preset — it applies to every thread under this channel, not just this one.",
      ],
      restartsSession: true,
      apply: (actor) => {
        // Serialize the FULL candidate document and swap atomically (temp+rename),
        // then hot-reload the live maps (P0) so it takes effect with no redeploy.
        const abs = path.resolve(file);
        const tmp = `${abs}.tmp-${id.slice(0, 8)}`;
        fs.writeFileSync(tmp, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
        fs.renameSync(tmp, abs);
        const reload = this.deps.reloadPresets();
        if (!reload.ok) {
          // The written file passed PresetsFileSchema above, so a reload failure
          // here is unexpected; log loudly. The file is written but the live map
          // keeps the previous good config (P0 guarantees no half-applied map).
          this.logger.error({ err: reload.error, file: abs }, "Tier-C reload failed after write");
        }
        const audit = this.writeAudit({
          tier: "channel-preset",
          scope: channelId,
          correlationId: id,
          actor,
          summary: `channel ${channelId} preset: ${fields.map((f) => f.label).join(", ")}`,
          before: { channel: current },
          after: { channel: next },
        });
        return {
          ok: true,
          message:
            `Channel preset for ${channelId} updated and hot-reloaded — it takes effect on the ` +
            `next turn in every thread under this channel. The lock was left unchanged.`,
          auditId: audit.id,
        };
      },
    };
    return { ok: true, proposal };
  }

  // --- Tier C: thread preset (channel-presets.json `threads`) --------------

  /**
   * #68: edit the CALLER'S OWN thread-level preset in the `threads` map of
   * channel-presets.json. Structurally a sibling of the channel branch — same
   * fields, same guardrails (flag gate, PresetsFileSchema round-trip, atomic
   * temp+rename, hot-reload, one audit row) — but the target is ALWAYS the
   * caller's own thread id (record.channelRef), so a cross-thread edit is
   * impossible by construction, exactly like the channel branch's parent scope.
   *
   * Two deliberate divergences from the channel branch:
   *  - `locked` lives ONLY on channel entries. A thread entry has no lock, so
   *    the channel branch's preserve-lock line is NOT carried over here, and a
   *    caller-supplied `locked` is refused (belt-and-suspenders, same as D2/P3).
   *  - A thread preset OVERRIDES the channel preset per-field (resolveChannelPreset
   *    picks thread ?? channel), so any field that shadows a channel value emits a
   *    Trap-1 warning: the write persists, but the effective source is this layer.
   */
  private buildThreadPresetProposal(
    record: SessionRecord,
    changes: ThreadPresetChanges
  ): BuildProposalResult {
    if (!this.deps.tierCEnabled) {
      return {
        ok: false,
        error:
          "Thread-preset editing is disabled on this deployment " +
          "(SEAM_CONFIG_MUTATION_TIER_C_ENABLED is off). Session config and presets are still available.",
      };
    }
    const file = this.deps.presetsFile;
    if (!file) {
      return {
        ok: false,
        error: "No CHANNEL_PRESETS_FILE is configured, so there is no presets file to edit.",
      };
    }
    // D3 + P3: the target is ALWAYS the caller's own thread. There is no
    // thread-id parameter, so a cross-thread edit is structurally impossible.
    const threadId = record.channelRef;
    if (!threadId) {
      return {
        ok: false,
        error: "This session has no thread id to scope a thread preset to.",
      };
    }
    // D2/P3 belt-and-suspenders: `locked` exists only on channel entries and can
    // never be set through any tool — refuse it here rather than silently drop it.
    if ("locked" in (changes as unknown as Record<string, unknown>)) {
      return {
        ok: false,
        error:
          "The `locked` flag exists only on channels and cannot be set on a thread preset " +
          "(or changed through any tool) — unlocking is a deliberate out-of-band act.",
      };
    }

    // Read the current file as raw JSON so we preserve every OTHER thread, the
    // channel entries, and every channel's `locked` value byte-for-byte.
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
    } catch (err) {
      // A missing/empty file is fine — start from an empty document.
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") raw = {};
      else return { ok: false, error: `Could not read channel-presets file: ${(err as Error).message}` };
    }
    const doc = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}) as {
      channels?: Record<string, Record<string, unknown>>;
      threads?: Record<string, Record<string, unknown>>;
    };
    const threads = { ...(doc.threads ?? {}) };
    const current = { ...(threads[threadId] ?? {}) };
    // The parent channel's entry, used ONLY to detect Trap-1 shadowing below.
    const channelEntry = record.parentRef ? doc.channels?.[record.parentRef] : undefined;

    const keys: Array<keyof ThreadPresetChanges> = ["agent", "model", "cwd", "effort", "rider"];
    const fields: ProposedField[] = [];
    const warnings: string[] = [];
    const next: Record<string, unknown> = { ...current };
    for (const key of keys) {
      const val = changes[key];
      if (val === undefined) continue; // field not part of this proposal
      const beforeVal = (current[key] as { value?: string } | undefined)?.value ?? null;
      if (val === null || val === "") {
        delete next[key];
        if (beforeVal !== null) fields.push({ label: key, before: beforeVal, after: "(removed)" });
      } else {
        const resolved = key === "cwd" ? path.resolve(val) : val;
        next[key] = { value: resolved };
        if (beforeVal !== resolved) {
          fields.push({ label: key, before: beforeVal ?? "(unset)", after: resolved });
          // Trap 1: a thread field shadows the channel value for that field.
          const chanVal = (channelEntry?.[key] as { value?: string } | undefined)?.value;
          if (chanVal !== undefined && key !== "rider") {
            warnings.push(
              `${key} is also set by the channel preset ("${chanVal}") — the thread preset ` +
                `overrides it, so this thread's effective ${key} will be "${resolved}" while ` +
                `sibling threads keep the channel value.`
            );
          } else if (chanVal !== undefined && key === "rider") {
            warnings.push(
              `the channel preset also sets a rider — thread and channel riders STACK ` +
                `(channel first, then this thread's), they do not override.`
            );
          }
        }
      }
    }
    // NB: no preserve-lock line here — thread entries carry no `locked` field.

    if (fields.length === 0) {
      return { ok: false, error: "No effective change to this thread's preset." };
    }

    threads[threadId] = next;
    const candidate = { ...doc, threads };

    // D7: the candidate MUST pass the exact boot schema or we refuse — an invalid
    // channel-presets.json throws at startup and would fail the next boot.
    const parsed = PresetsFileSchema.safeParse(candidate);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      return {
        ok: false,
        error: `Refused: the resulting channel-presets.json would be invalid (${issues}). Nothing written.`,
      };
    }

    const id = randomUUID();
    const proposal: ConfigProposal = {
      id,
      tier: "thread-preset",
      scope: threadId,
      title: `Thread preset for this thread (${threadId})`,
      fields,
      warnings,
      restartsSession: true,
      apply: (actor) => {
        // Serialize the FULL candidate document and swap atomically (temp+rename),
        // then hot-reload the live maps (P0) so it takes effect with no redeploy.
        const abs = path.resolve(file);
        const tmp = `${abs}.tmp-${id.slice(0, 8)}`;
        fs.writeFileSync(tmp, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
        fs.renameSync(tmp, abs);
        const reload = this.deps.reloadPresets();
        if (!reload.ok) {
          // The written file passed PresetsFileSchema above, so a reload failure
          // here is unexpected; log loudly. The file is written but the live map
          // keeps the previous good config (P0 guarantees no half-applied map).
          this.logger.error({ err: reload.error, file: abs }, "Tier-C reload failed after write");
        }
        const audit = this.writeAudit({
          tier: "thread-preset",
          scope: threadId,
          correlationId: id,
          actor,
          summary: `thread ${threadId} preset: ${fields.map((f) => f.label).join(", ")}`,
          before: { thread: current },
          after: { thread: next },
        });
        return {
          ok: true,
          message:
            `Thread preset for ${threadId} updated and hot-reloaded — it takes effect on the ` +
            `next turn in THIS thread only. Sibling threads and the channel preset are unchanged.`,
          auditId: audit.id,
        };
      },
    };
    return { ok: true, proposal };
  }

  // --- Tier D: scheduled prompt (#69) --------------------------------------

  /**
   * Validate + compute a scheduled-prompt proposal for the calling thread (#69).
   * Writes NOTHING (D5). Every mutating branch's `apply` writes the DB row AND
   * calls `reschedule(id)` — because writing the row arms no timer (the manager
   * owns them), so a create/update/delete that skipped `reschedule` would list
   * fine yet never fire (or keep firing after a delete). The cron is hard-
   * validated through the SAME `validateCron` the arm path uses, so a bad
   * expression is refused here at write-time rather than silently failing at
   * arm-time. Self-scope (D3): only the caller's OWN thread's schedules are
   * reachable — an existing row whose channelRef isn't the caller's is refused.
   */
  private buildScheduleProposal(
    record: SessionRecord,
    changes: ScheduleChanges
  ): BuildProposalResult {
    const action = changes.action;
    if (!action) {
      return {
        ok: false,
        error: "`schedule.action` is required: one of create, update, enable, disable, delete.",
      };
    }

    // --- resolve + self-scope the target for every non-create action ---------
    let existing: ScheduledPrompt | null = null;
    if (action !== "create") {
      const id = changes.id?.trim();
      if (!id) {
        return { ok: false, error: `\`schedule.id\` is required for "${action}".` };
      }
      existing = this.deps.store.getScheduled(id);
      // D3 self-scope: a caller may only touch schedules bound to its OWN thread.
      // An unknown id and another thread's id are reported identically so the
      // tool never becomes a cross-thread existence oracle.
      if (
        !existing ||
        existing.platform !== record.platform ||
        existing.channelRef !== record.channelRef
      ) {
        return {
          ok: false,
          error: `No schedule "${id}" in this thread. List them with config_describe.`,
        };
      }
    }

    if (action === "delete") return this.buildScheduleDelete(record, existing!);
    if (action === "enable" || action === "disable") {
      return this.buildScheduleToggle(record, existing!, action === "enable");
    }
    return this.buildScheduleUpsert(record, changes, existing);
  }

  private buildScheduleDelete(
    record: SessionRecord,
    existing: ScheduledPrompt
  ): BuildProposalResult {
    const id = randomUUID();
    const proposal: ConfigProposal = {
      id,
      tier: "schedule",
      scope: record.channelRef,
      title: `Delete scheduled prompt "${existing.name}"`,
      fields: [
        { label: "name", before: existing.name, after: "(deleted)" },
        { label: "cadence", before: `${describeCron(existing.cron)} (${existing.timezone})`, after: "(deleted)" },
      ],
      warnings: existing.attachments.length
        ? [`${existing.attachments.length} attached reference file(s) will be removed with it.`]
        : [],
      restartsSession: false,
      apply: (actor) => {
        this.deps.store.deleteScheduled(existing.id);
        // reschedule with the row now gone disarms the timer (D: manager owns it).
        this.deps.reschedule(existing.id);
        this.deps.cleanupScheduleAttachments?.(existing.id);
        const audit = this.writeAudit({
          tier: "schedule",
          scope: record.channelRef,
          correlationId: id,
          actor,
          summary: `delete schedule "${existing.name}" (${existing.id})`,
          before: this.scheduleSnapshot(existing),
          after: { schedule: null },
        });
        return {
          ok: true,
          message: `Deleted scheduled prompt "${existing.name}" (${existing.id}). Its timer is disarmed.`,
          auditId: audit.id,
        };
      },
    };
    return { ok: true, proposal };
  }

  private buildScheduleToggle(
    record: SessionRecord,
    existing: ScheduledPrompt,
    enable: boolean
  ): BuildProposalResult {
    if (existing.enabled === enable) {
      return {
        ok: false,
        error: `Schedule "${existing.name}" is already ${enable ? "enabled" : "disabled"}.`,
      };
    }
    const id = randomUUID();
    const proposal: ConfigProposal = {
      id,
      tier: "schedule",
      scope: record.channelRef,
      title: `${enable ? "Enable" : "Disable"} scheduled prompt "${existing.name}"`,
      fields: [{ label: "enabled", before: String(existing.enabled), after: String(enable) }],
      warnings: [],
      restartsSession: false,
      apply: (actor) => {
        const updated: ScheduledPrompt = {
          ...existing,
          enabled: enable,
          updatedUtc: new Date().toISOString(),
        };
        this.deps.store.upsertScheduled(updated);
        // Arms (enable) or disarms (disable) the timer to match the new row.
        this.deps.reschedule(existing.id);
        const audit = this.writeAudit({
          tier: "schedule",
          scope: record.channelRef,
          correlationId: id,
          actor,
          summary: `${enable ? "enable" : "disable"} schedule "${existing.name}" (${existing.id})`,
          before: this.scheduleSnapshot(existing),
          after: this.scheduleSnapshot(updated),
        });
        return {
          ok: true,
          message: `${enable ? "Enabled" : "Disabled"} "${existing.name}" (${existing.id}).`,
          auditId: audit.id,
        };
      },
    };
    return { ok: true, proposal };
  }

  private buildScheduleUpsert(
    record: SessionRecord,
    changes: ScheduleChanges,
    existing: ScheduledPrompt | null
  ): BuildProposalResult {
    const creating = existing === null;

    // Resolve the effective values: provided → existing → default.
    const name = (changes.name ?? existing?.name)?.trim();
    if (!name) return { ok: false, error: "`schedule.name` is required to create a schedule." };
    const promptText = (changes.promptText ?? existing?.promptText)?.trim();
    if (!promptText) return { ok: false, error: "`schedule.promptText` is required to create a schedule." };

    const cron = (changes.cron ?? existing?.cron)?.trim();
    if (!cron) return { ok: false, error: "`schedule.cron` is required to create a schedule." };

    const timezone = (changes.timezone ?? existing?.timezone ?? this.deps.defaultTimezone).trim();
    if (!isValidTimeZone(timezone)) {
      return {
        ok: false,
        error: `"${timezone}" is not a valid IANA timezone (e.g. "America/Chicago", "Europe/London").`,
      };
    }

    // HARD REQUIREMENT (#69): validate through the SAME validateCron the arm path
    // uses. An invalid cron fails at ARM time, not write time — so a bad row would
    // list fine and simply never fire. Refuse it here, before persisting anything.
    const check = validateCron(cron, timezone);
    if (!check.ok || !check.next) {
      return {
        ok: false,
        error: `Invalid schedule: ${check.error ?? "that cron has no upcoming runs"}. Nothing was written.`,
      };
    }
    const nextRunDate = check.next;

    const sessionMode: "isolated" | "live" =
      changes.sessionMode ?? existing?.sessionMode ?? "isolated";
    const live = sessionMode === "live";

    // In live mode model/cwd/target/output are meaningless (D1) — null them so a
    // mode flip can't leave stale values behind. In isolated mode, provided →
    // existing → default. `null` explicitly clears back to the thread default.
    const resolveNullable = (
      provided: string | null | undefined,
      prev: string | null
    ): string | null => (provided === undefined ? prev : provided === null ? null : provided.trim() || null);

    const model = live ? null : resolveNullable(changes.model, existing?.model ?? null);
    const cwd = live ? null : resolveNullable(changes.cwd, existing?.cwd ?? null);
    const targetChannel = live ? null : resolveNullable(changes.targetChannel, existing?.targetChannel ?? null);
    const outputType: "card" | "messages" = live
      ? "card"
      : (changes.outputType ?? existing?.outputType ?? "card");
    const catchupSeconds =
      changes.catchupSeconds !== undefined
        ? Math.max(0, Math.floor(changes.catchupSeconds))
        : (existing?.catchupSeconds ?? 7200);

    const now = new Date().toISOString();
    const scheduleId = existing?.id ?? `sch_${randomUUID().slice(0, 8)}`;
    const nextRunUtc = nextRunDate.toISOString();

    // Build the row to persist. On update, preserve id / created* / enabled /
    // last-run / attachments (attachments can't be managed conversationally).
    const buildRow = (actor: MutationActor): ScheduledPrompt =>
      existing
        ? {
            ...existing,
            name,
            promptText,
            cron,
            timezone,
            sessionMode,
            model,
            cwd,
            targetChannel,
            outputType,
            catchupSeconds,
            updatedUtc: now,
            nextRunUtc,
          }
        : {
            id: scheduleId,
            platform: record.platform,
            channelRef: record.channelRef,
            parentRef: record.parentRef,
            name,
            promptText,
            cron,
            timezone,
            model,
            cwd,
            targetChannel,
            outputType,
            sessionMode,
            catchupSeconds,
            enabled: true,
            attachments: [],
            createdBy: actor.id ?? "seam-mcp",
            createdUtc: now,
            updatedUtc: now,
            lastRunUtc: null,
            lastStatus: null,
            nextRunUtc,
            pinnedSessionId: null,
          };

    // Diff for the confirm card: parsed cron + resolved next run are ALWAYS shown
    // (#69 — the only proof the schedule means what the user said, so a timezone
    // mistake is visible before Apply).
    const fields: ProposedField[] = [];
    const field = (label: string, b: string | null, a: string | null) => {
      if ((b ?? "(unset)") !== (a ?? "(unset)")) {
        fields.push({ label, before: b ?? "(unset)", after: a ?? "(unset)" });
      }
    };
    if (creating) fields.push({ label: "name", before: "(new)", after: name });
    else field("name", existing!.name, name);
    field("cadence", existing ? `${describeCron(existing.cron)} [${existing.cron}]` : null, `${describeCron(cron)} [${cron}]`);
    field("timezone", existing?.timezone ?? null, timezone);
    // Resolved next run — echoed even when unchanged, so it's never missing.
    fields.push({
      label: "next run",
      before: existing?.nextRunUtc ?? "(none)",
      after: nextRunUtc,
    });
    field("prompt", existing ? clip(existing.promptText, 200) : null, clip(promptText, 200));
    field("session", existing?.sessionMode ?? null, sessionMode);
    if (!live) {
      field("model", existing?.model ?? null, model);
      field("cwd", existing?.cwd ?? null, cwd);
      field("targetChannel", existing?.targetChannel ?? null, targetChannel);
      field("outputType", existing?.outputType ?? null, outputType);
    }

    const warnings: string[] = [];
    if (live && (changes.model != null || changes.cwd != null || changes.targetChannel != null || changes.outputType != null)) {
      warnings.push("Live mode ignores model / cwd / targetChannel / outputType — the thread's own config governs the run.");
    }
    if (creating) {
      warnings.push("Attachments can't be added conversationally — use `/seam schedule add-file` to attach reference files.");
    }

    const id = randomUUID();
    const proposal: ConfigProposal = {
      id,
      tier: "schedule",
      scope: record.channelRef,
      title: `${creating ? "Create" : "Update"} scheduled prompt "${name}"`,
      fields,
      warnings,
      // Applying a schedule change must NEVER restart the calling thread — it
      // re-arms the manager's timer instead (below), leaving the session intact.
      restartsSession: false,
      apply: (actor) => {
        const row = buildRow(actor);
        this.deps.store.upsertScheduled(row);
        // HARD REQUIREMENT (#69): arm/refresh the timer. Without this the row
        // exists, config_describe lists it, and it never runs.
        this.deps.reschedule(row.id);
        const audit = this.writeAudit({
          tier: "schedule",
          scope: record.channelRef,
          correlationId: id,
          actor,
          summary: `${creating ? "create" : "update"} schedule "${name}" (${row.id})`,
          before: existing ? this.scheduleSnapshot(existing) : { schedule: null },
          after: this.scheduleSnapshot(row),
        });
        return {
          ok: true,
          message:
            `Scheduled prompt "${name}" ${creating ? "created" : "updated"} (${row.id}) and armed — ` +
            `next run ${nextRunUtc}${row.enabled ? "" : " (currently disabled)"}.`,
          auditId: audit.id,
        };
      },
    };
    return { ok: true, proposal };
  }

  // --- helpers -------------------------------------------------------------

  private writeAudit(opts: {
    tier: ConfigMutationTier;
    scope: string;
    correlationId: string;
    actor: MutationActor;
    summary: string;
    before: unknown;
    after: unknown;
  }): ConfigAuditEntry {
    const entry = this.deps.store.recordConfigMutation({
      id: randomUUID(),
      tier: opts.tier,
      actorId: opts.actor.id,
      actorName: opts.actor.name,
      scope: opts.scope,
      summary: opts.summary,
      beforeJson: JSON.stringify(opts.before),
      afterJson: JSON.stringify(opts.after),
      correlationId: opts.correlationId,
    });
    this.logger.info(
      { auditId: entry.id, tier: opts.tier, scope: opts.scope, actor: opts.actor.id },
      "config mutation applied + audited"
    );
    return entry;
  }

  private effectiveSnapshot(d: ConfigDescription): Record<string, unknown> {
    return {
      agent: { value: d.agent.value, source: d.agent.source },
      model: { value: d.model.value, source: d.model.source },
      effort: { value: d.effort.value, source: d.effort.source },
      cwd: { value: d.cwd.value, source: d.cwd.source },
      permission: { value: d.permission.value, source: d.permission.source },
    };
  }

  private presetSnapshot(p: Preset): Record<string, unknown> {
    // Full object — a preset delete records this in before_json, so it must carry
    // every field needed to reconstruct the removed preset from the audit trail.
    return {
      id: p.id,
      name: p.name,
      projectRef: p.projectRef ?? null,
      agentId: p.agentId,
      model: p.model,
      effort: p.effort,
      permission: p.permission,
      description: p.description,
      repoPath: p.repoPath,
      toolsAllow: p.toolsAllow,
      toolsExclude: p.toolsExclude,
      instructions: p.instructions,
    };
  }

  private scheduleSnapshot(s: ScheduledPrompt): Record<string, unknown> {
    return {
      id: s.id,
      name: s.name,
      promptText: s.promptText,
      cron: s.cron,
      timezone: s.timezone,
      sessionMode: s.sessionMode,
      model: s.model,
      cwd: s.cwd,
      targetChannel: s.targetChannel,
      outputType: s.outputType,
      catchupSeconds: s.catchupSeconds,
      enabled: s.enabled,
      nextRunUtc: s.nextRunUtc,
    };
  }
}

/** True if `tz` is a real IANA zone. Intl throws a RangeError for anything it
 *  doesn't recognize, which is exactly the "must be a real IANA zone" gate. */
function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Clip a possibly-multiline string to one clamped line for a diff-card field. */
function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

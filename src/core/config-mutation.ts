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
import type {
  ConfigAuditEntry,
  ConfigAuditInput,
  PermissionPolicyMode,
  Preset,
  SessionConfigState,
  SessionRecord,
} from "./types.js";

/** Config surface a single proposal touches. */
export type ConfigMutationTier = "session" | "preset" | "channel-preset" | "thread-preset";

/** Tier A — the calling thread's own session config. */
export interface SessionConfigChanges {
  agent?: string;
  model?: string;
  /** `null` clears the session-level effort override. */
  effort?: string | null;
  cwd?: string;
  permission?: PermissionPolicyMode;
}

/** Tier B — a preset in the calling thread's project scope. */
export interface PresetChanges {
  name: string;
  agent?: string;
  model?: string;
  effort?: string | null;
  description?: string | null;
  permission?: PermissionPolicyMode;
  // `instructions` is intentionally unsupported — the Preset type's own comment
  // notes it is stored but NOT injected into the system prompt, so a tool that
  // set it would promise a personality it cannot deliver. Refused in validate().
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

/** A single `config_propose` request. Exactly one tier per call (D8: intent-
 *  shaped, not a table-mapped CRUD surface). */
export interface ConfigMutationInput {
  session?: SessionConfigChanges;
  preset?: PresetChanges;
  channelPreset?: ChannelPresetChanges;
  threadPreset?: ThreadPresetChanges;
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
  recordConfigMutation(entry: ConfigAuditInput): ConfigAuditEntry;
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
    ].filter((t): t is ConfigMutationTier => t !== null);

    if (tiers.length === 0) {
      return {
        ok: false,
        error:
          "Nothing to change. Provide exactly one of `session`, `preset`, `channelPreset`, or `threadPreset`.",
      };
    }
    if (tiers.length > 1) {
      return {
        ok: false,
        error:
          "One change at a time. A proposal must touch exactly one of `session`, " +
          "`preset`, `channelPreset`, or `threadPreset` so the confirmation is unambiguous.",
      };
    }

    const tier = tiers[0];
    if (tier === "session") return this.buildSessionProposal(record, input.session!);
    if (tier === "preset") return this.buildPresetProposal(record, input.preset!);
    if (tier === "thread-preset") return this.buildThreadPresetProposal(record, input.threadPreset!);
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
          before: this.effectiveSnapshot(before),
          after: this.effectiveSnapshot(effective),
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
    if ("instructions" in (changes as unknown as Record<string, unknown>)) {
      return {
        ok: false,
        error:
          "`instructions` cannot be set conversationally: presets round-trip it but do " +
          "NOT inject it into the system prompt yet, so it would change nothing. Refused " +
          "rather than promise a personality the preset can't deliver.",
      };
    }
    if (changes.agent !== undefined && !this.deps.profiles.has(changes.agent)) {
      return { ok: false, error: `Unknown agent "${changes.agent}".` };
    }
    if (changes.permission !== undefined && !PERMISSIONS.includes(changes.permission)) {
      return { ok: false, error: `Invalid permission "${changes.permission}".` };
    }

    // Project scope = the calling thread's channel (#21) — never global by
    // default (a conversationally-created preset lands where it was made).
    const projectRef = record.parentRef;
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
    field("agent", existing?.agentId ?? null, nextAgentId);
    field("model", existing?.model ?? null, nextModel);
    field("effort", existing?.effort ?? null, nextEffort);
    field("permission", existing?.permission ?? null, nextPermission);
    field("description", existing?.description ?? null, nextDescription);

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
          repoPath: existing?.repoPath ?? null,
          permission: nextPermission,
          toolsAllow: existing?.toolsAllow ?? null,
          toolsExclude: existing?.toolsExclude ?? null,
          instructions: existing?.instructions ?? null,
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
    return {
      name: p.name,
      projectRef: p.projectRef ?? null,
      agentId: p.agentId,
      model: p.model,
      effort: p.effort,
      permission: p.permission,
      description: p.description,
    };
  }
}

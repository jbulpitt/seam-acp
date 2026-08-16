/** Per-session permission policy. */
export type PermissionPolicyMode = "always" | "ask" | "deny";

/**
 * Per-session, agent-specific settings. Stored as JSON in `sessions.config_json`.
 * Mostly mirrors the C# `SessionConfigState`, generalized for multi-agent use.
 */
export interface SessionConfigState {
  /** ACP model id (e.g. "gpt-5.4", "claude-sonnet-4.5", "auto"). */
  model?: string;
  /** ACP mode id (e.g. agent / plan / autopilot URI). */
  mode?: string;
  /** Reasoning effort for models that support it ("low" | "medium" | "high"). */
  reasoningEffort?: string;
  /** Allowlist of tool names; empty = all allowed. */
  availableTools?: string[];
  /** Blocklist of tool names. */
  excludedTools?: string[];
  /** Vendor-specific MCP server configuration (passed via ACP `_meta`). */
  mcpServers?: unknown;
  /**
   * Per-session permission policy.
   * - "always": auto-approve every request (yolo)
   * - "ask":    prompt the user in Discord; deny on timeout
   * - "deny":   auto-deny every request
   */
  permissionPolicy?: PermissionPolicyMode;
  /**
   * @deprecated Use `permissionPolicy` instead. Kept for read-time backward
   * compatibility: legacy `true` → "always", legacy `false`/missing → fall
   * back to the bot-wide default policy.
   */
  autoApprovePermissions?: boolean;
  /**
   * Last-known context-window usage at end of the previous turn. Used to
   * seed the status panel at turn start so the user sees continuity. Cleared
   * on model change. May go stale after out-of-band session edits — corrected
   * by the post-turn side-channel `getUsage` read in normal operation.
   */
  lastContextUsage?: {
    used: number;
    size: number;
    /** The model id this measurement was taken under. Used to invalidate
     *  on model change without needing a separate field. */
    model: string;
    atUtc: string;
  };
}

export function defaultSessionConfig(
  defaultModel: string,
  defaultPolicy: PermissionPolicyMode = "ask"
): SessionConfigState {
  return { model: defaultModel, permissionPolicy: defaultPolicy };
}

/**
 * A named, reusable bundle of session configuration.
 *
 * Every override field is nullable: `null` means "this preset does not touch
 * that setting", so applying a preset only changes the fields it specifies.
 *
 * Presets are scoped by project (#21): `projectRef` names the channel/parentRef
 * the preset belongs to. `null` means a *global* preset — visible in every
 * project (the legacy behavior). A project-scoped preset shadows a global one of
 * the same name within its project. Names are unique per (name, scope), so the
 * same short name can be reused independently across projects.
 */
export interface Preset {
  id: string;
  name: string;
  /** Project scope (channel/parentRef); `null` = global. See interface doc. */
  projectRef?: string | null;
  description: string | null;
  agentId: string | null;
  model: string | null;
  effort: string | null;
  repoPath: string | null;
  permission: PermissionPolicyMode | null;
  toolsAllow: string[] | null;
  toolsExclude: string[] | null;
  /** Stored and round-tripped, but not yet injected into the system prompt. */
  instructions: string | null;
  createdBy: string;
  createdUtc: string;
  updatedUtc: string;
}

/**
 * Resolve the effective permission mode for a session, honoring (in order):
 *   1. The new `permissionPolicy` field
 *   2. The legacy `autoApprovePermissions` field — but only when it is `true`
 *      (`false` / missing both fall through so the new safer default wins)
 *   3. The bot-wide default
 */
export function resolvePermissionMode(
  cfg: SessionConfigState,
  defaultMode: PermissionPolicyMode
): PermissionPolicyMode {
  if (cfg.permissionPolicy) return cfg.permissionPolicy;
  if (cfg.autoApprovePermissions === true) return "always";
  return defaultMode;
}

/**
 * A channel activated for the bot at runtime via the DB (issue #22).
 *
 * Additive to the static env allowlist (`DISCORD_ALLOWED_CHANNEL_IDS`): an
 * enabled row makes a channel respond even when it is not in the env seed, and
 * takes effect without a redeploy. The env path is never weakened — the DB is
 * strictly additive truth. Keyed by `channelRef`, the same channel id the
 * incoming-message gate checks (a thread's parent channel).
 */
export interface ActiveProject {
  /** Channel id the message gate matches (a thread's parent channel). */
  channelRef: string;
  /** Disabled rows are retained but do not grant access. */
  enabled: boolean;
  /** Optional JSON blob for per-project metadata (e.g. `{ description }`). */
  configJson: string | null;
  createdUtc: string;
  updatedUtc: string;
}

/**
 * Persisted record for one chat session (one Discord thread, one Slack thread, etc.).
 * Multi-platform / multi-agent ready: keyed by composite (`platform`, `channel_ref`).
 */
export interface SessionRecord {
  /** Composite primary key: `${platform}:${channel_ref}`. */
  id: string;
  platform: string;
  channelRef: string;
  parentRef: string | null;
  agentId: string;
  acpSessionId: string;
  repoPath: string | null;
  configJson: string;
  createdUtc: string;
  updatedUtc: string;
}

/** Status panel state shown to the user during a turn. */
export type TurnState =
  | "Working"
  | "Done"
  | "Failed"
  | "Timed out"
  | "Waiting"
  // Turn ended but the agent left background/monitor work running that may
  // resume on its own (Claude Monitor tool / run_in_background tasks).
  | "Monitoring";

export interface StatusPanel {
  state: TurnState;
  repoDisplay: string;
  model: string;
  /** Resolved API model id (e.g. "claude-opus-4-8[1m]"), if different from model alias. */
  resolvedModel?: string;
  /** Reasoning effort for this turn, if set (low|medium|high|xhigh|max). */
  effort?: string;
  action: string;
  elapsedSeconds: number;
  /** Optional context-window line shown when token info is known. */
  context?: string;
  /** Recent tool / progress activity (oldest → newest). */
  activity?: string[];
  /** Last few lines of model reasoning (oldest → newest). */
  thinking?: string[];
}

// --- delegation ledger -----------------------------------------------------
// Durable log of every programmatic turn / cross-thread handoff. Written by
// the delegation runtime so a handoff's return path is a recorded fact rather
// than a behavioral hope (see docs/seam-mcp-vision.md §1).

/** What kind of programmatic turn a ledger row records. */
export type DelegationKind =
  /** Thread A hands work to thread B. */
  | "handoff"
  /** One thread's output piped onward as another's input. */
  | "forward"
  /** A completed handoff's result delivered back to its origin. */
  | "report_back"
  /** Scheduler-origin turn — has no source thread. */
  | "scheduled"
  /** Read-only cross-thread inspection. */
  | "peek";

/** Lifecycle of a ledger row. Terminal states: completed | failed | timed_out. */
export type DelegationStatus =
  | "dispatched"
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  /** Deliberately set aside (e.g. awaiting human steering) — not terminal. */
  | "parked";

/** Statuses considered still in flight by `listActiveDelegations`. */
export const DELEGATION_ACTIVE_STATUSES: readonly DelegationStatus[] = [
  "dispatched",
  "running",
];

/** Max stored length of `promptPreview`; the store truncates on write. */
export const PROMPT_PREVIEW_MAX = 200;

/** One row of the delegation ledger. */
export interface LedgerEntry {
  id: string;
  /** Originating thread/session id. Null for scheduler-origin turns. */
  sourceRef: string | null;
  /** Resolved target thread/session id. Null until the target resolves. */
  targetRef: string | null;
  /** The handoff worker: preset name or thread alias. */
  worker: string | null;
  kind: DelegationKind;
  /** First `PROMPT_PREVIEW_MAX` chars of the dispatched prompt. */
  promptPreview: string | null;
  /** Ties a handoff to its later report-back. */
  correlationId: string | null;
  status: DelegationStatus;
  createdUtc: string;
  updatedUtc: string;
}

/**
 * Caller-supplied shape for `recordDelegation`. Only `id` and `kind` are
 * required; `status` defaults to "dispatched" and the timestamps default to
 * now, so a dispatch site writes one line and gets a complete row back.
 */
export interface LedgerEntryInput {
  id: string;
  kind: DelegationKind;
  sourceRef?: string | null;
  targetRef?: string | null;
  worker?: string | null;
  promptPreview?: string | null;
  correlationId?: string | null;
  /** Defaults to "dispatched". */
  status?: DelegationStatus;
  /** Defaults to now (ISO 8601). */
  createdUtc?: string;
  /** Defaults to `createdUtc`. */
  updatedUtc?: string;
}

/**
 * Fields `updateDelegationStatus` may amend alongside the status change.
 * Immutable by design: `id`, `kind`, `createdUtc`.
 */
export type LedgerPatch = Partial<
  Pick<
    LedgerEntry,
    "sourceRef" | "targetRef" | "worker" | "promptPreview" | "correlationId"
  >
>;

// --- durable multi-hop chains (#25) ----------------------------------------

/** Lifecycle of a chain. Terminal states: completed | failed. */
export type ChainStatus = "running" | "completed" | "failed";

/**
 * One durable multi-hop chain: t1 → t2 → … → origin, where each hop's OUTPUT
 * becomes the next hop's INPUT. The runtime (not the agents) drives each hop,
 * and this row is the single source of truth so a restart mid-chain resumes.
 */
export interface Chain {
  id: string;
  /** Workers still to dispatch, in order — each a thread id or preset name.
   *  The hop currently in flight has already been popped off the front. */
  hops: string[];
  /** Final delivery thread — where the last hop's output is reported back. */
  originRef: string;
  /** First `PROMPT_PREVIEW_MAX` chars of the chain's initiating prompt. */
  promptPreview: string | null;
  status: ChainStatus;
  /** Count of hops dispatched so far (bumped on each `advanceChain`). */
  currentIndex: number;
  createdUtc: string;
  updatedUtc: string;
}

/**
 * Caller-supplied shape for `createChain`. Only `id`, `hops` and `originRef`
 * are required; `status` defaults to "running", `currentIndex` to 0, and the
 * timestamps to now.
 */
export interface ChainCreateInput {
  id: string;
  hops: string[];
  originRef: string;
  promptPreview?: string | null;
  status?: ChainStatus;
  currentIndex?: number;
  createdUtc?: string;
  updatedUtc?: string;
}

/** Result of one agent turn (reply round-trip). */
export interface TurnOutcome {
  success: boolean;
  timedOut: boolean;
  errorMessage?: string;
}

/**
 * Platform-agnostic rich status card. The renderer produces this structure and
 * the adapter converts it to the platform's native rich format (Discord embed,
 * Slack block-kit, etc.). A text-serialization fallback is provided for
 * adapters that only support plain text.
 */
export interface StructuredPanel {
  /** Sidebar / accent color as a hex number (e.g. 0x57F287 for green). */
  color: number;
  /** Main title line (e.g. "⏳ Working"). */
  title: string;
  /** Optional author line (e.g. agent display name). */
  author?: string;
  /** Optional body text rendered as markdown (activity log, thinking, etc.). */
  description?: string;
  /** Key/value fields for the embed grid. */
  fields: Array<{ name: string; value: string; inline?: boolean }>;
  /** Footer text (e.g. "⏱ 12s elapsed"). */
  footer?: string;
}

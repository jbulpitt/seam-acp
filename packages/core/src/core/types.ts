/** Per-session permission policy. */
export type PermissionPolicyMode = "always" | "ask" | "deny";

/** Per-turn status-card layout (#96). Omit / unset = `"full"`. */
export type StatusCardStyle = "full" | "simple";

export const STATUS_CARD_STYLES: readonly StatusCardStyle[] = ["full", "simple"];

export function parseStatusCardStyle(v: unknown): StatusCardStyle | undefined {
  return v === "full" || v === "simple" ? v : undefined;
}

/** Parse a simple-card GIF toggle. `true`/`"on"`/`"true"` → on; `false`/`"off"`/`"false"` → off. */
export function parseSimpleCardGif(v: unknown): boolean | undefined {
  if (v === true || v === "on" || v === "true") return true;
  if (v === false || v === "off" || v === "false") return false;
  return undefined;
}

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
  /**
   * Status-card layout for this thread (#96). Omit = `"full"`. Stored in the
   * session JSON blob (no DB migration). Named presets copy this in on apply.
   */
  statusCardStyle?: StatusCardStyle;
  /**
   * Random curated GIF in the simple status-card thumbnail. Omit = inherit
   * (channel/thread preset, then default off). Explicit `false` turns it off
   * even if a parent preset is on.
   */
  simpleCardGif?: boolean;
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
  /** Auto-numbering token for `/seam preset thread` names. Null = not set. */
  threadSlug?: string | null;
  permission: PermissionPolicyMode | null;
  toolsAllow: string[] | null;
  toolsExclude: string[] | null;
  /** The preset worker's identity/personality. Injected at run time: the
   *  orchestrator prepends it as a `<seam-worker-identity name="…">…</seam-worker-identity>`
   *  block when the preset runs as a handoff/dispatch worker (#23), so a stateless
   *  preset worker cold-starts with this identity. */
  instructions: string | null;
  /**
   * Status-card layout baked into this preset (#96). `null` = this preset does
   * not touch the thread's style (apply leaves the session value alone).
   */
  statusCardStyle: StatusCardStyle | null;
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
  /** Optional title prefix shown before the state, e.g. a dispatch type
   *  ("📨 Handoff", "⏰ Wake"). Unset for normal user turns. */
  titlePrefix?: string;
  action: string;
  elapsedSeconds: number;
  /** Optional context-window line shown when token info is known. */
  context?: string;
  /** Integer percent of the context window used, when known. Simple cards
   *  show this instead of the full `used / size (pct)` string. */
  contextPct?: number;
  /** Recent tool / progress activity (oldest → newest). */
  activity?: string[];
  /** Last few lines of model reasoning (oldest → newest). */
  thinking?: string[];
  /** `"simple"` drops repo/model/action/effort/tool-tags; default `"full"`. */
  style?: StatusCardStyle;
  /** Filename of the brand logo attached at card creation (`attachment://`). */
  brandFilename?: string;
  /** Author name for the full card (agent display name / brand). Simple cards
   *  put the turn state in `author` instead and ignore this. */
  authorName?: string;
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
  /** Agent-scheduled wake (#59) — self-initiated re-entry at a chosen time.
   *  Distinct from "scheduled" so watchdog policy can treat agent-initiated
   *  re-entry differently from human-scheduled cron runs (D7). */
  | "wake"
  /** Agent-defined watch (#60) — a bridge-evaluated condition tripped and
   *  re-entered its owning thread. Distinct from "wake" so watchdog policy can
   *  tell a time-triggered self-resumption from a condition-triggered one. */
  | "watch"
  /** Read-only cross-thread inspection. */
  | "peek"
  /** Agent-triggered thread compaction — the caller asked the runtime to run
   *  the premium multi-agent compaction pipeline on a thread's session (its
   *  own, or an explicit target) and rebind the thread to the seeded result.
   *  Recorded actor→target so a cross-thread compaction is an audited fact. */
  | "compact"
  /** Agent inbox (#61) — a durable, pull-only message left in a thread's queue
   *  (`send`) or drained from it (`poll_inbox`). Distinct from "forward"/
   *  "handoff": an inbox message never starts or interrupts a turn, so watchdog
   *  policy must not treat it as an in-flight delegation. */
  | "inbox"
  /** Parked user prompt (#88) — a message held while its remote bridge was
   *  offline, now firing as a live turn on the same host. Distinct from "wake"
   *  so watchdog policy can tell a user-originated reconnect delivery from
   *  an agent-scheduled self-resumption. */
  | "parked"
  /** Frozen choice-card click (#91) — one click emitted one prompt via
   *  emitChoice. Distinct from "wake"/"parked" so watchdog/dispatch panels
   *  do not mis-file these. */
  | "choice"
  /** Headless HTTP ingest endpoint (#95) — isolated silent scoring turn.
   *  Distinct from "choice" so Discord click-cards and microsite endpoints
   *  do not share ledger/panel filing. */
  | "ingest"
  /** Durable user-authored input produced only by authenticated Thread Voice
   *  capture. Trusted speaker metadata is verified against its durable batch. */
  | "thread_voice";

/**
 * Lifecycle of a ledger row.
 * Terminal: completed | failed | timed_out.
 * `interrupted` is the boot-reconciliation state for crash leftovers (#75) —
 * not in-flight, not a successful/failed completion; resume (#76) acts on it.
 * `abandoned` is a resume that was set aside (max-age, deleted thread) rather
 * than re-fired — terminal, operator-visible, manually resumable.
 */
export type DelegationStatus =
  | "dispatched"
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  /** Deliberately set aside (e.g. awaiting human steering) — not terminal. */
  | "parked"
  /** Crash leftover: process died while the row was still in flight. */
  | "interrupted"
  /** Resume declined (max-age / deleted thread) — terminal, not in-flight. */
  | "abandoned";

/** Statuses considered still in flight by `listActiveDelegations`. */
export const DELEGATION_ACTIVE_STATUSES: readonly DelegationStatus[] = [
  "dispatched",
  "running",
];

/** Statuses a completed turn reached — boot reconciliation must not touch these. */
export const DELEGATION_TERMINAL_STATUSES: readonly DelegationStatus[] = [
  "completed",
  "failed",
  "timed_out",
  "abandoned",
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
  /**
   * ACP session the turn is/was running in. Written at the `running`
   * transition (as soon as `newSession()` returns for isolated dispatches)
   * so a crash mid-turn still has a pointer for resume (#75 / #76).
   */
  acpSessionId: string | null;
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
  /** Defaults to null — filled in at the `running` transition. */
  acpSessionId?: string | null;
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
    | "sourceRef"
    | "targetRef"
    | "worker"
    | "promptPreview"
    | "correlationId"
    | "acpSessionId"
  >
>;

// --- conversational config-mutation audit (#58 P2/P3, D6) ------------------

/**
 * One row of the config-mutation audit ledger. Every applied conversational
 * config change (session config, a preset, or a channel-presets.json write)
 * records who authorized it, what it touched, and the full before/after — so
 * "who changed this, and to what?" is always answerable (D6). Follows the
 * delegation_log pattern (#26) but is a separate table: config drift and task
 * delegation are different questions and mixing them makes both harder to read.
 */
export interface ConfigAuditEntry {
  id: string;
  /** Config surface touched: "session" | "preset" | "channel-preset". */
  tier: string;
  /**
   * The human who confirmed the change (the click carries a real, harness-
   * stamped Discord user id — the trust anchor per #57 D4). Null only for a
   * non-interactive apply path (none today).
   */
  actorId: string | null;
  actorName: string | null;
  /** The thread/channel the change was scoped to (never caller-supplied; D3). */
  scope: string;
  /** One-line human summary of the change. */
  summary: string;
  /** JSON snapshot of the affected values BEFORE the change. */
  beforeJson: string;
  /** JSON snapshot of the affected values AFTER the change. */
  afterJson: string;
  /** Ties the audit row to the propose→confirm turn that requested it. */
  correlationId: string | null;
  appliedUtc: string;
}

/** Caller-supplied shape for `recordConfigMutation`; `appliedUtc` defaults to now. */
export interface ConfigAuditInput {
  id: string;
  tier: string;
  actorId?: string | null;
  actorName?: string | null;
  scope: string;
  summary: string;
  beforeJson: string;
  afterJson: string;
  correlationId?: string | null;
  appliedUtc?: string;
}

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
export type PanelButtonStyle = "primary" | "secondary" | "success" | "danger";

/** One classic action-row button. Discord caps 5 per row, 5 rows. */
export interface PanelButton {
  customId: string;
  label: string;
  style?: PanelButtonStyle;
  disabled?: boolean;
  emoji?: string;
}

export interface StructuredPanel {
  /** Sidebar / accent color as a hex number (e.g. 0x57F287 for green). */
  color: number;
  /** Main title line (e.g. "⏳ Working"). Omit on the simple status card. */
  title?: string;
  /** Optional author line (e.g. agent display name, or turn state on simple). */
  author?: string;
  /** Discord `attachment://<filename>` (or a URL) for the author icon. */
  authorIconURL?: string;
  /** Discord embed main-image URL (standalone simple-card GIF message). */
  imageUrl?: string;
  /** Optional body text rendered as markdown (activity log, thinking, etc.). */
  description?: string;
  /** Key/value fields for the embed grid. */
  fields: Array<{ name: string; value: string; inline?: boolean }>;
  /** Footer text (e.g. "⏱ 12s elapsed"). */
  footer?: string;
  /**
   * Optional classic action rows (NOT Components v2). When present on send,
   * the adapter attaches them. On edit, `[]` clears buttons; `undefined`
   * leaves existing components alone.
   */
  actions?: PanelButton[][];
  /**
   * Optional file attachments on the same message as the embed (Discord can
   * play an ogg here; embeds themselves cannot host audio).
   * On send: attached. On edit: `[]` clears files; `undefined` leaves them.
   */
  files?: Array<{ data: Buffer; filename: string }>;
}

/**
 * Discord Components v2 layout (Container + TextDisplay + Separator).
 * Cannot mix with embeds — the whole message is this tree.
 */
export type LayoutSpacing = "small" | "large";

export type LayoutBlock =
  | { kind: "text"; content: string }
  | { kind: "separator"; divider?: boolean; spacing?: LayoutSpacing };

export interface StructuredLayout {
  /** Accent bar color (Container), same meaning as {@link StructuredPanel.color}. */
  color?: number;
  blocks: LayoutBlock[];
  /**
   * Optional classic action rows attached as sibling components below the v2
   * container (both are valid top-level Components-v2 message components). On
   * send/edit the adapter attaches them; omit for a button-less layout.
   */
  actions?: PanelButton[][];
}

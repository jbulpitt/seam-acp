/**
 * Agent-defined watches / triggers (#60) — bridge-evaluated condition polling.
 *
 * A watch is the fourth member of the "re-enter this thread when ‹trigger›
 * fires" family (time → wake #59, cron → scheduled prompts, process-exit →
 * durable-jobs). It converges on the SAME delivery primitive as a wake — inject
 * a live turn into the owning thread — and differs only in what trips it: a
 * predicate the bridge evaluates cheaply on an interval.
 *
 * The core insight (D1): the *bridge* evaluates the predicate; the model is
 * NEVER invoked to check. The cheap thing (the poll — a `stat`, a `fetch`, a
 * short command) happens constantly; the expensive thing (a full agent turn)
 * happens only on a real event. If an implementation ever "wakes the agent to
 * look", it has become #59 with extra steps.
 *
 * Lifecycle (D3): `mode: "once"` is the default — fire once, delete (mirroring a
 * wake). `mode: "each"` is an explicit opt-in bounded by `maxFires`. Every watch
 * MUST carry an expiry (D4): on expiry a turn is injected saying so, because a
 * watch that quietly evaporates is the worst outcome — the agent believes it is
 * still waiting.
 *
 * Durability + delivery reuse #59 wholesale (D2): the WatchManager sweeper
 * mirrors WakeManager, and a fire enqueues a dispatch spec through the shipped
 * queue (kind "watch"). The DB sweep decides *when to check*, the predicate
 * decides *whether to fire*, and the dispatch queue owns *how to deliver*.
 */

/** What a watch observes. `file`/`http` are the safe sources shipped first;
 *  `command` is a privileged capability (D8) — flag-gated + allowlisted. */
export type WatchKind = "file" | "http" | "command";

/** Fire-once-then-delete (default, D3) or fire-each-change up to `maxFires`. */
export type WatchMode = "once" | "each";

/** One persisted watch. Deleted on fire (`once`), on reaching `maxFires`
 *  (`each`), on a rate-limit breach, or on expiry (D3/D4/D5). */
export interface WatchEvent {
  id: string;
  platform: string;
  /** The thread id — the stable binding anchor the watch fires into (self-scope). */
  channelRef: string;
  parentRef: string | null;
  kind: WatchKind;
  /** The observed target: a file path, a URL, or a command string. */
  spec: string;
  /** Kind-specific match config. For `http`: `"status:NNN"` (fire when the
   *  response status equals NNN) or a body regex (fire when the body matches).
   *  Absent ⇒ default change-detection. Unused for `file`/`command`. */
  match: string | null;
  /** How often the bridge re-checks (seconds). Floored per kind (D6). */
  intervalSeconds: number;
  /** The agent's stored prompt, replayed as a live turn on fire, plus the
   *  captured event text. */
  prompt: string;
  /** Human-facing reason (telemetry / the fire notice), not model instructions. */
  reason: string;
  mode: WatchMode;
  /** Fires allowed before the watch stops (`each` mode). `once` ⇒ effectively 1. */
  maxFires: number;
  /** How many times it has fired so far. */
  fireCount: number;
  /** Last time the predicate was evaluated (ISO 8601), or null before the first check. */
  lastCheckedUtc: string | null;
  /** Last time it fired (ISO 8601), or null. */
  lastFiredUtc: string | null;
  /** Serialized snapshot of the last observation, for change-detection — a file
   *  signature (`exists:size:mtime`), or an http `status:len` / `matched`. Null
   *  before the first check establishes a baseline. */
  lastObserved: string | null;
  /** Absolute UTC instant the watch expires (ISO 8601). Mandatory (D4). */
  expiresAtUtc: string;
  /** Session that registered the watch (its session id). Provenance only. */
  createdBy: string;
  /** Ledger correlation; null when unset. */
  correlationId: string | null;
  createdUtc: string;
}

/** Caller-supplied shape for registering a watch. The store/orchestrator stamp
 *  `id`, `expiresAtUtc` (from `expiresInSeconds`), `fireCount`, timestamps, and
 *  `correlationId`, so a registration site writes the essentials only. */
export interface WatchCreateRequest {
  kind: WatchKind;
  spec: string;
  match?: string;
  intervalSeconds: number;
  prompt: string;
  reason?: string;
  mode?: WatchMode;
  maxFires?: number;
  /** Mandatory (D4) — the watch is armed to expire this many seconds from now. */
  expiresInSeconds: number;
}

/** What a single predicate evaluation returns. `observed` is persisted as the
 *  new `lastObserved` (change-detection baseline); a transient `error` means the
 *  check failed but the watch must NOT die (`|| true` semantics, D-sketch). */
export interface WatchEvalResult {
  /** True ⇒ the condition tripped this check. */
  fired: boolean;
  /** Captured event text delivered with the fired turn (stdout, a body excerpt,
   *  a file-change description). Empty when not fired. */
  eventText: string;
  /** New snapshot to persist for the next comparison; null keeps the prior one. */
  observed: string | null;
  /** Transient failure (network blip, missing file for http, etc.) — logged, not
   *  fatal. A watch survives a failed check. */
  error?: string;
  /** A privileged-source refusal (command disabled / not on the allowlist) — a
   *  defense-in-depth backstop to registration-time rejection (D8). */
  refused?: string;
}

// --- floors / caps ---------------------------------------------------------
// These bound abuse (a tight poll against a third party is an attack pointed at
// someone else's host — D6) and runaway cost (each fire is a whole turn — D5).

/** DB sweep interval (D2, mirroring WakeManager's poll). The effective check
 *  granularity of any watch is `max(intervalSeconds, WATCH_SWEEP_MS)`. */
export const WATCH_SWEEP_MS = 15_000;

/** Minimum poll interval per kind (D6). Local checks may poll fast; a remote
 *  API must not (a 1s HTTP watch against a third party is an abuse vector). */
export const WATCH_MIN_INTERVAL_SECONDS: Record<WatchKind, number> = {
  file: 2,
  http: 30,
  command: 10,
};

/** Maximum poll interval (24h). Past this it isn't a watch, it's a scheduled
 *  prompt; reject it. */
export const WATCH_MAX_INTERVAL_SECONDS = 24 * 60 * 60;

/** A watch must expire; the horizon is 7 days (matching the wake ceiling). */
export const WATCH_MAX_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

/** Default mode (D3): fire once, then delete. */
export const WATCH_DEFAULT_MODE: WatchMode = "once";

/** Default `maxFires` for an `each` watch when the caller omits it. */
export const WATCH_DEFAULT_MAX_FIRES = 10;

/** Hard ceiling on `maxFires` — a runaway backstop, not a spending policy. */
export const WATCH_MAX_FIRES_CEILING = 500;

/** Simultaneously-pending watches allowed per thread (D5), mirroring
 *  WAKE_MAX_PENDING_PER_THREAD. */
export const WATCH_MAX_PENDING_PER_THREAD = 20;

/** Per-thread fire budget within a rolling hour (D5). On breach the offending
 *  watch is stopped with a visible notice — never silently. */
export const WATCH_MAX_FIRES_PER_THREAD_PER_HOUR = 30;

/** Timeout for a single `http` probe (ms). A slow endpoint must not wedge the
 *  sweep. */
export const WATCH_HTTP_TIMEOUT_MS = 10_000;

/** Timeout for a single `command` probe (ms). */
export const WATCH_COMMAND_TIMEOUT_MS = 10_000;

/** Cap on captured event text (chars) delivered with a fired turn, so a chatty
 *  source can't inject an unbounded prompt. */
export const WATCH_EVENT_TEXT_MAX = 4_000;

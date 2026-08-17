/**
 * Agent-scheduled wake events (#59) — one-shot, durable self-resumption.
 *
 * A wake is an agent's own bookkeeping: "wake me in N minutes and give me this
 * prompt back." It is the time-triggered sibling of durable-jobs' completion
 * trigger and #56's cron trigger, and it converges on the same delivery
 * primitive — inject a live turn into a thread without a chat message.
 *
 * Lifecycle (D1): written at schedule time, rehydrated on boot, fired once, and
 * deleted after firing (success or failure). No accumulating history in this
 * table — the audit trail lives in the delegation ledger (D7). Unlike
 * `ScheduledPrompt`, a wake carries no cron, no schedule config, and no timers:
 * it stores *when* to fire and *what* to say, and the DB sweep (D11) decides
 * *when*, while the shipped dispatch queue owns *how* (delivery).
 */

/** One persisted wake event. Deleted the moment it fires (D1). */
export interface WakeEvent {
  id: string;
  platform: string;
  /** The thread id — the stable binding anchor the wake resumes into. */
  channelRef: string;
  parentRef: string | null;
  /** Absolute UTC instant the wake becomes due (ISO 8601). */
  fireAtUtc: string;
  /** The agent's own stored prompt, replayed as a live turn when the wake fires. */
  prompt: string;
  /** Human-facing reason (telemetry / the D6 notice), not model instructions. */
  reason: string;
  /** Speaker/session that requested the wake (its session id). Provenance only. */
  createdBy: string;
  /** Ledger correlation (D7); null when unset. */
  correlationId: string | null;
  /** Consecutive self-renewals (D8): 0 for a fresh wake, +1 for each wake armed
   *  *during* a woken turn. The runaway-loop backstop trips past
   *  `WAKE_MAX_CHAIN_DEPTH`. */
  chainDepth: number;
  /** Missed-fire catch-up window in seconds (D10). 0 = never catch up. */
  catchupSeconds: number;
  /** Fire on the next process boot instead of at a wall-clock time. When true
   *  the wake is EXCLUDED from the time sweep (`fireAtUtc` is nominal) and fires
   *  once during `WakeManager.start()`, then is deleted like any other wake
   *  (D1 — one-shot; there is no fire-on-every-boot mode). */
  fireOnStartup: boolean;
  createdUtc: string;
}

/** Caller-supplied shape for scheduling a wake. `id`, `fireAtUtc`, `chainDepth`,
 *  `catchupSeconds`, `correlationId`, and `createdUtc` are stamped by the store /
 *  orchestrator when omitted, so a schedule site writes the essentials only. */
export interface WakeScheduleRequest {
  delaySeconds: number;
  reason: string;
  prompt: string;
  /** When true, arm a boot-triggered wake instead of a timed one: `delaySeconds`
   *  is ignored and the wake fires on the next process start (D1 one-shot). */
  fireOnStartup?: boolean;
}

// --- loop-safety backstops (D8 / D14) --------------------------------------
// These bound a *bug* (a self-renewal that never converges), not a spending
// policy — thresholds are deliberately loose so legitimate polling loops are
// unaffected (D8). Feed into the #26 watchdog rather than rationing here.

/** Minimum wake delay — mirrors upstream `ScheduleWakeup`'s 60s floor (D8).
 *  Anything shorter is rejected. */
export const WAKE_MIN_DELAY_SECONDS = 60;

/** Maximum wake delay (D14) — 7 days, matching upstream cron's auto-expire.
 *  Past this bound it isn't a wake, it's a scheduled prompt; reject it. */
export const WAKE_MAX_DELAY_SECONDS = 7 * 24 * 60 * 60;

/** Default missed-fire catch-up window (D10), mirroring the scheduled-prompt
 *  default. A wake overdue by more than this is dropped, not fired late. */
export const WAKE_DEFAULT_CATCHUP_SECONDS = 900;

/** Consecutive self-renewals allowed before the chain-depth cap trips (D8).
 *  Generous — the goal is catching a runaway, not rationing normal use. */
export const WAKE_MAX_CHAIN_DEPTH = 50;

/** Simultaneously-pending wakes allowed per thread (D8). */
export const WAKE_MAX_PENDING_PER_THREAD = 20;

/** DB sweep interval (D11) — poll for due wakes rather than arming timers. */
export const WAKE_SWEEP_MS = 30_000;

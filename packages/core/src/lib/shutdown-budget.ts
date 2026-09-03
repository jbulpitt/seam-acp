/**
 * The two pure decisions the #174 shutdown sequence makes.
 *
 * Factored out ONLY so they are testable: the sequence itself lives in
 * `index.ts`, which runs `main()` on import and so cannot be exercised from a
 * test. These functions hold no state and own no lifecycle — `index.ts` still
 * decides when to call what.
 */

/**
 * What the host gives us after SIGTERM before SIGKILL. pm2's default
 * `kill_timeout` is 1.6s and ours is raised for #174; systemd's
 * `DefaultTimeoutStopSec` is 90s. 30s is the strictest of the plausible
 * hosts, so it is the one the budget below has to satisfy.
 */
export const HOST_SIGKILL_BUDGET_MS = 30_000;

/**
 * The whole shutdown's bounded work, shared by every stage.
 *
 * Deliberately a constant and not a new env knob: `SHUTDOWN_QUIESCE_TIMEOUT_MS`
 * stays the per-stage ceiling operators tune, and a second, interacting knob
 * would let the two be configured into a combination that violates
 * `shutdownFitsHostBudget()` below.
 */
export const SHUTDOWN_BUDGET_MS = 20_000;

/**
 * Hard stop once the bounded stages are done: `health.close()` does not call
 * back while a connection is open, so the exit cannot be awaited.
 */
export const SHUTDOWN_EXIT_FALLBACK_MS = 5_000;

/**
 * Headroom for the parts of shutdown that are NOT on a timer: the synchronous
 * `manager.stop()` calls, three `store.close()`s, and the process teardown
 * after `process.exit`.
 */
export const SHUTDOWN_OVERHEAD_ALLOWANCE_MS = 2_000;

/**
 * The timing contract, as an assertion rather than a comment: worst case is the
 * full budget, then the full exit fallback, plus untimed overhead — and that
 * has to leave margin under the strictest host.
 */
export function shutdownFitsHostBudget(): boolean {
  return (
    SHUTDOWN_BUDGET_MS + SHUTDOWN_EXIT_FALLBACK_MS + SHUTDOWN_OVERHEAD_ALLOWANCE_MS <
    HOST_SIGKILL_BUDGET_MS
  );
}

/** How long one bounded shutdown stage may wait. */
export interface ShutdownBudget {
  /** Milliseconds left in the whole shutdown. */
  remaining(): number;
  /** A stage's own ceiling, capped by what is left. Never negative. */
  forStage(capMs: number): number;
  /** True once the budget is spent — remaining stages get 0 and give up at once. */
  expired(): boolean;
}

/**
 * Start a shared shutdown budget.
 *
 * Per-stage timeouts bound each stage but say nothing about their sum: four
 * sequential 10s/10s/5s/10s stages is 35s, past the ~30s a host allows before
 * SIGKILL. Draining from one budget makes the total an invariant instead of an
 * accident of how the individual ceilings happen to be tuned.
 */
export function startShutdownBudget(
  totalMs: number,
  now: () => number = Date.now
): ShutdownBudget {
  const startedAt = now();
  const remaining = (): number => Math.max(0, totalMs - (now() - startedAt));
  return {
    remaining,
    forStage: (capMs: number) => Math.max(0, Math.min(capMs, remaining())),
    expired: () => remaining() === 0,
  };
}

/**
 * Run one teardown step against a deadline. Never throws.
 *
 * Returns whether the step actually FINISHED. That distinction is the whole
 * point: a step that timed out or threw may still have work resuming behind it,
 * and a caller about to close a shared handle has to be able to tell. A step
 * that "completed" by having its deadline expire is the failure mode this
 * exists to make visible, not to hide.
 */
export async function runBoundedStep(opts: {
  label: string;
  timeoutMs: number;
  work: () => Promise<unknown>;
  /** Reported when the deadline won. The work is abandoned, not cancelled. */
  onTimeout?: (label: string, timeoutMs: number) => void;
  onError?: (label: string, err: unknown) => void;
}): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  let failed = false;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, opts.timeoutMs);
    timer.unref?.();
  });
  await Promise.race([
    // `.then(work)` so a SYNCHRONOUS throw is a failed step, not a thrown one.
    Promise.resolve()
      .then(opts.work)
      .catch((err) => {
        failed = true;
        opts.onError?.(opts.label, err);
      }),
    deadline,
  ]);
  if (timer) clearTimeout(timer);
  if (timedOut) opts.onTimeout?.(opts.label, opts.timeoutMs);
  return !timedOut && !failed;
}

/** One bounded stage's verdict: did it finish, or did it give up? */
export interface DrainVerdict {
  stage: string;
  /** False on a timeout OR a barrier failure — both mean work may still resume. */
  drained: boolean;
}

/** The stages that did not cleanly drain, for the operator-facing log. */
export function undrainedStages(verdicts: readonly DrainVerdict[]): string[] {
  return verdicts.filter((v) => !v.drained).map((v) => v.stage);
}

/**
 * Whether shutdown may EXPLICITLY close the adapter and the SQLite stores.
 *
 * Only when every drain finished. A stage that timed out or whose barrier
 * failed has left work that can still RESUME — an admitted `/mcp` call past its
 * deadline, a turn the quiesce gave up on — and that work reaches for the store
 * and the adapter. Closing them underneath it converts "a side effect landed
 * late" into "a dispatch is recorded as failed with its answer thrown away",
 * which is strictly worse than the leak: the process is exiting either way, and
 * the bounded `process.exit` fallback releases the fds, the socket and the
 * gateway connection regardless.
 *
 * So this deliberately trades a few seconds of held OS resources — already
 * bounded, already about to be reclaimed — for never corrupting late work.
 */
export function safeToCloseResources(verdicts: readonly DrainVerdict[]): boolean {
  return verdicts.every((v) => v.drained);
}

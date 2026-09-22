/** Let the ordinary turn timeout finish its own cleanup before the hard guard. */
export const TURN_WATCHDOG_GRACE_MS = 30_000;

export function turnSilenceDeadlineMs(turnTimeoutSeconds: number): number {
  return Math.max(1, turnTimeoutSeconds * 1000);
}

/**
 * Silence past the deadline plus this grace. `turnHealth.stalled` uses it so
 * the staleness verdict stays strictly later than the silence deadline: the
 * deadline is what ends the turn, and stalled only stops believing `busy`
 * when that deadline did not.
 */
export function turnStalenessBoundMs(turnTimeoutSeconds: number): number {
  return turnSilenceDeadlineMs(turnTimeoutSeconds) + TURN_WATCHDOG_GRACE_MS;
}

export function turnWatchdogTimeoutMs(turnTimeoutSeconds: number): number {
  return turnStalenessBoundMs(turnTimeoutSeconds);
}

export class TurnWatchdogTimeoutError extends Error {
  constructor(
    readonly label: string,
    readonly timeoutMs: number
  ) {
    super(`${label} exceeded the ${timeoutMs}ms turn watchdog`);
    this.name = "TurnWatchdogTimeoutError";
  }
}

/**
 * Wait until `promise` settles, or until `silenceMs` has passed since
 * `lastActivityAt` (#460).
 *
 * This is not a second opinion of whether the child is hung. It reads the
 * same last-output observation `turnHealth` reads. A missing hang-probe
 * report is the link failing and is not an input here; `hang-watch` is the
 * only owner of that evidence, and it never treats a missing report as a
 * reason to restart.
 *
 * Activity during the wait re-arms the timer. A quiet agent hits the
 * deadline. An agent that keeps producing output does not.
 */
export async function raceUntilSilence<T>(
  promise: Promise<T>,
  opts: {
    silenceMs: number;
    lastActivityAt: () => number;
    now?: () => number;
  }
): Promise<T | "timeout"> {
  const now = opts.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const timeout = new Promise<"timeout">((resolve) => {
    const arm = () => {
      if (settled) return;
      const wait = opts.silenceMs - (now() - opts.lastActivityAt());
      if (wait <= 0) {
        resolve("timeout");
        return;
      }
      timer = setTimeout(arm, wait);
    };
    arm();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    settled = true;
    if (timer) clearTimeout(timer);
  }
}

/**
 * Bound an otherwise-untrusted async turn. Promise.race installs terminal
 * handlers on the underlying promise, so a late rejection after the watchdog
 * fires cannot become unhandled; the caller can release its accounting in a
 * normal finally block.
 *
 * With `lastActivityAt`, the bound is silence since that observation — the
 * same clock as the prompt deadline, plus the grace already baked into
 * `timeoutMs`. Without it, the bound stays wall-clock from the call, which
 * is the pre-prompt path that has no runtime yet.
 */
export async function settleWithTurnWatchdog<T>(
  task: () => Promise<T>,
  opts: {
    timeoutMs: number;
    label: string;
    lastActivityAt?: () => number;
    now?: () => number;
  }
): Promise<T> {
  const work = Promise.resolve().then(task);
  if (!opts.lastActivityAt) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new TurnWatchdogTimeoutError(opts.label, opts.timeoutMs)),
        Math.max(1, opts.timeoutMs)
      );
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const outcome = await raceUntilSilence(work, {
    silenceMs: Math.max(1, opts.timeoutMs),
    lastActivityAt: opts.lastActivityAt,
    ...(opts.now ? { now: opts.now } : {}),
  });
  if (outcome === "timeout") {
    throw new TurnWatchdogTimeoutError(opts.label, opts.timeoutMs);
  }
  return outcome;
}

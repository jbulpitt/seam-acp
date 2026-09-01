/** Let the ordinary turn timeout finish its own cleanup before the hard guard. */
export const TURN_WATCHDOG_GRACE_MS = 30_000;

export function turnWatchdogTimeoutMs(turnTimeoutSeconds: number): number {
  return Math.max(1, turnTimeoutSeconds * 1000) + TURN_WATCHDOG_GRACE_MS;
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
 * Bound an otherwise-untrusted async turn. Promise.race installs terminal
 * handlers on the underlying promise, so a late rejection after the watchdog
 * fires cannot become unhandled; the caller can release its accounting in a
 * normal finally block.
 */
export async function settleWithTurnWatchdog<T>(
  task: () => Promise<T>,
  opts: { timeoutMs: number; label: string }
): Promise<T> {
  const work = Promise.resolve().then(task);
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

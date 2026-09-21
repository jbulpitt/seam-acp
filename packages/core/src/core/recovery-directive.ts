import type { ErrorVerdict, RecoveryRung } from "@seam/adapters";

/** Versioned wire DATA, not closures, Error objects, or provider wording. #467
 * will attach this to a daemon slot; until then execution is process-local.
 * Counts are additional attempts, never counts per nested caller. Rung 5 is a
 * report, not a provider call. Targets at rung 2 must be precomputed upstream. */
export interface RecoveryDirective {
  version: 1;
  scope: "conversation" | "ephemeral";
  startRung: RecoveryRung;
  surface: true;
  tier: ErrorVerdict["tier"];
  optionCount: number;
  steps: Array<{
    rung: RecoveryRung;
    retryCount: number;
    backoffMs: number[];
    optionIds: string[];
  }>;
}

export function buildRecoveryDirective(
  verdict: ErrorVerdict,
  scope: RecoveryDirective["scope"],
  permittedRungs: readonly RecoveryRung[] = [1, 5],
): RecoveryDirective {
  // #426/#448: refuse aggressive retries of ephemeral outward-effect work;
  // delivery proof owns that decision. Persistent conversations keep their
  // transcript (including tool results), so output is NOT a refusal predicate.
  const rungs = verdict.action === "stop" || scope === "ephemeral"
    ? [5] as const
    : ([1, 2, 3, 4, 5] as const).filter(rung =>
      rung === 5 || (rung >= verdict.startRung && permittedRungs.includes(rung)));
  return {
    version: 1, scope, startRung: verdict.startRung, surface: true,
    tier: verdict.tier, optionCount: verdict.optionCount,
    steps: rungs.map(rung => ({
      rung,
      retryCount: rung === 1 ? 3 : rung === 5 ? 0 : 1,
      backoffMs: rung === 1 ? [2_000, 5_000, 10_000] : rung === 5 ? [] : [0],
      optionIds: verdict.options.filter(option => option.rung === rung).map(option => option.id),
    })),
  };
}

/** One mechanical owner. A changed error may shorten/stop the first schedule,
 * never replenish it. Policy is supplied by the caller, not inferred here.
 * Only settled operations enter backoff: this introduces no silence timer and
 * cannot race #460's deadline or turnHealth's later staleness threshold. */
export async function runBoundedRecovery<T>(opts: {
  run: () => Promise<T>;
  delays: (error: unknown) => readonly number[];
  onRetry?: (error: unknown, retry: number, delayMs: number) => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}): Promise<T> {
  let budget: number | undefined;
  for (let retry = 0; ; retry++) {
    try { return await opts.run(); }
    catch (error) {
      const delays = opts.delays(error);
      budget ??= delays.length;
      // Cancellation refuses only further recovery, never destroys the session.
      // Cancel during backoff is reachable via /seam cancel and must not fire a
      // surprise paid prompt after the operator has stopped the work.
      if (retry >= budget || retry >= delays.length || opts.signal?.aborted) throw error;
      const delay = delays[retry]!;
      await opts.onRetry?.(error, retry + 1, delay);
      if (opts.sleep) await opts.sleep(delay);
      else await new Promise<void>(resolve => {
        const finish = () => {
          clearTimeout(timer);
          opts.signal?.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, delay);
        opts.signal?.addEventListener("abort", finish, { once: true });
        if (opts.signal?.aborted) finish();
      });
      if (opts.signal?.aborted) throw error;
    }
  }
}

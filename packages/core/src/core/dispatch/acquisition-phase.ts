import { DispatchSuspendedError } from "./attempt-store.js";

/**
 * Boot acquisition happens before a continuation prompt, so an unknown
 * transport/start failure is safe to retry with a bound. Named integrity and
 * capability refusals are permanent and must be surfaced immediately.
 */
export function isRetryableBootAcquisitionError(err: unknown): boolean {
  let current: unknown = err;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const typed = current as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
    if (typed.code === "session_load_timeout" || typed.name === "SessionLoadTimeoutError") return true;
    const message = typeof typed.message === "string" ? typed.message : "";
    if (/rpc 'spawn' timed out|ACP connection closed|Remote bridge is offline/i.test(message)) return true;
    current = typed.cause;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/Strict resume refused:/i.test(message) || /cwd does not exist/i.test(message)) return false;
  // Unknown pre-prompt transport failures get bounded retries. Exhaustion is
  // visible; this never permits prompt replay or an unbounded loop.
  return true;
}

/** Per-dispatch provenance, never a read of the orchestrator's ambient cutoff. */
export class DispatchAcquisitionPhase {
  private readonly pending = new Set<() => void>();

  constructor(readonly dispatchId: string, readonly phase: "execution" | "boot-recovery") {}

  /** The shutdown event takes ownership of acquisitions that are still pending. */
  shutdown(): void {
    for (const cancel of this.pending) cancel();
  }

  async acquire<T>(operation: () => Promise<T>): Promise<T> {
    let cancel!: () => void;
    const shutdown = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(DispatchSuspendedError.shutdown(this.dispatchId,
        "shutdown interrupted provider acquisition; the next boot owns the dispatch"));
    });
    this.pending.add(cancel);
    const work = Promise.resolve().then(operation);
    try {
      return await Promise.race([work, shutdown]);
    } catch (err) {
      // Refuse only this acquisition. Keep the recorded session recoverable;
      // explicit integrity/identity defects remain actionable in every phase.
      try { await work; }
      catch (cause) { if (cause instanceof DispatchSuspendedError) throw cause; }
      if (err instanceof DispatchSuspendedError) throw err;
      const reason = `provider acquisition failed during ${this.phase}: ${err instanceof Error ? err.message : String(err)}`;
      // #421: a boot-time spawn/load failure happens before prompt submission,
      // so retrying this recorded session cannot replay the original brief. It
      // refuses only this acquisition while other dispatches keep running. The
      // watcher owns the bounded retry/backoff and turns exhaustion into a
      // visible quarantine; a real shutdown still arrives through the explicit
      // DispatchSuspendedError above and is left for the next boot.
      throw this.phase === "boot-recovery" && isRetryableBootAcquisitionError(err)
        ? DispatchSuspendedError.retryable(this.dispatchId, reason)
        : DispatchSuspendedError.defect(this.dispatchId, reason);
    } finally {
      this.pending.delete(cancel);
      // Do not let a late start/load finish after injectTurn has disposed its
      // runtime. Shutdown tears down the transport; wait for its RPC to settle.
      await work.catch(() => {});
    }
  }
}

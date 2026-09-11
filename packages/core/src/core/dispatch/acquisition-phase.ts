import { DispatchSuspendedError } from "./attempt-store.js";

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
      throw this.phase === "boot-recovery"
        ? DispatchSuspendedError.shutdown(this.dispatchId, reason)
        : DispatchSuspendedError.defect(this.dispatchId, reason);
    } finally {
      this.pending.delete(cancel);
      // Do not let a late start/load finish after injectTurn has disposed its
      // runtime. Shutdown tears down the transport; wait for its RPC to settle.
      await work.catch(() => {});
    }
  }
}

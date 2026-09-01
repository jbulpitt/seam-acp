import type { Logger } from "../lib/logger.js";

export const DELEGATION_RECONCILE_INTERVAL_MS = 60_000;

export interface DelegationReconcilerStore {
  abandonStaleRunningDelegations(cutoffUtc: string, nowUtc?: string): number;
}

/** Boot + periodic cleanup for delegation rows whose owning turn never settled. */
export class DelegationReconciler {
  private readonly store: DelegationReconcilerStore;
  private readonly logger: Logger;
  private readonly maxAgeMs: number;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private timer?: ReturnType<typeof setInterval>;

  constructor(opts: {
    store: DelegationReconcilerStore;
    logger: Logger;
    maxAgeMs: number;
    intervalMs?: number;
    now?: () => number;
  }) {
    this.store = opts.store;
    this.logger = opts.logger.child({ comp: "delegation-reconciler" });
    this.maxAgeMs = Math.max(0, opts.maxAgeMs);
    this.intervalMs = Math.max(1, opts.intervalMs ?? DELEGATION_RECONCILE_INTERVAL_MS);
    this.now = opts.now ?? Date.now;
  }

  reconcile(): number {
    const nowMs = this.now();
    const nowUtc = new Date(nowMs).toISOString();
    const cutoffUtc = new Date(nowMs - this.maxAgeMs).toISOString();
    const abandoned = this.store.abandonStaleRunningDelegations(cutoffUtc, nowUtc);
    if (abandoned > 0) {
      this.logger.warn(
        { abandoned, cutoffUtc, maxAgeMs: this.maxAgeMs },
        "abandoned stale running delegation rows"
      );
    }
    return abandoned;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.reconcile();
      } catch (err) {
        this.logger.error({ err }, "delegation reconciliation sweep failed");
      }
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

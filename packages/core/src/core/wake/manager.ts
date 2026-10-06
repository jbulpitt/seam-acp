/**
 * WakeManager — the DB sweeper for agent-scheduled wake events (#59).
 *
 * Unlike `ScheduledPromptManager` (which arms in-memory croner timers), a wake
 * is one-shot and durable, so this polls the DB for due rows on a short interval
 * (D11) rather than holding timers. That is restart-safe by construction: there
 * is nothing to rehydrate or re-arm — a reboot just resumes sweeping, and any
 * wake that came due while down is caught on the first sweep. It also sidesteps
 * the `setTimeout` >2^31 ms overflow if long delays are ever allowed.
 *
 * Due and startup wakes remain here until dispatch admission consumes them.
 * The dispatch queue then owns delivery. Timed catch-up policy is unchanged.
 */
import type { SessionStore } from "../session-store.js";
import type { WakeEvent } from "./types.js";
import { WAKE_SWEEP_MS } from "./types.js";
import type { Logger } from "../../lib/logger.js";

export interface WakeManagerOpts {
  store: SessionStore;
  /** Consume the row in the same transaction as dispatch admission. */
  onFire: (wake: WakeEvent, consume: () => void) => Promise<void>;
  logger: Logger;
  /** Sweep interval in ms. Default `WAKE_SWEEP_MS` (~30s). */
  sweepMs?: number;
}

export class WakeManager {
  private readonly store: SessionStore;
  private readonly onFire: WakeManagerOpts["onFire"];
  private readonly logger: Logger;
  private readonly sweepMs: number;
  private timer?: ReturnType<typeof setInterval>;
  /** Reentrancy guard: a slow sweep must not overlap the next interval tick. */
  private sweeping = false;
  private readonly activePasses = new Set<Promise<void>>();
  private stopped = false;
  private readonly startupPending = new Set<string>();

  constructor(opts: WakeManagerOpts) {
    this.store = opts.store;
    this.onFire = opts.onFire;
    this.logger = opts.logger;
    this.sweepMs = opts.sweepMs ?? WAKE_SWEEP_MS;
  }

  /** Select boot-triggered wakes, sweep immediately, then arm the interval. */
  start(): void {
    if (this.stopped) return;
    void this.fireStartupWakes();
    this.timer = setInterval(() => this.onSweepTick(), this.sweepMs);
    // Don't hold the event loop open just for the poller.
    this.timer.unref?.();
    this.logger.info({ sweepMs: this.sweepMs }, "wake sweeper started");
  }

  /** Select this boot's wakes; failed admissions retry in the existing sweep. */
  fireStartupWakes(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    try {
      for (const wake of this.store.listStartupWakes()) this.startupPending.add(wake.id);
    } catch (err) {
      this.logger.warn({ err }, "wake startup pass failed");
    }
    return this.sweep();
  }

  private async fire(wake: WakeEvent): Promise<void> {
    let consumed = false;
    const consume = () => {
      if (consumed) return;
      this.store.deleteWake(wake.id);
      consumed = true;
    };
    try {
      await this.onFire(wake, consume);
      if (consumed) this.startupPending.delete(wake.id);
    } catch (err) {
      this.logger.error({ id: wake.id, err }, "wake fire failed");
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Interval entry: a tick queued before stop is a no-op once admission is closed. */
  private onSweepTick(): void {
    if (this.stopped) return;
    void this.sweep();
  }

  async drain(): Promise<void> {
    while (this.activePasses.size > 0) {
      await Promise.allSettled([...this.activePasses]);
    }
  }

  /**
   * One sweep: fire (or drop) every wake whose time has come. Resolves when all
   * due rows picked up by this sweep have been handled — which is what makes the
   * sweeper testable without real timers.
   */
  sweep(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.sweeping) return Promise.resolve();
    this.sweeping = true;
    return this.trackPass(() => this.sweepInner()).finally(() => {
      this.sweeping = false;
    });
  }

  private async sweepInner(): Promise<void> {
    try {
      const now = Date.now();
      for (const id of this.startupPending) {
        const wake = this.store.getWake(id);
        if (!wake) {
          this.startupPending.delete(id);
          continue;
        }
        this.logger.info({ id }, "wake: firing on startup");
        await this.fire(wake);
      }
      const due = this.store.listDueWakes(new Date(now).toISOString());
      for (const wake of due) {
        const dueAt = Date.parse(wake.fireAtUtc);
        const overdueSec = isNaN(dueAt) ? 0 : Math.round((now - dueAt) / 1000);

        // D10: too stale to fire — drop it. (catchupSeconds <= 0 means "never
        // catch up", so any overdue fire is dropped.)
        if (
          overdueSec > 0 &&
          (wake.catchupSeconds <= 0 || overdueSec > wake.catchupSeconds)
        ) {
          this.store.deleteWake(wake.id);
          this.logger.info(
            { id: wake.id, overdueSec, window: wake.catchupSeconds },
            "wake: missed catch-up window, dropping"
          );
          continue;
        }

        await this.fire(wake);
      }
    } catch (err) {
      this.logger.warn({ err }, "wake sweep failed");
    }
  }

  private trackPass(run: () => Promise<void>): Promise<void> {
    const running = Promise.resolve().then(run);
    const tracked = running.finally(() => this.activePasses.delete(tracked));
    this.activePasses.add(tracked);
    return tracked;
  }
}

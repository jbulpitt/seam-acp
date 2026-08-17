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
 * Per due row (mirroring `ScheduledPromptManager.catchUp` for D10):
 *  1. If the wake is overdue by more than its `catchupSeconds` window, DROP it
 *     (delete + log) — a stale wake firing hours late is worse than not firing.
 *  2. Otherwise DELETE the row *before* firing (D1), so a crash mid-turn can
 *     never re-fire it (delete-before-fire trades a possibly-lost wake for
 *     never double-firing — the safer direction).
 *  3. Invoke `onFire(wake)` — the orchestrator's callback that enqueues a
 *     dispatch spec through the shipped queue (delivery is that queue's job).
 *
 * `start()` runs one immediate sweep (so a wake already due at boot fires
 * without waiting a full interval), then fires any boot-triggered wakes
 * (`fire_on_startup`, #59 extension) through the SAME delete-before-fire path,
 * then arms the interval. Boot shape mirrors `ScheduledPromptManager.start()`.
 */
import type { SessionStore } from "../session-store.js";
import type { WakeEvent } from "./types.js";
import { WAKE_SWEEP_MS } from "./types.js";
import type { Logger } from "../../lib/logger.js";

export interface WakeManagerOpts {
  store: SessionStore;
  /** Deliver a due wake (enqueue its dispatch). The row is already deleted when
   *  this is called (D1); `onFire` owns preconditions + delivery + the ledger. */
  onFire: (wake: WakeEvent) => Promise<void>;
  logger: Logger;
  /** Sweep interval in ms. Default `WAKE_SWEEP_MS` (~30s). */
  sweepMs?: number;
}

export class WakeManager {
  private readonly store: SessionStore;
  private readonly onFire: (wake: WakeEvent) => Promise<void>;
  private readonly logger: Logger;
  private readonly sweepMs: number;
  private timer?: ReturnType<typeof setInterval>;
  /** Reentrancy guard: a slow sweep must not overlap the next interval tick. */
  private sweeping = false;

  constructor(opts: WakeManagerOpts) {
    this.store = opts.store;
    this.onFire = opts.onFire;
    this.logger = opts.logger;
    this.sweepMs = opts.sweepMs ?? WAKE_SWEEP_MS;
  }

  /** Sweep once now (catch-up), fire boot-triggered wakes, then arm the
   *  interval. The catch-up sweep and the startup pass both run BEFORE the
   *  interval is armed (kicked off here, non-blocking so boot isn't delayed). */
  start(): void {
    void this.sweep();
    void this.fireStartupWakes();
    this.timer = setInterval(() => void this.sweep(), this.sweepMs);
    // Don't hold the event loop open just for the poller.
    this.timer.unref?.();
    this.logger.info({ sweepMs: this.sweepMs }, "wake sweeper started");
  }

  /**
   * Fire every boot-triggered wake once, on this process start (#59 extension).
   *
   * Boot-triggered wakes are excluded from the time sweep (`listDueWakes`), so
   * this is their only firing path. Each goes through the SAME safety-critical
   * `deleteThenFire` helper as a due wake: the row is DELETED BEFORE `onFire`
   * (D1). That is load-bearing here — a crash during the woken turn must not
   * re-fire the wake on the NEXT reboot, which would be an infinite boot-loop.
   * One-shot: fired, then gone. Unlike the sweep, no catch-up/drop check — a
   * startup wake fires on the next boot however long the process was down.
   */
  async fireStartupWakes(): Promise<void> {
    try {
      const startup = this.store.listStartupWakes();
      for (const wake of startup) {
        this.logger.info({ id: wake.id }, "wake: firing on startup");
        await this.deleteThenFire(wake);
      }
    } catch (err) {
      this.logger.warn({ err }, "wake startup pass failed");
    }
  }

  /**
   * Delete-before-fire (D1): remove the row, THEN invoke `onFire`. Deleting
   * first trades a possibly-lost wake for never double-firing (the safer
   * direction) — a crash after the delete simply loses the wake rather than
   * re-firing it every sweep/boot. Shared by the time sweep and the startup
   * pass so both preserve the invariant identically; do not weaken it.
   */
  private async deleteThenFire(wake: WakeEvent): Promise<void> {
    this.store.deleteWake(wake.id);
    try {
      await this.onFire(wake);
    } catch (err) {
      this.logger.error({ id: wake.id, err }, "wake fire failed");
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * One sweep: fire (or drop) every wake whose time has come. Resolves when all
   * due rows picked up by this sweep have been handled — which is what makes the
   * sweeper testable without real timers.
   */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const now = Date.now();
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

        // D1: delete BEFORE firing so a crash mid-turn can't re-fire it.
        await this.deleteThenFire(wake);
      }
    } catch (err) {
      this.logger.warn({ err }, "wake sweep failed");
    } finally {
      this.sweeping = false;
    }
  }
}

/**
 * WatchManager — the DB sweeper for agent-defined watches (#60).
 *
 * A direct sibling of `WakeManager` (#59): both poll the DB on a short interval
 * and are restart-safe by construction (nothing to rehydrate — a reboot resumes
 * sweeping). The ONLY difference is the due-check: a wake compares a timestamp;
 * a watch runs a predicate (`evaluate`) and fires only when the condition trips
 * (D1 — the model is never invoked to check; the cheap poll runs here).
 *
 * Per swept watch:
 *  1. EXPIRY (D4) — past `expiresAtUtc`: delete, then `onExpire` injects a turn
 *     saying so. A watch that quietly evaporates is the worst outcome (the agent
 *     believes it is still waiting), so expiry is loud, not silent.
 *  2. DUE-CHECK — skip if `lastCheckedUtc + intervalSeconds` has not passed.
 *  3. EVALUATE — run the predicate. A transient error (network blip, missing
 *     file) records the check time and moves on; the watch survives (`|| true`).
 *     A privileged-source refusal (command disabled/not allowlisted) stops the
 *     watch with a notice (D8 backstop).
 *  4. FIRE — on a tripped predicate: enforce the per-thread hourly rate cap
 *     (D5), then deliver. `once` (D3 default) deletes BEFORE firing (mirroring
 *     #59 D1 — a crash mid-turn can never re-fire). `each` increments and stops
 *     with a notice once `maxFires` is reached.
 *
 * BATCHING (D5): one evaluation yields at most one event whose `eventText`
 * carries everything the check saw (all of stdout, the whole matched body), so a
 * chatty source is delivered as a SINGLE turn by construction — the sweep never
 * fans one check into many turns. Runaway *frequency* is bounded by `maxFires`
 * and the per-thread hourly cap, which stop the watch with a visible notice.
 */
import type { WatchEvent, WatchEvalResult } from "./types.js";
import { WATCH_SWEEP_MS, WATCH_MAX_FIRES_PER_THREAD_PER_HOUR } from "./types.js";
import type { Logger } from "../../lib/logger.js";

export interface WatchManagerStore {
  /** Every live watch, oldest first — the sweeper's work list. */
  listAllWatches(): WatchEvent[];
  /** Record that a watch was evaluated at `checkedUtc`, persisting the new
   *  change-detection snapshot (`observed`, may be null to keep the prior one). */
  markWatchChecked(id: string, checkedUtc: string, observed: string | null): void;
  /** A non-terminal `each` fire: bump `fireCount` + `lastFiredUtc`. */
  incrementWatchFire(id: string, firedUtc: string): void;
  deleteWatch(id: string): void;
}

export interface WatchManagerOpts {
  store: WatchManagerStore;
  /** Run one watch's predicate (the cheap bridge-side check). */
  evaluate: (watch: WatchEvent) => Promise<WatchEvalResult>;
  /** Deliver a fired watch (enqueue its dispatch). The row is already handled
   *  (deleted for `once`, incremented for `each`) when this is called. */
  onFire: (watch: WatchEvent, eventText: string) => Promise<void>;
  /** A watch reached its expiry — inject a turn saying so (D4). The row is
   *  already deleted. */
  onExpire: (watch: WatchEvent) => Promise<void>;
  /** A watch was stopped early (rate cap, maxFires, refusal) — post a visible
   *  notice saying why (D5, never silently). The row is already deleted. */
  onStopped: (watch: WatchEvent, reason: string) => Promise<void>;
  logger: Logger;
  sweepMs?: number;
}

export class WatchManager {
  private readonly store: WatchManagerStore;
  private readonly evaluate: (watch: WatchEvent) => Promise<WatchEvalResult>;
  private readonly onFire: (watch: WatchEvent, eventText: string) => Promise<void>;
  private readonly onExpire: (watch: WatchEvent) => Promise<void>;
  private readonly onStopped: (watch: WatchEvent, reason: string) => Promise<void>;
  private readonly logger: Logger;
  private readonly sweepMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private sweeping = false;
  private readonly activeSweeps = new Set<Promise<void>>();
  private stopped = false;
  /** Rolling per-thread fire timestamps (ms) for the hourly rate cap (D5). In
   *  memory — a rate *backstop*, not durable accounting; a restart resets it. */
  private readonly fireHistory = new Map<string, number[]>();

  constructor(opts: WatchManagerOpts) {
    this.store = opts.store;
    this.evaluate = opts.evaluate;
    this.onFire = opts.onFire;
    this.onExpire = opts.onExpire;
    this.onStopped = opts.onStopped;
    this.logger = opts.logger;
    this.sweepMs = opts.sweepMs ?? WATCH_SWEEP_MS;
  }

  start(): void {
    if (this.stopped) return;
    void this.sweep();
    this.timer = setInterval(() => this.onSweepTick(), this.sweepMs);
    this.timer.unref?.();
    this.logger.info({ sweepMs: this.sweepMs }, "watch sweeper started");
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
    while (this.activeSweeps.size > 0) {
      await Promise.allSettled([...this.activeSweeps]);
    }
  }

  /** One sweep: expire, evaluate, and fire every watch whose predicate trips.
   *  Resolves when all watches picked up by this sweep have been handled — the
   *  property that makes the sweeper testable without real timers. */
  sweep(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.sweeping) return Promise.resolve();
    this.sweeping = true;
    const running = this.sweepInner();
    const tracked = running.finally(() => {
      this.sweeping = false;
      this.activeSweeps.delete(tracked);
    });
    this.activeSweeps.add(tracked);
    return tracked;
  }

  private async sweepInner(): Promise<void> {
    try {
      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      for (const watch of this.store.listAllWatches()) {
        try {
          await this.handleOne(watch, now, nowIso);
        } catch (err) {
          this.logger.error({ id: watch.id, err }, "watch handling failed");
        }
      }
    } catch (err) {
      this.logger.warn({ err }, "watch sweep failed");
    }
  }

  private async handleOne(watch: WatchEvent, now: number, nowIso: string): Promise<void> {
    // 1. Expiry (D4) — loud, never silent.
    const expiresAt = Date.parse(watch.expiresAtUtc);
    if (!isNaN(expiresAt) && expiresAt <= now) {
      this.store.deleteWatch(watch.id);
      this.logger.info(
        { id: watch.id, channel: watch.channelRef, fireCount: watch.fireCount },
        "watch: expired; injecting notice turn"
      );
      await this.onExpire(watch);
      return;
    }

    // 2. Due-check — has `interval` elapsed since the last check?
    const lastChecked = watch.lastCheckedUtc ? Date.parse(watch.lastCheckedUtc) : 0;
    if (!isNaN(lastChecked) && lastChecked + watch.intervalSeconds * 1000 > now) {
      return;
    }

    // 3. Evaluate the predicate (the cheap bridge-side poll).
    const result = await this.evaluate(watch);

    // A privileged-source refusal stops the watch (D8 backstop): a command watch
    // that was armed before the flag flipped must not keep running.
    if (result.refused) {
      this.store.deleteWatch(watch.id);
      this.logger.warn(
        { id: watch.id, channel: watch.channelRef, reason: result.refused },
        "watch: refused at evaluation; stopping"
      );
      await this.onStopped(watch, result.refused);
      return;
    }

    // Persist the check time + snapshot regardless of outcome.
    this.store.markWatchChecked(watch.id, nowIso, result.observed);

    if (result.error) {
      // Transient — the watch survives and retries next interval.
      this.logger.debug(
        { id: watch.id, kind: watch.kind, err: result.error },
        "watch: transient check failure; retrying next interval"
      );
      return;
    }

    if (!result.fired) return;

    // 4. Fired. Enforce the per-thread hourly rate cap (D5) BEFORE delivering.
    if (this.rateExceeded(watch.channelRef, now)) {
      this.store.deleteWatch(watch.id);
      const reason = `per-thread rate cap reached (${WATCH_MAX_FIRES_PER_THREAD_PER_HOUR} fires/hour)`;
      this.logger.warn({ id: watch.id, channel: watch.channelRef }, `watch: ${reason}; stopping`);
      await this.onStopped(watch, reason);
      return;
    }
    this.recordFire(watch.channelRef, now);

    // `once` (D3): delete BEFORE firing so a crash mid-turn can't re-fire it.
    if (watch.mode === "once") {
      this.store.deleteWatch(watch.id);
      this.logger.info(
        { id: watch.id, channel: watch.channelRef, kind: watch.kind },
        "watch: fired (once); deleted"
      );
      await this.onFire(watch, result.eventText);
      return;
    }

    // `each`: stop after `maxFires` with a notice; otherwise increment and stay armed.
    const nextCount = watch.fireCount + 1;
    if (nextCount >= watch.maxFires) {
      this.store.deleteWatch(watch.id);
      this.logger.info(
        { id: watch.id, channel: watch.channelRef, fires: nextCount, maxFires: watch.maxFires },
        "watch: reached maxFires; firing final + stopping"
      );
      await this.onFire(watch, result.eventText);
      await this.onStopped(watch, `reached maxFires (${watch.maxFires})`);
      return;
    }
    this.store.incrementWatchFire(watch.id, nowIso);
    this.logger.info(
      { id: watch.id, channel: watch.channelRef, fires: nextCount, maxFires: watch.maxFires },
      "watch: fired (each)"
    );
    await this.onFire(watch, result.eventText);
  }

  /** Would one more fire for this thread breach the rolling-hour cap? Prunes
   *  entries older than an hour as a side effect. */
  private rateExceeded(channelRef: string, now: number): boolean {
    const cutoff = now - 3_600_000;
    const hist = (this.fireHistory.get(channelRef) ?? []).filter((t) => t > cutoff);
    this.fireHistory.set(channelRef, hist);
    return hist.length >= WATCH_MAX_FIRES_PER_THREAD_PER_HOUR;
  }

  private recordFire(channelRef: string, now: number): void {
    const hist = this.fireHistory.get(channelRef) ?? [];
    hist.push(now);
    this.fireHistory.set(channelRef, hist);
  }
}

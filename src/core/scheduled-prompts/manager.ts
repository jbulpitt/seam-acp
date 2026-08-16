/**
 * ScheduledPromptManager — owns the in-memory croner timers for enabled
 * scheduled prompts, rehydrated from the DB on every boot. Firing is delegated
 * to an injected `onFire(id)` (the orchestrator's isolated runner). The manager
 * is the sole owner of `next_run_utc`; `onFire` only touches last_run/last_status.
 *
 * Catch-up: on boot, if a schedule's stored next-run was missed but within its
 * `catchupSeconds` window, fire it once; otherwise roll forward. Never bursts.
 */
import { Cron } from "croner";
import type { SessionStore } from "../session-store.js";
import type { ScheduledPrompt } from "./types.js";
import type { Logger } from "../../lib/logger.js";

export interface ScheduledPromptManagerOpts {
  store: SessionStore;
  /** Run the schedule now. Updates last_run/last_status; must NOT touch next_run. */
  onFire: (id: string) => Promise<void>;
  logger: Logger;
}

export class ScheduledPromptManager {
  private readonly jobs = new Map<string, Cron>();
  /** Schedule ids whose `onFire` is currently running. Guards same-schedule
   *  overlap (D3): a fire that lands while a prior fire of the same id is still
   *  in flight is skipped (status-stamped) rather than stacked. Covers both the
   *  timer path and the boot catch-up path (both go through `fire`). */
  private readonly inFlight = new Set<string>();
  private readonly store: SessionStore;
  private readonly onFire: (id: string) => Promise<void>;
  private readonly logger: Logger;

  constructor(opts: ScheduledPromptManagerOpts) {
    this.store = opts.store;
    this.onFire = opts.onFire;
    this.logger = opts.logger;
  }

  /** Rehydrate: catch-up missed fires, then arm every enabled schedule. */
  start(): void {
    const rows = this.store.listScheduledEnabled();
    for (const row of rows) {
      this.catchUp(row); // uses the pre-downtime next_run_utc; may fire once
      this.armFromRow(row); // sets a fresh forward next_run_utc
    }
    this.logger.info({ count: rows.length }, "scheduled prompts armed");
  }

  /** (Re)arm a single schedule from its current row. No-op (disarms) if disabled. */
  armFromRow(row: ScheduledPrompt): void {
    this.disarm(row.id);
    if (!row.enabled) return;
    let job: Cron;
    try {
      job = new Cron(row.cron, { timezone: row.timezone, name: row.id }, () => {
        void this.fire(row.id);
      });
    } catch (err) {
      this.logger.error({ id: row.id, cron: row.cron, err }, "invalid cron; not armed");
      this.patchRow(row.id, { lastStatus: `error: invalid cron (${(err as Error).message})` });
      return;
    }
    this.jobs.set(row.id, job);
    this.patchRow(row.id, { nextRunUtc: job.nextRun()?.toISOString() ?? null });
  }

  /** Re-read a schedule from the store and (re)arm or disarm accordingly. */
  reschedule(id: string): void {
    const row = this.store.getScheduled(id);
    if (row) this.armFromRow(row);
    else this.disarm(id);
  }

  disarm(id: string): void {
    const job = this.jobs.get(id);
    if (job) {
      job.stop();
      this.jobs.delete(id);
    }
  }

  /** Number of currently-armed schedules (for diagnostics). */
  get armedCount(): number {
    return this.jobs.size;
  }

  stop(): void {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
  }

  // --- internals ------------------------------------------------------------

  private catchUp(row: ScheduledPrompt): void {
    if (!row.nextRunUtc) return; // never armed before — nothing was due
    const due = Date.parse(row.nextRunUtc);
    if (isNaN(due) || due > Date.now()) return; // not missed
    const missedBySec = Math.round((Date.now() - due) / 1000);
    if (row.catchupSeconds > 0 && missedBySec <= row.catchupSeconds) {
      this.logger.info({ id: row.id, missedBySec }, "scheduled prompt: catch-up firing");
      void this.fire(row.id);
    } else {
      this.logger.info(
        { id: row.id, missedBySec, window: row.catchupSeconds },
        "scheduled prompt: missed window, skipping catch-up"
      );
    }
  }

  /** Execute one fire: run the job, then refresh next_run from the armed timer. */
  private async fire(id: string): Promise<void> {
    // D3: skip (don't stack) if a prior fire of this same schedule is still
    // running. With live + per-channel FIFO, stacking would grow the channel
    // queue without bound and pin the thread replaying stale fires.
    if (this.inFlight.has(id)) {
      this.logger.info({ id }, "scheduled prompt: still running, skipping overlap");
      this.patchRow(id, { lastStatus: "skipped: still running" });
      return;
    }
    this.inFlight.add(id);
    try {
      await this.onFire(id);
    } catch (err) {
      this.logger.error({ id, err }, "scheduled fire failed");
    } finally {
      this.inFlight.delete(id);
      const job = this.jobs.get(id);
      if (job) this.patchRow(id, { nextRunUtc: job.nextRun()?.toISOString() ?? null });
    }
  }

  /** Re-read fresh and patch a few fields, preserving everything else (avoids
   *  clobbering concurrent last_run/last_status writes from onFire). */
  private patchRow(id: string, patch: Partial<Pick<ScheduledPrompt, "nextRunUtc" | "lastStatus">>): void {
    const fresh = this.store.getScheduled(id);
    if (!fresh) return;
    this.store.upsertScheduled({ ...fresh, ...patch });
  }
}

/**
 * ScheduledPromptManager — owns the in-memory croner timers for enabled
 * scheduled prompts, rehydrated from the DB on every boot. Firing is delegated
 * to an injected `onFire(id)` (the orchestrator's isolated runner). The manager
 * is the sole owner of `next_run_utc`; `onFire` only touches last_run/last_status.
 *
 * Catch-up: on boot, if a schedule's stored next-run is in the past, fire it
 * once, then arm forward. Never bursts. A long restart-drain must not drop a
 * missed slot — there is no catch-up window skip.
 */
import { Cron } from "croner";
import type { SessionStore } from "../session-store.js";
import type { ScheduledPrompt } from "./types.js";
import { legacyAttachmentQuarantine, legacyAttachmentStatus } from "./quarantine.js";
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
  private readonly activeFires = new Set<Promise<void>>();
  private readonly store: SessionStore;
  private readonly onFire: (id: string) => Promise<void>;
  private readonly logger: Logger;

  constructor(opts: ScheduledPromptManagerOpts) {
    this.store = opts.store;
    this.onFire = opts.onFire;
    this.logger = opts.logger;
  }

  /** Rehydrate: catch-up missed fires, then arm every enabled schedule.
   *  #158: an enabled row that still carries legacy attachments is reported and
   *  left disarmed — it is neither caught up nor armed. */
  start(): void {
    const rows = this.store.listScheduledEnabled();
    const quarantined: string[] = [];
    for (const row of rows) {
      if (legacyAttachmentQuarantine(row)) {
        quarantined.push(row.id);
        this.armFromRow(row); // reports + stamps the row; arms nothing
        continue;
      }
      this.catchUp(row); // uses the pre-downtime next_run_utc; may fire once
      this.armFromRow(row); // sets a fresh forward next_run_utc
    }
    this.logger.info(
      { count: rows.length - quarantined.length, quarantined: quarantined.length },
      "scheduled prompts armed"
    );
    if (quarantined.length > 0) {
      this.logger.warn(
        { ids: quarantined },
        "scheduled prompts NOT armed: enabled rows still carry legacy attachments (#158); " +
          "edit each schedule so its prompt references a repository runbook"
      );
    }
  }

  /** (Re)arm a single schedule from its current row. No-op (disarms) if disabled
   *  or quarantined by a legacy attachment manifest (#158). */
  armFromRow(row: ScheduledPrompt): void {
    this.disarm(row.id);
    if (!row.enabled) return;
    // #158 arming boundary: refuse an enabled legacy attachment-bearing row.
    // Its prompt was authored assuming the files would be re-sent; running it
    // silently without them is the failure mode we are removing.
    const quarantine = legacyAttachmentQuarantine(row);
    if (quarantine) {
      this.logger.warn({ id: row.id, name: row.name, files: row.legacyAttachmentCount }, quarantine);
      this.patchRow(row.id, { lastStatus: legacyAttachmentStatus(row), nextRunUtc: null });
      return;
    }
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

  async drain(): Promise<void> {
    while (this.activeFires.size > 0) {
      await Promise.allSettled([...this.activeFires]);
    }
  }

  /** Manual invoke: same `onFire` path as the cron tick (isolated vs live,
   *  cards vs messages, model). Does not consume a cron slot — `next_run` is
   *  only refreshed from the armed timer if one exists. Honors the in-flight
   *  overlap guard. Works on disabled rows, but not on a row quarantined by a
   *  legacy attachment manifest (#158). */
  runNow(id: string): Promise<void> {
    return this.fire(id);
  }

  // --- internals ------------------------------------------------------------

  private catchUp(row: ScheduledPrompt): void {
    if (!row.nextRunUtc) return; // never armed before — nothing was due
    const due = Date.parse(row.nextRunUtc);
    if (isNaN(due) || due > Date.now()) return; // not missed
    const missedBySec = Math.round((Date.now() - due) / 1000);
    this.logger.info({ id: row.id, missedBySec }, "scheduled prompt: catch-up firing");
    void this.fire(row.id);
  }

  /** Execute one fire: run the job, then refresh next_run from the armed timer. */
  private fire(id: string): Promise<void> {
    const running = this.fireInner(id);
    const tracked = running.finally(() => this.activeFires.delete(tracked));
    this.activeFires.add(tracked);
    return tracked;
  }

  private async fireInner(id: string): Promise<void> {
    // #158: last line of defence. `armFromRow` never arms a quarantined row, but
    // catch-up and manual "Run now" reach `fire` directly — refuse there too so
    // there is exactly one answer for a legacy attachment-bearing schedule.
    const current = this.store.getScheduled(id);
    if (current) {
      const quarantine = legacyAttachmentQuarantine(current);
      if (quarantine) {
        this.logger.warn({ id, files: current.legacyAttachmentCount }, quarantine);
        this.patchRow(id, { lastStatus: legacyAttachmentStatus(current) });
        return;
      }
    }
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

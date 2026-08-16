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
export class ScheduledPromptManager {
    jobs = new Map();
    store;
    onFire;
    logger;
    constructor(opts) {
        this.store = opts.store;
        this.onFire = opts.onFire;
        this.logger = opts.logger;
    }
    /** Rehydrate: catch-up missed fires, then arm every enabled schedule. */
    start() {
        const rows = this.store.listScheduledEnabled();
        for (const row of rows) {
            this.catchUp(row); // uses the pre-downtime next_run_utc; may fire once
            this.armFromRow(row); // sets a fresh forward next_run_utc
        }
        this.logger.info({ count: rows.length }, "scheduled prompts armed");
    }
    /** (Re)arm a single schedule from its current row. No-op (disarms) if disabled. */
    armFromRow(row) {
        this.disarm(row.id);
        if (!row.enabled)
            return;
        let job;
        try {
            job = new Cron(row.cron, { timezone: row.timezone, name: row.id }, () => {
                void this.fire(row.id);
            });
        }
        catch (err) {
            this.logger.error({ id: row.id, cron: row.cron, err }, "invalid cron; not armed");
            this.patchRow(row.id, { lastStatus: `error: invalid cron (${err.message})` });
            return;
        }
        this.jobs.set(row.id, job);
        this.patchRow(row.id, { nextRunUtc: job.nextRun()?.toISOString() ?? null });
    }
    /** Re-read a schedule from the store and (re)arm or disarm accordingly. */
    reschedule(id) {
        const row = this.store.getScheduled(id);
        if (row)
            this.armFromRow(row);
        else
            this.disarm(id);
    }
    disarm(id) {
        const job = this.jobs.get(id);
        if (job) {
            job.stop();
            this.jobs.delete(id);
        }
    }
    /** Number of currently-armed schedules (for diagnostics). */
    get armedCount() {
        return this.jobs.size;
    }
    stop() {
        for (const job of this.jobs.values())
            job.stop();
        this.jobs.clear();
    }
    // --- internals ------------------------------------------------------------
    catchUp(row) {
        if (!row.nextRunUtc)
            return; // never armed before — nothing was due
        const due = Date.parse(row.nextRunUtc);
        if (isNaN(due) || due > Date.now())
            return; // not missed
        const missedBySec = Math.round((Date.now() - due) / 1000);
        if (row.catchupSeconds > 0 && missedBySec <= row.catchupSeconds) {
            this.logger.info({ id: row.id, missedBySec }, "scheduled prompt: catch-up firing");
            void this.fire(row.id);
        }
        else {
            this.logger.info({ id: row.id, missedBySec, window: row.catchupSeconds }, "scheduled prompt: missed window, skipping catch-up");
        }
    }
    /** Execute one fire: run the job, then refresh next_run from the armed timer. */
    async fire(id) {
        try {
            await this.onFire(id);
        }
        catch (err) {
            this.logger.error({ id, err }, "scheduled fire failed");
        }
        finally {
            const job = this.jobs.get(id);
            if (job)
                this.patchRow(id, { nextRunUtc: job.nextRun()?.toISOString() ?? null });
        }
    }
    /** Re-read fresh and patch a few fields, preserving everything else (avoids
     *  clobbering concurrent last_run/last_status writes from onFire). */
    patchRow(id, patch) {
        const fresh = this.store.getScheduled(id);
        if (!fresh)
            return;
        this.store.upsertScheduled({ ...fresh, ...patch });
    }
}
//# sourceMappingURL=manager.js.map
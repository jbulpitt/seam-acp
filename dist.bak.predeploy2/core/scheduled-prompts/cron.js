/**
 * Cron helpers: validate + describe in plain English + compute next run.
 * croner does the scheduling/timezone math; cronstrue does the English.
 */
import { Cron } from "croner";
import cronstrue from "cronstrue";
/** Plain-English description of a cron expression (falls back to the raw cron). */
export function describeCron(cron) {
    try {
        return cronstrue.toString(cron, { use24HourTimeFormat: false, verbose: false });
    }
    catch {
        return cron;
    }
}
/** Validate a cron expression against a timezone; returns the next run if valid. */
export function validateCron(cron, timezone) {
    let job;
    try {
        job = new Cron(cron, { timezone, paused: true });
        const next = job.nextRun();
        if (!next)
            return { ok: false, error: "That schedule has no upcoming runs." };
        return { ok: true, next };
    }
    catch (e) {
        return { ok: false, error: e.message };
    }
    finally {
        job?.stop();
    }
}
/** Next run time for a cron+timezone, or null if invalid / none upcoming. */
export function nextRun(cron, timezone) {
    let job;
    try {
        job = new Cron(cron, { timezone, paused: true });
        return job.nextRun();
    }
    catch {
        return null;
    }
    finally {
        job?.stop();
    }
}
//# sourceMappingURL=cron.js.map
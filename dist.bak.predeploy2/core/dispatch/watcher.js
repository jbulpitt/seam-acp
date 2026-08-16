/**
 * DispatchWatcher — the filesystem half of the operator-dispatch bridge.
 *
 * Polls `<DATA_DIR>/dispatch/pending/` for spec files, claims each one by
 * renaming it into `running/`, hands it to an injected `onDispatch` callback,
 * and records the outcome in `done/`. It knows nothing about Discord or ACP:
 * the callback is the seam (see `Orchestrator.dispatchInjectTurn`), which keeps
 * this testable with a stub and keeps the queue mechanics out of the 6.5k-line
 * orchestrator.
 *
 * Delivery is **at-least-once**. `start()` re-enqueues anything left in
 * `running/` by a crash, so an interrupted dispatch runs again; the done-file
 * is written before the running-file is removed, and recovery skips specs that
 * already have one, which keeps the duplicate window to "crashed after the
 * turn finished but before the result was durable".
 *
 * Concurrency: specs for *different* targets run concurrently — one slow thread
 * must not block dispatches to every other worker. Specs for the *same* target
 * are serialized through a `SerialQueue`, so the on-disk arrival order is the
 * order they reach the thread.
 */
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { SerialQueue } from "../serial-queue.js";
import { dispatchDirs, parseDispatchSpec } from "./types.js";
export class DispatchWatcher {
    dirs;
    logger;
    onDispatch;
    pollMs;
    /** One FIFO per target thread — different targets get different queues and
     *  therefore run concurrently. */
    queues = new Map();
    /** Ids claimed by this process, so an overlapping poll tick can't pick up a
     *  spec that's mid-flight (the rename claim also guards this, but only until
     *  the file lands in `running/`). */
    inFlight = new Set();
    timer;
    ready = false;
    constructor(opts) {
        this.dirs = dispatchDirs(opts.dataDir);
        this.logger = opts.logger.child({ comp: "dispatch-watcher" });
        this.onDispatch = opts.onDispatch;
        this.pollMs = opts.pollMs ?? 1000;
    }
    /** Create the queue dirs, recover anything a crash left in `running/`, then
     *  start polling. Safe to await — index.ts does. */
    async start() {
        await mkdir(this.dirs.pending, { recursive: true });
        await mkdir(this.dirs.running, { recursive: true });
        await mkdir(this.dirs.done, { recursive: true });
        await this.recoverStale();
        this.ready = true;
        this.timer = setInterval(() => void this.tick(), this.pollMs);
        // Don't hold the event loop open just for the poller.
        this.timer.unref?.();
        await this.tick();
    }
    stop() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = undefined;
        this.ready = false;
    }
    /**
     * Scan `pending/` once and run everything found. Resolves when every spec
     * picked up *by this tick* has finished and its done-file is written, which
     * is what makes the watcher testable without timers.
     */
    async tick() {
        if (!this.ready)
            return;
        let names;
        try {
            names = await readdir(this.dirs.pending);
        }
        catch (err) {
            this.logger.warn({ err }, "cannot read pending dir");
            return;
        }
        const jobs = [];
        for (const name of names) {
            if (!name.endsWith(".json"))
                continue;
            const id = name.slice(0, -".json".length);
            if (this.inFlight.has(id))
                continue;
            this.inFlight.add(id);
            jobs.push(this.claimAndRun(id)
                .catch((err) => this.logger.error({ err, id }, "dispatch failed unexpectedly"))
                .finally(() => this.inFlight.delete(id)));
        }
        await Promise.all(jobs);
    }
    // --- internals ------------------------------------------------------------
    /**
     * Re-enqueue crash leftovers. A spec that already has a done-file finished its
     * turn — the process just died before deleting the running-file — so it is
     * dropped rather than re-run.
     */
    async recoverStale() {
        let names;
        try {
            names = await readdir(this.dirs.running);
        }
        catch {
            return;
        }
        let requeued = 0;
        for (const name of names) {
            if (!name.endsWith(".json"))
                continue;
            const id = name.slice(0, -".json".length);
            const runningPath = path.join(this.dirs.running, name);
            if (await exists(path.join(this.dirs.done, name))) {
                await rm(runningPath, { force: true }).catch(() => { });
                this.logger.info({ id }, "dispatch: dropped stale running spec (already done)");
                continue;
            }
            try {
                await rename(runningPath, path.join(this.dirs.pending, name));
                requeued++;
            }
            catch (err) {
                this.logger.warn({ err, id }, "dispatch: could not re-enqueue stale spec");
            }
        }
        if (requeued > 0) {
            this.logger.info({ requeued }, "dispatch: re-enqueued stale running specs");
        }
    }
    async claimAndRun(id) {
        const name = `${id}.json`;
        const runningPath = path.join(this.dirs.running, name);
        // Claim by rename: atomic within a filesystem, so if two ticks (or two
        // processes) race, exactly one wins and the loser sees ENOENT.
        try {
            await rename(path.join(this.dirs.pending, name), runningPath);
        }
        catch (err) {
            if (err.code === "ENOENT")
                return;
            throw err;
        }
        let spec;
        try {
            spec = parseDispatchSpec(id, await readFile(runningPath, "utf8"));
        }
        catch (err) {
            // Unparseable specs can never succeed — retrying would spin forever, so
            // record the failure and drain the file out of the queue.
            const message = err.message;
            this.logger.error({ id, err }, "dispatch: unusable spec");
            await this.finish(id, {
                id,
                status: "failed",
                target: "",
                error: message,
                finishedUtc: new Date().toISOString(),
            });
            return;
        }
        this.logger.info({ id, target: spec.target, session: spec.session, correlationId: spec.correlationId }, "dispatch: running");
        await this.queueFor(spec.target).run(async () => {
            const base = {
                id,
                target: spec.target,
                ...(spec.correlationId ? { correlationId: spec.correlationId } : {}),
            };
            try {
                const { output, stopReason } = await this.onDispatch(spec);
                await this.finish(id, {
                    ...base,
                    status: "completed",
                    output,
                    ...(stopReason ? { stopReason } : {}),
                    finishedUtc: new Date().toISOString(),
                });
                this.logger.info({ id, target: spec.target, chars: output.length }, "dispatch: completed");
            }
            catch (err) {
                const message = err?.message ?? String(err);
                await this.finish(id, {
                    ...base,
                    status: "failed",
                    error: message,
                    finishedUtc: new Date().toISOString(),
                });
                this.logger.warn({ id, target: spec.target, err }, "dispatch: failed");
            }
        });
    }
    /** Write the done-file (atomically, so `--wait` never reads a half-file),
     *  then drop the running-file. Order matters — see the class doc on
     *  at-least-once delivery. */
    async finish(id, result) {
        const name = `${id}.json`;
        const finalPath = path.join(this.dirs.done, name);
        const tmpPath = `${finalPath}.tmp`;
        try {
            await writeFile(tmpPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
            await rename(tmpPath, finalPath);
        }
        catch (err) {
            this.logger.error({ err, id }, "dispatch: could not write result file");
            await rm(tmpPath, { force: true }).catch(() => { });
            return; // leave the running-file so start() re-enqueues it
        }
        await rm(path.join(this.dirs.running, name), { force: true }).catch(() => { });
    }
    queueFor(target) {
        let q = this.queues.get(target);
        if (!q) {
            q = new SerialQueue();
            this.queues.set(target, q);
        }
        return q;
    }
}
async function exists(p) {
    try {
        await access(p);
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=watcher.js.map
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
import type { Logger } from "../../lib/logger.js";
import type { DispatchResult, DispatchSpec } from "./types.js";
import { dispatchDirs, parseDispatchSpec } from "./types.js";

export interface DispatchWatcherOpts {
  /** `config.DATA_DIR` — the queue lives at `<dataDir>/dispatch/`. */
  dataDir: string;
  logger: Logger;
  /**
   * Run one dispatched turn. Resolve ⇒ `done/` gets `status: "completed"`;
   * reject ⇒ `status: "failed"` with the error message.
   */
  onDispatch: (spec: DispatchSpec) => Promise<{ output: string; stopReason: string }>;
  /** Poll interval in ms. Default 1000. */
  pollMs?: number;
}

export class DispatchWatcher {
  private readonly dirs: ReturnType<typeof dispatchDirs>;
  private readonly logger: Logger;
  private readonly onDispatch: DispatchWatcherOpts["onDispatch"];
  private readonly pollMs: number;

  /** One FIFO per target thread — different targets get different queues and
   *  therefore run concurrently. */
  private readonly queues = new Map<string, SerialQueue>();
  /** Ids claimed by this process, so an overlapping poll tick can't pick up a
   *  spec that's mid-flight (the rename claim also guards this, but only until
   *  the file lands in `running/`). */
  private readonly inFlight = new Set<string>();
  private timer?: NodeJS.Timeout;
  private ready = false;

  constructor(opts: DispatchWatcherOpts) {
    this.dirs = dispatchDirs(opts.dataDir);
    this.logger = opts.logger.child({ comp: "dispatch-watcher" });
    this.onDispatch = opts.onDispatch;
    this.pollMs = opts.pollMs ?? 1000;
  }

  /** Create the queue dirs, recover anything a crash left in `running/`, then
   *  start polling. Safe to await — index.ts does. */
  async start(): Promise<void> {
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

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.ready = false;
  }

  /**
   * Scan `pending/` once and run everything found. Resolves when every spec
   * picked up *by this tick* has finished and its done-file is written, which
   * is what makes the watcher testable without timers.
   */
  async tick(): Promise<void> {
    if (!this.ready) return;
    let names: string[];
    try {
      names = await readdir(this.dirs.pending);
    } catch (err) {
      this.logger.warn({ err }, "cannot read pending dir");
      return;
    }
    const jobs: Promise<void>[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      if (this.inFlight.has(id)) continue;
      this.inFlight.add(id);
      jobs.push(
        this.claimAndRun(id)
          .catch((err) => this.logger.error({ err, id }, "dispatch failed unexpectedly"))
          .finally(() => this.inFlight.delete(id))
      );
    }
    await Promise.all(jobs);
  }

  // --- internals ------------------------------------------------------------

  /**
   * Re-enqueue crash leftovers. A spec that already has a done-file finished its
   * turn — the process just died before deleting the running-file — so it is
   * dropped rather than re-run.
   */
  private async recoverStale(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.dirs.running);
    } catch {
      return;
    }
    let requeued = 0;
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      const runningPath = path.join(this.dirs.running, name);
      if (await exists(path.join(this.dirs.done, name))) {
        await rm(runningPath, { force: true }).catch(() => {});
        this.logger.info({ id }, "dispatch: dropped stale running spec (already done)");
        continue;
      }
      try {
        await rename(runningPath, path.join(this.dirs.pending, name));
        requeued++;
      } catch (err) {
        this.logger.warn({ err, id }, "dispatch: could not re-enqueue stale spec");
      }
    }
    if (requeued > 0) {
      this.logger.info({ requeued }, "dispatch: re-enqueued stale running specs");
    }
  }

  private async claimAndRun(id: string): Promise<void> {
    const name = `${id}.json`;
    const runningPath = path.join(this.dirs.running, name);

    // Claim by rename: atomic within a filesystem, so if two ticks (or two
    // processes) race, exactly one wins and the loser sees ENOENT.
    try {
      await rename(path.join(this.dirs.pending, name), runningPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }

    let spec: DispatchSpec;
    try {
      spec = parseDispatchSpec(id, await readFile(runningPath, "utf8"));
    } catch (err) {
      // Unparseable specs can never succeed — retrying would spin forever, so
      // record the failure and drain the file out of the queue.
      const message = (err as Error).message;
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

    this.logger.info(
      { id, target: spec.target, session: spec.session, correlationId: spec.correlationId },
      "dispatch: running"
    );

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
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
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
  private async finish(id: string, result: DispatchResult): Promise<void> {
    const name = `${id}.json`;
    const finalPath = path.join(this.dirs.done, name);
    const tmpPath = `${finalPath}.tmp`;
    try {
      await writeFile(tmpPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
      await rename(tmpPath, finalPath);
    } catch (err) {
      this.logger.error({ err, id }, "dispatch: could not write result file");
      await rm(tmpPath, { force: true }).catch(() => {});
      return; // leave the running-file so start() re-enqueues it
    }
    await rm(path.join(this.dirs.running, name), { force: true }).catch(() => {});
  }

  private queueFor(target: string): SerialQueue {
    let q = this.queues.get(target);
    if (!q) {
      q = new SerialQueue();
      this.queues.set(target, q);
    }
    return q;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

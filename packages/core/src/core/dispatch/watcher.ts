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
import { DispatchTurnError, dispatchDirs, parseDispatchSpec } from "./types.js";

/** Clamp on the originating prompt copied into a done-file (#174). */
export const DONE_ORIGIN_PROMPT_MAX = 4000;

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
  /**
   * When true, crash leftovers in `running/` are marked `resume: true` and
   * LEFT in place for the orchestrator to precondition-check + stagger-
   * requeue. When false (default), today's recoverStale re-enqueues them
   * unmarked — original-prompt replay, unconfigured == today's behavior.
   */
  resumeEnabled?: boolean;
  /** Durable ledger gate: false means recovery must terminalize, never replay. */
  mayRecover?: (id: string) => boolean;
  /**
   * Directory-listing seam. Defaults to `fs.readdir`.
   *
   * #174: `tickInner` checks `ready`, then AWAITS this call before claiming
   * anything — that await IS the pre-claim race window. Tests inject a gated
   * listing to park a tick precisely inside it; there is no other way to hold a
   * tick there deterministically, and a timing-based approximation would pass
   * against the buggy code.
   */
  readDir?: (dir: string) => Promise<string[]>;
}

export class DispatchWatcher {
  private readonly dirs: ReturnType<typeof dispatchDirs>;
  private readonly logger: Logger;
  private readonly onDispatch: DispatchWatcherOpts["onDispatch"];
  private readonly pollMs: number;
  private readonly resumeEnabled: boolean;
  private readonly mayRecover: (id: string) => boolean;
  private readonly readDir: (dir: string) => Promise<string[]>;

  /** One FIFO per target thread — different targets get different queues and
   *  therefore run concurrently. */
  private readonly queues = new Map<string, SerialQueue>();
  /** Ids claimed by this process, so an overlapping poll tick can't pick up a
   *  spec that's mid-flight (the rename claim also guards this, but only until
   *  the file lands in `running/`). */
  private readonly inFlight = new Map<string, symbol>();
  /** Artifacts terminalized by the Voice Console quarantine path. A claimed
   *  callback may still be waiting in its target queue (or cancelling); this
   *  fence prevents it from starting or overwriting the quarantine result. */
  private readonly quarantined = new Set<string>();
  /** Local recovery swaps both this generation and the SerialQueue instance.
   * A late callback from the old generation is observation-only: it may settle,
   * but it cannot write done or remove the re-queued running artifact. */
  private readonly targetEpochs = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private ready = false;
  /**
   * #174: in-progress `tick()` calls. A tick checks `ready`, then AWAITS
   * `readdir` — so `stop()` can land in that gap and `drain()` would see empty
   * queues and return while the tick goes on to claim and run a spec against
   * dependencies that are being torn down. Draining must await these too.
   */
  private readonly activeTicks = new Set<Promise<void>>();

  constructor(opts: DispatchWatcherOpts) {
    this.dirs = dispatchDirs(opts.dataDir);
    this.logger = opts.logger.child({ comp: "dispatch-watcher" });
    this.onDispatch = opts.onDispatch;
    this.pollMs = opts.pollMs ?? 1000;
    this.resumeEnabled = opts.resumeEnabled === true;
    this.mayRecover = opts.mayRecover ?? (() => true);
    this.readDir = opts.readDir ?? readdir;
  }

  /** Create the queue dirs, recover anything a crash left in `running/`, then
   *  start polling. Safe to await — index.ts does. */
  async start(): Promise<void> {
    await mkdir(this.dirs.pending, { recursive: true });
    await mkdir(this.dirs.running, { recursive: true });
    await mkdir(this.dirs.done, { recursive: true });
    // SINGLE-INSTANCE ASSUMPTION: recovery assumes no other seam-acp process
    // owns these specs. Two processes on one DATA_DIR would double-resume.
    if (this.resumeEnabled) {
      await this.markStaleInPlace();
    } else {
      await this.recoverStale();
    }
    this.ready = true;
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    // Don't hold the event loop open just for the poller.
    this.timer.unref?.();
    await this.tick();
  }

  /**
   * Stop INTAKE. This closes the claim door — no further tick claims a spec —
   * but says nothing about work already claimed.
   *
   * #174: `stop()` was previously treated as "drained" by the shutdown path,
   * which is what let `store.close()` land on top of an in-flight dispatch.
   * Anything left in `pending/` after this is simply delivered on the next
   * boot, so stopping intake early is lossless.
   */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.ready = false;
  }

  /** True while any claimed spec is still running. */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /**
   * Resolve once every CLAIMED spec has finished and its done-file is written.
   *
   * This is the real barrier `stop()` is not. A spec's report-back and chain
   * advance are awaited inside its per-target `SerialQueue` task, so draining
   * the queues drains those side effects too — while the store is still open.
   *
   * Runs to an ACTUAL fixpoint: it keeps settling queues until nothing is in
   * flight and no new queue appeared, because a completing task can enqueue
   * onto a different target. It deliberately has no internal pass cap — a
   * fixed cap would let it return "drained" with work still running, which is
   * the failure it exists to prevent. Termination is guaranteed from outside:
   * `stop()` closes intake, and the caller races this against a bounded
   * timeout (`Orchestrator.quiesce`). Never call it without both.
   */
  async drain(): Promise<void> {
    for (;;) {
      // Ticks FIRST: an in-progress tick has not created its queue entries
      // yet, so draining queues before it would miss the work it is about to
      // claim. This is the pre-claim race.
      await Promise.allSettled([...this.activeTicks]);
      const queues = [...this.queues.values()];
      await Promise.allSettled(queues.map((q) => q.idle()));
      // Yield so a just-settled task can register its follow-on work before
      // we decide we are done.
      await new Promise((resolve) => setImmediate(resolve));
      const grew = this.queues.size !== queues.length;
      if (this.inFlight.size === 0 && this.activeTicks.size === 0 && !grew) return;
    }
  }

  /**
   * Scan `pending/` once and run everything found. Resolves when every spec
   * picked up *by this tick* has finished and its done-file is written, which
   * is what makes the watcher testable without timers.
   */
  async tick(): Promise<void> {
    if (!this.ready) return;
    const run = this.tickInner();
    const tracked = run.finally(() => {
      this.activeTicks.delete(tracked);
    });
    this.activeTicks.add(tracked);
    await tracked;
  }

  private async tickInner(): Promise<void> {
    let names: string[];
    try {
      names = await this.readDir(this.dirs.pending);
    } catch (err) {
      this.logger.warn({ err }, "cannot read pending dir");
      return;
    }
    // #174: re-check admission AFTER the await. Intake may have closed while
    // this tick was reading the directory; claiming now would start work the
    // shutdown barrier has already decided it is not waiting for. The specs
    // stay in `pending/` and are delivered on the next boot.
    if (!this.ready) return;
    const ids = names
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .filter((id) => !this.inFlight.has(id));
    const claims = ids.map((id) => ({ id, token: Symbol(id) }));
    for (const { id, token } of claims) this.inFlight.set(id, token);

    // Claim (rename + parse) concurrently — a race here is harmless — but collect
    // the winners and ENQUEUE their runs in a deterministic arrival order
    // (createdUtc, then id). Otherwise two same-target specs claimed in one tick
    // would reach their SerialQueue in whatever order the async claim races
    // resolve, breaking the "on-disk arrival order is the order they reach the
    // thread" guarantee (and flaking any test that relies on it).
    const claimed: Array<{ id: string; spec: DispatchSpec; token: symbol }> = [];
    await Promise.all(
      claims.map(async ({ id, token }) => {
        try {
          const spec = await this.claimSpec(id);
          if (spec) claimed.push({ id, spec, token });
          else if (this.inFlight.get(id) === token) this.inFlight.delete(id);
        } catch (err) {
          this.logger.error({ err, id }, "dispatch: claim failed unexpectedly");
          if (this.inFlight.get(id) === token) this.inFlight.delete(id);
        }
      })
    );
    claimed.sort(
      (a, b) =>
        (a.spec.createdUtc ?? "").localeCompare(b.spec.createdUtc ?? "") ||
        a.id.localeCompare(b.id)
    );

    const jobs = claimed.map(({ id, spec, token }) =>
      this.runSpec(id, spec, this.targetEpoch(spec.target))
        .catch((err) => this.logger.error({ err, id }, "dispatch failed unexpectedly"))
        .finally(() => {
          if (this.inFlight.get(id) === token) this.inFlight.delete(id);
          this.quarantined.delete(id);
        })
    );
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
      names = await this.readDir(this.dirs.running);
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
      if (!this.mayRecover(id)) {
        await this.abandonRunning(id, "durable delegation ledger is terminal");
        this.logger.warn({ id }, "dispatch: terminalized stale spec blocked by ledger");
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

  /**
   * Flag-on boot path: stamp `resume: true` onto crash leftovers in `running/`
   * but do NOT move them to pending. The orchestrator lists them, applies
   * max-age / preconditions, then {@link requeueStale}s the ones that should
   * fire. Specs that already have a done-file are dropped (same as recoverStale).
   */
  private async markStaleInPlace(): Promise<void> {
    let names: string[];
    try {
      names = await this.readDir(this.dirs.running);
    } catch {
      return;
    }
    let marked = 0;
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      const runningPath = path.join(this.dirs.running, name);
      if (await exists(path.join(this.dirs.done, name))) {
        await rm(runningPath, { force: true }).catch(() => {});
        this.logger.info({ id }, "dispatch: dropped stale running spec (already done)");
        continue;
      }
      if (!this.mayRecover(id)) {
        await this.abandonRunning(id, "durable delegation ledger is terminal");
        this.logger.warn({ id }, "dispatch: terminalized stale resume blocked by ledger");
        continue;
      }
      try {
        const spec = parseDispatchSpec(id, await readFile(runningPath, "utf8"));
        if (spec.resume) {
          marked++;
          continue;
        }
        const tmpPath = `${runningPath}.tmp`;
        await writeFile(tmpPath, `${JSON.stringify({ ...spec, resume: true }, null, 2)}\n`, "utf8");
        await rename(tmpPath, runningPath);
        marked++;
      } catch (err) {
        this.logger.warn({ err, id }, "dispatch: could not mark stale spec as resume");
      }
    }
    if (marked > 0) {
      this.logger.info({ marked }, "dispatch: marked stale running specs for resume");
    }
  }

  /** Crash leftovers still sitting in `running/` with no done-file. */
  async listStaleRunning(): Promise<DispatchSpec[]> {
    let names: string[];
    try {
      names = await this.readDir(this.dirs.running);
    } catch {
      return [];
    }
    const out: DispatchSpec[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      if (this.inFlight.has(id)) continue;
      if (await exists(path.join(this.dirs.done, name))) continue;
      try {
        out.push(parseDispatchSpec(id, await readFile(path.join(this.dirs.running, name), "utf8")));
      } catch {
        // unparseable
      }
    }
    return out;
  }

  /** Move a marked stale spec from `running/` to `pending/` so the next tick
   *  claims it through the normal dispatch path. */
  async requeueStale(id: string): Promise<boolean> {
    const name = `${id}.json`;
    const runningPath = path.join(this.dirs.running, name);
    const pendingPath = path.join(this.dirs.pending, name);
    if (await exists(path.join(this.dirs.done, name))) {
      await rm(runningPath, { force: true }).catch(() => {});
      return false;
    }
    try {
      await rename(runningPath, pendingPath);
      return true;
    } catch (err) {
      this.logger.warn({ err, id }, "dispatch: could not requeue resume spec");
      return false;
    }
  }

  /**
   * Localized queue repair. Move every artifact for one target back to pending,
   * relinquish this process's old ownership token, and replace that target's
   * in-memory FIFO. The old callback is fenced by target epoch checks in
   * runSpec, so its late resolution cannot produce a done-file.
   */
  async recoverTarget(target: string): Promise<string[]> {
    const next = this.targetEpoch(target) + 1;
    this.targetEpochs.set(target, next);
    this.queues.set(target, new SerialQueue());
    const specs = await this.listQueueSpecs(["running", "pending"]);
    const recovered: string[] = [];
    for (const spec of specs) {
      if (spec.target !== target || recovered.includes(spec.id)) continue;
      const name = `${spec.id}.json`;
      if (await exists(path.join(this.dirs.done, name))) continue;
      const runningPath = path.join(this.dirs.running, name);
      const pendingPath = path.join(this.dirs.pending, name);
      if (await exists(runningPath)) {
        try {
          await rename(runningPath, pendingPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            this.logger.warn({ err, id: spec.id, target }, "dispatch: local recovery requeue failed");
            continue;
          }
        }
      }
      this.inFlight.delete(spec.id);
      recovered.push(spec.id);
    }
    return recovered;
  }

  /**
   * Command-layer cancel: write a terminal done-file THEN drop the running
   * (and any pending) spec. Same commit ordering as {@link finish}. Does NOT
   * live in dispose() — SIGTERM must leave markers intact.
   */
  async cancelRunning(filter?: { target?: string; id?: string }): Promise<string[]> {
    const cancelled: string[] = [];
    const seen = new Set<string>();
    for (const spec of await this.listQueueSpecs(["running", "pending"])) {
      if (filter?.target && spec.target !== filter.target) continue;
      if (filter?.id && spec.id !== filter.id) continue;
      if (seen.has(spec.id)) continue;
      seen.add(spec.id);
      await this.finish(spec.id, {
        id: spec.id,
        status: "failed",
        error: "cancelled by operator",
        target: spec.target,
        ...(spec.correlationId ? { correlationId: spec.correlationId } : {}),
        finishedUtc: new Date().toISOString(),
      });
      cancelled.push(spec.id);
    }
    return cancelled;
  }

  /** Max-age / deleted-thread abandon: terminal write then drop the marker. */
  async abandonRunning(id: string, reason: string): Promise<void> {
    let target = "";
    let correlationId: string | undefined;
    try {
      const spec = parseDispatchSpec(
        id,
        await readFile(path.join(this.dirs.running, `${id}.json`), "utf8")
      );
      target = spec.target;
      correlationId = spec.correlationId;
    } catch {
      // still finalize so recoverStale cannot re-run it
    }
    await this.finish(id, {
      id,
      status: "failed",
      error: `abandoned: ${reason}`,
      target,
      ...(correlationId ? { correlationId } : {}),
      finishedUtc: new Date().toISOString(),
    });
  }

  /**
   * Fail closed for a Voice Console artifact whose durable capture identity was
   * quarantined. This is deliberately id-scoped: unlike command cancellation it
   * cannot affect another dispatch in the same thread.
   *
   * An existing done-file is already terminal and is preserved byte-for-byte.
   * Pending/running artifacts receive a failed result before their queue marker
   * is removed. `inFlight` tells Package E whether an already-claimed callback
   * also needs its exact ACP turn fenced/cancelled.
   */
  async quarantineArtifact(
    id: string,
    reason: string
  ): Promise<{ state: "missing" | "done" | "terminalized"; inFlight: boolean }> {
    const name = `${id}.json`;
    const donePath = path.join(this.dirs.done, name);
    const runningPath = path.join(this.dirs.running, name);
    const pendingPath = path.join(this.dirs.pending, name);
    // Fence first, before filesystem awaits give a polling tick a chance to
    // claim and enter the callback.
    this.quarantined.add(id);

    if (await exists(donePath)) {
      await rm(runningPath, { force: true }).catch(() => {});
      await rm(pendingPath, { force: true }).catch(() => {});
      const inFlight = this.inFlight.has(id);
      if (!inFlight) this.quarantined.delete(id);
      return { state: "done", inFlight };
    }

    let target = "";
    let correlationId: string | undefined;
    let found = false;
    for (const artifactPath of [runningPath, pendingPath]) {
      try {
        const spec = parseDispatchSpec(id, await readFile(artifactPath, "utf8"));
        target = spec.target;
        correlationId = spec.correlationId;
        found = true;
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") found = true;
      }
    }
    const inFlight = this.inFlight.has(id);
    if (!found && !inFlight) {
      this.quarantined.delete(id);
      return { state: "missing", inFlight: false };
    }

    await mkdir(this.dirs.done, { recursive: true });
    await this.finish(id, {
      id,
      status: "failed",
      error: `quarantined: ${reason}`,
      target,
      ...(correlationId ? { correlationId } : {}),
      finishedUtc: new Date().toISOString(),
    });
    if (!(await exists(donePath))) {
      throw new Error(`dispatch ${id}: quarantine result was not durable`);
    }
    if (!inFlight) this.quarantined.delete(id);
    return { state: "terminalized", inFlight };
  }

  private async listQueueSpecs(subdirs: Array<"running" | "pending">): Promise<DispatchSpec[]> {
    const out: DispatchSpec[] = [];
    for (const sub of subdirs) {
      const dir = this.dirs[sub];
      let names: string[];
      try {
        names = await this.readDir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const id = name.slice(0, -".json".length);
        try {
          out.push(parseDispatchSpec(id, await readFile(path.join(dir, name), "utf8")));
        } catch {
          // ignore
        }
      }
    }
    return out;
  }

  /**
   * Claim a pending spec by atomic rename into `running/`, then parse it.
   * Returns the spec on success; `null` when the claim was lost (ENOENT — a
   * racing tick/process won it) or the spec was unparseable (already finalized
   * as `failed` here, since retrying could never succeed). Kept separate from
   * {@link runSpec} so `tick` can order the runs after all claims land.
   */
  private async claimSpec(id: string): Promise<DispatchSpec | null> {
    const name = `${id}.json`;
    const runningPath = path.join(this.dirs.running, name);

    // Claim by rename: atomic within a filesystem, so if two ticks (or two
    // processes) race, exactly one wins and the loser sees ENOENT.
    try {
      await rename(path.join(this.dirs.pending, name), runningPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }

    try {
      return parseDispatchSpec(id, await readFile(runningPath, "utf8"));
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
      return null;
    }
  }

  /** Run one claimed spec through its target's SerialQueue and record the
   *  outcome. Invoked by `tick` in arrival order, so the synchronous
   *  `queueFor(target).run(...)` enqueue below preserves same-target order. */
  private async runSpec(id: string, spec: DispatchSpec, targetEpoch: number): Promise<void> {
    this.logger.info(
      { id, target: spec.target, session: spec.session, correlationId: spec.correlationId },
      "dispatch: running"
    );

    await this.queueFor(spec.target).run(async () => {
      if (this.targetEpoch(spec.target) !== targetEpoch) return;
      if (this.quarantined.has(id)) {
        this.logger.warn({ id, target: spec.target }, "dispatch: quarantined before execution");
        return;
      }
      const base = {
        id,
        target: spec.target,
        ...(spec.correlationId ? { correlationId: spec.correlationId } : {}),
        // #174: carry the routing forward so a completion whose ledger side
        // effects were lost to a shutdown race can be replayed at boot from
        // the done-file alone, without rerunning the worker. `kind` rides
        // along because `returnTo` is not self-describing: on a compact spec
        // it is the ACTOR, not a report-back address.
        ...(spec.kind ? { kind: spec.kind } : {}),
        ...(spec.returnTo ? { returnTo: spec.returnTo } : {}),
        ...(spec.chainId ? { chainId: spec.chainId } : {}),
        ...(spec.prompt
          ? { originPrompt: spec.prompt.slice(0, DONE_ORIGIN_PROMPT_MAX) }
          : {}),
      };
      try {
        const { output, stopReason } = await this.onDispatch(spec);
        if (this.targetEpoch(spec.target) !== targetEpoch) return;
        if (this.quarantined.has(id)) return;
        await this.finish(id, {
          ...base,
          status: "completed",
          output,
          ...(stopReason ? { stopReason } : {}),
          finishedUtc: new Date().toISOString(),
        });
        this.logger.info({ id, target: spec.target, chars: output.length }, "dispatch: completed");
      } catch (err) {
        if (this.targetEpoch(spec.target) !== targetEpoch) return;
        if (this.quarantined.has(id)) return;
        const message = (err as Error)?.message ?? String(err);
        const partial = err instanceof DispatchTurnError ? err.output : undefined;
        const stopReason = err instanceof DispatchTurnError ? err.stopReason : undefined;
        const workerStatus = err instanceof DispatchTurnError ? err.workerStatus : undefined;
        const workerError = err instanceof DispatchTurnError ? err.workerError : undefined;
        const completionPending = err instanceof DispatchTurnError && err.completionPending;
        // #67: `base` carries the spec's routing unconditionally, so a turn
        // whose onward delivery was deliberately suppressed has to say so —
        // otherwise boot replay reads that routing as work still owed.
        const suppressedOnward = err instanceof DispatchTurnError && err.suppressedOnward;
        await this.finish(id, {
          ...base,
          status: "failed",
          ...(partial ? { output: partial } : {}),
          error: message,
          ...(workerStatus ? { workerStatus } : {}),
          ...(workerError ? { workerError } : {}),
          ...(completionPending ? { completionError: message } : {}),
          ...(suppressedOnward ? { suppressedOnward: true } : {}),
          ...(stopReason ? { stopReason } : {}),
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
    // Command-layer cancel may finalize a spec still sitting in pending/
    // (a staggered resume that has not been claimed yet).
    await rm(path.join(this.dirs.pending, name), { force: true }).catch(() => {});
  }

  private queueFor(target: string): SerialQueue {
    let q = this.queues.get(target);
    if (!q) {
      q = new SerialQueue();
      this.queues.set(target, q);
    }
    return q;
  }

  private targetEpoch(target: string): number {
    return this.targetEpochs.get(target) ?? 0;
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

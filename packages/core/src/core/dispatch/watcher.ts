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
import { renameSync, rmSync } from "node:fs";
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
  /** Deterministic test seam: pauses an owned writer after its temp file is
   * durable but before the atomic done-file rename. */
  beforeOwnedDoneCommit?: (id: string) => Promise<void>;
  /** Deterministic test seam: pauses recovery after its first ledger check but
   * before publishing the recovered pending artifact. */
  beforeRecoveryPublish?: (id: string) => Promise<void>;
}

export interface DispatchWatcherStartOpts {
  /**
   * Preserve the historical test/utility behavior by default: `start()` does
   * not resolve until every spec found by its first pending-directory scan has
   * settled. Production startup disables this so paid agent work cannot delay
   * the rest of application readiness.
   */
  waitForInitialDispatches?: boolean;
}

interface ClaimOwnership {
  readonly token: symbol;
  readonly spec: DispatchSpec;
  readonly targetEpoch: number;
  readonly globalEpoch: number;
}

/** Opaque synchronous fence handed from the orchestrator to async recovery. */
export interface DispatchTargetFence {
  readonly target: string;
  readonly epoch: number;
  readonly token: symbol;
  readonly claims: readonly DispatchSpec[];
}

export class DispatchWatcher {
  private readonly dirs: ReturnType<typeof dispatchDirs>;
  private readonly logger: Logger;
  private readonly onDispatch: DispatchWatcherOpts["onDispatch"];
  private readonly pollMs: number;
  private readonly resumeEnabled: boolean;
  private readonly mayRecover: (id: string) => boolean;
  private readonly readDir: (dir: string) => Promise<string[]>;
  private readonly beforeOwnedDoneCommit?: (id: string) => Promise<void>;
  private readonly beforeRecoveryPublish?: (id: string) => Promise<void>;

  /** One FIFO per target thread — different targets get different queues and
   *  therefore run concurrently. */
  private readonly queues = new Map<string, SerialQueue>();
  /** Ids claimed by this process, so an overlapping poll tick can't pick up a
   *  spec that's mid-flight (the rename claim also guards this, but only until
   *  the file lands in `running/`). */
  private readonly inFlight = new Map<string, ClaimOwnership>();
  /** Pending-file reads that have not resolved enough metadata to become an
   * owned claim yet. Target fencing is detected with `fenceSequence`. */
  private readonly claiming = new Set<string>();
  /** Artifacts terminalized by the Voice Console quarantine path. A claimed
   *  callback may still be waiting in its target queue (or cancelling); this
   *  fence prevents it from starting or overwriting the quarantine result. */
  private readonly quarantined = new Set<string>();
  /** Local recovery swaps both this generation and the SerialQueue instance.
   * A late callback from the old generation is observation-only: it may settle,
   * but it cannot write done or remove the re-queued running artifact. */
  private readonly targetEpochs = new Map<string, number>();
  /** Sequence of the latest synchronous fence for each target. A claim reads
   * the spec before rename and refuses the rename if its target was fenced in
   * that window. */
  private fenceSequence = 0;
  private readonly targetFenceSequences = new Map<string, number>();
  /** A target stays blocked between synchronous fencing and the caller's
   * explicit release after async filesystem/runtime reconciliation. */
  private readonly targetFences = new Map<string, symbol>();
  private globalEpoch = 0;
  private globalFence?: symbol;
  /** Filesystem commits for one artifact are serialized across worker finish,
   * recovery, cancellation, and quarantine. */
  private readonly artifactTails = new Map<string, Promise<void>>();
  private timer?: NodeJS.Timeout;
  private ready = false;
  /** Settles after the first pending-directory pass, including every dispatch
   * it claimed. The handled promise is safe to observe from boot sequencing. */
  private initialDispatchPass: Promise<void> = Promise.resolve();
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
    this.beforeOwnedDoneCommit = opts.beforeOwnedDoneCommit;
    this.beforeRecoveryPublish = opts.beforeRecoveryPublish;
  }

  /** Create the queue dirs, recover anything a crash left in `running/`, then
   * start polling. Callers may arm the first dispatch pass in the background;
   * crash reconciliation itself is always complete before this resolves. */
  async start(opts: DispatchWatcherStartOpts = {}): Promise<void> {
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
    const initialPass = this.tick();
    this.initialDispatchPass = initialPass.catch((err) => {
      this.logger.warn({ err }, "initial dispatch pass failed");
    });
    if (opts.waitForInitialDispatches !== false) await initialPass;
  }

  /** Observe the background first pass without changing normal drain
   * semantics. Used to preserve boot-recovery ordering without holding the
   * application readiness notification behind paid agent turns. */
  initialDispatchesSettled(): Promise<void> {
    return this.initialDispatchPass;
  }

  /** False after shutdown closes watcher intake. */
  get isAcceptingDispatches(): boolean {
    return this.ready;
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
    return this.inFlight.size + this.claiming.size;
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
      if (this.inFlightCount === 0 && this.activeTicks.size === 0 && !grew) return;
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
      .filter((id) => !this.inFlight.has(id) && !this.claiming.has(id));
    const claimFenceSequence = this.fenceSequence;
    const claimGlobalEpoch = this.globalEpoch;
    const claims = ids.map((id) => ({ id, token: Symbol(id) }));
    for (const { id } of claims) this.claiming.add(id);

    // Claim (rename + parse) concurrently — a race here is harmless — but collect
    // the winners and ENQUEUE their runs in a deterministic arrival order
    // (createdUtc, then id). Otherwise two same-target specs claimed in one tick
    // would reach their SerialQueue in whatever order the async claim races
    // resolve, breaking the "on-disk arrival order is the order they reach the
    // thread" guarantee (and flaking any test that relies on it).
    const claimed: Array<{ id: string; spec: DispatchSpec; owner: ClaimOwnership }> = [];
    await Promise.all(
      claims.map(async ({ id, token }) => {
        try {
          const claim = await this.claimSpec(id, token, claimFenceSequence, claimGlobalEpoch);
          if (claim) claimed.push({ id, ...claim });
        } catch (err) {
          this.logger.error({ err, id }, "dispatch: claim failed unexpectedly");
        } finally {
          this.claiming.delete(id);
        }
      })
    );
    claimed.sort(
      (a, b) =>
        (a.spec.createdUtc ?? "").localeCompare(b.spec.createdUtc ?? "") ||
        a.id.localeCompare(b.id)
    );

    const jobs = claimed.map(({ id, spec, owner }) =>
      this.runSpec(id, spec, owner)
        .catch((err) => this.logger.error({ err, id }, "dispatch failed unexpectedly"))
        .finally(() => {
          if (this.inFlight.get(id) === owner) this.inFlight.delete(id);
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
      if (await this.requeueStale(id)) requeued++;
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
    return this.withArtifact(id, async () => {
      const name = `${id}.json`;
      const runningPath = path.join(this.dirs.running, name);
      const pendingPath = path.join(this.dirs.pending, name);
      if (await exists(path.join(this.dirs.done, name))) {
        await rm(runningPath, { force: true }).catch(() => {});
        return false;
      }
      let spec: DispatchSpec;
      try {
        spec = parseDispatchSpec(id, await readFile(runningPath, "utf8"));
      } catch (err) {
        this.logger.warn({ err, id }, "dispatch: could not read resume spec");
        return false;
      }
      if (!this.mayRecover(id)) {
        await this.terminalizeLocked(spec, "abandoned: durable delegation ledger is terminal");
        return false;
      }
      if (this.beforeRecoveryPublish) await this.beforeRecoveryPublish(id);
      if (!this.mayRecover(id)) {
        await this.terminalizeLocked(spec, "abandoned: durable delegation ledger is terminal");
        return false;
      }
      try {
        // The final ledger check and publication are one non-yielding commit
        // section, so a terminal transition cannot land between them.
        renameSync(runningPath, pendingPath);
      } catch (err) {
        this.logger.warn({ err, id }, "dispatch: could not requeue resume spec");
        return false;
      }
      if (!this.mayRecover(id)) {
        await this.terminalizeLocked(spec, "abandoned: durable delegation ledger is terminal");
        return false;
      }
      return true;
    });
  }

  /**
   * Synchronously revoke every current claim for a target and block new ones.
   * The caller must do this before its first await, then retain the returned
   * fence through filesystem reconciliation and runtime abort/invalidation.
   */
  fenceTarget(target: string): DispatchTargetFence {
    const epoch = this.targetEpoch(target) + 1;
    const token = Symbol(`target-fence:${target}:${epoch}`);
    const sequence = ++this.fenceSequence;
    this.targetEpochs.set(target, epoch);
    this.targetFenceSequences.set(target, sequence);
    this.targetFences.set(target, token);
    this.queues.set(target, new SerialQueue());
    const claims = [...this.inFlight.values()].filter((owner) => owner.spec.target === target);
    for (const owner of claims) {
      if (this.inFlight.get(owner.spec.id) === owner) this.inFlight.delete(owner.spec.id);
    }
    return Object.freeze({
      target,
      epoch,
      token,
      claims: Object.freeze(claims.map((owner) => owner.spec)),
    });
  }

  /** Release a target only when this is still its newest fence. */
  releaseTargetFence(fence: DispatchTargetFence): void {
    if (this.targetFences.get(fence.target) === fence.token) {
      this.targetFences.delete(fence.target);
    }
  }

  /**
   * Async half of localized repair. Worker finalization, recovery publication,
   * and cleanup all take the same id-scoped serializer. The durable ledger is
   * checked immediately before and immediately after the atomic publication,
   * closing the check/rename window in both directions.
   */
  async recoverTarget(fence: DispatchTargetFence): Promise<string[]> {
    if (this.targetFences.get(fence.target) !== fence.token) return [];
    const listed = await this.listQueueSpecs(["running", "pending"]);
    const byId = new Map<string, DispatchSpec>();
    for (const spec of [...listed, ...fence.claims]) {
      if (spec.target === fence.target) byId.set(spec.id, spec);
    }

    const recovered: string[] = [];
    for (const spec of byId.values()) {
      const didRecover = await this.withArtifact(spec.id, async () => {
        if (!this.fenceCurrent(fence)) return false;
        const name = `${spec.id}.json`;
        const runningPath = path.join(this.dirs.running, name);
        const pendingPath = path.join(this.dirs.pending, name);
        const donePath = path.join(this.dirs.done, name);
        if (await exists(donePath)) {
          await rm(runningPath, { force: true }).catch(() => {});
          await rm(pendingPath, { force: true }).catch(() => {});
          return false;
        }
        if (!this.mayRecover(spec.id)) {
          await this.terminalizeLocked(spec, "abandoned: durable delegation ledger is terminal");
          this.logger.warn(
            { id: spec.id, target: fence.target },
            "dispatch: local recovery terminalized artifact blocked by ledger"
          );
          return false;
        }

        if (this.beforeRecoveryPublish) await this.beforeRecoveryPublish(spec.id);
        if (!this.fenceCurrent(fence)) return false;
        if (!this.mayRecover(spec.id)) {
          await this.terminalizeLocked(spec, "abandoned: durable delegation ledger is terminal");
          return false;
        }

        if (await exists(runningPath)) {
          if (!this.fenceCurrent(fence)) return false;
          if (!this.mayRecover(spec.id)) {
            await this.terminalizeLocked(spec, "abandoned: durable delegation ledger is terminal");
            return false;
          }
          try {
            // Same non-yielding ledger-check/publication commit as manual and
            // boot recovery.
            renameSync(runningPath, pendingPath);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
              this.logger.warn(
                { err, id: spec.id, target: fence.target },
                "dispatch: local recovery requeue failed"
              );
              return false;
            }
          }
        } else if (!(await exists(pendingPath))) {
          const published = await this.publishPendingLocked(
            spec,
            () => this.fenceCurrent(fence) && this.mayRecover(spec.id)
          );
          if (!published) {
            if (this.fenceCurrent(fence) && !this.mayRecover(spec.id)) {
              await this.terminalizeLocked(
                spec,
                "abandoned: durable delegation ledger is terminal"
              );
            }
            return false;
          }
        }

        // A ledger transition can occur during any preceding staging/existence
        // await. Reconcile it before exposing this artifact for execution.
        if (!this.fenceCurrent(fence)) return false;
        if (!this.mayRecover(spec.id)) {
          await this.terminalizeLocked(spec, "abandoned: durable delegation ledger is terminal");
          return false;
        }
        return exists(pendingPath);
      });
      if (didRecover) recovered.push(spec.id);
    }
    return recovered;
  }

  /**
   * Command-layer cancel: write a terminal done-file THEN drop the running
   * (and any pending) spec. Same commit ordering as worker finalization. Does NOT
   * live in dispose() — SIGTERM must leave markers intact.
   */
  async cancelRunning(filter?: { target?: string; id?: string }): Promise<string[]> {
    const targetFence = filter?.target ? this.fenceTarget(filter.target) : undefined;
    const globalFence = filter?.target ? undefined : this.fenceAll();
    if (filter?.id) {
      this.quarantined.add(filter.id);
      this.revokeArtifact(filter.id);
    }
    try {
      const listed = await this.listQueueSpecs(["running", "pending"]);
      const claims = targetFence?.claims ?? globalFence?.claims ?? [];
      const byId = new Map<string, DispatchSpec>();
      for (const spec of [...listed, ...claims]) {
        if (filter?.target && spec.target !== filter.target) continue;
        if (filter?.id && spec.id !== filter.id) continue;
        byId.set(spec.id, spec);
      }

      const cancelled: string[] = [];
      for (const spec of byId.values()) {
        this.quarantined.add(spec.id);
        await this.withArtifact(spec.id, () =>
          this.terminalizeLocked(spec, "cancelled by operator")
        );
        this.quarantined.delete(spec.id);
        cancelled.push(spec.id);
      }
      return cancelled;
    } finally {
      if (targetFence) this.releaseTargetFence(targetFence);
      if (globalFence && this.globalFence === globalFence.token) this.globalFence = undefined;
      if (filter?.id) this.quarantined.delete(filter.id);
    }
  }

  /** Max-age / deleted-thread abandon: terminal write then drop the marker. */
  async abandonRunning(id: string, reason: string): Promise<void> {
    this.revokeArtifact(id);
    let target = "";
    let correlationId: string | undefined;
    for (const dir of [this.dirs.running, this.dirs.pending]) {
      try {
        const spec = parseDispatchSpec(id, await readFile(path.join(dir, `${id}.json`), "utf8"));
        target = spec.target;
        correlationId = spec.correlationId;
        break;
      } catch {
        // Try the other durable queue location; still finalize if neither parses.
      }
    }
    await this.withArtifact(id, () =>
      this.finishLocked(id, {
        id,
        status: "failed",
        error: `abandoned: ${reason}`,
        target,
        ...(correlationId ? { correlationId } : {}),
        finishedUtc: new Date().toISOString(),
      })
    );
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
    // Fence first, before filesystem awaits give a polling tick a chance to
    // claim and enter the callback.
    const owner = this.inFlight.get(id);
    const inFlight = owner !== undefined;
    this.quarantined.add(id);
    this.revokeArtifact(id);
    try {
      return await this.withArtifact(id, async () => {
        const name = `${id}.json`;
        const donePath = path.join(this.dirs.done, name);
        const runningPath = path.join(this.dirs.running, name);
        const pendingPath = path.join(this.dirs.pending, name);
        if (await exists(donePath)) {
          await rm(runningPath, { force: true }).catch(() => {});
          await rm(pendingPath, { force: true }).catch(() => {});
          return { state: "done" as const, inFlight };
        }

        let spec = owner?.spec;
        let found = spec !== undefined;
        if (!spec) {
          for (const artifactPath of [runningPath, pendingPath]) {
            try {
              spec = parseDispatchSpec(id, await readFile(artifactPath, "utf8"));
              found = true;
              break;
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code !== "ENOENT") found = true;
            }
          }
        }
        if (!found) return { state: "missing" as const, inFlight: false };

        await this.finishLocked(id, {
          id,
          status: "failed",
          error: `quarantined: ${reason}`,
          target: spec?.target ?? "",
          ...(spec?.correlationId ? { correlationId: spec.correlationId } : {}),
          finishedUtc: new Date().toISOString(),
        });
        if (!(await exists(donePath))) {
          throw new Error(`dispatch ${id}: quarantine result was not durable`);
        }
        return { state: "terminalized" as const, inFlight };
      });
    } finally {
      this.quarantined.delete(id);
    }
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
   * Parse a pending spec, publish immutable ownership, then claim it by atomic
   * rename into `running/`.
   * Returns the spec on success; `null` when the claim was lost (ENOENT — a
   * racing tick/process won it) or the spec was unparseable (already finalized
   * as `failed` here, since retrying could never succeed). Kept separate from
   * {@link runSpec} so `tick` can order the runs after all claims land.
   */
  private async claimSpec(
    id: string,
    token: symbol,
    startedFenceSequence: number,
    startedGlobalEpoch: number
  ): Promise<{ spec: DispatchSpec; owner: ClaimOwnership } | null> {
    return this.withArtifact(id, async () => {
      const name = `${id}.json`;
      const pendingPath = path.join(this.dirs.pending, name);
      const runningPath = path.join(this.dirs.running, name);
      let spec: DispatchSpec;
      try {
        // Parse before rename so target fencing can publish its ownership
        // barrier before this claim crosses the pending→running commit point.
        spec = parseDispatchSpec(id, await readFile(pendingPath, "utf8"));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        try {
          await rename(pendingPath, runningPath);
        } catch (renameErr) {
          if ((renameErr as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw renameErr;
        }
        const message = (err as Error).message;
        this.logger.error({ id, err }, "dispatch: unusable spec");
        await this.finishLocked(id, {
          id,
          status: "failed",
          target: "",
          error: message,
          finishedUtc: new Date().toISOString(),
        });
        return null;
      }

      const owner: ClaimOwnership = Object.freeze({
        token,
        spec,
        targetEpoch: this.targetEpoch(spec.target),
        globalEpoch: this.globalEpoch,
      });
      const targetWasFenced =
        (this.targetFenceSequences.get(spec.target) ?? 0) > startedFenceSequence;
      if (
        targetWasFenced ||
        this.globalEpoch !== startedGlobalEpoch ||
        this.targetFences.has(spec.target) ||
        this.globalFence
      ) {
        return null;
      }
      this.inFlight.set(id, owner);

      // Claim by rename: atomic within a filesystem, so if two processes race,
      // exactly one wins. It is synchronous so a target fence cannot interleave
      // between the ownership check above and this commit point.
      try {
        renameSync(pendingPath, runningPath);
      } catch (err) {
        if (this.inFlight.get(id) === owner) this.inFlight.delete(id);
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
      return { spec, owner };
    });
  }

  /** Run one claimed spec through its target's SerialQueue and record the
   *  outcome. Invoked by `tick` in arrival order, so the synchronous
   *  `queueFor(target).run(...)` enqueue below preserves same-target order. */
  private async runSpec(id: string, spec: DispatchSpec, owner: ClaimOwnership): Promise<void> {
    this.logger.info(
      { id, target: spec.target, session: spec.session, correlationId: spec.correlationId },
      "dispatch: running"
    );

    await this.queueFor(spec.target).run(async () => {
      if (!this.owns(owner)) return;
      if (!this.mayRecover(id)) {
        this.revokeArtifact(id);
        await this.withArtifact(id, () =>
          this.terminalizeLocked(spec, "abandoned: durable delegation ledger is terminal")
        );
        this.logger.warn(
          { id, target: spec.target },
          "dispatch: execution blocked by terminal ledger"
        );
        return;
      }
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
        const committed = await this.finishOwned(owner, {
          ...base,
          status: "completed",
          output,
          ...(stopReason ? { stopReason } : {}),
          finishedUtc: new Date().toISOString(),
        });
        if (committed) {
          this.logger.info({ id, target: spec.target, chars: output.length }, "dispatch: completed");
        }
      } catch (err) {
        if (!this.owns(owner)) return;
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
        const committed = await this.finishOwned(owner, {
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
        if (committed) this.logger.warn({ id, target: spec.target, err }, "dispatch: failed");
      }
    });
  }

  /** Write the done-file (atomically, so `--wait` never reads a half-file),
   *  then drop the running-file. Order matters — see the class doc on
   *  at-least-once delivery. */
  private async finishOwned(owner: ClaimOwnership, result: DispatchResult): Promise<boolean> {
    return this.withArtifact(owner.spec.id, async () => {
      if (!this.owns(owner)) {
        await this.restoreRevokedOwnerLocked(owner);
        return false;
      }
      const id = owner.spec.id;
      const name = `${id}.json`;
      const finalPath = path.join(this.dirs.done, name);
      const tmpPath = `${finalPath}.tmp`;
      let published = false;
      try {
        await writeFile(tmpPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
        if (this.beforeOwnedDoneCommit) await this.beforeOwnedDoneCommit(id);
        if (!this.owns(owner)) {
          await rm(tmpPath, { force: true }).catch(() => {});
          await this.restoreRevokedOwnerLocked(owner);
          return false;
        }
        // These tiny metadata operations intentionally do not yield. Ownership
        // is checked at the actual publication boundary, and neither recovery
        // nor cancellation can revoke it between that check, the atomic rename,
        // and cleanup of this claim's queue artifacts.
        renameSync(tmpPath, finalPath);
        published = true;
        rmSync(path.join(this.dirs.running, name), { force: true });
        rmSync(path.join(this.dirs.pending, name), { force: true });
      } catch (err) {
        this.logger.error({ err, id }, "dispatch: could not write result file");
        await rm(tmpPath, { force: true }).catch(() => {});
        // If publication succeeded but cleanup failed, the done-file remains
        // authoritative and startup recovery drops the leftover marker.
        return published && (await exists(finalPath));
      }
      return true;
    });
  }

  private async finishLocked(id: string, result: DispatchResult): Promise<void> {
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

  private owns(owner: ClaimOwnership): boolean {
    const current = this.inFlight.get(owner.spec.id);
    return (
      current?.token === owner.token &&
      current.targetEpoch === owner.targetEpoch &&
      current.globalEpoch === owner.globalEpoch &&
      owner.targetEpoch === this.targetEpoch(owner.spec.target) &&
      owner.globalEpoch === this.globalEpoch &&
      !this.targetFences.has(owner.spec.target) &&
      !this.globalFence &&
      !this.quarantined.has(owner.spec.id)
    );
  }

  private fenceCurrent(fence: DispatchTargetFence): boolean {
    return (
      this.targetFences.get(fence.target) === fence.token &&
      this.targetEpoch(fence.target) === fence.epoch
    );
  }

  private fenceAll(): { token: symbol; claims: readonly DispatchSpec[] } {
    const token = Symbol(`global-fence:${this.globalEpoch + 1}`);
    this.globalEpoch += 1;
    this.globalFence = token;
    this.fenceSequence += 1;
    const claims = [...this.inFlight.values()];
    for (const owner of claims) {
      if (this.inFlight.get(owner.spec.id) === owner) this.inFlight.delete(owner.spec.id);
    }
    return Object.freeze({
      token,
      claims: Object.freeze(claims.map((owner) => owner.spec)),
    });
  }

  private revokeArtifact(id: string): void {
    this.inFlight.delete(id);
  }

  private async terminalizeLocked(spec: DispatchSpec, error: string): Promise<void> {
    await this.finishLocked(spec.id, {
      id: spec.id,
      status: "failed",
      error,
      target: spec.target,
      ...(spec.correlationId ? { correlationId: spec.correlationId } : {}),
      finishedUtc: new Date().toISOString(),
    });
  }

  /** Recreate the claimed spec only when no later terminal owner exists. */
  private async restoreRevokedOwnerLocked(owner: ClaimOwnership): Promise<void> {
    const current = this.inFlight.get(owner.spec.id);
    if (current && current.token !== owner.token) return;
    await this.restorePendingLocked(owner.spec);
  }

  private async restorePendingLocked(spec: DispatchSpec): Promise<void> {
    const name = `${spec.id}.json`;
    if (await exists(path.join(this.dirs.done, name))) return;
    const runningPath = path.join(this.dirs.running, name);
    const pendingPath = path.join(this.dirs.pending, name);
    if (await exists(runningPath)) {
      try {
        await rename(runningPath, pendingPath);
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    if (!(await exists(pendingPath))) await this.publishPendingLocked(spec);
  }

  private async publishPendingLocked(
    spec: DispatchSpec,
    mayCommit?: () => boolean
  ): Promise<boolean> {
    const pendingPath = path.join(this.dirs.pending, `${spec.id}.json`);
    const tmpPath = `${pendingPath}.recovery.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
    if (mayCommit && !mayCommit()) {
      await rm(tmpPath, { force: true }).catch(() => {});
      return false;
    }
    renameSync(tmpPath, pendingPath);
    return true;
  }

  private async withArtifact<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.artifactTails.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(
      () => gate,
      () => gate
    );
    this.artifactTails.set(id, tail);
    await previous.catch(() => {});
    try {
      return await task();
    } finally {
      release();
      if (this.artifactTails.get(id) === tail) this.artifactTails.delete(id);
    }
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

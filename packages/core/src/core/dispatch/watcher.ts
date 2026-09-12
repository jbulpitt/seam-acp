/**
 * SQL-backed dispatch admission and recovery with filesystem ingress/results.
 *
 * pending/ is acknowledged only after turn_attempts.admit commits. SQL pending
 * rows survive queue/file loss; suspended rows are authorized by the runtime's
 * boot/operator preconditions and continue their recorded session. running/
 * is a best-effort compatibility projection, never read for execution.
 *
 * Per-target SerialQueues preserve createdUtc/id ordering; other targets run
 * concurrently. Provider ownership, generations and completion remain in the
 * same turn_attempts row, so there is no second durable recovery queue.
 */
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { renameSync, rmSync } from "node:fs";
import * as path from "node:path";
import { SerialQueue } from "../serial-queue.js";
import { DispatchSuspendedError, type TurnAttemptStore } from "./attempt-store.js";
import type { Logger } from "../../lib/logger.js";
import type { DispatchResult, DispatchSpec } from "./types.js";
import {
  DispatchTurnError,
  dispatchDirs,
  parseDispatchSpec,
  shouldInlineCardReportBack,
} from "./types.js";

/**
 * Longest admission may stay closed waiting for boot reconciliation.
 *
 * 60s. The observed boot-recovery window in #290 was ~25s from process start
 * (resume activity and bridge reconciliation landed in the same window), so
 * this leaves roughly 2.4x headroom: an ordinary boot — a few Discord channel
 * fetches and session loads, even through a rate-limit backoff — finishes well
 * inside it and keeps the #303 ordering guarantee. Past that, something is
 * hung rather than slow: #314 records that `loadSession` has no timeout and
 * `checkResumePreconditions` makes network calls with none, so an unbounded
 * wait here costs the entire dispatch spool for the life of the process. One
 * minute of closed admission is a bounded cost; forever is an outage.
 */
export const ADMISSION_BARRIER_TIMEOUT_MS = 60_000;

/** Clamp on the originating prompt copied into a done-file (#174). */
export const DONE_ORIGIN_PROMPT_MAX = 4000;

export interface DispatchWatcherOpts {
  /** `config.DATA_DIR` — the queue lives at `<dataDir>/dispatch/`. */
  dataDir: string;
  logger: Logger;
  /** Sole authority for admitted work, execution phase, and recovery. */
  attempts: TurnAttemptStore;
  /**
   * Run one dispatched turn. Resolve ⇒ `done/` gets `status: "completed"`;
   * reject ⇒ `status: "failed"` with the error message.
   */
  onDispatch: (spec: DispatchSpec) => Promise<{ output: string; stopReason: string }>;
  /**
   * Observe a retained callback that no other actor will finish — i.e. a
   * `defect` refusal. Shutdown and superseded retentions never reach here:
   * the next boot or the current owner respectively already have that work.
   *
   * #333: this used to be gated on intake still being open, which made the
   * SAME shutdown event either a quarantine or a clean handoff depending on
   * who won a race with `stop()`. It receives the refusal now so the
   * quarantine can name its cause instead of guessing one.
   */
  onRetained?: (spec: DispatchSpec, err: DispatchSuspendedError) => Promise<void>;
  /** Poll interval in ms. Default 1000. */
  pollMs?: number;
  /**
   * Compatibility option for callers. The runtime's beforeAdmission callback
   * owns resume policy; this watcher never infers replay from a flag or file.
   */
  resumeEnabled?: boolean;
  /** Legacy delegation observation. Conflicts with SQL attempts are reported,
   * not used to veto their recorded execution. */
  mayRecover?: (id: string) => boolean;
  /** Boot reconciliation that must finish before pending specs may be claimed. */
  beforeAdmission?: () => Promise<void>;
  /**
   * How long admission may stay closed waiting for `beforeAdmission`. Default
   * {@link ADMISSION_BARRIER_TIMEOUT_MS}. Overridable here rather than through a
   * config key so the bound travels with the watcher that enforces it.
   */
  admissionBarrierTimeoutMs?: number;
  /** SQL completion authority survives removal of a delivered result file. */
  isCompleted?: (id: string) => boolean;
  /** Retention runs after publication, including when delivery preceded the file. */
  onResultPublished?: (id: string) => Promise<void>;
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
  /** Deterministic test seam: pauses recovery before its final SQL state check
   * and transient authorization. No recovery artifact is published. */
  beforeRecoveryPublish?: (id: string) => Promise<void>;
}

export interface DispatchWatcherStartOpts {
  /**
   * Preserve the historical test/utility behavior by default: `start()` does
   * not resolve until boot reconciliation and every spec found by its first
   * pending-directory scan have settled. Production startup disables this so
   * slow recovery or paid agent work cannot delay the rest of readiness; the
   * watcher still keeps admission closed until reconciliation finishes.
   */
  waitForInitialDispatches?: boolean;
}

/** Single production composition point for execution, retained observability,
 * and boot recovery. Tests use this same factory so deleting any wire is a
 * behavioral regression, not an untested index.ts assembly detail. */
export function createRuntimeDispatchWatcher(
  opts: Omit<DispatchWatcherOpts, "onDispatch" | "onRetained" | "beforeAdmission"> & {
    runtime: {
      dispatchInjectTurn(spec: DispatchSpec): Promise<{ output: string; stopReason: string }>;
      observeRetainedDispatch(spec: DispatchSpec, err?: DispatchSuspendedError): Promise<void>;
      recoverInterruptedTurns(): Promise<void>;
    };
  }
): DispatchWatcher {
  const { runtime, ...watcherOpts } = opts;
  return new DispatchWatcher({
    ...watcherOpts,
    onDispatch: (spec) => runtime.dispatchInjectTurn(spec),
    onRetained: (spec, err) => runtime.observeRetainedDispatch(spec, err),
    // #307: protects the production recovery barrier; deleting this wire lets
    // the runtime watcher admit pending work before interrupted turns requeue.
    beforeAdmission: () => runtime.recoverInterruptedTurns(),
  });
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
  private readonly onRetained?: DispatchWatcherOpts["onRetained"];
  private readonly pollMs: number;
  private readonly mayRecover: (id: string) => boolean;
  private readonly attempts: TurnAttemptStore;
  /** Boot/operator preconditions authorize an existing suspended row, not a
   * second durable queue. A new boot recomputes this transient permission. */
  private readonly recoveryReady = new Set<string>();
  private readonly deferred = new Set<string>();
  private readonly beforeAdmission?: () => Promise<void>;
  private admissionRelease: Promise<void> = Promise.resolve();
  private readonly admissionBarrierTimeoutMs: number;
  private readonly isCompleted: (id: string) => boolean;
  private readonly onResultPublished?: (id: string) => Promise<void>;
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
  /** #303: invalidates a delayed boot opener; deleting this fence lets stop()
   * race a slow admission barrier and accidentally reopen intake afterward. */
  private lifecycleEpoch = 0;
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
    this.onRetained = opts.onRetained;
    this.pollMs = opts.pollMs ?? 1000;
    this.mayRecover = opts.mayRecover ?? (() => true);
    this.attempts = opts.attempts;
    this.beforeAdmission = opts.beforeAdmission;
    this.admissionBarrierTimeoutMs = opts.admissionBarrierTimeoutMs ?? ADMISSION_BARRIER_TIMEOUT_MS;
    this.isCompleted = opts.isCompleted ?? (() => false);
    this.onResultPublished = opts.onResultPublished;
    this.readDir = opts.readDir ?? readdir;
    this.beforeOwnedDoneCommit = opts.beforeOwnedDoneCommit;
    this.beforeRecoveryPublish = opts.beforeRecoveryPublish;
  }

  /**
   * Wait for boot reconciliation, bounded. Always resolves: a rejected or hung
   * barrier must not be able to hold dispatch admission closed, because that
   * turns one failed recovery into a dark queue for the life of the process.
   * Both degraded outcomes are reported at error with what was forfeited.
   */
  private async awaitAdmissionBarrier(): Promise<void> {
    if (!this.beforeAdmission) return;
    const forfeited = (what: string, err?: unknown): void => {
      this.logger.error(
        { ...(err === undefined ? {} : { err }), timeoutMs: this.admissionBarrierTimeoutMs },
        `boot recovery ${what}; opening dispatch admission anyway — interrupted turns may be ` +
          "admitted out of createdUtc order, or not at all, this boot"
      );
    };
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        // A rejection is caught HERE, before the epoch check, so the caller
        // still proceeds to open admission and run the first tick.
        this.beforeAdmission().catch((err) => forfeited("failed", err)),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            // The hung barrier keeps running detached; it cannot be cancelled,
            // but it no longer gates admission.
            forfeited(`did not finish within ${this.admissionBarrierTimeoutMs}ms`);
            resolve();
          }, this.admissionBarrierTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Create the projection dirs, retire proven-dead SQL owners, then
   * start polling. Callers may arm boot reconciliation plus the first dispatch
   * pass in the background; admission stays closed until reconciliation ends. */
  async start(opts: DispatchWatcherStartOpts = {}): Promise<void> {
    const lifecycleEpoch = ++this.lifecycleEpoch;
    for (const dir of [this.dirs.pending, this.dirs.running, this.dirs.done]) {
      await mkdir(dir, { recursive: true }).catch(err =>
        this.logger.warn({ dir, err }, "dispatch: filesystem contract unavailable; admitted SQL work remains available"));
    }
    // SINGLE-INSTANCE ASSUMPTION: recovery assumes no other seam-acp process
    // owns these specs. Two processes on one DATA_DIR would double-resume.
    this.attempts.retireDeadOwners();
    this.admissionRelease = (async () => {
      // #303: keep pending admission closed until interrupted running turns have
      // joined the same first tick; deleting this await lets newer pending turns
      // bypass the existing createdUtc ordering while recovery is still running.
      //
      // That ordering rule governs how running and pending work INTERLEAVE WHEN
      // RECOVERY SUCCEEDS. It is not a licence to halt the queue when recovery
      // fails or hangs: ordering is a correctness property of a working system,
      // admission IS the system. So a rejection and a timeout both degrade to
      // "pending work still flows, the ordering guarantee is forfeited, and we
      // say so loudly" — never to silence. `awaitAdmissionBarrier` therefore
      // always resolves, and the epoch check below still runs on those degraded
      // paths, because stop() can win during either wait.
      await this.awaitAdmissionBarrier();
      if (this.lifecycleEpoch !== lifecycleEpoch) return;
      this.ready = true;
      this.timer = setInterval(() => void this.tick(), this.pollMs);
      // Don't hold the event loop open just for the poller.
      this.timer.unref?.();
    })();
    const initialPass = this.admissionRelease.then(async () => {
      if (this.lifecycleEpoch === lifecycleEpoch && this.ready) await this.tick();
    });
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

  /** Recovery barrier only, not the paid work admitted by the initial tick.
   * Call after start(); false-wait startup intentionally returns before this. */
  admissionReleased(): Promise<void> {
    return this.admissionRelease;
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
    this.lifecycleEpoch++;
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
      names = []; // Only ingress is unavailable; admitted SQL work still runs.
    }
    // #174: re-check admission AFTER the await. Intake may have closed while
    // this tick was reading the directory; claiming now would start work the
    // shutdown barrier has already decided it is not waiting for. The specs
    // stay in `pending/` and are delivered on the next boot.
    if (!this.ready) return;
    const ids = [...new Set([...names
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length)),
      ...this.attempts.list("pending").filter(a => a.source === "dispatch").map(a => a.id),
      ...this.recoveryReady])]
      .filter((id) => !this.inFlight.has(id) && !this.claiming.has(id) && !this.deferred.has(id));
    const claimFenceSequence = this.fenceSequence;
    const claimGlobalEpoch = this.globalEpoch;
    const claims = ids.map((id) => ({ id, token: Symbol(id) }));
    for (const { id } of claims) this.claiming.add(id);

    // Admit (SQL commit + ingress acknowledgement) concurrently, but collect
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

  /** SQL wins after pruning. Legacy outputs without a SQL completion remain
   * recovery authority until their completion/delivery has been resolved. */
  async hasCompleted(id: string): Promise<boolean> {
    const attempt = this.attempts.get(id);
    if (attempt) {
      if (attempt.state === "completed" || attempt.state === "cancelled") return true;
      if (this.isCompleted(id) || !this.mayRecover(id) || await exists(path.join(this.dirs.done, `${id}.json`))) {
        this.logger.warn({ id, authority: "turn_attempts" },
          "dispatch: completion projection conflicts with nonterminal SQL; continuing recorded execution");
      }
      return false;
    }
    return this.isCompleted(id) || await exists(path.join(this.dirs.done, `${id}.json`));
  }

  /** Interrupted inventory comes only from SQL, even if every projection is lost. */
  async listStaleRunning(): Promise<DispatchSpec[]> {
    return this.attempts.list("suspended")
      .filter(a => a.source === "dispatch" && !this.inFlight.has(a.id))
      .map(a => ({ ...a.spec, resume: a.promptStarted }));
  }

  /** Authorize an existing SQL attempt after boot/operator preconditions. */
  async requeueStale(id: string): Promise<boolean> {
    return this.withArtifact(id, async () => {
      if (this.beforeRecoveryPublish) await this.beforeRecoveryPublish(id);
      const a = this.attempts.get(id);
      if (!a || a.source !== "dispatch" || a.state !== "suspended") return false;
      // Refuse only a terminal execution. A stale delegation projection cannot
      // strand nonterminal SQL-owned work; the owning dispatcher repairs it.
      this.recoveryReady.add(id);
      this.deferred.delete(id);
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
   * and cleanup all take the same id-scoped serializer. Re-read SQL after the
   * final fence check; terminal SQL wins and nonterminal SQL remains eligible
   * without reconstructing original input from a filesystem projection.
   */
  async recoverTarget(fence: DispatchTargetFence): Promise<string[]> {
    if (!this.fenceCurrent(fence)) return [];
    const specs = [...new Map([...fence.claims, ...await this.listQueueSpecs()]
      .map(spec => [spec.id, spec])).values()];
    const recovered: string[] = [];
    for (const spec of specs) {
      if (spec.target !== fence.target) continue;
      await this.withArtifact(spec.id, async () => {
        if (this.beforeRecoveryPublish) await this.beforeRecoveryPublish(spec.id);
        if (!this.fenceCurrent(fence)) return;
        const a = this.attempts.get(spec.id) ?? this.attempts.admit(spec);
        if (a.state === "completed" || a.state === "cancelled") {
          if (a.outcome) await this.finishLocked(a.id, a.outcome);
          return;
        }
        if (a.state === "suspended") this.recoveryReady.add(a.id);
        this.deferred.delete(a.id);
        recovered.push(a.id);
      });
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
      const listed = await this.listQueueSpecs();
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
    const recorded = this.attempts.get(id);
    if (recorded) {
      target = recorded.spec.target;
      correlationId = recorded.spec.correlationId;
      this.attempts.cancel(id, `abandoned: ${reason}`);
    }
    for (const dir of recorded ? [] : [this.dirs.pending]) {
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
        const runningPath = path.join(this.dirs.running, name);
        const pendingPath = path.join(this.dirs.pending, name);
        if (await this.hasCompleted(id)) {
          await rm(runningPath, { force: true }).catch(() => {});
          await rm(pendingPath, { force: true }).catch(() => {});
          return { state: "done" as const, inFlight };
        }

        let spec = this.attempts.get(id)?.spec ?? owner?.spec;
        let found = spec !== undefined;
        if (!spec) {
          for (const artifactPath of [pendingPath]) {
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

        if (spec) this.attempts.admit(spec);
        this.attempts.cancel(id, `quarantined: ${reason}`);

        await this.finishLocked(id, {
          id,
          status: "failed",
          error: `quarantined: ${reason}`,
          target: spec?.target ?? "",
          ...(spec?.correlationId ? { correlationId: spec.correlationId } : {}),
          finishedUtc: new Date().toISOString(),
        });
        if (!(await this.hasCompleted(id))) {
          throw new Error(`dispatch ${id}: quarantine result was not durable`);
        }
        return { state: "terminalized" as const, inFlight };
      });
    } finally {
      this.quarantined.delete(id);
    }
  }

  private async listQueueSpecs(): Promise<DispatchSpec[]> {
    const out = new Map<string, DispatchSpec>();
    {
      for (const name of await this.readDir(this.dirs.pending).catch(() => [])) {
        if (!name.endsWith(".json")) continue;
        const id = name.slice(0, -5);
        try { out.set(id, parseDispatchSpec(id, await readFile(path.join(this.dirs.pending, name), "utf8"))); }
        catch (err) { this.logger.warn({ id, err }, "dispatch: unreadable ingress spec"); }
      }
    }
    // SQL overwrites producer projections, never the reverse.
    for (const state of ["pending", "active", "suspended"] as const) {
      for (const a of this.attempts.list(state)) {
        if (a.source === "dispatch") out.set(a.id, { ...a.spec, resume: a.promptStarted });
      }
    }
    return [...out.values()];
  }

  /**
   * Admit ingress to SQL and publish immutable local queue ownership.
   * Returns null when fenced, terminal, owned elsewhere, or unparseable.
   * A missing producer file is normal after SQL admission. Kept separate from
   * {@link runSpec} so `tick` can order the runs after all claims land.
   */
  private async claimSpec(
    id: string,
    token: symbol,
    startedFenceSequence: number,
    startedGlobalEpoch: number
  ): Promise<{ spec: DispatchSpec; owner: ClaimOwnership } | null> {
    return this.withArtifact(id, async () => {
      const pendingPath = path.join(this.dirs.pending, `${id}.json`);
      let recorded = this.attempts.get(id);
      let incoming: DispatchSpec | undefined;
      try { incoming = parseDispatchSpec(id, await readFile(pendingPath, "utf8")); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          this.logger.error({ id, err }, "dispatch: unusable ingress; retaining SQL execution if present");
          if (!recorded) {
            await this.finishLocked(id, { id, status: "failed", target: "",
              error: (err as Error).message, finishedUtc: new Date().toISOString() });
            return null;
          }
        }
      }
      if (recorded && incoming && JSON.stringify(recorded.spec) !== JSON.stringify(incoming)) {
        this.logger.warn({ id, authority: "turn_attempts" },
          "dispatch: ingress conflicts with SQL; continuing recorded execution");
      }
      if (await this.hasCompleted(id)) {
        this.recoveryReady.delete(id);
        await rm(pendingPath, { force: true }).catch(() => {});
        return null;
      }
      // Only an unowned legacy ingress uses the old terminal ledger check.
      // Existing SQL execution keeps running despite a stale ledger projection.
      if (!recorded && incoming && !this.mayRecover(id)) {
        await this.terminalizeLocked(incoming, "abandoned: durable delegation ledger is terminal");
        return null;
      }
      let spec = recorded ? { ...recorded.spec, resume: recorded.promptStarted } : incoming;
      if (!spec) return null;
      if ((this.targetFenceSequences.get(spec.target) ?? 0) > startedFenceSequence ||
          this.globalEpoch !== startedGlobalEpoch || this.targetFences.has(spec.target) || this.globalFence) return null;
      // SQL commit precedes ingress acknowledgement. A crash anywhere after
      // this commit is recoverable with SQL alone.
      recorded = this.attempts.admit(spec);
      spec = { ...recorded.spec, resume: recorded.promptStarted };
      if (incoming && recorded.state === "suspended" && !recorded.stalledUtc) this.recoveryReady.add(id);
      await rm(pendingPath, { force: true }).catch(err =>
        this.logger.warn({ id, err }, "dispatch: admitted ingress cleanup failed; SQL owns the duplicate"));
      if (recorded.state !== "pending" && !this.recoveryReady.has(id)) return null;
      const owner: ClaimOwnership = Object.freeze({
        token, spec, targetEpoch: this.targetEpoch(spec.target), globalEpoch: this.globalEpoch,
      });
      // Intake/fencing may change during best-effort ingress cleanup.
      if (!this.ready || this.globalEpoch !== startedGlobalEpoch ||
          (this.targetFenceSequences.get(spec.target) ?? 0) > startedFenceSequence ||
          this.targetFences.has(spec.target) || this.globalFence) return null;
      this.inFlight.set(id, owner);
      this.recoveryReady.delete(id);
      // Compatibility inventory only. Failure or loss cannot change execution.
      await writeFile(path.join(this.dirs.running, `${id}.json`), JSON.stringify(spec), "utf8")
        .catch(err => this.logger.warn({ id, err }, "dispatch: running projection unavailable; SQL execution continues"));
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
      // Another queued callback may have completed this id since claim time.
      // Keep the winning SQL outcome instead of writing a replacement failure.
      if (await this.hasCompleted(id)) {
        await this.withArtifact(id, async () => {
          await rm(path.join(this.dirs.running, `${id}.json`), { force: true });
          await rm(path.join(this.dirs.pending, `${id}.json`), { force: true });
        });
        return;
      }
      if (!this.mayRecover(id) && !this.attempts.get(id)) {
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
      if (!this.owns(owner)) return;
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
        ...(shouldInlineCardReportBack(spec) ? { inlinedReportBack: true } : {}),
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
        if (err instanceof DispatchSuspendedError) {
          this.deferred.add(id);
          // SQL owns suspension. Keep the running spec; no failed done/report.
          this.logger.info(
            { id, target: spec.target, suspension: err.suspension, reason: err.reason },
            "dispatch: attempt retained"
          );
          // #333: the CLASS decides, not the clock.
          //
          // This used to read `if (this.ready && ...)`, which made the outcome
          // depend on whether `stop()` had already closed intake. The identical
          // shutdown handoff became a durable quarantine plus an operator notice
          // on the losing side of that race, and a genuine defect became silence
          // on the winning side. Both halves were wrong, and neither was
          // reproducible, because the deciding input was timing.
          //
          // A shutdown is the next boot's work and a superseded attempt is
          // somebody else's work; neither is owed a human. Only a defect is.
          // Deleting this branch restores the race and re-buries the 92% of
          // refusals that are not failures.
          if (err.suspension !== "defect") {
            this.logger.debug(
              { id, target: spec.target, suspension: err.suspension, reason: err.reason },
              "dispatch: retained attempt needs no operator action"
            );
            return;
          }
          if (this.onRetained) {
            try {
              await this.onRetained(spec, err);
            } catch (observeErr) {
              this.logger.error(
                { err: observeErr, id, target: spec.target },
                "dispatch: retained attempt observability failed"
              );
            }
          }
          return;
        }
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
        return false;
      }
      const id = owner.spec.id;
      this.attempts.completePending(id, result);
      const name = `${id}.json`;
      const finalPath = path.join(this.dirs.done, name);
      const tmpPath = `${finalPath}.tmp`;
      let published = false;
      try {
        await writeFile(tmpPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
        if (this.beforeOwnedDoneCommit) await this.beforeOwnedDoneCommit(id);
        if (!this.owns(owner)) {
          await rm(tmpPath, { force: true }).catch(() => {});
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
        // Cleanup failure cannot undo captured SQL completion. The published
        // result remains available and startup projection repairs leftovers.
        return published && (await exists(finalPath));
      }
      await this.applyRetention(id);
      return true;
    });
  }

  private async finishLocked(id: string, result: DispatchResult): Promise<void> {
    this.attempts.completePending(id, result);
    result = this.attempts.get(id)?.outcome ?? result;
    const name = `${id}.json`;
    const finalPath = path.join(this.dirs.done, name);
    const tmpPath = `${finalPath}.tmp`;
    try {
      await writeFile(tmpPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
      await rename(tmpPath, finalPath);
    } catch (err) {
      this.logger.error({ err, id }, "dispatch: could not write result file");
      await rm(tmpPath, { force: true }).catch(() => {});
      return; // SQL completion remains terminal; boot retries its projection.
    }
    await rm(path.join(this.dirs.running, name), { force: true }).catch(() => {});
    // Command-layer cancel may finalize a spec still sitting in pending/
    // (a staggered resume that has not been claimed yet).
    await rm(path.join(this.dirs.pending, name), { force: true }).catch(() => {});
    await this.applyRetention(id);
  }

  private async applyRetention(id: string): Promise<void> {
    try { await this.onResultPublished?.(id); }
    catch (err) {
      // A cleanup failure must not replace a winning output with a failure;
      // the periodic sweep retries the retained artifact.
      this.logger.warn({ err, id }, "dispatch: delivered artifact retention failed");
    }
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
    const recorded = this.attempts.get(spec.id);
    if (recorded?.state === "completed" || recorded?.state === "cancelled") {
      if (recorded.outcome) await this.finishLocked(spec.id, recorded.outcome);
      return;
    }
    this.attempts.admit(spec);
    this.attempts.cancel(spec.id, error);
    await this.finishLocked(spec.id, {
      id: spec.id,
      status: "failed",
      error,
      target: spec.target,
      ...(spec.correlationId ? { correlationId: spec.correlationId } : {}),
      finishedUtc: new Date().toISOString(),
    });
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

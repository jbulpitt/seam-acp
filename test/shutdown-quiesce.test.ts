/**
 * #174 — shutdown quiesce, drain barrier, and boot completion reconciliation.
 *
 * The bug class under test: a dispatch's OUTPUT becomes durable when
 * `done/<id>.json` is written, but its completion SIDE EFFECTS (ledger status,
 * report-back enqueue, chain advance) are DB-first and run earlier. Anything
 * that lets the store close between those two loses the delivery while the
 * answer sits on disk.
 *
 * Every test here is deterministic — no timers beyond explicit deadlines, no
 * sleeps to "let things settle", and crash points are injected explicitly
 * rather than raced.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import {
  DispatchWatcher,
  type DispatchWatcherOpts,
} from "../packages/core/src/core/dispatch/watcher.js";
import {
  reconcileCompletedDoneFiles,
  needsCompletionReplay,
  completionRoute,
} from "../packages/core/src/core/dispatch/done-reconcile.js";
import {
  DispatchTurnError,
  dispatchDirs,
  type DispatchSpec,
} from "../packages/core/src/core/dispatch/types.js";
import { DELEGATION_TERMINAL_STATUSES } from "../packages/core/src/core/types.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import { startHealthServer } from "../packages/core/src/lib/health.js";
import {
  startShutdownBudget,
  runBoundedStep,
  safeToCloseResources,
  undrainedStages,
  shutdownFitsHostBudget,
  HOST_SIGKILL_BUDGET_MS,
  SHUTDOWN_BUDGET_MS,
  SHUTDOWN_EXIT_FALLBACK_MS,
  SHUTDOWN_OVERHEAD_ALLOWANCE_MS,
} from "../packages/core/src/lib/shutdown-budget.js";
import { SeamMcpServer } from "../packages/core/src/core/mcp/seam-mcp-server.js";
import {
  SessionStore,
  isPlannedChainChildId,
  plannedChainChildDispatchId,
} from "../packages/core/src/core/session-store.js";
import net from "node:net";

const silent = pino({ level: "silent" }) as unknown as Logger;

let dataDir: string;
let dirs: ReturnType<typeof dispatchDirs>;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "seam-174-"));
  dirs = dispatchDirs(dataDir);
  await mkdir(dirs.pending, { recursive: true });
  await mkdir(dirs.running, { recursive: true });
  await mkdir(dirs.done, { recursive: true });
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function dropSpec(spec: Partial<DispatchSpec> & { id: string }): Promise<void> {
  await writeFile(
    path.join(dirs.pending, `${spec.id}.json`),
    JSON.stringify({
      target: "thread-1",
      prompt: "do the thing",
      session: "live",
      createdUtc: new Date().toISOString(),
      ...spec,
    }),
    "utf8"
  );
}
async function writeDone(id: string, body: Record<string, unknown>): Promise<void> {
  await writeFile(path.join(dirs.done, `${id}.json`), JSON.stringify(body), "utf8");
}
/** Flush enough macrotask turns that a non-blocking barrier would have won. */
const flush = async (turns = 8) => {
  for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 0));
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

// ---------------------------------------------------------------------------
// 1. The drain barrier — `stop()` is not "drained"
// ---------------------------------------------------------------------------

describe("#174 DispatchWatcher.drain", () => {
  it("writes partial worker output into a failed done-file", async () => {
    const watcher = new DispatchWatcher({
      dataDir,
      logger: silent,
      onDispatch: async () => {
        throw new DispatchTurnError(
          "onward enqueue failed",
          "USEFUL PARTIAL",
          "end_turn",
          "completed",
          undefined,
          true
        );
      },
    });
    await dropSpec({ id: "partial" });
    await watcher.start();
    await vi.waitFor(async () => {
      const result = JSON.parse(await readFile(path.join(dirs.done, "partial.json"), "utf8"));
      expect(result).toMatchObject({
        status: "failed",
        error: "onward enqueue failed",
        workerStatus: "completed",
        completionError: "onward enqueue failed",
        output: "USEFUL PARTIAL",
      });
    });
    watcher.stop();
  });

  it("stop() closes intake but does NOT mean drained", async () => {
    const gate = deferred();
    const watcher = new DispatchWatcher({
      dataDir,
      logger: silent,
      onDispatch: async () => {
        await gate.promise;
        return { output: "done", stopReason: "end_turn" };
      },
    });
    await dropSpec({ id: "slow" });
    void watcher.start();
    await vi.waitFor(() => expect(watcher.inFlightCount).toBe(1));

    watcher.stop();
    // The regression: shutdown treated this state as safe to close the store.
    expect(watcher.inFlightCount).toBe(1);

    let drained = false;
    const drain = watcher.drain().then(() => (drained = true));
    await new Promise((r) => setImmediate(r));
    expect(drained).toBe(false); // barrier is genuinely waiting

    gate.resolve();
    await drain;
    expect(drained).toBe(true);
    expect(watcher.inFlightCount).toBe(0);
  });

  it("stops claiming new specs once intake is closed", async () => {
    const watcher = new DispatchWatcher({
      dataDir,
      logger: silent,
      onDispatch: async () => ({ output: "x", stopReason: "end_turn" }),
    });
    await watcher.start();
    watcher.stop();
    await dropSpec({ id: "after-stop" });
    await watcher.tick();
    await watcher.drain();
    // Left pending for the next boot — lossless, not claimed into the window.
    expect(await readdir(dirs.pending)).toContain("after-stop.json");
    expect(await readdir(dirs.done)).not.toContain("after-stop.json");
  });

  it("reaches a fixpoint when a completing task enqueues onto another target", async () => {
    // The fixed-pass version could return with work still in flight.
    let follow: Promise<unknown> | null = null;
    const watcher = new DispatchWatcher({
      dataDir,
      logger: silent,
      onDispatch: async (spec) => {
        if (spec.id === "first") {
          // Simulate completion work landing on a different target's queue.
          follow = new Promise<void>((r) => setTimeout(r, 30));
          await follow;
        }
        return { output: spec.id, stopReason: "end_turn" };
      },
    });
    await dropSpec({ id: "first", target: "t-a" });
    await dropSpec({ id: "second", target: "t-b" });
    await watcher.start();
    watcher.stop();
    await watcher.drain();
    expect(watcher.inFlightCount).toBe(0);
    expect((await readdir(dirs.done)).sort()).toEqual(["first.json", "second.json"]);
  });

  it("carries #174 replay routing into the done-file", async () => {
    const watcher = new DispatchWatcher({
      dataDir,
      logger: silent,
      onDispatch: async () => ({ output: "the answer", stopReason: "end_turn" }),
    });
    await dropSpec({
      id: "rb",
      target: "worker",
      kind: "handoff",
      returnTo: "parent",
      correlationId: "c1",
    });
    await watcher.start();
    await watcher.drain();
    const done = JSON.parse(await readFile(path.join(dirs.done, "rb.json"), "utf8"));
    expect(done).toMatchObject({
      status: "completed",
      output: "the answer",
      returnTo: "parent",
      correlationId: "c1",
      originPrompt: "do the thing",
    });
    // `kind` must ride along: without it a replay cannot tell a handoff's
    // report-back address from a compact's actor.
    expect(done.kind).toBe("handoff");
  });

  it("carries the KIND of a self-delivering spec, so replay can refuse it", async () => {
    const watcher = new DispatchWatcher({
      dataDir,
      logger: silent,
      onDispatch: async () => ({ output: "compacted", stopReason: "end_turn" }),
    });
    // A compact spec stamps the ACTOR into returnTo.
    await dropSpec({ id: "cmp", target: "thread-target", kind: "compact", returnTo: "thread-actor" });
    await watcher.start();
    await watcher.drain();
    const done = JSON.parse(await readFile(path.join(dirs.done, "cmp.json"), "utf8"));
    expect(done.kind).toBe("compact");
    // …and that is exactly what stops the replay delivering to the actor.
    expect(completionRoute(done, { status: "interrupted", kind: "compact" })).toEqual({
      action: "terminalize",
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Bounded quiesce — two phases, explicit timeout semantics
// ---------------------------------------------------------------------------

/**
 * Captures what shutdown reported. The returned outcome and the log are two
 * separate claims: a barrier that failed could still be logging
 * "quiesce phase complete", which is what an operator actually reads.
 */
function makeCapturingLogger() {
  const entries: Array<{ level: string; msg: string; data: Record<string, unknown> }> = [];
  const at =
    (level: string) =>
    (data?: unknown, msg?: unknown) => {
      entries.push({
        level,
        msg: String(msg ?? ""),
        data: (typeof data === "object" && data ? data : {}) as Record<string, unknown>,
      });
    };
  const logger: Record<string, unknown> = {
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    debug: at("debug"),
  };
  logger.child = () => logger;
  return {
    logger: logger as unknown as Logger,
    entries,
    msgs: () => entries.map((e) => e.msg),
    find: (re: RegExp) => entries.find((e) => re.test(e.msg)),
  };
}

/**
 * Minimal orchestrator stand-in exercising the real shutdown methods.
 *
 * Built on `Orchestrator.prototype` rather than by cherry-picking methods, so
 * `activeTurns` — now a DERIVED getter over the tracked turn set — reads the
 * same way it does in production. A host that carried its own `activeTurns`
 * number could be moved by a test to a value the barrier could never see.
 */
function makeQuiesceHost(over: Record<string, unknown> = {}) {
  const self = Object.create(Orchestrator.prototype) as Record<string, unknown>;
  Object.assign(self, {
    logger: silent,
    intakeStopped: false,
    gatewayClosed: false,
    activeTurnSettles: new Set<Promise<void>>(),
    inboundWork: new Set<Promise<void>>(),
    pendingContinuations: new Set<Promise<void>>(),
    // #179 added a fifth kind of outstanding work to the barrier: jobs launched
    // from an interactive card, which outlive their click handler by minutes.
    cardJobs: new Set<Promise<void>>(),
    channelQueues: new Map<string, Promise<void>>(),
    dispatchWatcher: undefined,
    scheduledManager: undefined,
    ...over,
  });
  return self as unknown as {
    quiesce(o?: { timeoutMs?: number }): Promise<{ timedOut: boolean; continuations: number }>;
    drainAfterDispose(o?: { timeoutMs?: number }): Promise<{ timedOut: boolean }>;
    trackContinuation(p: Promise<void>): void;
    settleTrackedContinuations(): Promise<void>;
    beginTurn(): () => void;
    runScheduledPrompt(id: string): Promise<void>;
    pendingContinuations: Set<Promise<void>>;
    activeTurnSettles: Set<Promise<void>>;
    inboundWork: Set<Promise<void>>;
    cardJobs: Set<Promise<void>>;
    settleCardJobs(): Promise<void>;
    trackCardJob(p: Promise<void>): void;
    runInbound(
      label: string,
      run: () => Promise<void>,
      refuse?: () => Promise<void> | void
    ): Promise<void>;
    channelQueues: Map<string, Promise<void>>;
    intakeStopped: boolean;
    gatewayClosed: boolean;
    readonly admissionClosed: boolean;
    closeAdmission(): void;
    stopIntake(): void;
    handleRestartSentinel(): Promise<void>;
    readonly activeTurns: number;
    dispatchWatcher?: DispatchWatcher;
  };
}

describe("#174 bounded quiesce", () => {
  it("resolves without timing out once everything settles", async () => {
    const host = makeQuiesceHost();
    const g = deferred();
    host.trackContinuation(g.promise);
    const q = host.quiesce({ timeoutMs: 5000 });
    g.resolve();
    const out = await q;
    expect(out.timedOut).toBe(false);
    expect(out.continuations).toBe(0);
  });

  it("stops intake before doing anything else", async () => {
    const stop = vi.fn();
    const host = makeQuiesceHost({ dispatchWatcher: { stop, drain: async () => {}, inFlightCount: 0 } });
    await host.quiesce({ timeoutMs: 100 });
    expect(stop).toHaveBeenCalled();
    expect(host.intakeStopped).toBe(true);
  });

  it("times out instead of hanging on a wedged continuation", async () => {
    const host = makeQuiesceHost();
    host.trackContinuation(new Promise<void>(() => {})); // never settles
    const started = Date.now();
    const out = await host.quiesce({ timeoutMs: 60 });
    expect(out.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(out.continuations).toBe(1); // surfaced, not silently dropped
  });

  /**
   * A barrier stage that throws used to be swallowed and reported as
   * `timedOut: false` — indistinguishable from a clean drain, and reached by
   * SKIPPING every stage after the one that threw. `resolves.toBeDefined()`
   * asserted none of that; these do.
   */
  it("a PERSISTENTLY failing stage is never reported as drained", async () => {
    let drainCalls = 0;
    const log = makeCapturingLogger();
    const host = makeQuiesceHost({
      logger: log.logger,
      dispatchWatcher: {
        stop() {},
        inFlightCount: 1, // work really is outstanding
        drain: async () => {
          drainCalls++;
          throw new Error("drain exploded");
        },
      },
    });

    // Generous deadline on purpose: if the barrier only stopped because the
    // clock ran out, this test would still pass with a spin. It must stop on
    // its own, well inside the timeout.
    const started = Date.now();
    const phase = host.quiesce({ timeoutMs: 30_000 });

    const outcome = await phase;
    expect(Date.now() - started).toBeLessThan(5_000); // returned, did not wait out 30s
    expect(outcome.drained).toBe(false);
    expect(outcome.barrierFailed).toBe(true);
    // NOT a retry storm: the stage is attempted once per pass and the barrier
    // gives up after that pass rather than spinning until the deadline.
    expect(drainCalls).toBe(1);
    expect(outcome.timedOut).toBe(false); // it reported failure, not a timeout

    // What the operator READS must not contradict that.
    expect(log.msgs()).not.toContain("quiesce phase complete");
    expect(log.find(/barrier stage failed/)).toBeDefined();
    const final = log.find(/quiesce barrier failed/);
    expect(final?.level).toBe("warn");
    expect(final?.data).toMatchObject({ barrierFailed: true, drained: false });
  });

  it("a TRANSIENT stage failure still runs the other stages", async () => {
    let drainCalls = 0;
    const late = deferred();
    const log = makeCapturingLogger();
    const host = makeQuiesceHost({
      logger: log.logger,
      dispatchWatcher: {
        stop() {},
        inFlightCount: 0,
        drain: async () => {
          if (++drainCalls === 1) throw new Error("drain hiccup");
        },
      },
    });
    // Registered BEFORE the barrier starts: the old code threw out of stage 1
    // and never reached the turn/continuation stages at all.
    const endTurn = host.beginTurn();
    host.trackContinuation(late.promise);

    let settled = false;
    const phase = host.quiesce({ timeoutMs: 5000 }).then((r) => ((settled = true), r));
    await flush();
    // THE POINT: stage 1 threw, yet the barrier is still here, blocked on the
    // turn/continuation stages. The old single-try version jumped straight
    // past them.
    expect(settled).toBe(false);

    endTurn();
    late.resolve();
    const outcome = await phase;
    expect(drainCalls).toBe(1); // one attempt, no storm
    expect(outcome.timedOut).toBe(false);
    expect(outcome.barrierFailed).toBe(true); // the failure is not hidden
    expect(outcome.drained).toBe(false); // so it is NOT called a clean drain
    expect(host.activeTurns).toBe(0);
    expect(host.pendingContinuations.size).toBe(0);

    // Recovered, but still not announced as a clean phase.
    expect(log.msgs()).not.toContain("quiesce phase complete");
    const final = log.find(/quiesce barrier failed/);
    expect(final?.level).toBe("warn");
    expect(final?.data).toMatchObject({ barrierFailed: true, drained: false, timedOut: false });
  });

  it("a clean phase is the only thing that reports drained", async () => {
    const log = makeCapturingLogger();
    const outcome = await makeQuiesceHost({ logger: log.logger }).quiesce({ timeoutMs: 5000 });
    expect(outcome).toMatchObject({ drained: true, timedOut: false, barrierFailed: false });
    const done = log.find(/quiesce phase complete/);
    expect(done?.level).toBe("info");
    expect(done?.data).toMatchObject({ drained: true });
    expect(log.find(/failed|timed out/)).toBeUndefined();
  });

  it("post-dispose drain awaits continuations REGISTERED BY disposal", async () => {
    // The core of correction (2): disposal spawns work, so one setImmediate
    // after disposeAll is not a barrier.
    const host = makeQuiesceHost();
    await host.quiesce({ timeoutMs: 500 }); // phase 1: nothing outstanding

    const late = deferred();
    host.trackContinuation(late.promise); // simulates a disposal rejection handler
    let done = false;
    const phase2 = host.drainAfterDispose({ timeoutMs: 5000 }).then((r) => {
      done = true;
      return r;
    });
    // Flush generously: a barrier that merely yields once (the rejected
    // single-setImmediate design) resolves here, a real one does not.
    await flush();
    expect(done).toBe(false);

    late.resolve();
    expect((await phase2).timedOut).toBe(false);
    expect(done).toBe(true);
  });

  it("post-dispose drain follows continuations that spawn continuations", async () => {
    const host = makeQuiesceHost();
    const first = deferred();
    const second = deferred();
    host.trackContinuation(
      first.promise.then(() => {
        host.trackContinuation(second.promise);
      })
    );
    let done = false;
    const phase2 = host.drainAfterDispose({ timeoutMs: 5000 }).then((r) => ((done = true), r));
    first.resolve();
    await flush();
    expect(done).toBe(false); // still following the chain
    second.resolve();
    expect((await phase2).timedOut).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Replay ordering under crash injection — the correction-(1) tests
// ---------------------------------------------------------------------------

/** In-memory ledger with the real DB-first report-back claim semantics. */
function makeLedger() {
  const rows = new Map<string, {
    id: string;
    kind: string;
    status: string;
    correlationId?: string;
    targetRef?: string | null;
    worker?: string | null;
    createdUtc?: string;
  }>();
  return {
    rows,
    getDelegation: (id: string) => rows.get(id) ?? null,
    updateDelegationStatus(id: string, status: string) {
      const r = rows.get(id);
      if (r) r.status = status;
    },
    getReportBackByCorrelation(correlationId: string) {
      for (const r of rows.values()) {
        if (r.kind === "report_back" && r.correlationId === correlationId) return r;
      }
      return null;
    },
    tryRecordReportBack(entry: {
      id: string;
      correlationId?: string;
      targetRef?: string | null;
      worker?: string | null;
      status?: string;
    }) {
      // Atomic claim: first writer for a correlation wins, as in SQLite.
      if (entry.correlationId && this.getReportBackByCorrelation(entry.correlationId)) return null;
      const row = {
        id: entry.id,
        kind: "report_back",
        status: entry.status ?? "dispatched",
        correlationId: entry.correlationId,
        targetRef: entry.targetRef ?? null,
        worker: entry.worker ?? null,
        createdUtc: new Date().toISOString(),
      };
      rows.set(entry.id, row);
      return row;
    },
  };
}

function makeReplayHost(ledger: ReturnType<typeof makeLedger>, over: Record<string, unknown> = {}) {
  const self: Record<string, unknown> = {
    logger: silent,
    config: { DATA_DIR: dataDir },
    store: ledger,
    replayCompletedDispatch: Orchestrator.prototype["replayCompletedDispatch" as never],
    enqueueReportBack: Orchestrator.prototype["enqueueReportBack" as never],
    claimAndEnqueueReportBack: Orchestrator.prototype["claimAndEnqueueReportBack" as never],
    advanceChain: async () => {},
    ...over,
  };
  return self as unknown as {
    replayCompletedDispatch(r: Record<string, unknown>, route: unknown): Promise<void>;
  };
}

/**
 * Replay through the REAL routing decision rather than a route the test picked.
 * Using `completionRoute` here is deliberate: it keeps every replay test honest
 * about the contract instead of letting them assume "returnTo means deliver".
 */
async function replayVia(
  host: { replayCompletedDispatch(r: Record<string, unknown>, route: unknown): Promise<void> },
  result: Record<string, unknown>,
  row: { status: string; kind?: string } = { status: "interrupted" }
): Promise<void> {
  const route = completionRoute(result as never, row);
  if (route.action === "skip") throw new Error(`route was skip: ${route.reason}`);
  await host.replayCompletedDispatch(result, route);
}

const completedWorker = {
  id: "w1",
  target: "worker-thread",
  status: "completed" as const,
  output: "THE ANSWER",
  correlationId: "corr-1",
  returnTo: "parent-thread",
  originPrompt: "the original ask",
};

async function pendingReportBacks(): Promise<Record<string, unknown>[]> {
  const names = await readdir(dirs.pending);
  const out: Record<string, unknown>[] = [];
  for (const n of names) {
    const s = JSON.parse(await readFile(path.join(dirs.pending, n), "utf8"));
    if (s.kind === "report_back") out.push(s);
  }
  return out;
}

describe("#174 replay ordering is crash-safe", () => {
  it("enqueues the report-back BEFORE terminalizing the worker row", async () => {
    const ledger = makeLedger();
    ledger.rows.set("w1", { id: "w1", kind: "handoff", status: "interrupted" });
    const order: string[] = [];
    const host = makeReplayHost(ledger, {
      store: new Proxy(ledger, {
        get(t, k) {
          if (k === "updateDelegationStatus") {
            return (id: string, s: string) => {
              order.push("terminalize");
              ledger.updateDelegationStatus(id, s);
            };
          }
          if (k === "tryRecordReportBack") {
            return (e: { id: string; correlationId?: string }) => {
              order.push("claim");
              return ledger.tryRecordReportBack(e);
            };
          }
          return Reflect.get(t, k);
        },
      }),
    });
    await replayVia(host, completedWorker);
    expect(order).toEqual(["claim", "terminalize"]);
    expect(ledger.rows.get("w1")!.status).toBe("completed");
    const specs = await pendingReportBacks();
    expect(specs).toHaveLength(1);
    expect(String(specs[0]!.prompt)).toContain("THE ANSWER");
  });

  it("does not misreport a completion-delivery failure as an agent failure", async () => {
    const ledger = makeLedger();
    ledger.rows.set("w1", { id: "w1", kind: "handoff", status: "interrupted" });
    const host = makeReplayHost(ledger);

    await replayVia(host, {
      ...completedWorker,
      status: "failed",
      error: "disk unavailable while enqueueing onward work",
      completionError: "disk unavailable while enqueueing onward work",
      workerStatus: "completed",
    });

    expect(ledger.rows.get("w1")!.status).toBe("completed");
    const specs = await pendingReportBacks();
    expect(specs).toHaveLength(1);
    expect(String(specs[0]!.prompt)).toContain("THE ANSWER");
    expect(String(specs[0]!.prompt)).not.toContain("disk unavailable");
  });

  it("CRASH between enqueue and terminalize: delivery survives, no duplicate", async () => {
    const ledger = makeLedger();
    ledger.rows.set("w1", { id: "w1", kind: "handoff", status: "interrupted" });
    let crash = true;
    const host = makeReplayHost(ledger, {
      store: new Proxy(ledger, {
        get(t, k) {
          if (k === "updateDelegationStatus") {
            return (id: string, s: string) => {
              if (crash) throw new Error("process died before terminalize");
              ledger.updateDelegationStatus(id, s);
            };
          }
          return Reflect.get(t, k);
        },
      }),
    });
    await expect(replayVia(host, completedWorker)).rejects.toThrow(/died/);
    // Row stayed non-terminal — that is what brings the next boot back here.
    expect(ledger.rows.get("w1")!.status).toBe("interrupted");
    expect(await pendingReportBacks()).toHaveLength(1);

    // Next boot replays. Must NOT deliver twice, must finish terminalizing.
    crash = false;
    await replayVia(host, completedWorker);
    expect(await pendingReportBacks()).toHaveLength(1); // still exactly one
    expect(ledger.rows.get("w1")!.status).toBe("completed");
  });

  it("CRASH before the enqueue: row stays replayable and later delivers", async () => {
    const ledger = makeLedger();
    ledger.rows.set("w1", { id: "w1", kind: "handoff", status: "interrupted" });
    let crash = true;
    const host = makeReplayHost(ledger, {
      store: new Proxy(ledger, {
        get(t, k) {
          if (k === "getReportBackByCorrelation" && crash) {
            return () => {
              throw new Error("store closed");
            };
          }
          return Reflect.get(t, k);
        },
      }),
    });
    await expect(replayVia(host, completedWorker)).rejects.toThrow(/store closed/);
    expect(ledger.rows.get("w1")!.status).toBe("interrupted");
    expect(await pendingReportBacks()).toHaveLength(0);

    crash = false;
    await replayVia(host, completedWorker);
    expect(await pendingReportBacks()).toHaveLength(1);
    expect(ledger.rows.get("w1")!.status).toBe("completed");
  });

  it("CRASH after report-back claim but before enqueue repairs the exact claimed id", async () => {
    const ledger = makeLedger();
    ledger.rows.set("w1", { id: "w1", kind: "handoff", status: "interrupted" });
    ledger.rows.set("claimed-rb", {
      id: "claimed-rb",
      kind: "report_back",
      status: "dispatched",
      correlationId: "corr-1",
      targetRef: "parent-thread",
      createdUtc: new Date().toISOString(),
    });
    const host = makeReplayHost(ledger);

    await replayVia(host, completedWorker);

    expect(await readdir(dirs.pending)).toEqual(["claimed-rb.json"]);
    const repaired = JSON.parse(await readFile(path.join(dirs.pending, "claimed-rb.json"), "utf8"));
    expect(repaired).toMatchObject({
      id: "claimed-rb",
      kind: "report_back",
      correlationId: "corr-1",
      target: "parent-thread",
    });
    expect(String(repaired.prompt)).toContain("THE ANSWER");
    expect(ledger.rows.get("w1")!.status).toBe("completed");
  });

  it("chain advance is likewise durable before terminalize", async () => {
    const ledger = makeLedger();
    ledger.rows.set("w2", { id: "w2", kind: "forward", status: "running" });
    const order: string[] = [];
    let crash = true;
    const host = makeReplayHost(ledger, {
      advanceChain: async () => {
        order.push("advance");
        if (crash) throw new Error("advance failed");
      },
      store: new Proxy(ledger, {
        get(t, k) {
          if (k === "updateDelegationStatus") {
            return (id: string, s: string) => {
              order.push("terminalize");
              ledger.updateDelegationStatus(id, s);
            };
          }
          return Reflect.get(t, k);
        },
      }),
    });
    await expect(
      replayVia(host, { ...completedWorker, id: "w2", returnTo: undefined, chainId: "chain-1" })
    ).rejects.toThrow(/advance failed/);
    expect(order).toEqual(["advance"]); // never terminalized
    expect(ledger.rows.get("w2")!.status).toBe("running");

    crash = false;
    await replayVia(host, { ...completedWorker, id: "w2", returnTo: undefined, chainId: "chain-1" });
    expect(order).toEqual(["advance", "advance", "terminalize"]);
    expect(ledger.rows.get("w2")!.status).toBe("completed");
  });

  it("keeps report-back dedup atomic across repeated replays", async () => {
    const ledger = makeLedger();
    ledger.rows.set("w1", { id: "w1", kind: "handoff", status: "interrupted" });
    const host = makeReplayHost(ledger);
    await replayVia(host, completedWorker);
    await replayVia(host, completedWorker);
    await replayVia(host, completedWorker);
    expect(await pendingReportBacks()).toHaveLength(1);
    const rbRows = [...ledger.rows.values()].filter((r) => r.kind === "report_back");
    expect(rbRows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Boot reconciliation
// ---------------------------------------------------------------------------

describe("#174 boot done-file reconciliation", () => {
  it("runs done-file replay before stale/orphan terminalization", async () => {
    const source = await readFile(
      path.join(process.cwd(), "packages/core/src/index.ts"),
      "utf8"
    );
    const done = source.indexOf("const repaired = await reconcileCompletedDoneFiles");
    const stale = source.indexOf("delegationReconciler.reconcile();");
    const orphan = source.indexOf("store.reconcileOrphanedDelegations();");
    expect(done).toBeGreaterThan(0);
    expect(stale).toBeGreaterThan(done);
    expect(orphan).toBeGreaterThan(done);
  });

  it("drains admitted HTTP work before the manager callbacks it can start", async () => {
    const source = await readFile(
      path.join(process.cwd(), "packages/core/src/index.ts"),
      "utf8"
    );
    const http = source.indexOf("seamMcpServer.drainRequests(httpDrain)");
    const manager = source.indexOf("drainStoreWritingManagers(");
    const quiesce = source.indexOf('stage: "pre-dispose-quiesce"');
    expect(http).toBeGreaterThan(0);
    expect(manager).toBeGreaterThan(http);
    expect(quiesce).toBeGreaterThan(manager);
  });

  const base = {
    target: "worker",
    status: "completed",
    output: "answer",
    correlationId: "c9",
    returnTo: "parent",
    finishedUtc: "2026-09-03T00:00:00.000Z",
  };

  it("replays a done-file whose ledger row is non-terminal, without rerunning the worker", async () => {
    await writeDone("d1", { id: "d1", ...base });
    const replay = vi.fn(async () => {});
    const onDispatch = vi.fn(async () => ({ output: "RERUN", stopReason: "end_turn" }));
    const summary = await reconcileCompletedDoneFiles({
      dataDir,
      logger: silent,
      getDelegation: () => ({ status: "interrupted" }),
      replay,
    });
    expect(summary.reconciled).toBe(1);
    expect(replay).toHaveBeenCalledOnce();
    expect(replay.mock.calls[0]![0]).toMatchObject({ id: "d1", output: "answer", returnTo: "parent" });
    expect(onDispatch).not.toHaveBeenCalled(); // the worker is never re-executed
  });

  it("uses the CANONICAL terminal statuses, so timed_out is not replayed", async () => {
    // The local copy this replaced listed "cancelled" — not a DelegationStatus
    // at all, so that case never fired — and omitted `timed_out`, which meant a
    // timed-out row with a done-file read as unfinished and got replayed.
    for (const status of ["interrupted", "running", "dispatched"]) {
      expect(needsCompletionReplay({ returnTo: "p" }, { status })).toBe(true);
    }
    for (const status of DELEGATION_TERMINAL_STATUSES) {
      expect(needsCompletionReplay({ returnTo: "p" }, { status })).toBe(false);
    }
    // Named explicitly: this is the regression, and it must not depend on the
    // constant's contents happening to be right.
    expect(needsCompletionReplay({ returnTo: "p" }, { status: "timed_out" })).toBe(false);
    // `parked` means "set aside", not "finished", so it stays replayable —
    // matching how index.ts decides recoverability.
    expect(needsCompletionReplay({ returnTo: "p" }, { status: "parked" })).toBe(true);
  });

  it("does not guess a legacy forward's route from correlationId", async () => {
    // `kind: forward` is shared by plain forwards and chain hops. A plain
    // forward uses its dispatch id as correlationId, so that field alone does
    // not prove a chain and must never be used to terminalize the row.
    expect(
      completionRoute({} as never, {
        status: "interrupted",
        kind: "forward",
        correlationId: "chain-7",
      })
    ).toEqual({ action: "skip", reason: "delivery-unprovable" });
    expect(completionRoute({} as never, { status: "interrupted", kind: "forward" })).toEqual({
      action: "skip",
      reason: "delivery-unprovable",
    });
  });

  it("STILL reconciles an unrouted done-file whose KIND proves nothing is owed", async () => {
    // An earlier revision skipped these without reading the ledger, leaving
    // completed wake/watch/report_back rows `interrupted` so `/seam workflows`
    // offered a paid rerun of finished work. The kind is what makes it safe:
    // a wake owes no onward delivery, so terminalizing loses nothing.
    await writeDone("d2", { id: "d2", target: "t", status: "completed", finishedUtc: "x" });
    const getDelegation = vi.fn(() => ({ status: "interrupted", kind: "wake" }));
    const summary = await reconcileCompletedDoneFiles({
      dataDir, logger: silent, getDelegation, replay: async () => {},
    });
    expect(summary.reconciled).toBe(1);
    expect(getDelegation).toHaveBeenCalled();
  });

  it("skips an unknown ledger row and a terminal row", async () => {
    await writeDone("d3", { id: "d3", ...base });
    const unknown = await reconcileCompletedDoneFiles({
      dataDir, logger: silent, getDelegation: () => null, replay: async () => {},
    });
    expect(unknown).toMatchObject({ reconciled: 0, skippedUnknown: 1 });

    const terminal = await reconcileCompletedDoneFiles({
      dataDir, logger: silent, getDelegation: () => ({ status: "completed" }), replay: async () => {},
    });
    expect(terminal).toMatchObject({ reconciled: 0, skippedTerminal: 1 });
  });

  it("is idempotent across reboots once the row goes terminal", async () => {
    await writeDone("d4", { id: "d4", ...base });
    let status = "interrupted";
    const replay = vi.fn(async () => {
      status = "completed";
    });
    const deps = { dataDir, logger: silent, getDelegation: () => ({ status }), replay };
    await reconcileCompletedDoneFiles(deps);
    await reconcileCompletedDoneFiles(deps);
    await reconcileCompletedDoneFiles(deps);
    expect(replay).toHaveBeenCalledOnce();
  });

  it("one bad done-file does not stop the scan", async () => {
    await writeDone("ok1", { id: "ok1", ...base });
    await writeFile(path.join(dirs.done, "broken.json"), "{not json", "utf8");
    await writeDone("ok2", { id: "ok2", ...base });
    const summary = await reconcileCompletedDoneFiles({
      dataDir, logger: silent,
      getDelegation: () => ({ status: "interrupted" }),
      replay: async (r) => {
        if (r.id === "ok1") throw new Error("replay boom");
      },
    });
    expect(summary.failed).toBe(1);
    expect(summary.reconciled).toBe(1); // ok2 still processed
  });

  it("returns an empty summary when nothing has ever completed", async () => {
    await rm(dirs.done, { recursive: true, force: true });
    const summary = await reconcileCompletedDoneFiles({
      dataDir, logger: silent, getDelegation: () => null, replay: async () => {},
    });
    expect(summary).toMatchObject({ scanned: 0, reconciled: 0 });
  });
});

// ---------------------------------------------------------------------------
// 5. Intake gates (review blockers 1 & 2)
// ---------------------------------------------------------------------------

/**
 * An orchestrator shell for the ingress gates, built on the real prototype so
 * `admissionClosed` is the REAL getter over the REAL `gatewayClosed` field —
 * a hand-set `admissionClosed: true` would let the gate be faked.
 */
function makeIngressHost<T>(over: Record<string, unknown>): T {
  const self = Object.create(Orchestrator.prototype) as Record<string, unknown>;
  Object.assign(self, { logger: silent, intakeStopped: true, gatewayClosed: true, ...over });
  return self as unknown as T;
}

describe("#174 admission gates", () => {
  it("refuses a message that arrives after the phase-1 snapshot, without touching the store", async () => {
    const sendMessage = vi.fn(async () => {});
    const store = new Proxy(
      {},
      {
        get() {
          throw new Error("store must not be touched by the intake gate");
        },
      }
    );
    const self = makeIngressHost<{
      runInbound(label: string, run: () => Promise<void>, refuse: () => Promise<void>): Promise<void>;
      handleIncomingMessage(m: unknown): Promise<void>;
    }>({
      logger: silent,
      inboundWork: new Set(),
      adapter: { sendMessage },
      store,
      runInbound: Orchestrator.prototype["runInbound" as never],
      handleIncomingMessage: Orchestrator.prototype["handleIncomingMessage" as never],
      // Any of these running would mean the gate did not short-circuit.
      tryConsumeConfigEditorRiderUpload: async () => {
        throw new Error("admitted a turn after intake closed");
      },
    });

    await self.runInbound(
      "message",
      () => self.handleIncomingMessage({ channel: { id: "c1" }, text: "hi", authorId: "u1" }),
      async () => { await sendMessage({ platform: "discord", id: "c1" }, "Restarting — send it again."); }
    );
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(String(sendMessage.mock.calls[0]![1])).toMatch(/Restarting/i);
    // Honest wording: we did not keep it.
    expect(String(sendMessage.mock.calls[0]![1])).toMatch(/again/i);
  });

  it("retains a parked prompt instead of firing or deleting it once intake is closed", async () => {
    const deleteParked = vi.fn();
    const fireParked = vi.fn(async () => {});
    const self = {
      logger: silent,
      intakeStopped: true,
      channelQueues: new Map(),
      store: {
        getParkedByChannel: () => ({ id: "p1", channelRef: "c1" }),
        deleteParked,
      },
      fireParked,
      tryFireParked: Orchestrator.prototype["tryFireParked" as never],
    } as unknown as { tryFireParked(c: string): Promise<void> };

    await self.tryFireParked("c1");
    expect(fireParked).not.toHaveBeenCalled(); // no new turn admitted
    expect(deleteParked).not.toHaveBeenCalled(); // and not lost either
  });

  /**
   * The other two ways an INTERACTIVE turn is opened. Neither goes through
   * `handleIncomingMessage`, so neither is covered by the gate above; both
   * reach `queueOnChannel` directly and would be counted after the snapshot.
   */
  it("skips a preset's opening turn once intake is closed", () => {
    const queueOnChannel = vi.fn(async () => {});
    const make = (intakeStopped: boolean) =>
      ({
        logger: silent,
        intakeStopped,
        queueOnChannel,
        handleIncomingMessageInner: async () => {},
        startPresetOpeningTurn: Orchestrator.prototype["startPresetOpeningTurn" as never],
      }) as unknown as {
        startPresetOpeningTurn(t: unknown, r: unknown, p: unknown, a: string): void;
      };
    const thread = { platform: "discord", id: "t-new" };
    const preset = { name: "p", instructions: "say hello" };

    make(true).startPresetOpeningTurn(thread, {}, preset, "u1");
    expect(queueOnChannel).not.toHaveBeenCalled();
    // Positive control: the same call opens a turn while intake is open.
    make(false).startPresetOpeningTurn(thread, {}, preset, "u1");
    expect(queueOnChannel).toHaveBeenCalledOnce();
  });

  it("refuses a preemptive steer once intake is closed, without cancelling", async () => {
    const abortTurn = vi.fn(async () => "cancelled");
    const queueOnChannel = vi.fn(async () => ({ text: "ok" }));
    const editReply = vi.fn(async () => {});
    const make = (intakeStopped: boolean) =>
      ({
        logger: silent,
        intakeStopped,
        config: { TURN_TIMEOUT_SECONDS: 900, REPOS_ROOT: "/tmp" },
        router: { ensureSessionRecord: () => ({ id: "s1" }), abortTurn },
        queueOnChannel,
        injectTurn: async () => ({ text: "ok" }),
        postSteerCard: async () => {},
        postSteerOutput: async () => {},
        pushHumanInbox: () => ({ queued: 1 }),
        channelRefFromInteraction: () => ({ platform: "discord", id: "t1" }),
        interactionSpeakerName: () => "op",
        cmdSteer: Orchestrator.prototype["cmdSteer" as never],
      }) as unknown as { cmdSteer(i: unknown): Promise<void> };
    const interaction = {
      options: {
        getString: (name: string) => (name === "prompt" ? "do it" : undefined),
        getBoolean: () => true, // now:true — the mode that opens a turn
      },
      user: { id: "u1" },
      deferReply: async () => {},
      editReply,
    };

    await make(true).cmdSteer(interaction);
    expect(abortTurn).not.toHaveBeenCalled(); // no live turn was killed…
    expect(queueOnChannel).not.toHaveBeenCalled(); // …and none was admitted
    expect(String(editReply.mock.calls[0]![0])).toMatch(/Restarting/i);
    expect(String(editReply.mock.calls[0]![0])).toMatch(/again/i);

    // Positive control: open intake still cancels and steers.
    await make(false).cmdSteer(interaction);
    expect(abortTurn).toHaveBeenCalledOnce();
    expect(queueOnChannel).toHaveBeenCalledOnce();
  });

  /**
   * Every OTHER Discord ingress. These do not open turns, which is why an
   * earlier revision left them open — but they do store-backed work that no
   * drain tracks, and `adapter.stop()` closes the gateway WITHOUT awaiting
   * handlers already running. So a handler admitted after the snapshot can
   * still be mid-await when `store.close()` lands.
   */
  it("refuses a slash command before it can touch the store", async () => {
    const reply = vi.fn(async () => {});
    const self = makeIngressHost<{ handleSlashInteraction(i: unknown): Promise<void> }>({
      store: new Proxy({}, { get() { throw new Error("store touched by a refused slash"); } }),
    });

    await self.handleSlashInteraction({
      user: { id: "u1" },
      reply,
      // Any read of these would mean the gate ran too late.
      options: {
        getSubcommand: () => {
          throw new Error("parsed the command after intake closed");
        },
        getSubcommandGroup: () => {
          throw new Error("parsed the command after intake closed");
        },
      },
    });
    expect(String(reply.mock.calls[0]![0].content)).toMatch(/Restarting/i);
    expect(String(reply.mock.calls[0]![0].content)).toMatch(/again/i);
  });

  it("answers autocomplete with an empty list instead of reading the store", async () => {
    const respond = vi.fn(async () => {});
    const lookup = vi.fn(() => undefined);
    // NOT a throwing stub: `safeAutocompleteRespond` catches and answers []
    // anyway, so a throw here would pass with or without the gate. The real
    // assertion is that the responder is never even looked up.
    const self = makeIngressHost<{ handleAutocompleteInteraction(i: unknown): Promise<void> }>({
      autocomplete: { get: lookup },
    });

    await self.handleAutocompleteInteraction({
      respond,
      options: {
        getSubcommandGroup: () => null,
        getSubcommand: () => null,
        getFocused: () => ({ name: "x", value: "" }),
      },
    });
    expect(respond).toHaveBeenCalledWith([]);
    expect(lookup).not.toHaveBeenCalled(); // never reached the store-backed path
  });

  it("refuses a component click without dispatching to any handler", async () => {
    const replyEphemeral = vi.fn(async () => {});
    const onComponent = vi.fn();
    const self = makeIngressHost<{ install(): void }>({
      adapter: { onMessage: () => {}, onComponent, setActiveChannelCheck: () => {} },
      store: {},
      watchSentinel: () => {},
      // Any of these running would mean the wrapper gate did not short-circuit.
      handleConfigEditorComponent: () => {
        throw new Error("dispatched a component after intake closed");
      },
    });

    self.install();
    // Awaited, not called bare: the refusal now runs inside the promise chain
    // (so a SYNCHRONOUS throw from `refuse` is caught too), which costs it one
    // microtask. The wrapper returns that promise precisely so callers — the
    // adapter included — can wait for it.
    const wrapper = onComponent.mock.calls[0]![0] as (e: unknown) => Promise<void>;
    await wrapper({ customId: "cfg:x", replyEphemeral });
    expect(replyEphemeral).toHaveBeenCalledOnce();
    expect(String(replyEphemeral.mock.calls[0]![0])).toMatch(/Restarting/i);
  });

  it("refuses a choice-card click without recording it", async () => {
    const replyEphemeral = vi.fn(async () => {});
    const onChoiceInteraction = vi.fn();
    const self = makeIngressHost<{ install(): void }>({
      adapter: {
        onMessage: () => {},
        onChoiceInteraction,
        setActiveChannelCheck: () => {},
      },
      store: {},
      watchSentinel: () => {},
      handleChoiceCardInteraction: () => {
        throw new Error("handled a choice click after intake closed");
      },
    });

    self.install();
    const wrapper = onChoiceInteraction.mock.calls[0]![0] as (e: unknown) => Promise<void>;
    await wrapper({ customId: "choice:x:0", replyEphemeral });
    expect(replyEphemeral).toHaveBeenCalledOnce();
    // Honest wording: the click was NOT recorded, so the user must click again.
    expect(String(replyEphemeral.mock.calls[0]![0])).toMatch(/Restarting/i);
    expect(String(replyEphemeral.mock.calls[0]![0])).toMatch(/again/i);
  });

  it("defers thread-delete cleanup rather than writing during shutdown", async () => {
    const listScheduledByChannel = vi.fn(() => [{ id: "s1" }]);
    const self = makeIngressHost<{ handleThreadDeleted(ref: string): Promise<void> }>({
      store: { listScheduledByChannel },
    });

    await self.handleThreadDeleted("t-gone");
    // Lazy fallback owns it: a fire against a deleted thread 404s and drops it.
    expect(listScheduledByChannel).not.toHaveBeenCalled();
  });

  it("stopIntake does NOT stop the scheduled manager (preserves the cron-drain fix)", () => {
    const schedStop = vi.fn();
    const dispatchStop = vi.fn();
    const self = {
      logger: silent,
      activeTurns: 0,
      intakeStopped: false,
      dispatchWatcher: { stop: dispatchStop, inFlightCount: 0 },
      scheduledManager: { stop: schedStop },
      stopIntake: Orchestrator.prototype["stopIntake" as never],
    } as unknown as { stopIntake(): void };

    self.stopIntake();
    expect(dispatchStop).toHaveBeenCalled();
    // Regression guard: stopping cron here is what made report-update miss 5:25.
    expect(schedStop).not.toHaveBeenCalled();
  });

  /**
   * Drive the REAL `handleRestartSentinel` — the method that owns the ordering
   * this blocker is about — with only its collaborators faked.
   *
   * What is real: the sentinel read, `stopIntake()`, `waitForRestartDrain`'s
   * polling, the 2s flush wait, the unlink, the order of all of it — and the
   * turns, which are registered through the same `beginTurn()` primitive
   * `runScheduledPrompt` uses, so the drain reads them exactly as it would in
   * production. What is stubbed is only WHAT the due fire does, not that it
   * is counted.
   */
  it("keeps cron running through the drain and stops it only in the last beat", async () => {
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      await writeFile(path.join(dataDir, ".restart-pending"), "", "utf8"); // graceful
      const self = makeQuiesceHost({
        config: { DATA_DIR: dataDir, RESTART_DRAIN_TIMEOUT_MS: 60_000 },
        restartPending: false,
        dispatchWatcher: { stop: () => order.push("dispatch-intake"), inFlightCount: 0 },
        scheduledManager: { stop: () => order.push("cron") },
        postNotification: async () => {},
        restartProcess: async () => void order.push("pm2-restart"),
      }) as unknown as ReturnType<typeof makeQuiesceHost> & {
        handleRestartSentinel(): Promise<void>;
      };
      // A real user turn is mid-flight when the sentinel lands — registered
      // through the primitive the drain actually reads, not a hand-set number.
      const endUserTurn = self.beginTurn();

      const done = self.handleRestartSentinel();
      await vi.advanceTimersByTimeAsync(0);
      // Dispatch/user/parked admission closes BEFORE the drain samples turns…
      expect(self.intakeStopped).toBe(true);
      expect(order).toEqual(["dispatch-intake"]);

      // …and cron keeps its timers, which is the only reason a schedule can
      // still come due here. One does: it registers a turn even as the
      // original user turn finishes.
      await vi.advanceTimersByTimeAsync(1500);
      expect(order).not.toContain("cron");
      const endDueFire = self.beginTurn(); // a schedule comes due and fires
      endUserTurn(); // the original user turn ends; the fire is still running
      expect(self.activeTurns).toBe(1);
      await vi.advanceTimersByTimeAsync(1500);
      expect(order).not.toContain("pm2-restart"); // the fire extended the drain

      endDueFire(); // the scheduled fire finishes
      expect(self.activeTurns).toBe(0);
      await vi.advanceTimersByTimeAsync(500); // drain poll notices
      expect(order).not.toContain("pm2-restart"); // still in the 2s flush wait
      await vi.advanceTimersByTimeAsync(2000);
      await done;

      // Last beat, in order: cron stops, then pm2 restarts. `stopIntake` is
      // called twice by this path and must stay idempotent — one entry, and
      // never a second "cron" from the earlier call.
      expect(order).toEqual(["dispatch-intake", "cron", "pm2-restart"]);
      expect(await readdir(dataDir)).not.toContain(".restart-pending");
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The restart drain and SIGTERM close DIFFERENT doors, and conflating them
   * is a trap: the drain can hold for `RESTART_DRAIN_TIMEOUT_MS` (15 min) with
   * the store and the gateway fully alive, so refusing Discord ingress there
   * takes `/seam cancel` — the one lever that ends the wedged turn the drain is
   * waiting on — away from the operator, for the entire wait.
   */
  it("keeps the Discord control surface reachable for the whole restart drain", async () => {
    vi.useFakeTimers();
    try {
      await writeFile(path.join(dataDir, ".restart-pending"), "", "utf8"); // graceful
      const fireParked = vi.fn(async () => {});
      const self = makeQuiesceHost({
        config: { DATA_DIR: dataDir, RESTART_DRAIN_TIMEOUT_MS: 60_000 },
        restartPending: false,
        dispatchWatcher: { stop: () => {}, inFlightCount: 0 },
        scheduledManager: { stop: () => {} },
        postNotification: async () => {},
        restartProcess: async () => {},
        fireParked,
        store: { getParkedByChannel: () => ({ id: "p1", channelRef: "c1" }), deleteParked: vi.fn() },
      });
      const endWedgedTurn = self.beginTurn(); // something is holding the drain

      const done = self.handleRestartSentinel();
      await vi.advanceTimersByTimeAsync(0);

      // WORK intake is shut — a parked prompt must not open a new turn here…
      expect(self.intakeStopped).toBe(true);
      await (self as unknown as { tryFireParked(c: string): Promise<void> }).tryFireParked("c1");
      expect(fireParked).not.toHaveBeenCalled();

      // …but the transport is NOT, so a slash command still reaches its handler
      // rather than being answered "Restarting — that command was not run".
      expect(self.admissionClosed).toBe(false);
      const cancelRan = vi.fn(async () => {});
      const refused = vi.fn(async () => {});
      await self.runInbound("slash", cancelRan, refused);
      expect(cancelRan).toHaveBeenCalledOnce();
      expect(refused).not.toHaveBeenCalled();

      endWedgedTurn();
      await vi.advanceTimersByTimeAsync(3000);
      await done;
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * `activeTurns` is a turn's-eye view: a message counts only once its channel
   * FIFO reaches it. Everything before that — the pre-queue body, which writes
   * the store, and the wait for its place in line — reads as zero, so a message
   * admitted while the channel is idle could let the drain sample 0, skip the
   * wait entirely, and start a full agent turn on the far side of it.
   */
  it("waits for a message admitted before it has become a turn", async () => {
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      const notes: string[] = [];
      const gate = deferred(); // parks the message inside its PRE-QUEUE body
      await writeFile(path.join(dataDir, ".restart-pending"), "", "utf8"); // graceful
      const host = makeQuiesceHost({
        config: {
          DATA_DIR: dataDir,
          RESTART_DRAIN_TIMEOUT_MS: 60_000,
          TURN_TIMEOUT_SECONDS: 900,
        },
        restartPending: false,
        dispatchWatcher: { stop: () => {}, inFlightCount: 0 },
        scheduledManager: { stop: () => {} },
        postNotification: async (m: string) => void notes.push(m),
        restartProcess: async () => void order.push("pm2-restart"),
        channelGenerations: new Map<string, number>(),
        lastUserMessageAt: new Map<string, number>(),
        store: {},
        router: { ensureSessionRecord: () => ({ id: "discord:c1" }), abortTurn: async () => "" },
        tryConsumeConfigEditorRiderUpload: async () => {
          await gate.promise;
          return false;
        },
        clearTurnMarkersForChannel: async () => {},
        tryParkForOfflineBridge: async () => false,
        handleIncomingMessageInner: async () => void order.push("turn-ran"),
      });

      void host
        .runInbound("message", () =>
          (host as unknown as { handleIncomingMessage(m: unknown): Promise<void> })
            .handleIncomingMessage({ channel: { id: "c1" }, text: "hi", authorId: "u1" })
        )
        .catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      // The sharp state: admitted and doing store-backed work, but not a turn.
      expect(host.activeTurns).toBe(0);
      expect(host.inboundWork.size).toBe(1);

      const done = (host as unknown as { handleRestartSentinel(): Promise<void> })
        .handleRestartSentinel();
      await vi.advanceTimersByTimeAsync(5000);
      // The load-bearing assertion: the drain was ENTERED and is holding for
      // this message. Sampling `activeTurns` alone reads 0 here, takes the
      // no-drain branch — announcing nothing — and restarts straight through it.
      expect(notes).toEqual(["♻️ Restart requested — waiting for 1 in-flight item to finish."]);
      expect(order).toEqual([]);

      gate.resolve();
      await vi.advanceTimersByTimeAsync(5000);
      await done;
      // The turn ran to completion first, and only then did the restart fire.
      expect(order).toEqual(["turn-ran", "pm2-restart"]);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The channel FIFO's generation-skip branch returns BEFORE `beginTurn()`, so
   * a superseded message is in no turn set at all. The question that matters is
   * whether that can make the barrier snapshot early — a queued message is real
   * work, and the one that supersedes it is a real turn.
   *
   * It cannot, and this pins WHY: `handleIncomingMessage` is admitted through
   * `runInbound` and awaits its own queue link, so from admission to the last
   * `endTurn()` it is one entry in `inboundWork`, which `settleAllWork` drains.
   * The skip branch registers nothing because it DOES nothing — it returns
   * without touching the store — while the message that superseded it is held
   * by both its turn and its own inbound entry.
   */
  it("holds quiesce for a queued message, including one the generation bump skips", async () => {
    const inner = deferred();
    const q0 = deferred();
    const started: string[] = [];
    const host = makeQuiesceHost({
      config: { TURN_TIMEOUT_SECONDS: 900 },
      channelGenerations: new Map<string, number>(),
      lastUserMessageAt: new Map<string, number>(),
      store: {},
      router: {
        ensureSessionRecord: () => ({ id: "discord:c1" }),
        abortTurn: async () => "cancelled",
      },
      tryConsumeConfigEditorRiderUpload: async () => false,
      clearTurnMarkersForChannel: async () => {},
      tryParkForOfflineBridge: async () => false,
      handleIncomingMessageInner: async (m: { text: string }) => {
        started.push(m.text);
        await inner.promise;
      },
    });
    // A turn already owns the channel, so both messages queue behind it.
    host.channelQueues.set("c1", q0.promise);
    const send = (text: string) =>
      host.runInbound("message", () =>
        (host as unknown as { handleIncomingMessage(m: unknown): Promise<void> })
          .handleIncomingMessage({ channel: { id: "c1" }, text, authorId: "u1" })
      );

    const first = send("first").catch(() => {});
    await flush();
    const second = send("second").catch(() => {});
    await flush();
    expect(host.inboundWork.size).toBe(2); // both admitted, neither started
    expect(host.activeTurns).toBe(0); // …and neither is a turn yet

    // Quiesce snapshots HERE — the sharpest moment, with real work queued and
    // nothing registered as a turn.
    let drained = false;
    const phase = host.quiesce({ timeoutMs: 5000 }).then((r) => ((drained = true), r));
    await flush();
    expect(drained).toBe(false);

    q0.resolve();
    await flush();
    // The superseded message took the skip branch: it started nothing, left no
    // turn behind, and its inbound entry is gone.
    expect(started).toEqual(["second"]);
    expect(host.activeTurns).toBe(1);
    expect(host.inboundWork.size).toBe(1);
    expect(drained).toBe(false); // still held by the turn that replaced it

    inner.resolve();
    expect((await phase).drained).toBe(true);
    await Promise.all([first, second]);
    expect(host.activeTurns).toBe(0);
    expect(host.inboundWork.size).toBe(0);
  });

  it("SIGTERM's closeAdmission shuts BOTH doors, and quiesce implies it", async () => {
    const dispatchStop = vi.fn();
    const self = makeQuiesceHost({
      dispatchWatcher: { stop: dispatchStop, drain: async () => {}, inFlightCount: 0 },
    });
    expect(self.admissionClosed).toBe(false);

    self.closeAdmission();
    expect(self.admissionClosed).toBe(true);
    expect(self.intakeStopped).toBe(true); // strictly stronger, never weaker
    expect(dispatchStop).toHaveBeenCalled();

    // And the barrier does not depend on the caller having closed it first.
    const viaQuiesce = makeQuiesceHost({
      dispatchWatcher: { stop: () => {}, drain: async () => {}, inFlightCount: 0 },
    });
    await viaQuiesce.quiesce({ timeoutMs: 100 });
    expect(viaQuiesce.admissionClosed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Watcher pre-claim race (review blocker 4)
// ---------------------------------------------------------------------------

describe("#174 tick pre-claim race", () => {
  /**
   * Build a watcher whose PENDING listing can be parked mid-await.
   *
   * This is the whole point: the race lives strictly between `tick()`'s `ready`
   * check and `tickInner`'s claim, and the only thing separating them is the
   * directory read. Holding a tick there requires suspending that read — a
   * test that merely starts a tick and assumes it is parked proves nothing,
   * because it would pass just as happily against the unfixed watcher.
   */
  function makeParkableWatcher(onDispatch: DispatchWatcherOpts["onDispatch"]) {
    let gate: { at: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | null =
      null;
    const watcher = new DispatchWatcher({
      dataDir,
      logger: silent,
      onDispatch,
      readDir: async (dir) => {
        const names = await readdir(dir);
        if (dir === dirs.pending && gate) {
          const g = gate;
          gate = null; // park exactly one tick
          g.at.resolve();
          await g.release.promise;
        }
        return names;
      },
    });
    /** Arm the next pending-listing to park. Resolves once a tick is parked. */
    const armPark = () => {
      const g = { at: deferred(), release: deferred() };
      gate = g;
      return { parked: g.at.promise, release: () => g.release.resolve() };
    };
    return { watcher, armPark };
  }

  it("a tick parked between its ready check and its claim claims nothing after stop()", async () => {
    let ran = false;
    const { watcher, armPark } = makeParkableWatcher(async () => {
      ran = true;
      return { output: "should not run", stopReason: "end_turn" };
    });
    await watcher.start(); // ready, nothing pending yet
    await dropSpec({ id: "racy" });

    // Park a tick INSIDE the listing: past `ready`, before any claim.
    const park = armPark();
    const tick = watcher.tick();
    await park.parked;

    // Intake closes while the tick sits in that gap — the exact race.
    watcher.stop();

    // drain() must not be able to declare victory over a parked tick.
    let drained = false;
    const drain = watcher.drain().then(() => (drained = true));
    await flush();
    expect(drained).toBe(false);

    park.release();
    await drain;
    await tick;
    expect(drained).toBe(true);

    // The re-check after the await is what leaves the spec for the next boot.
    expect(ran).toBe(false);
    expect(await readdir(dirs.pending)).toContain("racy.json");
    expect(await readdir(dirs.done)).not.toContain("racy.json");
    expect(watcher.inFlightCount).toBe(0);
  });

  it("drain awaits a parked tick and the work it goes on to claim", async () => {
    // Same park, intake NOT closed: drain must still wait for the tick, then
    // for the spec that tick claims after it resumes. Draining queues first
    // would return here with the dispatch not yet enqueued anywhere.
    const gate = deferred();
    let finished = false;
    const { watcher, armPark } = makeParkableWatcher(async () => {
      await gate.promise;
      finished = true;
      return { output: "x", stopReason: "end_turn" };
    });
    await watcher.start();
    await dropSpec({ id: "t1" });

    const park = armPark();
    const tick = watcher.tick();
    await park.parked;

    let drained = false;
    const drain = watcher.drain().then(() => (drained = true));
    await flush();
    expect(drained).toBe(false); // waiting on the tick itself

    park.release();
    await flush();
    expect(drained).toBe(false); // now waiting on what it claimed
    expect(watcher.inFlightCount).toBe(1);

    gate.resolve();
    await drain;
    await tick;
    expect(finished).toBe(true);
    expect(watcher.inFlightCount).toBe(0);
    expect(await readdir(dirs.done)).toContain("t1.json");
  });
});

// ---------------------------------------------------------------------------
// 7. Unrouted completions (review blocker 3)
// ---------------------------------------------------------------------------

describe("#174 an unrouted completion is judged by its KIND", () => {
  it.each(["wake", "watch", "report_back", "scheduled", "peek", "parked", "choice"])(
    "terminalizes a completed %s done-file that owes nothing onward",
    async (kind) => {
      await writeDone(`u-${kind}`, {
        id: `u-${kind}`,
        target: "thread-1",
        status: "completed",
        output: "finished",
        finishedUtc: "2026-09-03T00:00:00.000Z",
        kind,
        // deliberately no returnTo / chainId
      });
      const replay = vi.fn(async () => {});
      const summary = await reconcileCompletedDoneFiles({
        dataDir,
        logger: silent,
        getDelegation: () => ({ status: "interrupted", kind }),
        replay,
      });
      expect(summary.reconciled).toBe(1);
      expect(replay.mock.calls[0]![1]).toEqual({ action: "terminalize" });
    }
  );

  it("an unrouted replay terminalizes directly and reruns nothing", async () => {
    const ledger = makeLedger();
    ledger.rows.set("u1", { id: "u1", kind: "wake", status: "running" });
    const advanceChain = vi.fn(async () => {});
    const host = makeReplayHost(ledger, { advanceChain });
    await replayVia(
      host,
      { id: "u1", target: "t", status: "completed", output: "already done", kind: "wake" },
      { status: "running", kind: "wake" }
    );
    expect(ledger.rows.get("u1")!.status).toBe("completed");
    expect(advanceChain).not.toHaveBeenCalled();
    expect(await pendingReportBacks()).toHaveLength(0); // nothing to deliver
  });
});

// ---------------------------------------------------------------------------
// 7a. An interrupt-suppressed completion owes nothing onward (#67 × #174)
// ---------------------------------------------------------------------------

/**
 * The live path suppresses ALL onward delivery when an interrupt cancelled the
 * turn (#67) — the interrupt has already issued a replacement directive. That
 * decision lives only in memory, while the done-file copies the spec's
 * `returnTo`/`chainId` unconditionally. So a completion whose ledger write lost
 * the shutdown race is, on disk, indistinguishable from one that never
 * delivered — and boot replay would send exactly the stale answer #67 withheld,
 * arriving after the directive that superseded it.
 */
describe("#174 a completion the interrupt suppressed is never re-delivered", () => {
  const suppressingDispatch = (suppressed: boolean) => async () => {
    throw new DispatchTurnError(
      "ledger write failed",
      "STALE PARTIAL",
      "cancelled",
      "completed",
      undefined,
      true,
      suppressed
    );
  };

  it("carries the suppression from the dispatch error into the done-file", async () => {
    const watcher = new DispatchWatcher({
      dataDir,
      logger: silent,
      onDispatch: suppressingDispatch(true),
    });
    await dropSpec({ id: "sup", kind: "handoff", returnTo: "parent-thread", chainId: "chain-9" });
    await watcher.start();
    await vi.waitFor(async () => {
      const result = JSON.parse(await readFile(path.join(dirs.done, "sup.json"), "utf8"));
      // The routing is still recorded — it has to be, for every OTHER file —
      // which is precisely why the suppression has to be recorded beside it.
      expect(result).toMatchObject({
        suppressedOnward: true,
        returnTo: "parent-thread",
        chainId: "chain-9",
        completionError: "ledger write failed",
      });
    });
    watcher.stop();
  });

  it("omits the flag when nothing was suppressed (negative control)", async () => {
    const watcher = new DispatchWatcher({
      dataDir,
      logger: silent,
      onDispatch: suppressingDispatch(false),
    });
    await dropSpec({ id: "owed", kind: "handoff", returnTo: "parent-thread" });
    await watcher.start();
    await vi.waitFor(async () => {
      const result = JSON.parse(await readFile(path.join(dirs.done, "owed.json"), "utf8"));
      expect(result.completionError).toBe("ledger write failed");
      expect(result.suppressedOnward).toBeUndefined();
    });
    watcher.stop();
  });

  it("terminalizes rather than routing, even carrying BOTH returnTo and chainId", () => {
    const row = { status: "running", kind: "handoff" };
    const file = { returnTo: "parent-thread", chainId: "chain-9", kind: "handoff" };
    expect(completionRoute({ ...file, suppressedOnward: true } as never, row)).toEqual({
      action: "terminalize",
    });
    // Negative controls: the SAME file without the flag is real, owed work.
    expect(completionRoute({ ...file, suppressedOnward: false } as never, row)).toEqual({
      action: "chain",
      chainId: "chain-9",
    });
    expect(completionRoute({ returnTo: "parent-thread", kind: "handoff" } as never, row)).toEqual({
      action: "report_back",
      returnTo: "parent-thread",
    });
  });

  it("reconciles the row but enqueues nothing for a suppressed done-file", async () => {
    const ledger = makeLedger();
    ledger.rows.set("w-sup", { id: "w-sup", kind: "handoff", status: "running" });
    const host = makeReplayHost(ledger);
    await writeDone("w-sup", {
      id: "w-sup",
      target: "worker-thread",
      status: "failed",
      output: "STALE PARTIAL",
      workerStatus: "completed",
      correlationId: "corr-sup",
      returnTo: "parent-thread",
      kind: "handoff",
      suppressedOnward: true,
      finishedUtc: "2026-09-03T00:00:00.000Z",
    });

    const summary = await reconcileCompletedDoneFiles({
      dataDir,
      logger: silent,
      getDelegation: (id) => ledger.getDelegation(id),
      replay: (r, route) => host.replayCompletedDispatch(r as never, route),
    });

    expect(summary.reconciled).toBe(1);
    expect(await pendingReportBacks()).toHaveLength(0); // the stale answer stays put
    expect(ledger.rows.get("w-sup")!.status).toBe("completed"); // row still repaired
  });

  it("and the identical done-file WITHOUT the flag still delivers (negative control)", async () => {
    const ledger = makeLedger();
    ledger.rows.set("w-owed", { id: "w-owed", kind: "handoff", status: "running" });
    const host = makeReplayHost(ledger);
    await writeDone("w-owed", {
      id: "w-owed",
      target: "worker-thread",
      status: "failed",
      output: "THE ANSWER",
      workerStatus: "completed",
      correlationId: "corr-owed",
      returnTo: "parent-thread",
      kind: "handoff",
      finishedUtc: "2026-09-03T00:00:00.000Z",
    });

    const summary = await reconcileCompletedDoneFiles({
      dataDir,
      logger: silent,
      getDelegation: (id) => ledger.getDelegation(id),
      replay: (r, route) => host.replayCompletedDispatch(r as never, route),
    });

    expect(summary.reconciled).toBe(1);
    const queued = await pendingReportBacks();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ target: "parent-thread", correlationId: "corr-owed" });
    expect(ledger.rows.get("w-owed")!.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// 7b. `returnTo` is not a delivery address on every kind (ROOT-LATEST-8)
// ---------------------------------------------------------------------------

describe("#174 replay matches the LIVE dispatch contract, not just the fields", () => {
  /**
   * `dispatchCompact` reads `spec.returnTo` as the ACTOR — the thread that
   * asked for the compaction — and posts its own result card. It is an
   * early-return branch of `dispatchInjectTurn` and never touches the generic
   * report-back path. A replay that inferred "returnTo ⇒ report-back" would
   * invent a delivery the live path never performs, into a thread that only
   * ever ASKED for the work.
   */
  it("a compact completion does NOT enqueue a report-back to its actor", async () => {
    const ledger = makeLedger();
    ledger.rows.set("c1", { id: "c1", kind: "compact", status: "running" });
    const host = makeReplayHost(ledger);
    const result = {
      id: "c1",
      target: "thread-target",
      status: "completed",
      output: "compacted",
      kind: "compact",
      returnTo: "thread-actor", // the ACTOR, not a report-back address
    };

    expect(completionRoute(result as never, { status: "running", kind: "compact" })).toEqual({
      action: "terminalize",
    });
    await replayVia(host, result, { status: "running", kind: "compact" });

    expect(await pendingReportBacks()).toHaveLength(0); // the whole point
    expect(ledger.rows.get("c1")!.status).toBe("completed"); // still repaired
  });

  it.each(["ingest", "thread_voice"])(
    "a %s completion delivers its own result and owes nothing onward",
    async (kind) => {
      const route = completionRoute(
        { kind, returnTo: "somewhere" } as never,
        { status: "interrupted", kind }
      );
      expect(route).toEqual({ action: "terminalize" });
    }
  );

  it("a LEGACY forward with no routing is left alone, not silently terminalized", async () => {
    // Written before #174 carried routing: it cannot prove its report-back was
    // ever enqueued. Terminalizing would strand the answer permanently and
    // silently; leaving it non-terminal is merely a rerun offer, which is the
    // pre-existing behaviour and recoverable.
    await writeDone("legacy-h", {
      id: "legacy-h",
      target: "t",
      status: "completed",
      output: "the answer",
      finishedUtc: "x",
      // no kind, no returnTo, no chainId — a pre-#174 file
    });
    const replay = vi.fn(async () => {});
    const summary = await reconcileCompletedDoneFiles({
      dataDir,
      logger: silent,
      getDelegation: () => ({ status: "interrupted", kind: "forward", correlationId: "legacy-h" }),
      replay,
    });
    expect(replay).not.toHaveBeenCalled();
    expect(summary.reconciled).toBe(0);
    expect(summary.skippedUnprovable).toBe(1);
  });

  it("a forward's correlationId does not prove whether it is a chain hop", () => {
    expect(
      completionRoute({ kind: "forward" } as never, {
        status: "interrupted",
        kind: "forward",
        correlationId: "chain-9",
      })
    ).toEqual({ action: "skip", reason: "delivery-unprovable" });
    expect(
      completionRoute({ kind: "forward" } as never, { status: "interrupted", kind: "forward" })
    ).toEqual({ action: "skip", reason: "delivery-unprovable" });
  });

  it("routing decides WHAT replay does — and, when unprovable, WHETHER", () => {
    // The earlier blanket rule ("a done-file always proves completion") was
    // right for kinds that owe nothing and wrong for a handoff that may still
    // owe a delivery.
    expect(needsCompletionReplay({ kind: "wake" }, { status: "interrupted" })).toBe(true);
    expect(needsCompletionReplay({ returnTo: "p" }, { status: "running" })).toBe(true);
    expect(needsCompletionReplay({ kind: "wake" }, { status: "completed" })).toBe(false);
    expect(needsCompletionReplay({ kind: "handoff" }, { status: "interrupted" })).toBe(false);
  });
});

describe("#174 recovery contract is bounded and honest", () => {
  it("only done-file-backed completion is recoverable after a drain timeout", async () => {
    // A dispatch that finished (done-file present) IS repaired at boot…
    await writeDone("recovered", {
      id: "recovered",
      target: "t",
      status: "completed",
      output: "answer",
      returnTo: "parent",
      correlationId: "c-rec",
      finishedUtc: "2026-09-03T00:00:00.000Z",
    });
    const replay = vi.fn(async () => {});
    const summary = await reconcileCompletedDoneFiles({
      dataDir, logger: silent, getDelegation: () => ({ status: "interrupted" }), replay,
    });
    expect(summary.reconciled).toBe(1);

    // …but a turn still RUNNING when the timeout expired has no done-file, so
    // it is NOT recovered here. It keeps the pre-existing interrupted/Resume
    // path, and rerunning it is correct because nothing completed. The barrier
    // promise may still be running as teardown proceeds; that late work is
    // explicitly out of scope for this repair.
    const noDoneFile = await reconcileCompletedDoneFiles({
      dataDir,
      logger: silent,
      getDelegation: () => ({ status: "interrupted" }),
      replay: async () => {
        throw new Error("must not be called for a dispatch with no done-file");
      },
    });
    expect(noDoneFile.scanned).toBe(1); // only the finished one is even seen
  });
});

// ---------------------------------------------------------------------------
// 9. Real shutdown ORDER, not method stand-ins
// ---------------------------------------------------------------------------

/**
 * A store that behaves like better-sqlite3: every access after `close()`
 * throws the exact production error. Records violations rather than only
 * throwing, so a test can assert "nothing touched me after close".
 */
function makeClosableStore() {
  const violations: string[] = [];
  let closed = false;
  const ledger = makeLedger();
  const scheduled = new Map<string, Record<string, unknown>>();
  const guard = (name: string) => {
    if (closed) {
      violations.push(name);
      throw new TypeError("The database connection is not open");
    }
  };
  return {
    violations,
    get closed() {
      return closed;
    },
    close() {
      closed = true;
    },
    scheduled,
    getScheduled: (id: string) => (guard("getScheduled"), scheduled.get(id)),
    patchScheduled: (id: string, patch: Record<string, unknown>) => {
      guard("patchScheduled");
      scheduled.set(id, { ...scheduled.get(id), ...patch });
    },
    getDelegation: (id: string) => (guard("getDelegation"), ledger.getDelegation(id)),
    updateDelegationStatus: (id: string, s: string) => (
      guard("updateDelegationStatus"), ledger.updateDelegationStatus(id, s)
    ),
    getReportBackByCorrelation: (c: string) => (
      guard("getReportBackByCorrelation"), ledger.getReportBackByCorrelation(c)
    ),
    tryRecordReportBack: (e: { id: string; correlationId?: string }) => (
      guard("tryRecordReportBack"), ledger.tryRecordReportBack(e)
    ),
    rows: ledger.rows,
  };
}

/** An adapter that records any use after `stop()`. */
function makeStoppableAdapter() {
  const violations: string[] = [];
  let stopped = false;
  return {
    violations,
    get stopped() {
      return stopped;
    },
    async stop() {
      stopped = true;
    },
    sendMessage: async () => {
      if (stopped) violations.push("sendMessage");
    },
  };
}

describe("#174 real shutdown sequence keeps adapter and store live", () => {
  /**
   * Drive the ACTUAL phase order against real objects: a real DispatchWatcher
   * with an in-flight dispatch whose completion runs the real DB-first
   * report-back claim, plus disposal that rejects the turn and registers a late
   * continuation touching both store and adapter.
   */
  async function runShutdown(opts: { postDisposeDrain: boolean }) {
    const store = makeClosableStore();
    const adapter = makeStoppableAdapter();
    store.rows.set("w-live", { id: "w-live", kind: "handoff", status: "running" });

    const turnGate = deferred();
    const host = makeQuiesceHost();
    const replayHost = makeReplayHost(store as never);

    const watcher = new DispatchWatcher({
      dataDir,
      logger: silent,
      onDispatch: async () => {
        await turnGate.promise; // still running when shutdown begins
        // Completion does DB-first report-back work + an adapter post.
        await replayVia(replayHost, {
          id: "w-live",
          target: "worker",
          status: "completed",
          output: "THE ANSWER",
          correlationId: "corr-live",
          returnTo: "parent",
        });
        await adapter.sendMessage();
        return { output: "THE ANSWER", stopReason: "end_turn" };
      },
    });
    await dropSpec({ id: "w-live", target: "worker", returnTo: "parent", correlationId: "corr-live" });
    // NOT awaited: start() awaits its first tick, which blocks on the gated turn.
    void watcher.start();
    await vi.waitFor(() => expect(watcher.inFlightCount).toBe(1));

    (host as unknown as { dispatchWatcher: unknown }).dispatchWatcher = watcher;

    // ---- the real sequence ----
    // phase 1: stop intake + bounded pre-dispose quiesce
    const phase1 = host.quiesce({ timeoutMs: 5000 });
    // "disposal" releases the turn, exactly as killing an agent would.
    turnGate.resolve();
    await phase1;
    // phase 2: dispose runtimes (adapter + store STILL open). Killing an agent
    // rejects its turn, and THAT rejection registers the cleanup continuation
    // — which is why the set can grow after phase 1 has already drained it.
    const killed = deferred();
    const turnRejection = killed.promise.then(() => {
      host.trackContinuation(
        (async () => {
          // Real cleanup is not a single microtask: it settles a card, posts to
          // Discord and re-reads the ledger, so it spans I/O. Modelled with one
          // real timer hop — the smallest thing a `setImmediate` cannot cover.
          await new Promise((r) => setTimeout(r, 5));
          store.getDelegation("w-live");
          await adapter.sendMessage();
        })()
      );
    });
    killed.resolve();
    await turnRejection; // dispose() returns once the kill has propagated
    // phase 3: bounded post-dispose drain (the thing under test)
    if (opts.postDisposeDrain) await host.drainAfterDispose({ timeoutMs: 5000 });
    else await new Promise((r) => setImmediate(r)); // the rejected single-yield design
    // phase 4: only now tear down
    await adapter.stop();
    store.close();
    await flush();

    return { store, adapter, watcher };
  }

  it("completes an in-flight dispatch and its report-back before anything closes", async () => {
    const { store, adapter } = await runShutdown({ postDisposeDrain: true });

    expect(store.violations).toEqual([]);
    expect(adapter.violations).toEqual([]);
    // The report-back was durably queued while the store was open…
    const specs = await pendingReportBacks();
    expect(specs).toHaveLength(1);
    expect(String(specs[0]!.prompt)).toContain("THE ANSWER");
    // …and the worker row reached terminal, so boot will not offer a rerun.
    expect(store.rows.get("w-live")!.status).toBe("completed");
    // Teardown really did happen.
    expect(store.closed).toBe(true);
    expect(adapter.stopped).toBe(true);
  });

  it("NEGATIVE CONTROL: without the post-dispose drain, late work hits a closed store", async () => {
    // Proves this test can actually detect the regression it guards.
    const { store } = await runShutdown({ postDisposeDrain: false });
    expect(store.violations.length).toBeGreaterThan(0);
    expect(store.violations).toContain("getDelegation");
  });
});

// ---------------------------------------------------------------------------
// 10. Phase 2 must watch everything phase 1 watches (isolated dispatch)
// ---------------------------------------------------------------------------

describe("#174 post-dispose drain covers an ISOLATED dispatch", () => {
  /**
   * The case phase 2 was blind to. An isolated dispatch (`session` != "live")
   * takes NO channel queue and registers NO post-turn continuation — it is
   * counted in `activeTurns` and lives in the watcher's own per-target queue.
   * So when phase 1 times out on one and `disposeAll()` is what finally
   * releases it, a phase 2 that watched only `channelQueues` + continuations
   * would resolve immediately and close the store on top of the completion.
   */
  it("phase 1 times out, disposal releases it, phase 2 holds until the done-file lands", async () => {
    const store = makeClosableStore();
    const adapter = makeStoppableAdapter();
    store.rows.set("w-iso", { id: "w-iso", kind: "handoff", status: "running" });

    const kill = deferred(); // released by disposal
    const completion = deferred(); // the DB-first completion work in flight
    const host = makeQuiesceHost();
    const replayHost = makeReplayHost(store as never);

    const watcher = new DispatchWatcher({
      dataDir,
      logger: silent,
      onDispatch: async () => {
        // Mirrors the isolated branch of `dispatchInjectTurn`: registered
        // through the real primitive, and in no queue.
        const endTurn = host.beginTurn();
        try {
          await kill.promise;
          await completion.promise;
          await replayVia(replayHost, {
            id: "w-iso",
            target: "worker",
            status: "completed",
            output: "THE ANSWER",
            correlationId: "corr-iso",
            returnTo: "parent",
          });
          await adapter.sendMessage();
          return { output: "THE ANSWER", stopReason: "end_turn" };
        } finally {
          endTurn();
        }
      },
    });
    await dropSpec({
      id: "w-iso",
      target: "worker",
      session: "isolated",
      returnTo: "parent",
      correlationId: "corr-iso",
    });
    void watcher.start();
    await vi.waitFor(() => expect(watcher.inFlightCount).toBe(1));
    host.dispatchWatcher = watcher;

    // The structural fact that made phase 2 blind: nothing in the two sets it
    // used to watch refers to this turn.
    expect(host.channelQueues.size).toBe(0);
    expect(host.pendingContinuations.size).toBe(0);
    expect(host.activeTurns).toBe(1);

    // phase 1: wedged, so it must give up rather than stall the restart.
    const phase1 = await host.quiesce({ timeoutMs: 100 });
    expect(phase1.timedOut).toBe(true);
    expect(await readdir(dirs.done)).not.toContain("w-iso.json");

    // phase 2 starts while the turn is STILL running…
    let drained = false;
    const phase2 = host.drainAfterDispose({ timeoutMs: 5000 }).then((r) => ((drained = true), r));
    await flush();
    expect(drained).toBe(false);

    // …disposal kills the agent, which releases the turn into its completion…
    kill.resolve();
    await flush();
    expect(drained).toBe(false); // still holding: the completion has not landed
    expect(await readdir(dirs.done)).not.toContain("w-iso.json");

    // …and only when the done-file and its side effects are durable does the
    // barrier let go.
    completion.resolve();
    expect((await phase2).timedOut).toBe(false);
    expect(await readdir(dirs.done)).toContain("w-iso.json");
    expect(await pendingReportBacks()).toHaveLength(1);
    expect(store.rows.get("w-iso")!.status).toBe("completed");
    expect(host.activeTurns).toBe(0);
    expect(watcher.inFlightCount).toBe(0);

    // Teardown lands after all of it, touching nothing that was already closed.
    await adapter.stop();
    store.close();
    await flush();
    expect(store.violations).toEqual([]);
    expect(adapter.violations).toEqual([]);
  });

  it("NEGATIVE CONTROL: a phase 2 without the watcher drain closes onto live work", async () => {
    // Same scenario, but phase 2 is the OLD barrier — channel queues and
    // continuations only. Proves this test can detect the regression it guards
    // rather than relying on the mutation harness to notice.
    const store = makeClosableStore();
    const adapter = makeStoppableAdapter();
    store.rows.set("w-iso2", { id: "w-iso2", kind: "handoff", status: "running" });

    const kill = deferred();
    const host = makeQuiesceHost();
    const replayHost = makeReplayHost(store as never);

    const watcher = new DispatchWatcher({
      dataDir,
      logger: silent,
      onDispatch: async () => {
        const endTurn = host.beginTurn();
        try {
          await kill.promise;
          // Disposal released the agent; the DB-first completion runs now, and
          // it spans real I/O the way the live path does.
          await new Promise((r) => setTimeout(r, 5));
          await replayVia(replayHost, {
            id: "w-iso2",
            target: "worker",
            status: "completed",
            output: "THE ANSWER",
            correlationId: "corr-iso2",
            returnTo: "parent",
          });
          return { output: "THE ANSWER", stopReason: "end_turn" };
        } finally {
          endTurn();
        }
      },
    });
    await dropSpec({
      id: "w-iso2",
      target: "worker",
      kind: "handoff",
      session: "isolated",
      returnTo: "parent",
      correlationId: "corr-iso2",
    });
    void watcher.start();
    await vi.waitFor(() => expect(watcher.inFlightCount).toBe(1));
    host.dispatchWatcher = watcher;

    await host.quiesce({ timeoutMs: 100 }); // phase 1 times out on the wedged turn
    kill.resolve(); // router.disposeAll() releases it

    // The rejected phase-2 design: no watcher drain, no turn barrier.
    const narrow = (
      host as unknown as {
        runBoundedDrain(
          phase: string,
          ms: number,
          barrier: (onErr: (e: unknown) => void) => Promise<void>
        ): Promise<{ timedOut: boolean }>;
      }
    ).runBoundedDrain.bind(host);
    await narrow("post-dispose", 5000, async () => {
      await Promise.allSettled([...host.channelQueues.values()]);
      await host.settleTrackedContinuations();
    });

    await adapter.stop();
    store.close();
    await flush();

    // It returned while the dispatch was still completing, so the completion
    // landed on a closed store — the original #174 failure, one phase later.
    expect(store.violations.length).toBeGreaterThan(0);
    // And the damage is worse than a missing side effect: the store error
    // propagates out of the completion, so the watcher records the dispatch as
    // FAILED even though the agent had produced the answer.
    const done = JSON.parse(await readFile(path.join(dirs.done, "w-iso2.json"), "utf8"));
    expect(done.status).toBe("failed");
    expect(done.output).toBeUndefined();
    expect(await pendingReportBacks()).toHaveLength(0); // nothing delivered
  });

  it("phase 2 also holds for an isolated turn with no watcher entry at all", async () => {
    // An isolated SCHEDULED fire: no channel queue, no continuation, and no
    // dispatch spec either — `activeTurns` is the only evidence it exists.
    const host = makeQuiesceHost();
    const endTurn = host.beginTurn();
    expect(host.activeTurns).toBe(1);

    let drained = false;
    const phase2 = host.drainAfterDispose({ timeoutMs: 5000 }).then((r) => ((drained = true), r));
    await flush();
    expect(drained).toBe(false);

    endTurn();
    expect((await phase2).timedOut).toBe(false);
    expect(host.activeTurns).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 11. The isolated scheduled fire — visible to nothing but the turn set
// ---------------------------------------------------------------------------

describe("#174 an in-flight isolated scheduled fire holds both phases", () => {
  /**
   * The sharpest version of the isolated-turn problem.
   *
   * `runScheduledPrompt` registers an isolated fire and then runs it: no
   * channel queue, no tracked continuation, no dispatch spec. Once
   * `scheduledManager.stop()` has run, the manager no longer refers to it
   * either — the registered turn is the ONLY evidence it is still running. Its
   * tail (the schedule-status patch) needs an open store, so a barrier that
   * cannot see it lets `store.close()` land underneath.
   *
   * The fire's internals are stubbed on purpose: what is under test is the
   * wrapper's registration and the barrier, not the scheduled turn itself.
   */
  it("phase 1 waits for it and its status patch, and nothing closes early", async () => {
    const store = makeClosableStore();
    store.scheduled.set("s-1", { id: "s-1", sessionMode: "isolated" });
    const fire = deferred();
    let patched = false;
    const host = makeQuiesceHost({
      store,
      scheduledManager: { stop: () => {} },
      runScheduledPromptInner: async () => {
        await fire.promise;
        store.patchScheduled("s-1", { lastStatus: "ok" }); // the tail
        patched = true;
      },
    });

    const running = host.runScheduledPrompt("s-1");
    await flush();
    expect(host.activeTurns).toBe(1);
    // Nothing else in the process refers to this turn.
    expect(host.channelQueues.size).toBe(0);
    expect(host.pendingContinuations.size).toBe(0);

    let drained = false;
    const phase1 = host.quiesce({ timeoutMs: 5000 }).then((r) => ((drained = true), r));
    await flush();
    expect(drained).toBe(false);
    expect(patched).toBe(false);

    fire.resolve();
    expect((await phase1).timedOut).toBe(false);
    await running;
    expect(patched).toBe(true); // landed while the store was open

    // Phase 2 has nothing left, and teardown touches nothing already closed.
    expect((await host.drainAfterDispose({ timeoutMs: 5000 })).timedOut).toBe(false);
    store.close();
    await flush();
    expect(store.violations).toEqual([]);
  });

  it("a live scheduled fire is registered before its pre-queue awaits", async () => {
    const store = makeClosableStore();
    store.scheduled.set("s-live", { id: "s-live", sessionMode: "live" });
    const fire = deferred();
    const host = makeQuiesceHost({
      store,
      runScheduledPromptInner: async () => {
        expect(host.activeTurns).toBe(1);
        await fire.promise;
      },
    });

    const running = host.runScheduledPrompt("s-live");
    await flush();
    expect(host.activeTurns).toBe(1);
    fire.resolve();
    await running;
    expect(host.activeTurns).toBe(0);
  });
});

describe("#174 an ingest job stays registered through its durable tail", () => {
  /**
   * `dispatchIngestEndpoint` released its turn in the `finally` around
   * `injectTurn`, then went on to post the output and write the ledger status.
   * That tail is durable work performed by a turn nothing was counting — the
   * same shape as the post-turn continuation bug, one method over.
   */
  it("is still counted when its ledger status is written", async () => {
    let turnsAtLedgerWrite = -1;
    const host = makeQuiesceHost({
      config: { DEFAULT_AGENT: "a", REPOS_ROOT: "/tmp", TURN_TIMEOUT_SECONDS: 900 },
      ingestJobs: new Map(),
      router: {
        getProfile: () => ({ id: "a" }),
        mintMcpServersForSession: () => ({}),
        revokeMcpSession: () => {},
      },
      store: {
        recordDelegation: () => {},
        updateDelegationStatus: () => {
          turnsAtLedgerWrite = host.activeTurns;
        },
      },
      injectTurn: async () => ({ text: "scored" }),
    }) as unknown as ReturnType<typeof makeQuiesceHost> & {
      dispatchIngestEndpoint(s: Record<string, unknown>): Promise<{ output: string }>;
    };

    const out = await host.dispatchIngestEndpoint({
      id: "ing-1",
      target: "not-a-snowflake", // no notify thread, so no adapter post
      prompt: "score this",
      createdUtc: new Date().toISOString(),
    });

    expect(out.output).toBe("scored");
    expect(turnsAtLedgerWrite).toBe(1); // released only after the tail
    expect(host.activeTurns).toBe(0); // and released for certain
  });
});

// ---------------------------------------------------------------------------
// 12. HTTP ingress: /mcp and /ingest (ROOT-LATEST-7 / -7b)
// ---------------------------------------------------------------------------

describe("#174 HTTP ingress closes admission before the snapshot", () => {
  /** POST to a real listening server and return status + body. */
  async function post(port: number, path: string, body = "{}"): Promise<{ status: number; body: string }> {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    return { status: res.status, body: await res.text() };
  }
  const listeningPort = (s: { address(): unknown }) =>
    (s.address() as { port: number }).port;

  it("refuses /mcp and /ingest but keeps answering /health", async () => {
    const health = startHealthServer(0, silent, {
      onMcp: async (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: "mcp" }));
      },
      onIngest: async (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: "ingest" }));
      },
    });
    await vi.waitFor(() => expect(health.address()).toBeTruthy());
    const port = listeningPort(health);
    try {
      expect((await post(port, "/mcp")).status).toBe(200);
      expect((await post(port, "/ingest")).status).toBe(200);

      health.closeIngress();

      const mcp = await post(port, "/mcp");
      expect(mcp.status).toBe(503);
      expect(mcp.body).toMatch(/restarting/i);
      expect((await post(port, "/ingest")).status).toBe(503);
      // Monitoring still needs a truthful answer while we drain.
      const h = await fetch(`http://127.0.0.1:${port}/health`);
      expect(h.status).toBe(200);
    } finally {
      health.close();
    }
  });

  it("drains a request admitted just before closure, then reports it drained", async () => {
    const gate = deferred();
    let finished = false;
    const health = startHealthServer(0, silent, {
      onIngest: async (_req, res) => {
        await gate.promise; // still writing to the store when shutdown starts
        finished = true;
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      },
    });
    await vi.waitFor(() => expect(health.address()).toBeTruthy());
    const port = listeningPort(health);
    try {
      const inflight = post(port, "/ingest");
      await vi.waitFor(() => expect(health.listening).toBe(true));
      await flush();

      health.closeIngress();
      let drained: { drained: boolean; outstanding: number } | undefined;
      const drain = health.drainIngress(5000).then((r) => (drained = r));
      await flush();
      // THE POINT: `close()` alone could not see this — the handler promise is
      // fire-and-forget — so the drain must be what holds shutdown open.
      expect(drained).toBeUndefined();
      expect(finished).toBe(false);

      gate.resolve();
      await drain;
      expect(drained).toEqual({ drained: true, outstanding: 0 });
      expect(finished).toBe(true);
      await inflight;
    } finally {
      health.close();
    }
  });

  it("gives up on a wedged request instead of stalling shutdown", async () => {
    const health = startHealthServer(0, silent, {
      onIngest: () => new Promise<void>(() => {}), // never settles
    });
    await vi.waitFor(() => expect(health.address()).toBeTruthy());
    const port = listeningPort(health);
    try {
      void post(port, "/ingest").catch(() => {});
      await vi.waitFor(async () => {
        await flush();
        expect((await health.drainIngress(1)).outstanding).toBe(1);
      });
      const started = Date.now();
      const result = await health.drainIngress(120);
      expect(result).toEqual({ drained: false, outstanding: 1 });
      expect(Date.now() - started).toBeLessThan(3000); // bounded, not hung
    } finally {
      health.close();
    }
  });
});

describe("#174 seam-mcp shares one gate across both entry points", () => {
  function makeMcpHost(over: Record<string, unknown> = {}) {
    const self = Object.create(SeamMcpServer.prototype) as Record<string, unknown>;
    Object.assign(self, {
      logger: silent,
      admissionOpen: true,
      inFlight: new Set<Promise<void>>(),
      ...over,
    });
    return self as unknown as SeamMcpServer & {
      handle(req: unknown, res: unknown): Promise<void>;
      inFlight: Set<Promise<void>>;
    };
  }
  const fakeRes = () => {
    const out = { status: 0, body: "", headersSent: false };
    return {
      out,
      writeHead(status: number) {
        out.status = status;
        out.headersSent = true;
      },
      end(body?: string) {
        out.body = body ?? "";
      },
    };
  };

  it("refuses a tool call once admission is closed, before reading the body", async () => {
    let bodyRead = false;
    const server = makeMcpHost({
      handleAdmitted: async () => {
        bodyRead = true;
      },
    });
    server.closeAdmission();
    expect(server.admissionClosed).toBe(true);

    const res = fakeRes();
    // `handleRequest` is the health-proxy entry; it delegates to the same
    // private `handle` the direct listener uses, so one gate covers both.
    await server.handleRequest({ method: "POST", url: "/mcp" } as never, res as never);
    expect(res.out.status).toBe(503);
    expect(res.out.body).toMatch(/restarting/i);
    expect(bodyRead).toBe(false); // nothing the call would do ever started
  });

  it("tracks an admitted call so drainRequests can wait for it", async () => {
    const gate = deferred();
    let finished = false;
    const server = makeMcpHost({
      handleAdmitted: async () => {
        await gate.promise;
        finished = true;
      },
    });

    const call = server.handleRequest({ method: "POST", url: "/mcp" } as never, fakeRes() as never);
    expect(server.inFlightCount).toBe(1);

    server.closeAdmission(); // admitted calls keep running
    let drained: { drained: boolean } | undefined;
    const drain = server.drainRequests(5000).then((r) => (drained = r));
    await flush();
    expect(drained).toBeUndefined();
    expect(finished).toBe(false);

    gate.resolve();
    await call;
    await drain;
    expect(drained).toEqual({ drained: true, outstanding: 0 });
    expect(server.inFlightCount).toBe(0);
  });

  it("bounds the CONNECTION close against a lingering socket", async () => {
    // `server.close()` does not call back until every open connection ends, so
    // awaiting it unbounded stalls shutdown exactly when a hung tool call is
    // what caused the quiesce timeout. A raw socket reproduces that: connected,
    // never sending, never closing.
    const server = makeMcpHost();
    await server.start();
    const sock = net.connect(server.port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      sock.once("connect", () => resolve());
      sock.once("error", reject);
    });
    try {
      const started = Date.now();
      await server.stop({ timeoutMs: 150 });
      expect(Date.now() - started).toBeLessThan(3000); // gave up, did not hang
    } finally {
      sock.destroy();
    }
  });

  it("bounds the drain rather than waiting on a wedged tool call", async () => {
    const server = makeMcpHost({ handleAdmitted: () => new Promise<void>(() => {}) });
    void server.handleRequest({ method: "POST", url: "/mcp" } as never, fakeRes() as never);
    server.closeAdmission();
    const started = Date.now();
    expect(await server.drainRequests(120)).toEqual({ drained: false, outstanding: 1 });
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

// ---------------------------------------------------------------------------
// 13. Ingress admitted just BEFORE closure is tracked, not just gated
// ---------------------------------------------------------------------------

describe("#174 an admitted gateway handler is part of quiescence", () => {
  /**
   * Gating stops the NEXT handler. It does nothing for the one admitted a
   * millisecond earlier — that handler sits in no channel queue, counts as no
   * turn and registers no continuation, so before `inboundWork` existed the
   * barrier could not see it and `store.close()` could land on top of it.
   */
  it("phase 1 waits for a slash command admitted before the gate closed", async () => {
    const store = makeClosableStore();
    const work = deferred();
    let wrote = false;
    const host = makeQuiesceHost();

    // Admitted while intake is still open.
    const running = host.runInbound("slash", async () => {
      await work.promise;
      store.getDelegation("anything"); // the store touch that must land early
      wrote = true;
    });
    await flush();
    expect(host.inboundWork.size).toBe(1);
    // Invisible to every other collection the barrier watches.
    expect(host.channelQueues.size).toBe(0);
    expect(host.activeTurns).toBe(0);
    expect(host.pendingContinuations.size).toBe(0);

    let drained = false;
    const phase1 = host.quiesce({ timeoutMs: 5000 }).then((r) => ((drained = true), r));
    await flush();
    expect(drained).toBe(false); // held open by the admitted handler
    expect(wrote).toBe(false);

    work.resolve();
    expect((await phase1).drained).toBe(true);
    await running;
    expect(wrote).toBe(true);

    store.close();
    await flush();
    expect(store.violations).toEqual([]); // it finished while the store was open
  });

  it("refuses the NEXT handler without tracking or touching anything", async () => {
    const host = makeQuiesceHost();
    const refuse = vi.fn(async () => {});
    const run = vi.fn(async () => {});

    await host.quiesce({ timeoutMs: 1000 }); // closes admission
    await host.runInbound("slash", run, refuse);

    expect(run).not.toHaveBeenCalled();
    expect(refuse).toHaveBeenCalledOnce();
    expect(host.inboundWork.size).toBe(0); // a refusal is not tracked work
  });

  it("NEGATIVE CONTROL: an untracked handler reaches a closed store", async () => {
    // The pre-fix shape: the handler runs fire-and-forget, so the barrier has
    // nothing to wait on and teardown happens underneath it.
    const store = makeClosableStore();
    const work = deferred();
    const host = makeQuiesceHost();

    const untracked = (async () => {
      await work.promise;
      try {
        store.getDelegation("anything");
      } catch {
        /* recorded as a violation */
      }
    })();

    expect((await host.quiesce({ timeoutMs: 1000 })).drained).toBe(true); // saw nothing
    store.close();
    work.resolve();
    await untracked;
    await flush();
    expect(store.violations).toContain("getDelegation");
  });
});

/**
 * #179 — a card job is the fifth kind of outstanding work.
 *
 * A premium compaction launched from `/seam info sessions` runs for MINUTES
 * after its click handler returned. It sits in no channel queue, is no
 * registered turn, and registers no post-turn continuation, so before it was a
 * barrier stage the shutdown drain could report a perfectly clean pass while
 * one was mid-pipeline — and then close the store underneath its
 * compare-and-swap. That is the #174 failure on a surface #174 predates.
 */
describe("#179 card jobs hold the shutdown barrier", () => {
  it("a held card job keeps quiesce from reporting drained", async () => {
    const host = makeQuiesceHost();
    const job = deferred();
    host.trackCardJob(job.promise);
    expect(host.cardJobs.size).toBe(1);

    let outcome: { drained: boolean } | undefined;
    const phase = host.quiesce({ timeoutMs: 5000 }).then((r) => (outcome = r));
    await flush();
    expect(outcome).toBeUndefined(); // genuinely held, not merely slow

    job.resolve();
    await phase;
    expect(outcome!.drained).toBe(true);
    expect(host.cardJobs.size).toBe(0);
  });

  it("phase 2 holds for it too — disposal can leave one running", async () => {
    const host = makeQuiesceHost();
    const job = deferred();
    host.trackCardJob(job.promise);

    let done = false;
    const phase = host.drainAfterDispose({ timeoutMs: 5000 }).then((r) => ((done = true), r));
    await flush();
    expect(done).toBe(false);

    job.resolve();
    expect((await phase).drained).toBe(true);
  });

  it("AWAITS the job rather than polling for it", async () => {
    // Without the dedicated stage the barrier still terminates — the quiet
    // condition eventually goes true — but it gets there by spinning the whole
    // loop, `setImmediate` after `setImmediate`, for the entire ten minutes a
    // premium compaction runs. #174 added that condition precisely so a drain
    // could not burn CPU waiting; the stage is what makes this a wait.
    //
    // One loop pass ⇒ one watcher drain. A spin shows up as many.
    let passes = 0;
    const host = makeQuiesceHost({
      dispatchWatcher: {
        stop: () => {},
        inFlightCount: 0,
        drain: async () => {
          passes++;
        },
      },
    });
    const job = deferred();
    host.trackCardJob(job.promise);

    const phase = host.quiesce({ timeoutMs: 5000 });
    await flush(20);
    expect(passes).toBe(1);

    job.resolve();
    expect((await phase).drained).toBe(true);
  });

  it("a job registered after the card stage still re-arms the loop", async () => {
    // The stage drains to its own fixpoint, so it catches anything registered
    // WHILE it runs. What it cannot catch is a registration that lands in the
    // yield between the last stage and the quiet check — a settling render
    // scheduling one more. That gap is what the `cardJobs.size` term closes.
    const host = makeQuiesceHost();
    const late = deferred();
    const first = deferred();
    host.trackCardJob(
      first.promise.then(() => {
        // Scheduled, not registered: this lands after the stage has finished.
        setImmediate(() => host.trackCardJob(late.promise));
      })
    );

    let done = false;
    const phase = host.quiesce({ timeoutMs: 5000 }).then((r) => ((done = true), r));
    await flush();
    first.resolve();
    await flush();
    expect(done).toBe(false); // the late registration re-armed the loop

    late.resolve();
    expect((await phase).drained).toBe(true);
  });

  it("a card job registered by another card job re-arms the fixpoint", async () => {
    // A completion can start another render, which is itself tracked. One pass
    // over the set is not enough.
    const host = makeQuiesceHost();
    const first = deferred();
    const second = deferred();
    host.trackCardJob(
      first.promise.then(() => {
        host.trackCardJob(second.promise);
      })
    );

    let done = false;
    const phase = host.quiesce({ timeoutMs: 5000 }).then((r) => ((done = true), r));
    await flush();
    first.resolve();
    await flush();
    expect(done).toBe(false); // the follow-on job is holding it now

    second.resolve();
    expect((await phase).drained).toBe(true);
  });

  it("times out honestly rather than hanging on a wedged card job", async () => {
    const host = makeQuiesceHost();
    host.trackCardJob(new Promise<void>(() => {})); // never settles
    const out = await host.quiesce({ timeoutMs: 30 });
    expect(out.timedOut).toBe(true);
    expect(out.drained).toBe(false);
  });

  it("NEGATIVE CONTROL: without the stage, the same drain reports CLEAN", async () => {
    // The pre-#179 barrier: `cardJobs` existed but `settleAllWork` neither
    // awaited it nor counted it in the quiet condition. Model exactly that by
    // neutralising the stage and the termination term, and the identical held
    // job becomes invisible — `drained: true` with a compaction still running.
    const host = makeQuiesceHost({
      settleCardJobs: async () => {},
      cardJobs: {
        size: 0,
        add() {},
        delete() {},
        [Symbol.iterator]: function* () {},
      },
    });
    const job = deferred();
    let touchedStoreAfterDrain = false;
    const running = job.promise.then(() => {
      touchedStoreAfterDrain = true;
    });

    const out = await host.quiesce({ timeoutMs: 1000 });
    expect(out.drained).toBe(true); // …and it is lying

    job.resolve();
    await running;
    await flush();
    // The work the drain claimed was finished ran AFTER shutdown moved on.
    expect(touchedStoreAfterDrain).toBe(true);
  });
});

describe("#174 the component wrapper AWAITS its handlers, not just gates them", () => {
  /**
   * The four component handlers used to be `void`-ed individually — four
   * fire-and-forget promises with no handle, so nothing could ever wait for
   * them. Gating the wrapper does not fix that: a click admitted just before
   * the gate closed still runs untracked. The wrapper must aggregate them into
   * the ONE promise it registers, or `inboundWork` holds a promise that
   * resolves while the real work is still going.
   */
  it("a blocked component handler keeps quiesce pending until it settles", async () => {
    const onComponent = vi.fn();
    const slow = deferred();
    let finished = false;
    const host = makeQuiesceHost({
      adapter: { onMessage: () => {}, onComponent, setActiveChannelCheck: () => {} },
      store: {},
      watchSentinel: () => {},
      handleConfigEditorComponent: async () => {},
      handleTtsEditorComponent: async () => {},
      handleQuotaCardComponent: async () => {},
      // One slow handler stands for any real store-backed component action.
      handleVoiceConsoleComponent: async () => {
        await slow.promise;
        finished = true;
      },
    }) as unknown as ReturnType<typeof makeQuiesceHost> & { install(): void };

    host.install();
    const wrapper = onComponent.mock.calls[0]![0] as (e: unknown) => void;
    wrapper({ customId: "vc:x", replyEphemeral: async () => {} });
    await flush();

    // Admitted and tracked as ONE promise covering all four handlers.
    expect(host.inboundWork.size).toBe(1);

    let drained = false;
    const phase1 = host.quiesce({ timeoutMs: 5000 }).then((r) => ((drained = true), r));
    await flush();
    expect(drained).toBe(false); // the tracked promise has NOT resolved early
    expect(finished).toBe(false);

    slow.resolve();
    expect((await phase1).drained).toBe(true);
    expect(finished).toBe(true);
    expect(host.inboundWork.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 14. One shared budget for the whole shutdown (review blocker 5)
// ---------------------------------------------------------------------------

describe("#174 shutdown is bounded as a WHOLE, not just per stage", () => {
  /** A budget on a hand-cranked clock, so the arithmetic is exact. */
  function fakeBudget(totalMs: number) {
    let now = 0;
    const budget = startShutdownBudget(totalMs, () => now);
    /** Spend a stage that uses its entire allowance. */
    const spend = (capMs: number): number => {
      const ms = budget.forStage(capMs);
      now += ms;
      return ms;
    };
    return { budget, spend, elapsed: () => now };
  }

  it("hands a stage its own ceiling while the budget is ample", () => {
    const { budget } = fakeBudget(20_000);
    expect(budget.forStage(5_000)).toBe(5_000);
    expect(budget.remaining()).toBe(20_000);
    expect(budget.expired()).toBe(false);
  });

  it("caps a stage at what is LEFT, never at its own ceiling", () => {
    const { budget, spend } = fakeBudget(12_000);
    expect(spend(10_000)).toBe(10_000);
    // The next stage would like 10s; only 2s of budget survives.
    expect(budget.forStage(10_000)).toBe(2_000);
  });

  it("the four drain stages cannot sum past the budget", () => {
    // Representative sequential stages from index.ts, each asking for its
    // full ceiling. The shared budget keeps added stages from extending the
    // process beyond the host kill window.
    const { budget, spend, elapsed } = fakeBudget(SHUTDOWN_BUDGET_MS);
    const stages = [spend(10_000), spend(10_000), spend(5_000), spend(10_000)];
    expect(stages.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(SHUTDOWN_BUDGET_MS);
    expect(elapsed()).toBeLessThanOrEqual(SHUTDOWN_BUDGET_MS);
    expect(budget.expired()).toBe(true);
    // And a stage asked for after expiry gives up instantly rather than
    // starting a fresh timeout on a process that is already out of time.
    expect(budget.forStage(10_000)).toBe(0);
  });

  it("NEGATIVE CONTROL: the same four ceilings sequentially overrun the host", () => {
    // What the code did before: a fresh timeout per stage, so the ceilings add
    // up. 35s is past SIGKILL — the process is killed mid-teardown, which is
    // the failure mode all of #174 exists to prevent.
    const sequential = 10_000 + 10_000 + 5_000 + 10_000;
    expect(sequential).toBe(35_000);
    expect(sequential).toBeGreaterThan(HOST_SIGKILL_BUDGET_MS);
    // The shared budget clamps that same demand to something that fits.
    expect(SHUTDOWN_BUDGET_MS).toBeLessThan(sequential);
  });

  it("worst case — budget + exit fallback + overhead — stays under SIGKILL", () => {
    const worstCase =
      SHUTDOWN_BUDGET_MS + SHUTDOWN_EXIT_FALLBACK_MS + SHUTDOWN_OVERHEAD_ALLOWANCE_MS;
    expect(worstCase).toBeLessThan(HOST_SIGKILL_BUDGET_MS);
    // Real margin, not a tie: the earlier 25s budget left exactly 0ms once the
    // 5s fallback was counted, which is not a contract, it is a coincidence.
    expect(HOST_SIGKILL_BUDGET_MS - worstCase).toBeGreaterThanOrEqual(3_000);
    expect(shutdownFitsHostBudget()).toBe(true);
  });

  it("a zero budget degrades to giving up immediately, not to waiting forever", () => {
    const { budget } = fakeBudget(0);
    expect(budget.forStage(10_000)).toBe(0);
    expect(budget.expired()).toBe(true);
  });

  it("never returns a negative allowance once the clock has run past the budget", () => {
    let now = 0;
    const budget = startShutdownBudget(1_000, () => now);
    now = 9_999; // a stage badly overran its slice
    expect(budget.remaining()).toBe(0);
    expect(budget.forStage(5_000)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 15. Teardown is conditional on EVERY drain (review blocker 2)
// ---------------------------------------------------------------------------

describe("#174 nothing is explicitly closed while callbacks may still resume", () => {
  /** Every stage index.ts records a verdict for, in the order it runs them. */
  const ALL_STAGES = [
    "seam-mcp-ingress",
    "health-ingress",
    "manager-callbacks",
    "model-metadata-refresh",
    "model-value-refresh",
    "pre-dispose-quiesce",
    "voice-console-shutdown",
    "live-help-shutdown",
    "router-dispose",
    "post-dispose-drain",
  ] as const;
  const allDrained = () => ALL_STAGES.map((stage) => ({ stage, drained: true }));

  it("closes only when every stage drained", () => {
    expect(safeToCloseResources(allDrained())).toBe(true);
    expect(undrainedStages(allDrained())).toEqual([]);
  });

  it.each(ALL_STAGES)("refuses to close when %s did not drain", (failing) => {
    const verdicts = allDrained().map((v) =>
      v.stage === failing ? { ...v, drained: false } : v
    );
    expect(safeToCloseResources(verdicts)).toBe(false);
    // The operator is told WHICH stage held it open, not just that it did.
    expect(undrainedStages(verdicts)).toEqual([failing]);
  });

  it("names EVERY stage that failed, not just the first", () => {
    const verdicts = allDrained().map((v) =>
      v.stage === "health-ingress" || v.stage === "router-dispose"
        ? { ...v, drained: false }
        : v
    );
    expect(undrainedStages(verdicts)).toEqual(["health-ingress", "router-dispose"]);
  });

  it("an empty verdict list is not treated as proof of a clean drain by accident", () => {
    // Vacuously true — which is only safe because index.ts pushes a verdict for
    // every stage before this is consulted. Pinned so a lost `push` is visible
    // as a behaviour change here rather than as a silent early close.
    expect(safeToCloseResources([])).toBe(true);
    expect(ALL_STAGES).toHaveLength(10);
  });

  /**
   * The blocker, end to end, against the REAL health server.
   *
   * A request is admitted, the drain deadline expires while it is still
   * running, and only then does it resume into its store and adapter work. A
   * timed-out drain is exactly the case where the old code closed anyway.
   */
  async function resumeAfterDeadline(opts: { honourVerdicts: boolean }) {
    const store = makeClosableStore();
    const adapter = makeStoppableAdapter();
    const gate = deferred();
    let resumed = false;
    const health = startHealthServer(0, silent, {
      onIngest: async (_req, res) => {
        await gate.promise; // still running when the deadline expires
        store.getDelegation("late-ingest"); // must not hit a closed handle
        await adapter.sendMessage(); // nor a stopped adapter
        resumed = true;
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      },
    });
    await vi.waitFor(() => expect(health.address()).toBeTruthy());
    const port = (health.address() as { port: number }).port;
    const inflight = fetch(`http://127.0.0.1:${port}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    // Admitted and tracked before admission closes.
    await vi.waitFor(async () => {
      await flush();
      expect((await health.drainIngress(1)).outstanding).toBe(1);
    });
    health.closeIngress();

    // The drain gives up — bounded, as it must be.
    const drain = await health.drainIngress(120);
    expect(drain).toEqual({ drained: false, outstanding: 1 });

    const verdicts = [
      { stage: "seam-mcp-ingress", drained: true },
      { stage: "health-ingress", drained: drain.drained },
      { stage: "pre-dispose-quiesce", drained: true },
      { stage: "post-dispose-drain", drained: true },
    ];
    // The production predicate decides, not the test.
    if (!opts.honourVerdicts || safeToCloseResources(verdicts)) {
      await adapter.stop();
      store.close();
    }

    gate.resolve();
    const response = await inflight;
    await vi.waitFor(() => expect(health.listening).toBe(true));
    await flush();
    health.close();
    return { store, adapter, verdicts, resumed: () => resumed, status: response.status };
  }

  it("a request that resumes after its deadline never sees a closed store or adapter", async () => {
    const { store, adapter, verdicts, resumed, status } = await resumeAfterDeadline({
      honourVerdicts: true,
    });

    expect(safeToCloseResources(verdicts)).toBe(false);
    expect(undrainedStages(verdicts)).toEqual(["health-ingress"]);
    // Nothing was explicitly torn down under it…
    expect(store.closed).toBe(false);
    expect(adapter.stopped).toBe(false);
    // …so the late work completed cleanly and the caller got its answer.
    expect(store.violations).toEqual([]);
    expect(adapter.violations).toEqual([]);
    expect(resumed()).toBe(true);
    expect(status).toBe(200);
  });

  it("NEGATIVE CONTROL: closing anyway corrupts the very work the drain missed", async () => {
    // Proves the test can detect the regression rather than trusting the rule.
    const { store, adapter, resumed, status } = await resumeAfterDeadline({
      honourVerdicts: false,
    });

    expect(store.closed).toBe(true);
    expect(store.violations).toContain("getDelegation");
    // The damage is not a missing side effect: the store error propagates out
    // of the handler, so the request that had been admitted fails outright.
    expect(resumed()).toBe(false);
    expect(status).toBe(500);
    expect(adapter.stopped).toBe(true);
  });

  it("a clean shutdown still closes everything — the rule is not 'never close'", async () => {
    const store = makeClosableStore();
    const adapter = makeStoppableAdapter();
    const verdicts = [
      { stage: "seam-mcp-ingress", drained: true },
      { stage: "health-ingress", drained: true },
      { stage: "pre-dispose-quiesce", drained: true },
      { stage: "post-dispose-drain", drained: true },
    ];
    if (safeToCloseResources(verdicts)) {
      await adapter.stop();
      store.close();
    }
    expect(store.closed).toBe(true);
    expect(adapter.stopped).toBe(true);
    expect(undrainedStages(verdicts)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 16. Tracking must not swallow, and must not miss a sync throw (blockers 3+4)
// ---------------------------------------------------------------------------

describe("#174 runInbound tracks without swallowing", () => {
  it("an admitted handler's failure still rejects to the adapter boundary", async () => {
    const log = makeCapturingLogger();
    const host = makeQuiesceHost({ logger: log.logger, gatewayClosed: false });

    await expect(host.runInbound("slash", async () => {
      throw new Error("handler boom");
    })).rejects.toThrow(/handler boom/);

    // Still logged with its ingress label, and still fully untracked after.
    expect(log.find(/inbound handler failed/)).toBeDefined();
    expect(host.inboundWork.size).toBe(0);
  });

  it("a SYNCHRONOUS throw is tracked too, and still rejects", async () => {
    const host = makeQuiesceHost({ gatewayClosed: false });
    let trackedDuring = -1;

    const running = host.runInbound("component", () => {
      trackedDuring = host.inboundWork.size;
      throw new Error("sync boom");
    });
    await expect(running).rejects.toThrow(/sync boom/);
    // The old shape called `run()` OUTSIDE the chain, so a sync throw escaped
    // before anything was registered — the drain never knew it existed.
    // Now the handler is already IN the tracking set by the time it runs, which
    // closes the window where it could throw while invisible to the barrier.
    expect(trackedDuring).toBe(1);
    expect(host.inboundWork.size).toBe(0); // and removed once it settles
  });

  it("a failing handler is still drained, not left in the tracking set", async () => {
    const host = makeQuiesceHost({ gatewayClosed: false });
    const gate = deferred();
    const running = host
      .runInbound("slash", async () => {
        await gate.promise;
        throw new Error("late boom");
      })
      .catch(() => "rejected");

    await flush();
    expect(host.inboundWork.size).toBe(1); // the barrier can see it

    let drained = false;
    const phase1 = host.quiesce({ timeoutMs: 5000 }).then((r) => ((drained = true), r));
    await flush();
    expect(drained).toBe(false); // and is genuinely held by it

    gate.resolve();
    expect((await phase1).drained).toBe(true); // a handler FAILING is not a barrier failure
    expect(await running).toBe("rejected");
    expect(host.inboundWork.size).toBe(0);
  });

  it("a refusal that throws SYNCHRONOUSLY is still silent", async () => {
    const host = makeQuiesceHost({ gatewayClosed: true });
    const run = vi.fn(async () => {});

    // `Promise.resolve(refuse())` would have let this escape the `.catch`,
    // turning a deliberately silent refusal into a rejected inbound.
    await expect(
      host.runInbound("choice", run, () => {
        throw new Error("interaction already acknowledged");
      })
    ).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(host.inboundWork.size).toBe(0); // a refusal is never tracked
  });

  it("a refusal that rejects ASYNCHRONOUSLY is likewise silent", async () => {
    const host = makeQuiesceHost({ gatewayClosed: true });
    await expect(
      host.runInbound("choice", async () => {}, async () => {
        throw new Error("transport gone");
      })
    ).resolves.toBeUndefined();
  });
});

describe("#174 the component aggregate reports every handler's failure", () => {
  /** Build the real `install()` wrapper with all four handlers controllable. */
  function componentHost(over: Record<string, unknown>) {
    const log = makeCapturingLogger();
    const onComponent = vi.fn();
    const host = makeQuiesceHost({
      logger: log.logger,
      gatewayClosed: false,
      adapter: { onMessage: () => {}, onComponent, setActiveChannelCheck: () => {} },
      store: {},
      watchSentinel: () => {},
      handleConfigEditorComponent: async () => {},
      handleTtsEditorComponent: async () => {},
      handleVoiceConsoleComponent: async () => {},
      handleQuotaCardComponent: async () => {},
      ...over,
    }) as unknown as ReturnType<typeof makeQuiesceHost> & { install(): void };
    host.install();
    const wrapper = onComponent.mock.calls[0]![0] as (e: unknown) => Promise<void>;
    return { host, log, wrapper };
  }
  const evt = { customId: "cfg:x", replyEphemeral: async () => {}, followUpEphemeral: async () => {} };

  it("logs a CONFIG EDITOR failure instead of discarding it", async () => {
    // The one handler with no catch of its own: `allSettled` dropped its
    // rejection, so a failed config edit was indistinguishable from a
    // successful one in the log.
    const { log, wrapper } = componentHost({
      handleConfigEditorComponent: async () => {
        throw new Error("config write failed");
      },
    });

    await wrapper(evt);
    const entry = log.find(/component handler failed/);
    expect(entry?.level).toBe("warn");
    expect(entry?.data).toMatchObject({ handler: "config editor" });
    expect(String((entry?.data as { err?: Error }).err)).toMatch(/config write failed/);
  });

  it("names the handler that failed, so the log points at one of four", async () => {
    const { log, wrapper } = componentHost({
      handleQuotaCardComponent: async () => {
        throw new Error("quota boom");
      },
    });
    await wrapper(evt);
    expect(log.find(/component handler failed/)?.data).toMatchObject({
      handler: "quota card",
      customId: "cfg:x",
    });
  });

  it("catches a handler that throws SYNCHRONOUSLY", async () => {
    const { log, wrapper } = componentHost({
      handleTtsEditorComponent: () => {
        throw new Error("sync tts boom");
      },
    });
    await wrapper(evt);
    expect(log.find(/component handler failed/)?.data).toMatchObject({ handler: "tts editor" });
  });

  it("one failing handler does not stop the other three", async () => {
    const ran: string[] = [];
    const { wrapper } = componentHost({
      handleConfigEditorComponent: async () => {
        throw new Error("config boom");
      },
      handleTtsEditorComponent: async () => void ran.push("tts"),
      handleVoiceConsoleComponent: async () => void ran.push("voice"),
      handleQuotaCardComponent: async () => void ran.push("quota"),
    });

    await wrapper(evt);
    expect(ran.sort()).toEqual(["quota", "tts", "voice"]);
  });

  it("reports a RECOVERY that itself fails, instead of swallowing it", async () => {
    // The Voice Console handler is the one with a user-facing recovery, so it
    // can fail twice: the action, then the apology. The old code ended that
    // chain in `.catch(() => {})` — the action failed, the user was never told,
    // and the second failure was logged nowhere.
    const { log, wrapper } = componentHost({
      handleVoiceConsoleComponent: async () => {
        throw new Error("voice boom");
      },
    });

    await wrapper({
      customId: "vc:x",
      replyEphemeral: async () => {
        throw new Error("reply failed");
      },
      followUpEphemeral: async () => {
        throw new Error("follow-up failed");
      },
    });
    // Both are reported: the original action, and the fact that we could not
    // even tell the user about it.
    expect(log.find(/voice console component failed/)).toBeDefined();
    const outer = log.find(/component handler failed/);
    expect(outer?.data).toMatchObject({ handler: "voice console" });
    expect(String((outer?.data as { err?: Error }).err)).toMatch(/follow-up failed/);
  });

  it("a recovery that SUCCEEDS is not reported as a handler failure", async () => {
    const replyEphemeral = vi.fn(async () => {});
    const { log, wrapper } = componentHost({
      handleVoiceConsoleComponent: async () => {
        throw new Error("voice boom");
      },
    });

    await wrapper({ customId: "vc:x", replyEphemeral, followUpEphemeral: async () => {} });
    expect(replyEphemeral).toHaveBeenCalledOnce();
    expect(String(replyEphemeral.mock.calls[0]![0])).toMatch(/voice boom/);
    expect(log.find(/voice console component failed/)).toBeDefined(); // still logged
    expect(log.find(/component handler failed/)).toBeUndefined(); // but recovered
  });

  it("the wrapper's promise is what the adapter boundary awaits", async () => {
    // Returned rather than `void`-ed, so `handlePersistentComponent` — and the
    // event boundary that logs a crash — can actually see it settle.
    const gate = deferred();
    let finished = false;
    const { wrapper } = componentHost({
      handleQuotaCardComponent: async () => {
        await gate.promise;
        finished = true;
      },
    });

    const running = wrapper(evt);
    expect(running).toBeInstanceOf(Promise);
    await flush();
    expect(finished).toBe(false);
    gate.resolve();
    await running;
    expect(finished).toBe(true);
  });
});

describe("#174 the health server survives a handler that throws synchronously", () => {
  it("answers 500 and stays tracked instead of taking the process down", async () => {
    // `Promise.resolve(handler(req, res))` invoked the handler OUTSIDE the
    // chain: a sync throw escaped into the `createServer` callback — an
    // uncaught exception — AND left the request untracked, so the drain could
    // not see it and the client hung until timeout.
    const health = startHealthServer(0, silent, {
      onIngest: () => {
        throw new Error("sync handler boom");
      },
    });
    await vi.waitFor(() => expect(health.address()).toBeTruthy());
    const port = (health.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(500);
      expect(await res.text()).toMatch(/failed/i);
      // It went through the tracked path, so the drain accounts for it.
      expect(await health.drainIngress(1000)).toEqual({ drained: true, outstanding: 0 });
    } finally {
      health.close();
    }
  });

  it("still drains an async handler that rejects", async () => {
    const health = startHealthServer(0, silent, {
      onMcp: async () => {
        throw new Error("async handler boom");
      },
    });
    await vi.waitFor(() => expect(health.address()).toBeTruthy());
    const port = (health.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", body: "{}" });
      expect(res.status).toBe(500);
      expect(await health.drainIngress(1000)).toEqual({ drained: true, outstanding: 0 });
    } finally {
      health.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 17. An explicit route must actually be used
// ---------------------------------------------------------------------------

/**
 * `completionRoute` accepts only routing carried explicitly in the done-file.
 * Replay must then use the route's address rather than independently infer one,
 * or a future classifier change could again terminalize a row without sending
 * its report-back or advancing its chain.
 *
 * These tests deliberately assert the ENQUEUED SPEC, not that a stub was
 * called: classifying the route correctly is exactly what the broken version
 * already did.
 */
function makeChainStore() {
  const ledger = makeLedger();
  const chains = new Map<
    string,
    {
      id: string;
      status: string;
      hops: string[];
      currentIndex: number;
      originRef: string;
      promptPreview?: string;
    }
  >();
  return {
    ...ledger,
    rows: ledger.rows,
    chains,
    getChain: (id: string) => chains.get(id) ?? null,
    /** Mirrors SessionStore.advanceChain: pop one hop, bump only when one was popped. */
    advanceChain(id: string) {
      const current = chains.get(id);
      if (!current || current.status !== "running") return null;
      const hops = [...current.hops];
      const nextHop = hops.length > 0 ? hops.shift()! : null;
      current.hops = hops;
      if (nextHop !== null) current.currentIndex += 1;
      return { chain: { ...current }, nextHop };
    },
    completeChain(id: string, status = "completed") {
      const c = chains.get(id);
      if (c) c.status = status;
    },
    planChainHopCompletion(input: {
      dispatchId: string;
      chainId: string;
      failed: boolean;
      promptPreview?: string | null;
    }) {
      const existing = ledger.getReportBackByCorrelation(input.dispatchId);
      const chain = chains.get(input.chainId);
      if (existing) {
        // Mirrors the real guard: only a PLANNED child id may be read back.
        if (!isPlannedChainChildId(existing.targetRef) || !chain) return null;
        return {
          dispatchId: existing.targetRef,
          nextHop: existing.worker ?? null,
          originRef: chain.originRef,
          created: false,
        };
      }
      if (!chain || chain.status !== "running") return null;
      const nextHop = input.failed ? null : (chain.hops[0] ?? null);
      const dispatchId = plannedChainChildDispatchId({
        chainId: input.chainId,
        currentIndex: chain.currentIndex,
        kind: nextHop ? "hop" : "delivery",
      });
      ledger.tryRecordReportBack({
        id: `chain_advance:${input.dispatchId}`,
        correlationId: input.dispatchId,
        targetRef: dispatchId,
        worker: nextHop,
        status: "completed",
      });
      if (nextHop) this.advanceChain(input.chainId);
      return { dispatchId, nextHop, originRef: chain.originRef, created: true };
    },
  };
}

/** A replay host wired to the REAL chain machinery, not an `advanceChain` stub. */
function makeChainReplayHost(store: ReturnType<typeof makeChainStore>) {
  const self: Record<string, unknown> = {
    logger: silent,
    config: { DATA_DIR: dataDir },
    store,
    replayCompletedDispatch: Orchestrator.prototype["replayCompletedDispatch" as never],
    enqueueReportBack: Orchestrator.prototype["enqueueReportBack" as never],
    claimAndEnqueueReportBack: Orchestrator.prototype["claimAndEnqueueReportBack" as never],
    advanceChain: Orchestrator.prototype["advanceChain" as never],
    enqueueChainDelivery: Orchestrator.prototype["enqueueChainDelivery" as never],
  };
  return self as unknown as {
    replayCompletedDispatch(r: Record<string, unknown>, route: unknown): Promise<void>;
  };
}

/** Every spec currently sitting in `pending/`. */
async function pendingSpecs(): Promise<Record<string, unknown>[]> {
  const names = await readdir(dirs.pending);
  return Promise.all(
    names.map(async (n) => JSON.parse(await readFile(path.join(dirs.pending, n), "utf8")))
  );
}

describe("#174 a routed forward is actually delivered or advanced", () => {
  it("a modern chain hop enqueues the NEXT HOP", async () => {
    const store = makeChainStore();
    const chainDone = {
      id: "legacy-fwd",
      target: "worker-a",
      status: "completed" as const,
      output: "HOP ONE OUTPUT",
      kind: "forward" as const,
      chainId: "chain-legacy",
    };

    store.rows.set("legacy-fwd", {
      id: "legacy-fwd",
      kind: "forward",
      status: "interrupted",
      correlationId: "chain-legacy",
    });
    store.chains.set("chain-legacy", {
      id: "chain-legacy",
      status: "running",
      hops: ["worker-b"], // one hop still to run
      currentIndex: 0,
      originRef: "origin-thread",
      promptPreview: "the original chain ask",
    });

    const row = { status: "interrupted", kind: "forward", correlationId: "chain-legacy" };
    const route = completionRoute(chainDone as never, row);
    expect(route).toEqual({ action: "chain", chainId: "chain-legacy" });

    await makeChainReplayHost(store).replayCompletedDispatch(chainDone, route);

    // THE ASSERTION THAT FAILED BEFORE: the next hop is really on disk.
    // A named (preset) hop runs isolated and posts into the chain's origin, so
    // the worker name is on `preset` and `target` is the origin thread.
    const hop = (await pendingSpecs()).find((s) => s.preset === "worker-b");
    expect(hop).toBeDefined();
    expect(hop).toMatchObject({
      preset: "worker-b",
      target: "origin-thread",
      session: "isolated",
      kind: "forward",
      chainId: "chain-legacy",
      prompt: "HOP ONE OUTPUT", // this hop's output piped into the next
    });
    // The chain really moved, and is still running.
    expect(store.chains.get("chain-legacy")).toMatchObject({
      status: "running",
      hops: [],
      currentIndex: 1,
    });
    // And only now is the worker row terminal.
    expect(store.rows.get("legacy-fwd")!.status).toBe("completed");
  });

  it("a modern final chain hop delivers output to the origin", async () => {
    const store = makeChainStore();
    const chainDone = {
      id: "legacy-last",
      target: "worker-z",
      status: "completed" as const,
      output: "THE FINAL ANSWER",
      kind: "forward" as const,
      chainId: "chain-final",
    };
    store.rows.set("legacy-last", {
      id: "legacy-last",
      kind: "forward",
      status: "interrupted",
      correlationId: "chain-final",
    });
    store.chains.set("chain-final", {
      id: "chain-final",
      status: "running",
      hops: [], // last hop just finished
      currentIndex: 2,
      originRef: "origin-thread",
      promptPreview: "the original chain ask",
    });

    const route = completionRoute(chainDone as never, {
      status: "interrupted",
      kind: "forward",
      correlationId: "chain-final",
    });
    await makeChainReplayHost(store).replayCompletedDispatch(chainDone, route);

    const delivery = (await pendingSpecs()).find((s) => s.target === "origin-thread");
    expect(delivery).toBeDefined();
    expect(delivery).toMatchObject({ kind: "report_back", correlationId: "chain-final" });
    expect(String(delivery!.prompt)).toContain("THE FINAL ANSWER");
    expect(String(delivery!.prompt)).toContain('<seam-chain-result chain="chain-final">');
    expect(store.chains.get("chain-final")!.status).toBe("completed");
    expect(store.rows.get("legacy-last")!.status).toBe("completed");
  });

  it("NEGATIVE CONTROL: a route whose chainId is dropped advances nothing", async () => {
    // Reproduces the old spec-building rule — take the chain id from the
    // done-file only — against the SAME scenario, to prove these tests would
    // actually catch a revert rather than passing either way.
    const store = makeChainStore();
    store.rows.set("legacy-drop", {
      id: "legacy-drop",
      kind: "forward",
      status: "interrupted",
      correlationId: "chain-drop",
    });
    store.chains.set("chain-drop", {
      id: "chain-drop",
      status: "running",
      hops: ["worker-b"],
      currentIndex: 0,
      originRef: "origin-thread",
    });

    await makeChainReplayHost(store).replayCompletedDispatch(
      { id: "legacy-drop", target: "worker-a", status: "completed", output: "HOP ONE OUTPUT" },
      // The route the OLD code effectively acted on: classified as a chain, but
      // with no id to carry into the spec.
      { action: "chain", chainId: undefined } as never
    );

    expect(await pendingSpecs()).toHaveLength(0); // no hop, no delivery…
    expect(store.chains.get("chain-drop")).toMatchObject({ hops: ["worker-b"], currentIndex: 0 });
    // …yet the row went terminal anyway, so the next boot never comes back.
    // That combination is the silent loss.
    expect(store.rows.get("legacy-drop")!.status).toBe("completed");
  });

  it("a MODERN forward that carries its own chainId is unaffected", async () => {
    const store = makeChainStore();
    store.rows.set("modern-fwd", { id: "modern-fwd", kind: "forward", status: "running" });
    store.chains.set("chain-modern", {
      id: "chain-modern",
      status: "running",
      hops: ["worker-c"],
      currentIndex: 0,
      originRef: "origin-thread",
    });
    const done = {
      id: "modern-fwd",
      target: "worker-a",
      status: "completed" as const,
      output: "MODERN OUTPUT",
      kind: "forward",
      chainId: "chain-modern",
    };

    const route = completionRoute(done as never, { status: "running", kind: "forward" });
    expect(route).toEqual({ action: "chain", chainId: "chain-modern" });
    await makeChainReplayHost(store).replayCompletedDispatch(done, route);

    const hop = (await pendingSpecs()).find((s) => s.preset === "worker-c");
    expect(hop).toMatchObject({
      preset: "worker-c",
      chainId: "chain-modern",
      prompt: "MODERN OUTPUT",
    });
  });

  it("replaying the same modern chain hop twice advances the chain once", async () => {
    // The explicit id must not defeat the #77 hop claim: idempotence is
    // what makes boot reconciliation safe to run on every start.
    const store = makeChainStore();
    store.rows.set("legacy-idem", {
      id: "legacy-idem",
      kind: "forward",
      status: "interrupted",
      correlationId: "chain-idem",
    });
    store.chains.set("chain-idem", {
      id: "chain-idem",
      status: "running",
      hops: ["worker-b"],
      currentIndex: 0,
      originRef: "origin-thread",
    });
    const done = {
      id: "legacy-idem",
      target: "worker-a",
      status: "completed" as const,
      output: "HOP ONE OUTPUT",
      kind: "forward" as const,
      chainId: "chain-idem",
    };
    const row = { status: "interrupted", kind: "forward", correlationId: "chain-idem" };
    const host = makeChainReplayHost(store);

    await host.replayCompletedDispatch(done, completionRoute(done as never, row));
    await host.replayCompletedDispatch(done, completionRoute(done as never, row));

    expect((await pendingSpecs()).filter((s) => s.preset === "worker-b")).toHaveLength(1);
    expect(store.chains.get("chain-idem")).toMatchObject({ hops: [], currentIndex: 1 });
  });

  /**
   * Against the REAL `SessionStore`, not the in-memory mirror: the guard is a
   * store invariant and the mirror could drift from it.
   *
   * The #77 claim this replaced wrote the SAME row id (`chain_advance:<spec>`)
   * but stored the hop's target THREAD in `targetRef` and the completed hop's
   * OWN preset in `worker`. Reading one back as a plan would dispatch under a
   * Discord thread id and re-run a worker that has already been paid for —
   * exactly what #174 exists to prevent.
   */
  it("refuses to read a legacy #77 hop claim back as a completion plan", () => {
    const store = new SessionStore(path.join(dataDir, "chain-guard.db"));
    try {
      store.createChain({ id: "chain-legacy77", hops: ["worker-b"], originRef: "origin-thread" });
      // Exactly what the pre-#174 `claimChainHopAdvance` wrote.
      store.tryRecordReportBack({
        id: "chain_advance:hop-1",
        kind: "report_back",
        sourceRef: "chain-legacy77",
        targetRef: "worker-thread-id", // a THREAD, not a planned child id
        worker: "worker-a", // this hop's OWN preset, not the next one
        promptPreview: "old",
        correlationId: "hop-1",
        status: "completed",
      });

      expect(
        store.planChainHopCompletion({
          dispatchId: "hop-1",
          chainId: "chain-legacy77",
          failed: false,
        })
      ).toBeNull();
      // And it refused without touching the chain, so nothing is lost.
      expect(store.getChain("chain-legacy77")).toMatchObject({
        status: "running",
        hops: ["worker-b"],
        currentIndex: 0,
      });

      // Positive control: a plan THIS code wrote is read straight back, with
      // the popped chain state left exactly as the first pass committed it.
      store.createChain({ id: "chain-modern77", hops: ["worker-b"], originRef: "origin-thread" });
      const first = store.planChainHopCompletion({
        dispatchId: "hop-2",
        chainId: "chain-modern77",
        failed: false,
      });
      expect(first).toMatchObject({
        dispatchId: plannedChainChildDispatchId({
          chainId: "chain-modern77",
          currentIndex: 0,
          kind: "hop",
        }),
        nextHop: "worker-b",
        created: true,
      });
      const replay = store.planChainHopCompletion({
        dispatchId: "hop-2",
        chainId: "chain-modern77",
        failed: false,
      });
      expect(replay).toMatchObject({
        dispatchId: plannedChainChildDispatchId({
          chainId: "chain-modern77",
          currentIndex: 0,
          kind: "hop",
        }),
        nextHop: "worker-b",
        created: false,
      });
      expect(store.getChain("chain-modern77")).toMatchObject({ hops: [], currentIndex: 1 });
    } finally {
      store.close();
    }
  });

  it("repairs a crash after atomic chain plan/pop but before child enqueue", async () => {
    const store = makeChainStore();
    store.rows.set("parent-hop", { id: "parent-hop", kind: "forward", status: "interrupted" });
    store.chains.set("chain-crash", {
      id: "chain-crash",
      status: "running",
      hops: ["worker-b"],
      currentIndex: 0,
      originRef: "origin",
    });
    const plan = store.planChainHopCompletion({
      dispatchId: "parent-hop",
      chainId: "chain-crash",
      failed: false,
    });
    const childId = plannedChainChildDispatchId({
      chainId: "chain-crash",
      currentIndex: 0,
      kind: "hop",
    });
    expect(plan).toMatchObject({ dispatchId: childId, nextHop: "worker-b" });
    expect(store.chains.get("chain-crash")).toMatchObject({ hops: [], currentIndex: 1 });
    expect(await readdir(dirs.pending)).toEqual([]);

    await makeChainReplayHost(store).replayCompletedDispatch(
      {
        id: "parent-hop",
        target: "worker-a",
        status: "completed",
        output: "NEXT INPUT",
        chainId: "chain-crash",
      },
      { action: "chain", chainId: "chain-crash" }
    );
    expect(await readdir(dirs.pending)).toEqual([`${childId}.json`]);
    expect(store.chains.get("chain-crash")).toMatchObject({ status: "running", currentIndex: 1 });
  });

  it("does not mistake a popped final worker for terminal delivery on replay", async () => {
    const store = makeChainStore();
    store.rows.set("parent-hop", { id: "parent-hop", kind: "forward", status: "interrupted" });
    store.chains.set("chain-last", {
      id: "chain-last",
      status: "running",
      hops: ["last-worker"],
      currentIndex: 0,
      originRef: "origin",
    });
    store.planChainHopCompletion({
      dispatchId: "parent-hop",
      chainId: "chain-last",
      failed: false,
    });
    const childId = plannedChainChildDispatchId({
      chainId: "chain-last",
      currentIndex: 0,
      kind: "hop",
    });

    await makeChainReplayHost(store).replayCompletedDispatch(
      {
        id: "parent-hop",
        target: "worker-a",
        status: "completed",
        output: "FOR LAST WORKER",
        chainId: "chain-last",
      },
      { action: "chain", chainId: "chain-last" }
    );
    const specs = await pendingSpecs();
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      id: childId,
      target: "origin",
      preset: "last-worker",
      chainId: "chain-last",
    });
    expect(String(specs[0]!.prompt)).not.toContain("seam-chain-result");
    expect(store.chains.get("chain-last")!.status).toBe("running");
  });

  it("a modern plain forward routes to its report-back address", async () => {
    // Same class of bug, other branch: the route is authoritative for the
    // onward address, so the two can never disagree.
    const store = makeChainStore();
    store.rows.set("rb-route", { id: "rb-route", kind: "forward", status: "interrupted" });
    const done = {
      id: "rb-route",
      target: "worker",
      status: "completed" as const,
      output: "THE ANSWER",
      kind: "forward" as const,
      correlationId: "corr-route",
      returnTo: "parent-thread",
      originPrompt: "the ask",
    };
    const route = completionRoute(done as never, { status: "interrupted", kind: "forward" });
    expect(route).toEqual({ action: "report_back", returnTo: "parent-thread" });

    await makeChainReplayHost(store).replayCompletedDispatch(done, route);
    const specs = await pendingSpecs();
    expect(specs.filter((s) => s.kind === "report_back")).toHaveLength(1);
    expect(String(specs[0]!.prompt)).toContain("THE ANSWER");
  });
});

describe("#174 atomic chain completion plan", () => {
  it("commits the claim and hop pop together, then replays the same child id", () => {
    const store = new SessionStore(path.join(dataDir, "chain-plan.db"));
    try {
      store.createChain({
        id: "chain-db",
        hops: ["worker-b"],
        originRef: "origin",
      });
      const first = store.planChainHopCompletion({
        dispatchId: "parent-db",
        chainId: "chain-db",
        failed: false,
        promptPreview: "ask",
      });
      const replay = store.planChainHopCompletion({
        dispatchId: "parent-db",
        chainId: "chain-db",
        failed: false,
        promptPreview: "ask",
      });
      const childId = plannedChainChildDispatchId({
        chainId: "chain-db",
        currentIndex: 0,
        kind: "hop",
      });

      expect(first).toEqual({
        dispatchId: childId,
        nextHop: "worker-b",
        originRef: "origin",
        created: true,
      });
      expect(replay).toEqual({ ...first, created: false });
      expect(store.getChain("chain-db")).toMatchObject({ hops: [], currentIndex: 1 });
      expect(store.getReportBackByCorrelation("parent-db")).toMatchObject({
        id: "chain_advance:parent-db",
        targetRef: childId,
        worker: "worker-b",
      });
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 18. A bounded teardown step reports whether it actually FINISHED
// ---------------------------------------------------------------------------

describe("#174 a bounded step's verdict is what gates the closes", () => {
  it("reports true only when the work really completed", async () => {
    let ran = false;
    expect(
      await runBoundedStep({
        label: "quick",
        timeoutMs: 5000,
        work: async () => {
          ran = true;
        },
      })
    ).toBe(true);
    expect(ran).toBe(true);
  });

  it("reports FALSE on a timeout, and the abandoned work keeps running", async () => {
    // The distinction that matters: the step did not finish, so whatever it was
    // doing is still coming. Reporting `true` here is what let the old code
    // close a store underneath a disposal that had not finished.
    const gate = deferred();
    let finishedLate = false;
    const onTimeout = vi.fn();

    const started = Date.now();
    const verdict = await runBoundedStep({
      label: "wedged dispose",
      timeoutMs: 60,
      onTimeout,
      work: async () => {
        await gate.promise;
        finishedLate = true;
      },
    });

    expect(verdict).toBe(false);
    expect(Date.now() - started).toBeLessThan(3000); // bounded, not hung
    expect(onTimeout).toHaveBeenCalledWith("wedged dispose", 60);
    expect(finishedLate).toBe(false); // still outstanding at the decision point

    // Abandoned, not cancelled — it really does resume afterwards.
    gate.resolve();
    await flush();
    expect(finishedLate).toBe(true);
  });

  it("reports FALSE when the work rejects, and never rethrows", async () => {
    const onError = vi.fn();
    await expect(
      runBoundedStep({
        label: "boom",
        timeoutMs: 5000,
        onError,
        work: async () => {
          throw new Error("dispose exploded");
        },
      })
    ).resolves.toBe(false);
    expect(String(onError.mock.calls[0]![1])).toMatch(/dispose exploded/);
  });

  it("reports FALSE on a SYNCHRONOUS throw too", async () => {
    const onError = vi.fn();
    await expect(
      runBoundedStep({
        label: "sync boom",
        timeoutMs: 5000,
        onError,
        work: () => {
          throw new Error("sync dispose boom");
        },
      })
    ).resolves.toBe(false);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("a zero timeout gives up instead of running the step to completion", async () => {
    // What an exhausted budget hands the last stages.
    let ran = false;
    expect(
      await runBoundedStep({
        label: "out of budget",
        timeoutMs: 0,
        work: async () => {
          await new Promise((r) => setTimeout(r, 10));
          ran = true;
        },
      })
    ).toBe(false);
    expect(ran).toBe(false);
  });

  /**
   * The gate the review asked for: `adapter.stop()` timing out must not be
   * followed by closing the stores. It cannot be waved through as "the adapter
   * touches nothing" — `setActiveChannelCheck` calls `store.isChannelActive()`
   * on every inbound event, BEFORE the admission gate can refuse it, so a
   * gateway that did not really stop still reads the store on the next message.
   */
  it("a gateway that did not stop still reads the store, so the stores stay open", async () => {
    const store = makeClosableStore();
    const gate = deferred();
    // The adapter's channel gate — the one store read admission does not cover.
    const isChannelActive = () => {
      store.getDelegation("channel-gate");
      return true;
    };
    const adapterStopped = await runBoundedStep({
      label: "adapter stop",
      timeoutMs: 60,
      work: () => gate.promise, // a gateway that will not shut down in time
    });
    expect(adapterStopped).toBe(false);

    // The production rule: the adapter's own verdict gates the store closes.
    if (adapterStopped) store.close();

    // A message arrives after the abandoned stop, as it can on a live gateway.
    expect(() => isChannelActive()).not.toThrow();
    expect(store.violations).toEqual([]);
    expect(store.closed).toBe(false);
    gate.resolve();
  });

  it("NEGATIVE CONTROL: closing after an abandoned adapter stop breaks that read", async () => {
    const store = makeClosableStore();
    const gate = deferred();
    const isChannelActive = () => {
      store.getDelegation("channel-gate");
      return true;
    };
    const adapterStopped = await runBoundedStep({
      label: "adapter stop",
      timeoutMs: 60,
      work: () => gate.promise,
    });

    store.close(); // ignoring the verdict — the rejected behaviour
    expect(() => isChannelActive()).toThrow(/database connection is not open/);
    expect(store.violations).toContain("getDelegation");
    expect(adapterStopped).toBe(false);
    gate.resolve();
  });
});

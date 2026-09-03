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
} from "../packages/core/src/core/dispatch/done-reconcile.js";
import { dispatchDirs, type DispatchSpec } from "../packages/core/src/core/dispatch/types.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

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
    await dropSpec({ id: "rb", target: "worker", returnTo: "parent", correlationId: "c1" });
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
  });
});

// ---------------------------------------------------------------------------
// 2. Bounded quiesce — two phases, explicit timeout semantics
// ---------------------------------------------------------------------------

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
    activeTurnSettles: new Set<Promise<void>>(),
    pendingContinuations: new Set<Promise<void>>(),
    channelQueues: new Map<string, Promise<void>>(),
    dispatchWatcher: undefined,
    scheduledManager: undefined,
    ...over,
  });
  return self as unknown as {
    quiesce(o?: { timeoutMs?: number }): Promise<{ timedOut: boolean; continuations: number }>;
    drainAfterDispose(o?: { timeoutMs?: number }): Promise<{ timedOut: boolean }>;
    trackContinuation(p: Promise<void>): void;
    beginTurn(): () => void;
    runScheduledPrompt(id: string): Promise<void>;
    pendingContinuations: Set<Promise<void>>;
    activeTurnSettles: Set<Promise<void>>;
    channelQueues: Map<string, Promise<void>>;
    intakeStopped: boolean;
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
    const host = makeQuiesceHost({
      dispatchWatcher: {
        stop() {},
        inFlightCount: 1, // work really is outstanding
        drain: async () => {
          drainCalls++;
          throw new Error("drain exploded");
        },
      },
    });

    let settled = false;
    const phase = host.quiesce({ timeoutMs: 150 }).then((r) => ((settled = true), r));
    await flush();
    expect(settled).toBe(false); // did NOT short-circuit to success

    const outcome = await phase;
    expect(outcome.drained).toBe(false);
    expect(outcome.barrierFailed).toBe(true);
    expect(outcome.timedOut).toBe(true); // the deadline is what ended it
    expect(drainCalls).toBeGreaterThan(1); // it kept retrying, not gave up
  });

  it("a TRANSIENT stage failure still runs the other stages", async () => {
    let drainCalls = 0;
    const late = deferred();
    const host = makeQuiesceHost({
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
    expect(settled).toBe(false); // still waiting on the later stages

    endTurn();
    late.resolve();
    const outcome = await phase;
    expect(outcome.timedOut).toBe(false); // it recovered and finished
    expect(outcome.barrierFailed).toBe(true); // but the failure is not hidden
    expect(outcome.drained).toBe(false); // so it is NOT called a clean drain
    expect(host.activeTurns).toBe(0);
    expect(host.pendingContinuations.size).toBe(0);
  });

  it("a clean phase is the only thing that reports drained", async () => {
    const outcome = await makeQuiesceHost().quiesce({ timeoutMs: 5000 });
    expect(outcome).toMatchObject({ drained: true, timedOut: false, barrierFailed: false });
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
  const rows = new Map<string, { id: string; kind: string; status: string; correlationId?: string }>();
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
    tryRecordReportBack(entry: { id: string; correlationId?: string }) {
      // Atomic claim: first writer for a correlation wins, as in SQLite.
      if (entry.correlationId && this.getReportBackByCorrelation(entry.correlationId)) return null;
      const row = { id: entry.id, kind: "report_back", status: "dispatched", correlationId: entry.correlationId };
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
    replayCompletedDispatch(r: Record<string, unknown>): Promise<void>;
  };
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
    await host.replayCompletedDispatch(completedWorker);
    expect(order).toEqual(["claim", "terminalize"]);
    expect(ledger.rows.get("w1")!.status).toBe("completed");
    const specs = await pendingReportBacks();
    expect(specs).toHaveLength(1);
    expect(String(specs[0]!.prompt)).toContain("THE ANSWER");
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
    await expect(host.replayCompletedDispatch(completedWorker)).rejects.toThrow(/died/);
    // Row stayed non-terminal — that is what brings the next boot back here.
    expect(ledger.rows.get("w1")!.status).toBe("interrupted");
    expect(await pendingReportBacks()).toHaveLength(1);

    // Next boot replays. Must NOT deliver twice, must finish terminalizing.
    crash = false;
    await host.replayCompletedDispatch(completedWorker);
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
    await expect(host.replayCompletedDispatch(completedWorker)).rejects.toThrow(/store closed/);
    expect(ledger.rows.get("w1")!.status).toBe("interrupted");
    expect(await pendingReportBacks()).toHaveLength(0);

    crash = false;
    await host.replayCompletedDispatch(completedWorker);
    expect(await pendingReportBacks()).toHaveLength(1);
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
      host.replayCompletedDispatch({ ...completedWorker, id: "w2", returnTo: undefined, chainId: "chain-1" })
    ).rejects.toThrow(/advance failed/);
    expect(order).toEqual(["advance"]); // never terminalized
    expect(ledger.rows.get("w2")!.status).toBe("running");

    crash = false;
    await host.replayCompletedDispatch({ ...completedWorker, id: "w2", returnTo: undefined, chainId: "chain-1" });
    expect(order).toEqual(["advance", "advance", "terminalize"]);
    expect(ledger.rows.get("w2")!.status).toBe("completed");
  });

  it("keeps report-back dedup atomic across repeated replays", async () => {
    const ledger = makeLedger();
    ledger.rows.set("w1", { id: "w1", kind: "handoff", status: "interrupted" });
    const host = makeReplayHost(ledger);
    await host.replayCompletedDispatch(completedWorker);
    await host.replayCompletedDispatch(completedWorker);
    await host.replayCompletedDispatch(completedWorker);
    expect(await pendingReportBacks()).toHaveLength(1);
    const rbRows = [...ledger.rows.values()].filter((r) => r.kind === "report_back");
    expect(rbRows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Boot reconciliation
// ---------------------------------------------------------------------------

describe("#174 boot done-file reconciliation", () => {
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

  it("treats interrupted as replayable but completed/failed/abandoned as done", async () => {
    expect(needsCompletionReplay({ returnTo: "p" }, { status: "interrupted" })).toBe(true);
    expect(needsCompletionReplay({ returnTo: "p" }, { status: "running" })).toBe(true);
    expect(needsCompletionReplay({ returnTo: "p" }, { status: "dispatched" })).toBe(true);
    for (const status of ["completed", "failed", "abandoned", "cancelled"]) {
      expect(needsCompletionReplay({ returnTo: "p" }, { status })).toBe(false);
    }
  });

  it("STILL reconciles a done-file with no onward routing (review blocker 3)", async () => {
    // An earlier revision skipped these without reading the ledger. That left
    // completed wake/watch/report_back/unrouted-handoff rows `interrupted`, so
    // `/seam workflows` offered a paid rerun of finished work. Routing decides
    // what replay DOES, never whether it is owed.
    await writeDone("d2", { id: "d2", target: "t", status: "completed", finishedUtc: "x" });
    const getDelegation = vi.fn(() => ({ status: "interrupted" }));
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
    const self = {
      logger: silent,
      intakeStopped: true,
      adapter: { sendMessage },
      store,
      handleIncomingMessage: Orchestrator.prototype["handleIncomingMessage" as never],
      // Any of these running would mean the gate did not short-circuit.
      tryConsumeConfigEditorRiderUpload: async () => {
        throw new Error("admitted a turn after intake closed");
      },
    } as unknown as { handleIncomingMessage(m: unknown): Promise<void> };

    await self.handleIncomingMessage({ channel: { id: "c1" }, text: "hi", authorId: "u1" });
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

describe("#174 unrouted completions are still reconciled", () => {
  it.each(["wake", "watch", "report_back", "handoff-without-returnTo"])(
    "terminalizes a completed %s done-file with no onward routing",
    async (kind) => {
      await writeDone(`u-${kind}`, {
        id: `u-${kind}`,
        target: "thread-1",
        status: "completed",
        output: "finished",
        finishedUtc: "2026-09-03T00:00:00.000Z",
        // deliberately no returnTo / chainId
      });
      const replay = vi.fn(async () => {});
      const summary = await reconcileCompletedDoneFiles({
        dataDir,
        logger: silent,
        getDelegation: () => ({ status: "interrupted" }),
        replay,
      });
      expect(summary.reconciled).toBe(1);
      expect(replay).toHaveBeenCalledOnce();
    }
  );

  it("an unrouted replay terminalizes directly and reruns nothing", async () => {
    const ledger = makeLedger();
    ledger.rows.set("u1", { id: "u1", kind: "wake", status: "running" });
    const advanceChain = vi.fn(async () => {});
    const host = makeReplayHost(ledger, { advanceChain });
    await host.replayCompletedDispatch({
      id: "u1",
      target: "t",
      status: "completed",
      output: "already done",
    });
    expect(ledger.rows.get("u1")!.status).toBe("completed");
    expect(advanceChain).not.toHaveBeenCalled();
    expect(await pendingReportBacks()).toHaveLength(0); // nothing to deliver
  });

  it("routing decides WHAT replay does, never WHETHER it is owed", () => {
    expect(needsCompletionReplay({}, { status: "interrupted" })).toBe(true);
    expect(needsCompletionReplay({}, { status: "running" })).toBe(true);
    expect(needsCompletionReplay({}, { status: "completed" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. Honest recovery contract after a bounded timeout (QA note)
// ---------------------------------------------------------------------------

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
        await replayHost.replayCompletedDispatch({
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
          await replayHost.replayCompletedDispatch({
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

  it("a live scheduled fire is NOT double-counted (it is already queued)", async () => {
    // Regression guard on the primitive itself: the live path goes through
    // `queueOnChannel`, which registers the turn; registering again here would
    // inflate the drain and keep it alive after the turn had finished.
    const store = makeClosableStore();
    store.scheduled.set("s-live", { id: "s-live", sessionMode: "live" });
    const fire = deferred();
    const host = makeQuiesceHost({
      store,
      runScheduledPromptInner: async () => {
        expect(host.activeTurns).toBe(0); // no OUTER registration for live
        await fire.promise;
      },
    });

    const running = host.runScheduledPrompt("s-live");
    await flush();
    expect(host.activeTurns).toBe(0);
    fire.resolve();
    await running;
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

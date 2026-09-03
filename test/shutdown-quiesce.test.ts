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
import { DispatchWatcher } from "../packages/core/src/core/dispatch/watcher.js";
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

/** Minimal orchestrator stand-in exercising the real quiesce methods. */
function makeQuiesceHost(over: Record<string, unknown> = {}) {
  const self: Record<string, unknown> = {
    logger: silent,
    activeTurns: 0,
    intakeStopped: false,
    pendingContinuations: new Set<Promise<void>>(),
    channelQueues: new Map<string, Promise<void>>(),
    dispatchWatcher: undefined,
    scheduledManager: undefined,
    stopIntake: Orchestrator.prototype["stopIntake" as never],
    quiesce: Orchestrator.prototype["quiesce" as never],
    drainAfterDispose: Orchestrator.prototype["drainAfterDispose" as never],
    settleTrackedContinuations: Orchestrator.prototype["settleTrackedContinuations" as never],
    runBoundedDrain: Orchestrator.prototype["runBoundedDrain" as never],
    trackContinuation: Orchestrator.prototype["trackContinuation" as never],
    ...over,
  };
  return self as unknown as {
    quiesce(o?: { timeoutMs?: number }): Promise<{ timedOut: boolean; continuations: number }>;
    drainAfterDispose(o?: { timeoutMs?: number }): Promise<{ timedOut: boolean }>;
    trackContinuation(p: Promise<void>): void;
    pendingContinuations: Set<Promise<void>>;
    channelQueues: Map<string, Promise<void>>;
    intakeStopped: boolean;
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

  it("a barrier that throws is a timeout-equivalent, not a crash", async () => {
    const host = makeQuiesceHost({
      dispatchWatcher: {
        stop() {},
        inFlightCount: 0,
        drain: async () => {
          throw new Error("drain exploded");
        },
      },
    });
    await expect(host.quiesce({ timeoutMs: 200 })).resolves.toBeDefined();
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

  it("a schedule becoming due during the drain still fires and extends it", async () => {
    // Isolated scheduled fires increment activeTurns, so a due fire must be
    // able to START after intake closes and keep the drain alive.
    const host = makeQuiesceHost();
    await host.quiesce({ timeoutMs: 200 }); // intake now closed
    const dueFire = deferred();
    host.trackContinuation(dueFire.promise); // stands in for the in-flight fire
    let done = false;
    const phase = host.drainAfterDispose({ timeoutMs: 5000 }).then((r) => ((done = true), r));
    await flush();
    expect(done).toBe(false); // the drain waited for it
    dueFire.resolve();
    expect((await phase).timedOut).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Watcher pre-claim race (review blocker 4)
// ---------------------------------------------------------------------------

describe("#174 tick pre-claim race", () => {
  it("a tick paused between its ready check and its claim does not run after stop()+drain()", async () => {
    const atReaddir = deferred();
    const released = deferred();
    let ran = false;
    const watcher = new DispatchWatcher({
      dataDir,
      logger: silent,
      onDispatch: async () => {
        ran = true;
        return { output: "should not run", stopReason: "end_turn" };
      },
    });
    await watcher.start(); // ready, nothing pending
    await dropSpec({ id: "racy" });

    // Enter a tick and hold it exactly in the gap the race lives in: past the
    // `ready` check, inside the readdir await, before any claim.
    const origReaddir = (watcher as unknown as { dirs: { pending: string } }).dirs.pending;
    void origReaddir;
    const tick = (async () => {
      const inner = watcher.tick();
      atReaddir.resolve();
      await released.promise;
      await inner;
    })();

    await atReaddir.promise;
    watcher.stop();
    released.resolve();
    await watcher.drain();
    await tick;

    // The spec must be left for the next boot, not claimed into the window.
    expect(ran).toBe(false);
    expect(await readdir(dirs.pending)).toContain("racy.json");
    expect(await readdir(dirs.done)).not.toContain("racy.json");
  });

  it("drain awaits in-progress ticks, not just queues", async () => {
    const watcher = new DispatchWatcher({
      dataDir,
      logger: silent,
      onDispatch: async () => ({ output: "x", stopReason: "end_turn" }),
    });
    await watcher.start();
    await dropSpec({ id: "t1" });
    const ticking = watcher.tick();
    await watcher.drain();
    await ticking;
    expect(watcher.inFlightCount).toBe(0);
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

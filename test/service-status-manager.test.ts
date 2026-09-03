import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ServiceStatusRefreshManager,
  aggregateOutcome,
  backoffDelayMs,
  type ServiceStatusTimers,
  type SourceRefreshResult,
} from "../packages/core/src/core/service-status/manager.js";
import { ServiceStatusStore } from "../packages/core/src/core/service-status/store.js";
import type {
  ServiceStatusAdapterContext,
  ServiceStatusAdapterResult,
  ServiceStatusLevel,
  ServiceStatusSourceDefinition,
} from "../packages/core/src/core/service-status/types.js";

const NORMAL_INTERVAL_MS = 300_000;
const INCIDENT_INTERVAL_MS = 60_000;
/**
 * Deliberately not a round number: the harness tells a per-flight fetch timeout
 * from a scheduler timer by its delay, and 10s would collide with the second
 * backoff step.
 */
const FETCH_TIMEOUT_MS = 7_777;
const FORCED_COOLDOWN_MS = 30_000;

/**
 * Deterministic timers. Handles start at 0 on purpose: a falsy timer handle
 * must still be treated as armed and must still be cleared by `stop()`.
 */
class FakeTimers implements ServiceStatusTimers {
  private nextHandle = 0;
  readonly pending = new Map<number, { callback: () => void; ms: number }>();

  setTimeout = (callback: () => void, ms: number): unknown => {
    const handle = this.nextHandle++;
    this.pending.set(handle, { callback, ms });
    return handle;
  };

  clearTimeout = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };

  /**
   * Pending scheduler entries. The scheduler arms exactly one timer at a time;
   * everything else pending is a per-flight fetch timeout.
   */
  cadenceTimers(): { handle: number; ms: number }[] {
    return [...this.pending.entries()]
      .filter(([, entry]) => entry.ms !== FETCH_TIMEOUT_MS)
      .map(([handle, entry]) => ({ handle, ms: entry.ms }));
  }

  fetchTimers(): { handle: number; ms: number }[] {
    return [...this.pending.entries()]
      .filter(([, entry]) => entry.ms === FETCH_TIMEOUT_MS)
      .map(([handle, entry]) => ({ handle, ms: entry.ms }));
  }

  fireFetchTimeouts(): void {
    for (const [handle, entry] of [...this.pending.entries()]) {
      if (entry.ms !== FETCH_TIMEOUT_MS) continue;
      this.pending.delete(handle);
      entry.callback();
    }
  }

  fire(handle: number): void {
    const entry = this.pending.get(handle);
    if (!entry) throw new Error(`no pending timer ${String(handle)}`);
    this.pending.delete(handle);
    entry.callback();
  }
}

async function flush(times = 8): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function okResult(sourceId: string, overrides: Partial<ServiceStatusAdapterResult> = {}) {
  return {
    sourceId,
    fetchedAt: "2026-09-03T12:00:00.000Z",
    baseline: { status: "operational" as const, description: null, derived: false },
    components: [],
    incidents: [],
    notes: [],
    ...overrides,
  };
}

interface Harness {
  store: ServiceStatusStore;
  timers: FakeTimers;
  updates: SourceRefreshResult[];
  nowMs: number;
  advance: (ms: number) => void;
  manager: ServiceStatusRefreshManager;
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  /** Read a snapshot against the harness clock, not the wall clock. */
  snapshot: (sourceId: string) => ReturnType<ServiceStatusStore["getSnapshot"]>;
  /**
   * Fire the single armed scheduler timer, advancing the clock by its delay
   * first. A timer scheduled for +N ms firing means N ms have elapsed, and the
   * scheduler reads the clock to decide which sources are due.
   */
  fireScheduler: () => void;
  /** The delay of the currently armed scheduler timer, if any. */
  schedulerDelayMs: () => number | undefined;
}

function harness(
  sources: readonly ServiceStatusSourceDefinition[],
  options: {
    onUpdate?: (result: SourceRefreshResult) => void | Promise<void>;
    random?: () => number;
    maxBackoffAttempts?: number;
  } = {}
): Harness {
  const store = new ServiceStatusStore(":memory:");
  const timers = new FakeTimers();
  const updates: SourceRefreshResult[] = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const state = { nowMs: new Date("2026-09-03T12:00:00.000Z").getTime() };

  const manager = new ServiceStatusRefreshManager({
    store,
    sources,
    timers,
    logger,
    now: () => new Date(state.nowMs),
    random: options.random ?? (() => 0.5),
    normalIntervalMs: NORMAL_INTERVAL_MS,
    incidentIntervalMs: INCIDENT_INTERVAL_MS,
    fetchTimeoutMs: FETCH_TIMEOUT_MS,
    forcedCooldownMs: FORCED_COOLDOWN_MS,
    backoffBaseMs: 5_000,
    backoffMaxMs: 120_000,
    backoffJitterRatio: 0.2,
    maxBackoffAttempts: options.maxBackoffAttempts ?? 6,
    onUpdate:
      options.onUpdate ??
      ((result) => {
        updates.push(result);
      }),
  });

  return {
    store,
    timers,
    updates,
    logger,
    manager,
    get nowMs() {
      return state.nowMs;
    },
    advance: (ms: number) => {
      state.nowMs += ms;
    },
    snapshot: (sourceId: string) => store.getSnapshot(sourceId, new Date(state.nowMs)),
    schedulerDelayMs: () => timers.cadenceTimers()[0]?.ms,
    fireScheduler: () => {
      const armed = timers.cadenceTimers();
      if (armed.length !== 1) {
        throw new Error(`expected exactly one armed scheduler timer, found ${String(armed.length)}`);
      }
      state.nowMs += armed[0]!.ms;
      timers.fire(armed[0]!.handle);
    },
  };
}

function source(
  id: string,
  fetchImpl: (context: ServiceStatusAdapterContext) => Promise<ServiceStatusAdapterResult>
): ServiceStatusSourceDefinition {
  return {
    id,
    label: id,
    provenance: "official",
    homepage: `https://status.${id}.test`,
    scopeNote: `${id} test source`,
    fetch: fetchImpl,
  };
}

/** A source whose every call can be settled by the test. */
function manualSource(id: string) {
  const contexts: ServiceStatusAdapterContext[] = [];
  const settlers: { resolve: (r: ServiceStatusAdapterResult) => void; reject: (e: Error) => void }[] = [];
  const definition = source(id, (context) => {
    contexts.push(context);
    return new Promise<ServiceStatusAdapterResult>((resolve, reject) => {
      settlers.push({ resolve, reject });
    });
  });
  return {
    definition,
    contexts,
    get calls() {
      return contexts.length;
    },
    resolveLast: (result: ServiceStatusAdapterResult = okResult(id)) => {
      settlers[settlers.length - 1]!.resolve(result);
    },
    rejectLast: (error: Error) => {
      settlers[settlers.length - 1]!.reject(error);
    },
    /** Settle one specific call, so a stale flight can answer after a newer one. */
    settleAt: (index: number, result: ServiceStatusAdapterResult = okResult(id)) => {
      settlers[index]!.resolve(result);
    },
  };
}

describe("ServiceStatusRefreshManager", () => {
  let open: ServiceStatusStore[] = [];

  beforeEach(() => {
    open = [];
  });

  afterEach(() => {
    for (const store of open) {
      try {
        store.close();
      } catch {
        // Already closed.
      }
    }
  });

  function track(h: Harness): Harness {
    open.push(h.store);
    return h;
  }

  describe("source isolation", () => {
    it("one failing source neither blocks nor fails the others", async () => {
      const h = track(
        harness([
          source("good", () => Promise.resolve(okResult("good"))),
          source("bad", () => Promise.reject(new Error("upstream exploded"))),
        ])
      );

      const result = await h.manager.refresh();
      expect(result.outcome).toBe("mixed");

      const byId = new Map(result.sources.map((entry) => [entry.sourceId, entry]));
      expect(byId.get("good")!.succeeded).toBe(true);
      expect(byId.get("good")!.disposition).toBe("executed");
      expect(byId.get("good")!.attempted).toBe(true);
      expect(byId.get("good")!.error).toBeNull();

      expect(byId.get("bad")!.succeeded).toBe(false);
      expect(byId.get("bad")!.error).toContain("upstream exploded");
      expect(byId.get("bad")!.observation?.health).toBe("fetch_error");

      expect(h.snapshot("good")!.observation.health).toBe("ok");
      expect(h.snapshot("bad")!.observation.health).toBe("fetch_error");
    });

    it("reports a wholly successful and a wholly failed refresh distinctly", async () => {
      const allGood = track(harness([source("a", () => Promise.resolve(okResult("a")))]));
      expect((await allGood.manager.refresh()).outcome).toBe("succeeded");

      const allBad = track(harness([source("a", () => Promise.reject(new Error("no")))]));
      expect((await allBad.manager.refresh()).outcome).toBe("failed");
    });

    it("rejects an unknown source id", async () => {
      const h = track(harness([source("a", () => Promise.resolve(okResult("a")))]));
      await expect(h.manager.refreshSource("nope")).rejects.toThrow(/unknown service status source/i);
    });
  });

  describe("single flight", () => {
    it("coalesces a concurrent request onto the in-flight attempt", async () => {
      const manual = manualSource("a");
      const h = track(harness([manual.definition]));

      const first = h.manager.refreshSource("a");
      const second = h.manager.refreshSource("a");
      await flush(2);
      expect(manual.calls).toBe(1);

      manual.resolveLast();
      const [one, two] = await Promise.all([first, second]);

      expect(one.disposition).toBe("executed");
      expect(one.attempted).toBe(true);
      expect(two.disposition).toBe("coalesced");
      expect(two.attempted).toBe(false);
      expect(two.succeeded).toBe(true);
      expect(two.snapshot?.sourceId).toBe("a");
      expect(two.reason).toMatch(/coalesced/);

      // The upstream was fetched once, so exactly one notification is sent.
      expect(h.updates).toHaveLength(1);
      expect(h.updates[0]!.disposition).toBe("executed");
    });

    it("admits a fresh flight once the previous one has settled", async () => {
      const manual = manualSource("a");
      const h = track(harness([manual.definition]));

      const first = h.manager.refreshSource("a");
      await flush(2);
      manual.resolveLast();
      await first;

      // A success schedules the source for its next cadence slot, so an
      // ordinary request inside that window is honestly reported as not due.
      const tooSoon = await h.manager.refreshSource("a");
      expect(tooSoon.disposition).toBe("rate_limited");
      expect(tooSoon.reason).toBe("not yet due for refresh");
      expect(manual.calls).toBe(1);

      const second = h.manager.refreshSource("a", { force: true });
      await flush(2);
      expect(manual.calls).toBe(2);
      manual.resolveLast();
      await second;
    });
  });

  describe("forced cooldown", () => {
    it("applies per physical source across global and targeted calls", async () => {
      const h = track(
        harness([
          source("a", () => Promise.resolve(okResult("a"))),
          source("b", () => Promise.resolve(okResult("b"))),
        ])
      );

      const global = await h.manager.refresh({ force: true });
      expect(global.sources.every((entry) => entry.disposition === "executed")).toBe(true);

      const targeted = await h.manager.refreshSource("a", { force: true });
      expect(targeted.disposition).toBe("rate_limited");
      expect(targeted.attempted).toBe(false);
      expect(targeted.succeeded).toBeNull();
      expect(targeted.reason).toMatch(/cooldown/);
      // A rate-limited call still reports the source's current stored state.
      expect(targeted.snapshot?.sourceId).toBe("a");

      h.advance(FORCED_COOLDOWN_MS);
      const afterCooldown = await h.manager.refreshSource("a", { force: true });
      expect(afterCooldown.disposition).toBe("executed");
    });

    it("executes only the eligible sources in a global forced refresh", async () => {
      const h = track(
        harness([
          source("a", () => Promise.resolve(okResult("a"))),
          source("b", () => Promise.reject(new Error("b is down"))),
          source("c", () => Promise.resolve(okResult("c"))),
        ])
      );

      // Put `c` alone into cooldown with a targeted forced refresh.
      await h.manager.refreshSource("c", { force: true });

      const global = await h.manager.refresh({ force: true });
      const byId = new Map(global.sources.map((entry) => [entry.sourceId, entry]));
      expect(byId.get("a")!.disposition).toBe("executed");
      expect(byId.get("b")!.disposition).toBe("executed");
      expect(byId.get("c")!.disposition).toBe("rate_limited");

      // Mixed, computed only over the sources that actually produced an
      // outcome — a cooldown is not a failure.
      expect(global.outcome).toBe("mixed");
      expect(byId.get("c")!.succeeded).toBeNull();
      expect(byId.get("c")!.error).toBeNull();
    });
  });

  describe("bounded fetches", () => {
    it("times a refresh out even when the adapter ignores its AbortSignal", async () => {
      const stubborn = source("a", () => new Promise<ServiceStatusAdapterResult>(() => {}));
      const h = track(harness([stubborn]));

      const pending = h.manager.refreshSource("a");
      await flush(2);
      h.timers.fireFetchTimeouts();

      const result = await pending;
      expect(result.disposition).toBe("executed");
      expect(result.succeeded).toBe(false);
      expect(result.error).toMatch(/exceeded 7777ms/);
      expect(h.snapshot("a")!.observation.health).toBe("fetch_error");
    });

    it("passes an abort signal that a cooperative adapter can observe", async () => {
      const manual = manualSource("a");
      const h = track(harness([manual.definition]));
      const pending = h.manager.refreshSource("a");
      await flush(2);

      const signal = manual.contexts[0]!.signal!;
      expect(signal.aborted).toBe(false);
      h.manager.stop();
      expect(signal.aborted).toBe(true);

      manual.rejectLast(new Error("aborted"));
      expect((await pending).disposition).toBe("cancelled");
    });
  });

  describe("stop", () => {
    it("settles every caller when the adapter ignores abort entirely", async () => {
      const stubborn = source("a", () => new Promise<ServiceStatusAdapterResult>(() => {}));
      const h = track(harness([stubborn]));

      const first = h.manager.refreshSource("a");
      const coalesced = h.manager.refreshSource("a");
      await flush(2);
      expect([...h.timers.pending.values()].filter((t) => t.ms === FETCH_TIMEOUT_MS)).toHaveLength(1);

      h.manager.stop();

      const [one, two] = await Promise.all([first, coalesced]);
      expect(one.disposition).toBe("cancelled");
      expect(one.reason).toMatch(/manager stopped/);
      expect(two.disposition).toBe("cancelled");
      expect(h.updates).toHaveLength(0);

      // The adapter is still running and will never answer, so the flight's
      // timeout is the one thing that could still fire. It must be released —
      // but only after the callers above were settled, never before.
      expect(h.timers.pending.size).toBe(0);
    });

    it("settles callers when stop() lands during an onUpdate that never resolves", async () => {
      // The flight has already fetched and persisted; it is parked inside the
      // update callback. If it were removed from the in-flight map at that
      // point, `stop()` could not reach it and every caller would wait forever.
      let releaseCallback!: () => void;
      let callbackCalls = 0;
      const notified = new Promise<void>((resolve) => {
        releaseCallback = resolve;
      });
      const h = track(
        harness([source("a", () => Promise.resolve(okResult("a")))], {
          onUpdate: async () => {
            callbackCalls += 1;
            await notified;
          },
        })
      );

      const executed = h.manager.refreshSource("a");
      await flush(4);
      const coalesced = h.manager.refreshSource("a");
      await flush(2);
      expect(callbackCalls).toBe(1);

      h.manager.stop();

      // Both callers settle promptly, without waiting on the stuck callback.
      const [one, two] = await Promise.all([executed, coalesced]);
      expect(one.disposition).toBe("cancelled");
      expect(one.reason).toMatch(/manager stopped/);
      expect(two.disposition).toBe("cancelled");
      expect(h.timers.pending.size).toBe(0);
      expect(h.manager.hasArmedTimer).toBe(false);

      // The callback finally returns. It must not settle anyone a second time,
      // notify again, or rearm a timer.
      releaseCallback();
      await flush();
      expect(callbackCalls).toBe(1);
      expect(h.timers.pending.size).toBe(0);
      expect(h.manager.hasArmedTimer).toBe(false);
      expect((await executed).disposition).toBe("cancelled");
      expect(h.manager.isRunning).toBe(false);
    });

    it("keeps a source single-flighted while it persists and notifies", async () => {
      let releaseCallback!: () => void;
      const notified = new Promise<void>((resolve) => {
        releaseCallback = resolve;
      });
      let calls = 0;
      const h = track(
        harness(
          [
            source("a", () => {
              calls += 1;
              return Promise.resolve(okResult("a"));
            }),
          ],
          {
            onUpdate: async () => {
              await notified;
            },
          }
        )
      );

      const first = h.manager.refreshSource("a", { force: true });
      await flush(4);
      // Mid-write: a second forced request must coalesce, not start a parallel
      // fetch that could interleave with this one's store transaction.
      h.advance(FORCED_COOLDOWN_MS);
      const second = h.manager.refreshSource("a", { force: true });
      await flush(2);
      expect(calls).toBe(1);

      releaseCallback();
      const [a, b] = await Promise.all([first, second]);
      expect(a.disposition).toBe("executed");
      expect(b.disposition).toBe("coalesced");
      expect(calls).toBe(1);
    });

    it("releases the fetch timeout even when its handle is falsy", async () => {
      // A timers implementation may hand back `0`. A truthiness check would
      // leak that flight's timeout past stop().
      const cleared: unknown[] = [];
      let armed = 0;
      const zeroTimers: ServiceStatusTimers = {
        setTimeout: () => {
          armed += 1;
          return 0;
        },
        clearTimeout: (handle) => {
          cleared.push(handle);
        },
      };
      const store = new ServiceStatusStore(":memory:");
      open.push(store);
      const manager = new ServiceStatusRefreshManager({
        store,
        sources: [source("a", () => new Promise<ServiceStatusAdapterResult>(() => {}))],
        timers: zeroTimers,
        normalIntervalMs: NORMAL_INTERVAL_MS,
        fetchTimeoutMs: FETCH_TIMEOUT_MS,
      });

      const pending = manager.refreshSource("a");
      await flush(2);
      expect(armed).toBe(1);

      manager.stop();
      expect((await pending).disposition).toBe("cancelled");
      // Both the flight timeout and (had one been armed) the cadence timer are
      // released by handle value `0`.
      expect(cleared).toContain(0);
      expect(cleared).toHaveLength(1);
    });

    it("writes nothing and notifies no one after stop, even if the adapter later succeeds", async () => {
      const manual = manualSource("a");
      const h = track(harness([manual.definition]));

      const pending = h.manager.refreshSource("a");
      await flush(2);
      h.manager.stop();
      expect((await pending).disposition).toBe("cancelled");

      manual.resolveLast();
      await flush();

      expect(h.snapshot("a")!.observation.health).toBe("never_fetched");
      expect(h.store.listEvents({ sourceId: "a" })).toHaveLength(0);
      expect(h.updates).toHaveLength(0);
    });

    it("clears an armed cadence timer", async () => {
      const h = track(harness([source("a", () => Promise.resolve(okResult("a")))]));

      h.manager.start();
      await flush();
      expect(h.timers.cadenceTimers()).toHaveLength(1);
      expect(h.manager.hasArmedTimer).toBe(true);

      h.manager.stop();
      expect(h.manager.hasArmedTimer).toBe(false);
      expect(h.timers.cadenceTimers()).toHaveLength(0);
      expect(h.manager.isRunning).toBe(false);
    });

    it("treats a zero timer handle as armed and still clears it", async () => {
      // Node's timer handles are objects, but the injected timer contract
      // permits any value — including `0`. A truthiness check would silently
      // leak that timer past `stop()`.
      const cleared: unknown[] = [];
      const zeroTimers: ServiceStatusTimers = {
        setTimeout: () => 0,
        clearTimeout: (handle) => {
          cleared.push(handle);
        },
      };
      const store = new ServiceStatusStore(":memory:");
      open.push(store);
      const manager = new ServiceStatusRefreshManager({
        store,
        sources: [source("a", () => Promise.resolve(okResult("a")))],
        timers: zeroTimers,
        normalIntervalMs: NORMAL_INTERVAL_MS,
        fetchTimeoutMs: FETCH_TIMEOUT_MS,
      });

      manager.start();
      await flush();
      expect(manager.hasArmedTimer).toBe(true);

      manager.stop();
      expect(cleared).toContain(0);
      expect(manager.hasArmedTimer).toBe(false);
    });

    it("is idempotent", () => {
      const h = track(harness([source("a", () => Promise.resolve(okResult("a")))]));
      expect(() => {
        h.manager.stop();
        h.manager.stop();
      }).not.toThrow();
    });
  });

  describe("generations", () => {
    it("does not let a newer generation coalesce onto stale standalone work", async () => {
      const manual = manualSource("a");
      const h = track(harness([manual.definition]));

      // Admitted while the manager is stopped, under generation N.
      const standalone = h.manager.refreshSource("a");
      await flush(2);
      expect(manual.calls).toBe(1);

      // A newer generation begins before the adapter answers. The startup
      // refresh must NOT coalesce onto the doomed flight — that flight can
      // never persist, so coalescing would silently make the restart's first
      // refresh a no-op. It admits a physical fetch of its own instead.
      h.manager.start();
      await flush(2);
      expect(manual.calls).toBe(2);

      // The stale caller is settled immediately, without waiting on an adapter
      // that may never answer.
      const stale = await standalone;
      expect(stale.disposition).toBe("cancelled");
      expect(stale.reason).toMatch(/superseded by a newer manager generation/);
      expect(h.snapshot("a")!.observation.health).toBe("never_fetched");
      expect(h.updates).toHaveLength(0);

      // The retired flight leaves no timer behind.
      expect([...h.timers.pending.values()].filter((t) => t.ms === FETCH_TIMEOUT_MS)).toHaveLength(1);

      // The stale adapter answering late must not overwrite current state.
      manual.settleAt(0, okResult("a"));
      await flush();
      expect(h.snapshot("a")!.observation.health).toBe("never_fetched");
      expect(h.updates).toHaveLength(0);

      // The current-generation flight is the one that counts.
      manual.settleAt(1, okResult("a"));
      await flush();
      expect(h.snapshot("a")!.observation.health).toBe("ok");
      expect(h.updates.map((update) => update.disposition)).toEqual(["executed"]);

      h.manager.stop();
    });

    it("retires a stale flight on a targeted refresh after stop/restart", async () => {
      const manual = manualSource("a");
      const h = track(harness([manual.definition]));

      h.manager.start();
      await flush(2);
      expect(manual.calls).toBe(1);

      // Restart while the first fetch is still outstanding.
      h.manager.stop();
      h.manager.start();
      await flush(2);
      expect(manual.calls).toBe(2);

      // The pre-restart flight cannot persist even if it succeeds.
      manual.settleAt(0, okResult("a"));
      await flush();
      expect(h.snapshot("a")!.observation.health).toBe("never_fetched");

      manual.settleAt(1, okResult("a"));
      await flush();
      expect(h.snapshot("a")!.observation.health).toBe("ok");

      h.manager.stop();
      expect([...h.timers.pending.values()].filter((t) => t.ms === FETCH_TIMEOUT_MS)).toHaveLength(0);
    });

    it("persists standalone work when no newer generation intervened", async () => {
      const manual = manualSource("a");
      const h = track(harness([manual.definition]));

      const standalone = h.manager.refreshSource("a");
      await flush(2);
      manual.resolveLast();

      const result = await standalone;
      expect(result.disposition).toBe("executed");
      expect(result.succeeded).toBe(true);
      expect(h.snapshot("a")!.observation.health).toBe("ok");
    });
  });

  describe("cadence", () => {
    it("polls every five minutes normally and every minute during an incident", async () => {
      let incidentActive = false;
      const definition = source("a", () =>
        Promise.resolve(
          okResult("a", {
            incidents: incidentActive
              ? [
                  {
                    externalId: "INC-1",
                    title: "outage",
                    stage: "active" as const,
                    lifecycle: "investigating",
                    impact: "major_outage" as const,
                    url: null,
                    startedAt: "2026-09-03T12:00:00.000Z",
                    updatedAt: "2026-09-03T12:00:00.000Z",
                    resolvedAt: null,
                    componentIds: [],
                    updates: [],
                  },
                ]
              : [],
          })
        )
      );
      const h = track(harness([definition]));

      h.manager.start();
      await flush();
      expect(h.schedulerDelayMs()).toBe(NORMAL_INTERVAL_MS);

      incidentActive = true;
      h.fireScheduler();
      await flush();
      expect(h.schedulerDelayMs()).toBe(INCIDENT_INTERVAL_MS);

      incidentActive = false;
      h.fireScheduler();
      await flush();
      expect(h.schedulerDelayMs()).toBe(NORMAL_INTERVAL_MS);

      h.manager.stop();
    });

    it("accelerates for an unhealthy status even with no active incident", async () => {
      let status: ServiceStatusLevel = "operational";
      const definition = source("a", () =>
        Promise.resolve(
          okResult("a", {
            baseline: { status, description: null, derived: false },
          })
        )
      );
      const h = track(harness([definition]));

      h.manager.start();
      await flush();
      expect(h.schedulerDelayMs()).toBe(NORMAL_INTERVAL_MS);

      // A degraded page with no incident filed is exactly the case that must
      // not be polled lazily.
      for (const unhealthy of ["degraded", "unknown", "partial_outage", "major_outage"] as const) {
        status = unhealthy;
        h.fireScheduler();
        await flush();
        expect(h.schedulerDelayMs()).toBe(INCIDENT_INTERVAL_MS);
      }

      // Planned maintenance is announced and time-boxed; it does not accelerate.
      status = "maintenance";
      h.fireScheduler();
      await flush();
      expect(h.schedulerDelayMs()).toBe(NORMAL_INTERVAL_MS);

      // Recovery returns to the slow cadence.
      status = "operational";
      h.fireScheduler();
      await flush();
      expect(h.schedulerDelayMs()).toBe(NORMAL_INTERVAL_MS);

      h.manager.stop();
    });

    it("accelerates when a selected component is unhealthy", async () => {
      const h = track(
        harness([
          source("a", () =>
            Promise.resolve(
              okResult("a", {
                components: [
                  {
                    id: "api",
                    name: "API",
                    status: "partial_outage" as const,
                    description: null,
                    groupId: null,
                    isGroup: false,
                    selected: true,
                    updatedAt: null,
                  },
                ],
              })
            )
          ),
        ])
      );
      h.manager.start();
      await flush();
      expect(h.schedulerDelayMs()).toBe(INCIDENT_INTERVAL_MS);
      h.manager.stop();
    });

    it("never stacks cadence timers behind a slow refresh", async () => {
      const manual = manualSource("a");
      const h = track(harness([manual.definition]));

      h.manager.start();
      await flush(2);
      // The startup refresh has not answered yet, so nothing is armed.
      expect(h.timers.cadenceTimers()).toHaveLength(0);

      manual.resolveLast();
      await flush();
      expect(h.timers.cadenceTimers()).toHaveLength(1);

      h.fireScheduler();
      await flush(2);
      // The next refresh is outstanding, so again nothing is armed — one timer
      // at most, never a queue of them.
      expect(h.timers.cadenceTimers()).toHaveLength(0);
      manual.resolveLast();
      await flush();
      expect(h.timers.cadenceTimers()).toHaveLength(1);

      h.manager.stop();
    });

    it("arms the scheduler for the earliest due source and never postpones it", async () => {
      // `a` fails and is due again in 5s; `b` succeeds and is due in 5m. The
      // single scheduler timer must follow `a`, the earlier of the two.
      let aFailing = true;
      const h = track(
        harness([
          source("a", () =>
            aFailing ? Promise.reject(new Error("down")) : Promise.resolve(okResult("a"))
          ),
          source("b", () => Promise.resolve(okResult("b"))),
        ])
      );

      const startedAtMs = h.nowMs;
      h.manager.start();
      await flush();

      // `a` is retried in 5s; `b` succeeded, but `a` is now `unknown`, which
      // accelerates the shared cadence, so `b` is due in 60s rather than 5m.
      expect(h.manager.nextDueAtMs("a")).toBe(startedAtMs + 5_000);
      expect(h.manager.nextDueAtMs("b")).toBe(startedAtMs + INCIDENT_INTERVAL_MS);
      // The single timer follows the earlier of the two.
      expect(h.schedulerDelayMs()).toBe(5_000);

      aFailing = false;
      h.fireScheduler();
      await flush();

      // `a` recovered and goes to the normal cadence; `b`'s existing due time is
      // untouched and is now the earliest, so the timer is not postponed to
      // `a`'s far-off slot.
      expect(h.manager.nextDueAtMs("a")).toBe(startedAtMs + 5_000 + NORMAL_INTERVAL_MS);
      expect(h.manager.nextDueAtMs("b")).toBe(startedAtMs + INCIDENT_INTERVAL_MS);
      expect(h.schedulerDelayMs()).toBe(INCIDENT_INTERVAL_MS - 5_000);

      h.manager.stop();
    });

    it("does not rearm after a stop that happens mid-refresh", async () => {
      const manual = manualSource("a");
      const h = track(harness([manual.definition]));

      h.manager.start();
      await flush(2);
      h.manager.stop();
      manual.resolveLast();
      await flush();

      expect(h.timers.cadenceTimers()).toHaveLength(0);
      expect(h.manager.hasArmedTimer).toBe(false);
    });

    it("start() is idempotent while running", async () => {
      const h = track(harness([source("a", () => Promise.resolve(okResult("a")))]));
      h.manager.start();
      await flush();
      h.manager.start();
      await flush();
      expect(h.timers.cadenceTimers()).toHaveLength(1);
      h.manager.stop();
    });
  });

  describe("backoff", () => {
    it("clamps the jittered delay to the configured bounds", () => {
      const options = { backoffBaseMs: 5_000, backoffMaxMs: 120_000, backoffJitterRatio: 0.2 };
      expect(backoffDelayMs(1, options, () => 0.5)).toBe(5_000);
      // Jitter can only move the value inside [base, max].
      for (const random of [() => 0, () => 1, () => 0.5, () => 0.999]) {
        for (const failures of [1, 2, 3, 5, 8, 20]) {
          const delay = backoffDelayMs(failures, options, random);
          expect(delay).toBeGreaterThanOrEqual(options.backoffBaseMs);
          expect(delay).toBeLessThanOrEqual(options.backoffMaxMs);
        }
      }
      // It grows with consecutive failures and saturates at the ceiling.
      const noJitter = { ...options, backoffJitterRatio: 0 };
      expect(backoffDelayMs(2, noJitter, () => 0.5)).toBe(10_000);
      expect(backoffDelayMs(3, noJitter, () => 0.5)).toBe(20_000);
      expect(backoffDelayMs(30, noJitter, () => 0.5)).toBe(120_000);
      // A jitter draw at the low end still cannot go below the base.
      expect(backoffDelayMs(1, options, () => 0)).toBe(options.backoffBaseMs);
    });

    it("skips a backing-off source on cadence but not on a forced refresh", async () => {
      let failing = true;
      const definition = source("a", () =>
        failing ? Promise.reject(new Error("still down")) : Promise.resolve(okResult("a"))
      );
      const h = track(harness([definition]));

      const first = await h.manager.refresh();
      expect(first.outcome).toBe("failed");

      const immediate = await h.manager.refresh();
      expect(immediate.sources[0]!.disposition).toBe("rate_limited");
      expect(immediate.sources[0]!.reason).toMatch(/backoff/);
      expect(immediate.outcome).toBe("skipped");

      // Forcing bypasses backoff (but records the cooldown).
      const forced = await h.manager.refreshSource("a", { force: true });
      expect(forced.disposition).toBe("executed");

      // Once the backoff window elapses the source is eligible again, and a
      // success cancels the backoff entirely.
      h.advance(60_000);
      failing = false;
      const recovered = await h.manager.refresh();
      expect(recovered.outcome).toBe("succeeded");

      // Having succeeded, the source is on the normal cadence rather than the
      // failure backoff — so an immediate ordinary refresh is not due yet, and
      // says so for the right reason.
      const again = await h.manager.refresh();
      expect(again.sources[0]!.disposition).toBe("rate_limited");
      expect(again.sources[0]!.reason).toBe("not yet due for refresh");
      h.advance(NORMAL_INTERVAL_MS);
      expect((await h.manager.refresh()).sources[0]!.disposition).toBe("executed");
    });

    it("retries only the failed source, on a real timer, at the computed delay", async () => {
      let aFailing = true;
      let aCalls = 0;
      let bCalls = 0;
      const h = track(
        harness([
          source("a", () => {
            aCalls += 1;
            return aFailing ? Promise.reject(new Error("down")) : Promise.resolve(okResult("a"));
          }),
          source("b", () => {
            bCalls += 1;
            return Promise.resolve(okResult("b"));
          }),
        ])
      );

      h.manager.start();
      await flush();
      expect([aCalls, bCalls]).toEqual([1, 1]);
      // First failure retries at the base delay, not at the polling cadence.
      expect(h.schedulerDelayMs()).toBe(5_000);

      h.fireScheduler();
      await flush();
      // The retry hit `a` only; the healthy source was not refetched.
      expect([aCalls, bCalls]).toEqual([2, 1]);
      // Second consecutive failure backs off further.
      expect(h.schedulerDelayMs()).toBe(10_000);

      h.fireScheduler();
      await flush();
      expect([aCalls, bCalls]).toEqual([3, 1]);
      expect(h.schedulerDelayMs()).toBe(20_000);

      // Recovery clears the backoff and returns `a` to the normal cadence.
      aFailing = false;
      h.fireScheduler();
      await flush();
      expect([aCalls, bCalls]).toEqual([4, 1]);
      expect(h.manager.nextDueAtMs("a")! - h.nowMs).toBe(NORMAL_INTERVAL_MS);

      h.manager.stop();
      expect(h.timers.pending.size).toBe(0);
    });

    it("pulls the armed scheduler forward when a forced refresh finds a failure", async () => {
      let failing = false;
      const h = track(
        harness([
          source("a", () =>
            failing ? Promise.reject(new Error("down")) : Promise.resolve(okResult("a"))
          ),
        ])
      );

      h.manager.start();
      await flush();
      expect(h.schedulerDelayMs()).toBe(NORMAL_INTERVAL_MS);

      // An out-of-band forced refresh discovers the failure. Its five-second
      // retry is useless if the scheduler stays parked five minutes out.
      failing = true;
      h.advance(1_000);
      const forced = await h.manager.refreshSource("a", { force: true });
      await flush();
      expect(forced.succeeded).toBe(false);
      expect(h.manager.nextDueAtMs("a")! - h.nowMs).toBe(5_000);
      expect(h.schedulerDelayMs()).toBe(5_000);
      expect(h.timers.cadenceTimers()).toHaveLength(1);

      // Firing it performs the retry rather than a five-minute-late one: the
      // forced refresh was the first failure, this retry is the second.
      h.fireScheduler();
      await flush();
      expect(h.snapshot("a")!.observation.consecutiveFailures).toBe(2);
      expect(h.schedulerDelayMs()).toBe(10_000);

      h.manager.stop();
      expect(h.timers.pending.size).toBe(0);
    });

    it("pulls the armed scheduler forward when a forced refresh finds degradation", async () => {
      let status: ServiceStatusLevel = "operational";
      const h = track(
        harness([
          source("a", () =>
            Promise.resolve(
              okResult("a", { baseline: { status, description: null, derived: false } })
            )
          ),
        ])
      );

      h.manager.start();
      await flush();
      expect(h.schedulerDelayMs()).toBe(NORMAL_INTERVAL_MS);

      // A successful forced refresh that reports degradation warrants the
      // one-minute cadence immediately, not at the end of the five-minute slot.
      status = "degraded";
      h.advance(1_000);
      const forced = await h.manager.refreshSource("a", { force: true });
      await flush();
      expect(forced.succeeded).toBe(true);
      expect(forced.snapshot?.effectiveStatus).toBe("degraded");
      expect(h.schedulerDelayMs()).toBe(INCIDENT_INTERVAL_MS);
      expect(h.timers.cadenceTimers()).toHaveLength(1);

      h.manager.stop();
      expect(h.timers.pending.size).toBe(0);
    });

    it("never lets a later due postpone an already-armed earlier timer", async () => {
      let aFailing = true;
      const h = track(
        harness([
          source("a", () =>
            aFailing ? Promise.reject(new Error("down")) : Promise.resolve(okResult("a"))
          ),
          source("b", () => Promise.resolve(okResult("b"))),
        ])
      );

      h.manager.start();
      await flush();
      // `a` is retrying in 5s, so that is what the single timer holds.
      expect(h.schedulerDelayMs()).toBe(5_000);

      // `b` refreshed out of band computes a far-off due. The armed timer must
      // stay where it is rather than being pushed out behind `b`.
      aFailing = false;
      h.advance(1_000);
      const armedBefore = h.timers.cadenceTimers()[0]!.handle;
      await h.manager.refreshSource("b", { force: true });
      await flush();
      expect(h.manager.nextDueAtMs("b")! - h.nowMs).toBeGreaterThan(5_000);
      // Same timer, untouched — not cleared and re-armed later.
      expect(h.timers.cadenceTimers()).toEqual([{ handle: armedBefore, ms: 5_000 }]);

      h.manager.stop();
      expect(h.timers.pending.size).toBe(0);
    });

    it("does not arm a mid-tick timer after a restart unwinds the previous tick", async () => {
      // The interleaving: an old-generation tick is still unwinding when a new
      // generation's tick is already running. A shared in-progress flag would
      // let the old tick's cleanup declare the new one finished, after which an
      // out-of-band refresh could arm a timer into the running new tick.
      const manual = manualSource("a");
      const h = track(
        harness([manual.definition, source("b", () => Promise.reject(new Error("down")))])
      );

      h.manager.start();
      await flush(2);
      // Generation 1's tick is parked on `a`; nothing armed yet.
      expect(h.timers.cadenceTimers()).toHaveLength(0);
      expect(manual.calls).toBe(1);

      // Stop and immediately restart. Generation 1's caller is settled by
      // stop(), so its tick will finish unwinding *after* generation 2's tick
      // has already started and parked on `a` again.
      h.manager.stop();
      h.manager.start();
      await flush(6);
      expect(manual.calls).toBe(2);
      // The new tick is still pending, so still nothing armed.
      expect(h.timers.cadenceTimers()).toHaveLength(0);

      // An out-of-band forced refresh completes and computes a short retry due.
      // It must not arm a timer while the new tick is running.
      const forced = await h.manager.refreshSource("b", { force: true });
      await flush(2);
      expect(forced.succeeded).toBe(false);
      expect(h.manager.nextDueAtMs("b")).toBeDefined();
      expect(h.timers.cadenceTimers()).toHaveLength(0);

      // Only when the new tick finishes does exactly one timer appear.
      manual.resolveLast();
      await flush();
      expect(h.timers.cadenceTimers()).toHaveLength(1);

      h.manager.stop();
      expect(h.timers.pending.size).toBe(0);
    });

    it("does not arm a mid-tick timer that could fire into the running tick", async () => {
      const manual = manualSource("a");
      const h = track(harness([manual.definition, source("b", () => Promise.reject(new Error("down")))]));

      h.manager.start();
      await flush(2);
      // `b` has already failed and computed a 5s retry, but the tick is still
      // waiting on `a`. Nothing may be armed until the tick finishes.
      expect(h.timers.cadenceTimers()).toHaveLength(0);

      manual.resolveLast();
      await flush();
      // One timer, following the earliest due — and only one.
      expect(h.timers.cadenceTimers()).toHaveLength(1);
      expect(h.schedulerDelayMs()).toBe(5_000);

      h.manager.stop();
      expect(h.timers.pending.size).toBe(0);
    });

    it("falls back to the normal cadence after the failure cap", async () => {
      const h = track(
        harness([source("a", () => Promise.reject(new Error("permanently down")))], {
          maxBackoffAttempts: 3,
        })
      );

      h.manager.start();
      await flush();
      expect(h.schedulerDelayMs()).toBe(5_000);

      h.fireScheduler();
      await flush();
      expect(h.schedulerDelayMs()).toBe(10_000);

      h.fireScheduler();
      await flush();
      expect(h.schedulerDelayMs()).toBe(20_000);

      // The fourth consecutive failure exceeds the cap: stop hammering and
      // fall back to ordinary polling.
      h.fireScheduler();
      await flush();
      expect(h.schedulerDelayMs()).toBe(NORMAL_INTERVAL_MS);

      h.fireScheduler();
      await flush();
      expect(h.schedulerDelayMs()).toBe(NORMAL_INTERVAL_MS);

      h.manager.stop();
    });
  });

  describe("notifications", () => {
    it("awaits an async callback and survives its rejection", async () => {
      const seen: string[] = [];
      const h = track(
        harness([source("a", () => Promise.resolve(okResult("a")))], {
          onUpdate: async (result) => {
            await new Promise((resolve) => setImmediate(resolve));
            seen.push(result.sourceId);
            throw new Error("callback blew up");
          },
        })
      );

      const result = await h.manager.refresh();
      // The refresh result is unaffected by the callback failing, and the
      // callback had already run by the time the refresh resolved.
      expect(result.outcome).toBe("succeeded");
      expect(seen).toEqual(["a"]);
      expect(h.logger.error).toHaveBeenCalledTimes(1);
    });

    it("notifies once per executed flight, for failures as well as successes", async () => {
      const h = track(
        harness([
          source("a", () => Promise.resolve(okResult("a"))),
          source("b", () => Promise.reject(new Error("down"))),
        ])
      );
      await h.manager.refresh();
      expect(h.updates.map((update) => update.sourceId).sort()).toEqual(["a", "b"]);
      expect(h.updates.map((update) => update.succeeded).sort()).toEqual([false, true]);
    });

    it("does not notify for a rate-limited call", async () => {
      const h = track(harness([source("a", () => Promise.resolve(okResult("a")))]));
      await h.manager.refresh({ force: true });
      h.updates.length = 0;
      await h.manager.refreshSource("a", { force: true });
      expect(h.updates).toHaveLength(0);
    });
  });

  describe("aggregateOutcome", () => {
    const entry = (succeeded: boolean | null): SourceRefreshResult => ({
      sourceId: "x",
      disposition: succeeded === null ? "rate_limited" : "executed",
      attempted: succeeded !== null,
      succeeded,
      durationMs: null,
      error: null,
      reason: null,
      observation: null,
      snapshot: null,
    });

    it("separates outcome from disposition", () => {
      expect(aggregateOutcome([])).toBe("skipped");
      expect(aggregateOutcome([entry(null), entry(null)])).toBe("skipped");
      expect(aggregateOutcome([entry(true), entry(null)])).toBe("succeeded");
      expect(aggregateOutcome([entry(false), entry(null)])).toBe("failed");
      expect(aggregateOutcome([entry(true), entry(false)])).toBe("mixed");
    });
  });
});

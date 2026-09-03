import { describe, it, expect, vi } from "vitest";
import { WatchManager, type WatchManagerStore } from "../packages/core/src/core/watch/manager.js";
import type { WatchEvent, WatchEvalResult } from "../packages/core/src/core/watch/types.js";

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as any;

function makeWatch(over: Partial<WatchEvent> = {}): WatchEvent {
  const now = Date.now();
  return {
    id: "w1",
    platform: "discord",
    channelRef: "thread-1",
    parentRef: null,
    kind: "file",
    spec: "/tmp/x",
    match: null,
    intervalSeconds: 30,
    prompt: "resume",
    reason: "why",
    mode: "once",
    maxFires: 1,
    fireCount: 0,
    lastCheckedUtc: null, // due by default (never checked)
    lastFiredUtc: null,
    lastObserved: null,
    expiresAtUtc: new Date(now + 3600_000).toISOString(), // not expired
    createdBy: "discord:thread-1",
    correlationId: null,
    createdUtc: new Date(now).toISOString(),
    ...over,
  };
}

/** In-memory store double backed by a map — the manager only touches these. */
function makeStore(initial: WatchEvent[]) {
  const rows = new Map(initial.map((w) => [w.id, { ...w }]));
  const deletes: string[] = [];
  const store: WatchManagerStore = {
    listAllWatches: () => [...rows.values()],
    markWatchChecked: (id, checkedUtc, observed) => {
      const w = rows.get(id);
      if (w) {
        w.lastCheckedUtc = checkedUtc;
        w.lastObserved = observed;
      }
    },
    incrementWatchFire: (id, firedUtc) => {
      const w = rows.get(id);
      if (w) {
        w.fireCount += 1;
        w.lastFiredUtc = firedUtc;
      }
    },
    deleteWatch: (id) => {
      deletes.push(id);
      rows.delete(id);
    },
  };
  return { store, rows, deletes };
}

/** An evaluate() that always fires with the given event text. */
const fires = (eventText = "event"): ((w: WatchEvent) => Promise<WatchEvalResult>) =>
  async () => ({ fired: true, eventText, observed: "obs" });
/** An evaluate() that never fires. */
const quiet: (w: WatchEvent) => Promise<WatchEvalResult> = async () => ({
  fired: false,
  eventText: "",
  observed: "obs",
});

function makeManager(
  store: WatchManagerStore,
  evaluate: (w: WatchEvent) => Promise<WatchEvalResult>,
  cbs: Partial<{
    onFire: (w: WatchEvent, t: string) => Promise<void>;
    onExpire: (w: WatchEvent) => Promise<void>;
    onStopped: (w: WatchEvent, r: string) => Promise<void>;
  }> = {}
) {
  return new WatchManager({
    store,
    evaluate,
    onFire: cbs.onFire ?? (async () => {}),
    onExpire: cbs.onExpire ?? (async () => {}),
    onStopped: cbs.onStopped ?? (async () => {}),
    logger: silentLogger,
  });
}

describe("WatchManager sweeper (#60)", () => {
  it("drain waits for an already-admitted evaluation", async () => {
    const { store } = makeStore([makeWatch()]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const m = makeManager(store, async () => {
      await gate;
      return { fired: false, eventText: "", observed: "x" };
    });
    const sweep = m.sweep();
    m.stop();
    let drained = false;
    const drain = m.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await Promise.all([sweep, drain]);
    expect(drained).toBe(true);
  });

  it("evaluates and fires via onFire, carrying the captured event text", async () => {
    const { store } = makeStore([makeWatch()]);
    const onFire = vi.fn(async () => {});
    const m = makeManager(store, fires("BUILD OK"), { onFire });
    await m.sweep();
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire.mock.calls[0]![1]).toBe("BUILD OK");
  });

  it("NEVER invokes the model to check — only evaluate() runs when quiet", async () => {
    const { store, deletes } = makeStore([makeWatch()]);
    const onFire = vi.fn(async () => {});
    const m = makeManager(store, quiet, { onFire });
    await m.sweep();
    expect(onFire).not.toHaveBeenCalled();
    expect(deletes).toEqual([]);
  });

  it("a 'once' watch is deleted before firing and cannot fire twice", async () => {
    const { store, deletes, rows } = makeStore([makeWatch({ mode: "once" })]);
    const onFire = vi.fn(async (w: WatchEvent) => {
      expect(rows.has(w.id)).toBe(false); // delete-before-fire
    });
    const m = makeManager(store, fires(), { onFire });
    await m.sweep();
    await m.sweep(); // row is gone — no second fire
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(deletes).toEqual(["w1"]);
  });

  it("does not evaluate a watch that is not yet due (interval not elapsed)", async () => {
    const recent = makeWatch({
      intervalSeconds: 300,
      lastCheckedUtc: new Date(Date.now() - 5_000).toISOString(), // checked 5s ago
    });
    const { store } = makeStore([recent]);
    const evaluate = vi.fn(fires());
    const m = makeManager(store, evaluate);
    await m.sweep();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("injects an expiry turn (D4) for a watch that expired without firing", async () => {
    const expired = makeWatch({
      expiresAtUtc: new Date(Date.now() - 1000).toISOString(),
      fireCount: 0,
    });
    const { store, deletes } = makeStore([expired]);
    const onExpire = vi.fn(async () => {});
    const onFire = vi.fn(async () => {});
    const m = makeManager(store, fires(), { onExpire, onFire });
    await m.sweep();
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(onFire).not.toHaveBeenCalled(); // expiry pre-empts firing
    expect(deletes).toEqual(["w1"]);
  });

  it("'each' mode re-fires up to maxFires, then stops with a notice", async () => {
    const { store, rows } = makeStore([makeWatch({ mode: "each", maxFires: 3 })]);
    const onFire = vi.fn(async () => {});
    const onStopped = vi.fn(async () => {});
    const m = makeManager(store, fires(), { onFire, onStopped });
    // Each sweep is one due-check → one fire. Reset lastChecked so it stays due.
    for (let n = 0; n < 5; n++) {
      const w = rows.get("w1");
      if (w) w.lastCheckedUtc = null;
      await m.sweep();
    }
    expect(onFire).toHaveBeenCalledTimes(3); // capped at maxFires
    expect(onStopped).toHaveBeenCalledTimes(1);
    expect(onStopped.mock.calls[0]![1]).toMatch(/maxFires/);
    expect(rows.has("w1")).toBe(false); // stopped ⇒ deleted
  });

  it("a rapidly-firing source is delivered as ONE turn per check (batching)", async () => {
    // A single evaluation returns all captured lines as one eventText → one turn.
    const multiline = async (): Promise<WatchEvalResult> => ({
      fired: true,
      eventText: "line1\nline2\nline3",
      observed: "obs",
    });
    const { store } = makeStore([makeWatch({ mode: "once" })]);
    const onFire = vi.fn(async () => {});
    const m = makeManager(store, multiline, { onFire });
    await m.sweep();
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire.mock.calls[0]![1]).toBe("line1\nline2\nline3");
  });

  it("stops a watch and posts a notice when the per-thread hourly cap is breached (D5)", async () => {
    // 40 'each' watches on one thread, each fires once this sweep. The 31st fire
    // for the thread trips the 30/hour cap and stops that watch with a notice.
    const watches = Array.from({ length: 40 }, (_, i) =>
      makeWatch({ id: `w${i}`, mode: "each", maxFires: 100, channelRef: "thread-hot" })
    );
    const { store } = makeStore(watches);
    const onFire = vi.fn(async () => {});
    const onStopped = vi.fn(async () => {});
    const m = makeManager(store, fires(), { onFire, onStopped });
    await m.sweep();
    expect(onFire).toHaveBeenCalledTimes(30); // capped at 30 fires/hour
    // The remaining 10 are each stopped with a rate-cap notice.
    expect(onStopped).toHaveBeenCalledTimes(10);
    expect(onStopped.mock.calls[0]![1]).toMatch(/rate cap/);
  });

  it("a privileged-source refusal stops the watch with a notice (D8 backstop)", async () => {
    const refuse = async (): Promise<WatchEvalResult> => ({
      fired: false,
      eventText: "",
      observed: null,
      refused: "command watches are disabled on this deployment",
    });
    const { store, deletes } = makeStore([makeWatch({ kind: "command", spec: "echo x" })]);
    const onStopped = vi.fn(async () => {});
    const onFire = vi.fn(async () => {});
    const m = makeManager(store, refuse, { onStopped, onFire });
    await m.sweep();
    expect(onFire).not.toHaveBeenCalled();
    expect(onStopped).toHaveBeenCalledTimes(1);
    expect(deletes).toEqual(["w1"]);
  });

  it("survives a transient check error without firing or deleting", async () => {
    const transient = async (): Promise<WatchEvalResult> => ({
      fired: false,
      eventText: "",
      observed: "obs",
      error: "network blip",
    });
    const { store, deletes, rows } = makeStore([makeWatch()]);
    const onFire = vi.fn(async () => {});
    const m = makeManager(store, transient, { onFire });
    await m.sweep();
    expect(onFire).not.toHaveBeenCalled();
    expect(deletes).toEqual([]);
    expect(rows.has("w1")).toBe(true); // still armed
  });
});

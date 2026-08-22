import { describe, it, expect, vi } from "vitest";
import { ParkedPromptManager } from "../packages/core/src/core/parked-prompts/manager.js";
import type { SessionStore } from "../packages/core/src/core/session-store.js";
import type { ParkedPrompt } from "../packages/core/src/core/parked-prompts/types.js";

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as any;

function makeParked(over: Partial<ParkedPrompt> = {}): ParkedPrompt {
  return {
    id: "park-1",
    platform: "discord",
    channelRef: "thread-1",
    parentRef: "channel-1",
    location: "mac",
    kind: "bridge_offline",
    prompt: "hello",
    authorId: "u1",
    authorName: "Jesse",
    noticeMessageId: "m1",
    attachments: [],
    createdUtc: "2026-08-18T00:00:00.000Z",
    ...over,
  };
}

function makeStore(initial: ParkedPrompt[]) {
  const rows = new Map(initial.map((p) => [p.id, p]));
  const deletes: string[] = [];
  const store = {
    listParked: () => [...rows.values()],
    listParkedByLocation: (location: string) =>
      [...rows.values()].filter((p) => p.location === location),
    deleteParked: (id: string) => {
      deletes.push(id);
      rows.delete(id);
    },
  } as unknown as SessionStore;
  return { store, rows, deletes };
}

function makeHub(opts: { ready: Set<string>; emit?: (fn: (id: string) => void) => void }) {
  const listeners: Array<(id: string) => void> = [];
  opts.emit?.( (id) => {
    for (const l of listeners) l(id);
  });
  return {
    isBridgeReady: (id: string) => opts.ready.has(id),
    onBridgeReady: (listener: (bridgeId: string) => void) => {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
  };
}

describe("ParkedPromptManager (#88)", () => {
  it("deletes the row before onFire (no double delivery)", async () => {
    const parked = makeParked();
    const { store, rows, deletes } = makeStore([parked]);
    const onFire = vi.fn(async (p: ParkedPrompt) => {
      expect(rows.has(p.id)).toBe(false);
    });
    const m = new ParkedPromptManager({
      store,
      hub: makeHub({ ready: new Set(["mac"]) }),
      onFire,
      logger: silentLogger,
    });
    await m.fireLocation("mac");
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(deletes).toEqual(["park-1"]);
  });

  it("does not fire when the host is not ready", async () => {
    const { store, deletes } = makeStore([makeParked()]);
    const onFire = vi.fn(async () => {});
    const m = new ParkedPromptManager({
      store,
      hub: makeHub({ ready: new Set() }),
      onFire,
      logger: silentLogger,
    });
    await m.fireLocation("mac");
    expect(onFire).not.toHaveBeenCalled();
    expect(deletes).toEqual([]);
  });

  it("rehydrate fires only rows whose host is already ready", async () => {
    const { store } = makeStore([
      makeParked({ id: "a", channelRef: "t1", location: "mac" }),
      makeParked({ id: "b", channelRef: "t2", location: "office" }),
    ]);
    const fired: string[] = [];
    const m = new ParkedPromptManager({
      store,
      hub: makeHub({ ready: new Set(["mac"]) }),
      onFire: async (p) => {
        fired.push(p.id);
      },
      logger: silentLogger,
    });
    await m.rehydrate();
    expect(fired).toEqual(["a"]);
  });

  it("onBridgeReady delivers parked rows for that host", async () => {
    const { store } = makeStore([makeParked()]);
    let emit!: (id: string) => void;
    const hub = makeHub({
      ready: new Set(),
      emit: (fn) => {
        emit = fn;
      },
    });
    const fired: string[] = [];
    const m = new ParkedPromptManager({
      store,
      hub: {
        isBridgeReady: (id) => id === "mac",
        onBridgeReady: hub.onBridgeReady,
      },
      onFire: async (p) => {
        fired.push(p.id);
      },
      logger: silentLogger,
    });
    m.start();
    emit("mac");
    await new Promise((r) => setImmediate(r));
    expect(fired).toEqual(["park-1"]);
    m.stop();
  });

  it("does not fire a row whose thread is still busy (#89)", async () => {
    const parked = makeParked({ kind: "user_queue" });
    const { store, rows, deletes } = makeStore([parked]);
    const onFire = vi.fn(async () => {});
    const m = new ParkedPromptManager({
      store,
      hub: makeHub({ ready: new Set(["mac"]) }),
      onFire,
      logger: silentLogger,
      isChannelBusy: (id) => id === "thread-1",
    });
    await m.fireLocation("mac");
    expect(onFire).not.toHaveBeenCalled();
    expect(deletes).toEqual([]);
    expect([...rows.keys()]).toEqual(["park-1"]);
  });

  it("fires a busy-skipped row once the thread is free", async () => {
    const parked = makeParked({ kind: "user_queue" });
    const { store } = makeStore([parked]);
    const busy = new Set(["thread-1"]);
    const fired: string[] = [];
    const m = new ParkedPromptManager({
      store,
      hub: makeHub({ ready: new Set(["mac"]) }),
      onFire: async (p) => {
        fired.push(p.id);
      },
      logger: silentLogger,
      isChannelBusy: (id) => busy.has(id),
    });
    await m.fireLocation("mac");
    expect(fired).toEqual([]);
    busy.delete("thread-1");
    await m.fireLocation("mac");
    expect(fired).toEqual(["park-1"]);
  });

  it("skips a second overlapping fireLocation for the same host", async () => {
    const parked = makeParked();
    const { store } = makeStore([parked]);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started = 0;
    const m = new ParkedPromptManager({
      store,
      hub: makeHub({ ready: new Set(["mac"]) }),
      onFire: async () => {
        started += 1;
        await gate;
      },
      logger: silentLogger,
    });
    const first = m.fireLocation("mac");
    await new Promise((r) => setImmediate(r));
    await m.fireLocation("mac");
    release();
    await first;
    expect(started).toBe(1);
  });
});

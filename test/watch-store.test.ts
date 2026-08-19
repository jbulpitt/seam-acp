import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import type { WatchEvent } from "../packages/core/src/core/watch/types.js";

let dir: string;
let store: SessionStore;

function makeWatch(over: Partial<WatchEvent> = {}): WatchEvent {
  const now = Date.now();
  return {
    id: "watch-1",
    platform: "discord",
    channelRef: "thread-1",
    parentRef: "channel-1",
    kind: "file",
    spec: "/tmp/build.done",
    match: null,
    intervalSeconds: 30,
    prompt: "the build finished — resume",
    reason: "wait for CI",
    mode: "once",
    maxFires: 1,
    fireCount: 0,
    lastCheckedUtc: null,
    lastFiredUtc: null,
    lastObserved: null,
    expiresAtUtc: new Date(now + 3600_000).toISOString(),
    createdBy: "discord:thread-1",
    correlationId: null,
    createdUtc: new Date(now).toISOString(),
    ...over,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-watch-store-"));
  store = new SessionStore(path.join(dir, "test.db"));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("SessionStore watches (#60)", () => {
  it("upserts and reads back a watch", () => {
    const w = makeWatch();
    store.upsertWatch(w);
    expect(store.getWatch("watch-1")).toEqual(w);
  });

  it("returns null for a missing watch", () => {
    expect(store.getWatch("nope")).toBeNull();
  });

  it("persistence survives a reopen of the DB (redeploy)", () => {
    const w = makeWatch({ kind: "http", spec: "https://ci/status", match: "status:200" });
    store.upsertWatch(w);
    store.close();
    store = new SessionStore(path.join(dir, "test.db"));
    expect(store.getWatch("watch-1")).toEqual(w);
  });

  it("listAllWatches returns every watch oldest-first (the sweeper work list)", () => {
    store.upsertWatch(makeWatch({ id: "a", channelRef: "thread-1" }));
    store.upsertWatch(makeWatch({ id: "b", channelRef: "thread-2" }));
    const ids = store.listAllWatches().map((w) => w.id);
    expect(ids).toEqual(["a", "b"]);
  });

  it("listWatchesByChannel is scoped to the thread (self-scope isolation)", () => {
    store.upsertWatch(makeWatch({ id: "a", channelRef: "thread-1" }));
    store.upsertWatch(makeWatch({ id: "b", channelRef: "thread-1" }));
    store.upsertWatch(makeWatch({ id: "c", channelRef: "thread-2" }));
    const rows = store.listWatchesByChannel("discord", "thread-1");
    expect(rows.map((w) => w.id).sort()).toEqual(["a", "b"]);
    expect(store.listWatchesByChannel("discord", "thread-2").map((w) => w.id)).toEqual(["c"]);
  });

  it("countWatchesByChannel counts only that thread", () => {
    store.upsertWatch(makeWatch({ id: "a", channelRef: "thread-1" }));
    store.upsertWatch(makeWatch({ id: "b", channelRef: "thread-1" }));
    store.upsertWatch(makeWatch({ id: "c", channelRef: "thread-2" }));
    expect(store.countWatchesByChannel("discord", "thread-1")).toBe(2);
    expect(store.countWatchesByChannel("discord", "thread-2")).toBe(1);
    expect(store.countWatchesByChannel("discord", "thread-3")).toBe(0);
  });

  it("markWatchChecked updates last-checked + observed without touching fires", () => {
    store.upsertWatch(makeWatch());
    store.markWatchChecked("watch-1", "2026-01-01T00:00:00.000Z", "exists:12:999");
    const w = store.getWatch("watch-1")!;
    expect(w.lastCheckedUtc).toBe("2026-01-01T00:00:00.000Z");
    expect(w.lastObserved).toBe("exists:12:999");
    expect(w.fireCount).toBe(0);
    expect(w.lastFiredUtc).toBeNull();
  });

  it("incrementWatchFire bumps the counter and stamps the fire time", () => {
    store.upsertWatch(makeWatch({ mode: "each", maxFires: 5 }));
    store.incrementWatchFire("watch-1", "2026-01-01T00:00:01.000Z");
    store.incrementWatchFire("watch-1", "2026-01-01T00:00:02.000Z");
    const w = store.getWatch("watch-1")!;
    expect(w.fireCount).toBe(2);
    expect(w.lastFiredUtc).toBe("2026-01-01T00:00:02.000Z");
  });

  it("deleteWatch removes the row (a stopped watch is really gone)", () => {
    store.upsertWatch(makeWatch());
    store.deleteWatch("watch-1");
    expect(store.getWatch("watch-1")).toBeNull();
    expect(store.countWatchesByChannel("discord", "thread-1")).toBe(0);
  });
});

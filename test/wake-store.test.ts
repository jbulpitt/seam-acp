import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../src/core/session-store.js";
import type { WakeEvent } from "../src/core/wake/types.js";

let dir: string;
let store: SessionStore;

function makeWake(over: Partial<WakeEvent> = {}): WakeEvent {
  const now = Date.now();
  return {
    id: "wake-1",
    platform: "discord",
    channelRef: "thread-1",
    parentRef: "channel-1",
    fireAtUtc: new Date(now + 20 * 60_000).toISOString(),
    prompt: "resume the reading summary",
    reason: "check back in 20m",
    createdBy: "discord:thread-1",
    correlationId: null,
    chainDepth: 0,
    catchupSeconds: 900,
    createdUtc: new Date(now).toISOString(),
    ...over,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-wake-store-"));
  store = new SessionStore(path.join(dir, "test.db"));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("SessionStore wake_events (#59)", () => {
  it("upserts and reads back a wake", () => {
    const w = makeWake();
    store.upsertWake(w);
    expect(store.getWake("wake-1")).toEqual(w);
  });

  it("returns null for a missing wake", () => {
    expect(store.getWake("nope")).toBeNull();
  });

  it("persistence survives a reopen of the DB (redeploy) ", () => {
    const w = makeWake();
    store.upsertWake(w);
    store.close();
    store = new SessionStore(path.join(dir, "test.db"));
    expect(store.getWake("wake-1")).toEqual(w);
  });

  it("listDueWakes returns only wakes at/before now, soonest first", () => {
    const past1 = makeWake({ id: "a", fireAtUtc: new Date(Date.now() - 60_000).toISOString() });
    const past2 = makeWake({ id: "b", fireAtUtc: new Date(Date.now() - 5_000).toISOString() });
    const future = makeWake({ id: "c", fireAtUtc: new Date(Date.now() + 60_000).toISOString() });
    store.upsertWake(future);
    store.upsertWake(past2);
    store.upsertWake(past1);
    const due = store.listDueWakes(new Date().toISOString());
    expect(due.map((w) => w.id)).toEqual(["a", "b"]);
  });

  it("listWakesByChannel is scoped to the thread and ordered by fire time", () => {
    store.upsertWake(makeWake({ id: "a", channelRef: "thread-1", fireAtUtc: new Date(Date.now() + 2000).toISOString() }));
    store.upsertWake(makeWake({ id: "b", channelRef: "thread-1", fireAtUtc: new Date(Date.now() + 1000).toISOString() }));
    store.upsertWake(makeWake({ id: "c", channelRef: "thread-2" }));
    const rows = store.listWakesByChannel("discord", "thread-1");
    expect(rows.map((w) => w.id)).toEqual(["b", "a"]);
  });

  it("countPendingWakesByChannel counts only that thread", () => {
    store.upsertWake(makeWake({ id: "a", channelRef: "thread-1" }));
    store.upsertWake(makeWake({ id: "b", channelRef: "thread-1" }));
    store.upsertWake(makeWake({ id: "c", channelRef: "thread-2" }));
    expect(store.countPendingWakesByChannel("discord", "thread-1")).toBe(2);
    expect(store.countPendingWakesByChannel("discord", "thread-2")).toBe(1);
    expect(store.countPendingWakesByChannel("discord", "thread-3")).toBe(0);
  });

  it("deleteWake removes the row", () => {
    store.upsertWake(makeWake());
    store.deleteWake("wake-1");
    expect(store.getWake("wake-1")).toBeNull();
    expect(store.countPendingWakesByChannel("discord", "thread-1")).toBe(0);
  });

  it("round-trips chain_depth and correlation_id", () => {
    const w = makeWake({ chainDepth: 3, correlationId: "corr-9" });
    store.upsertWake(w);
    const read = store.getWake("wake-1")!;
    expect(read.chainDepth).toBe(3);
    expect(read.correlationId).toBe("corr-9");
  });
});

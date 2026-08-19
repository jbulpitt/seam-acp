import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import type { WakeEvent } from "../packages/core/src/core/wake/types.js";

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
    fireOnStartup: false,
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

  // --- boot-triggered wakes (#59 extension) ---------------------------------

  it("round-trips fire_on_startup", () => {
    store.upsertWake(makeWake({ id: "s", fireOnStartup: true }));
    store.upsertWake(makeWake({ id: "t", fireOnStartup: false }));
    expect(store.getWake("s")!.fireOnStartup).toBe(true);
    expect(store.getWake("t")!.fireOnStartup).toBe(false);
  });

  it("EXCLUDES a startup wake from listDueWakes even when overdue", () => {
    // Nominal fireAtUtc well in the past — a time-based wake would be due, but a
    // startup wake waits for a boot, not the clock.
    store.upsertWake(
      makeWake({ id: "boot", fireOnStartup: true, fireAtUtc: new Date(Date.now() - 60_000).toISOString() })
    );
    store.upsertWake(
      makeWake({ id: "timed", fireOnStartup: false, fireAtUtc: new Date(Date.now() - 5_000).toISOString() })
    );
    const due = store.listDueWakes(new Date().toISOString());
    expect(due.map((w) => w.id)).toEqual(["timed"]);
  });

  it("listStartupWakes returns only fire_on_startup rows", () => {
    store.upsertWake(makeWake({ id: "boot1", fireOnStartup: true }));
    store.upsertWake(makeWake({ id: "boot2", fireOnStartup: true }));
    store.upsertWake(makeWake({ id: "timed", fireOnStartup: false }));
    expect(store.listStartupWakes().map((w) => w.id).sort()).toEqual(["boot1", "boot2"]);
  });

  it("startup wakes still count toward the per-thread pending cap", () => {
    store.upsertWake(makeWake({ id: "a", channelRef: "thread-1", fireOnStartup: true }));
    store.upsertWake(makeWake({ id: "b", channelRef: "thread-1", fireOnStartup: false }));
    expect(store.countPendingWakesByChannel("discord", "thread-1")).toBe(2);
  });

  it("migration is idempotent: re-opening the store doesn't error and keeps the column", () => {
    store.upsertWake(makeWake({ id: "s", fireOnStartup: true }));
    store.close();
    // Re-open twice — the PRAGMA-guarded ALTER must be a no-op both times.
    store = new SessionStore(path.join(dir, "test.db"));
    store.close();
    store = new SessionStore(path.join(dir, "test.db"));
    expect(store.getWake("s")!.fireOnStartup).toBe(true);
  });

  it("migration adds fire_on_startup to a legacy DB that lacks it (no data loss)", () => {
    // Simulate a prod DB whose wake_events predates the column: drop it, insert
    // a legacy row, then re-open so the guarded migration runs.
    store.close();
    const raw = new Database(path.join(dir, "test.db"));
    raw.exec("ALTER TABLE wake_events DROP COLUMN fire_on_startup");
    raw
      .prepare(
        `INSERT INTO wake_events
           (id, platform, channel_ref, parent_ref, fire_at_utc, prompt, reason,
            created_by, correlation_id, chain_depth, catchup_seconds, created_utc)
         VALUES ('legacy','discord','thread-1',NULL,'2020-01-01T00:00:00.000Z',
                 'p','r','discord:thread-1',NULL,0,900,'2020-01-01T00:00:00.000Z')`
      )
      .run();
    raw.close();

    store = new SessionStore(path.join(dir, "test.db"));
    const read = store.getWake("legacy")!;
    expect(read).not.toBeNull();
    expect(read.prompt).toBe("p"); // pre-existing data preserved
    expect(read.fireOnStartup).toBe(false); // new column defaults to 0
  });
});

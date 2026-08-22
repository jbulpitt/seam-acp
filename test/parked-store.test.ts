import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import type { ParkedPrompt } from "../packages/core/src/core/parked-prompts/types.js";

let dir: string;
let store: SessionStore;

function makeParked(over: Partial<ParkedPrompt> = {}): ParkedPrompt {
  return {
    id: "park-1",
    platform: "discord",
    channelRef: "thread-1",
    parentRef: "channel-1",
    location: "mac",
    kind: "bridge_offline",
    prompt: "continue the doc when you're back",
    authorId: "user-1",
    authorName: "Jesse",
    noticeMessageId: "msg-1",
    attachments: [{ filename: "note.txt", mime: "text/plain", size: 12 }],
    createdUtc: "2026-08-18T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-parked-store-"));
  store = new SessionStore(path.join(dir, "test.db"));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("SessionStore parked_prompts (#88)", () => {
  it("upserts and reads back a parked prompt", () => {
    const p = makeParked();
    store.upsertParked(p);
    expect(store.getParked("park-1")).toEqual(p);
    expect(store.getParkedByChannel("discord", "thread-1")).toEqual(p);
  });

  it("returns null for a missing row", () => {
    expect(store.getParked("nope")).toBeNull();
    expect(store.getParkedByChannel("discord", "nope")).toBeNull();
  });

  it("persists across a reopen (redeploy)", () => {
    store.upsertParked(makeParked());
    store.close();
    store = new SessionStore(path.join(dir, "test.db"));
    expect(store.getParked("park-1")?.prompt).toBe("continue the doc when you're back");
    expect(store.getParked("park-1")?.attachments).toEqual([
      { filename: "note.txt", mime: "text/plain", size: 12 },
    ]);
  });

  it("enforces one row per thread — latest write wins", () => {
    store.upsertParked(makeParked({ id: "old", prompt: "first" }));
    store.upsertParked(makeParked({ id: "new", prompt: "second", noticeMessageId: "msg-2" }));
    expect(store.getParked("old")).toBeNull();
    expect(store.getParkedByChannel("discord", "thread-1")?.id).toBe("new");
    expect(store.getParkedByChannel("discord", "thread-1")?.prompt).toBe("second");
    expect(store.listParked()).toHaveLength(1);
  });

  it("listParkedByLocation is scoped to that host", () => {
    store.upsertParked(makeParked({ id: "a", channelRef: "t1", location: "mac" }));
    store.upsertParked(makeParked({ id: "b", channelRef: "t2", location: "mac" }));
    store.upsertParked(makeParked({ id: "c", channelRef: "t3", location: "office" }));
    expect(store.listParkedByLocation("mac").map((p) => p.id).sort()).toEqual(["a", "b"]);
    expect(store.countParkedByLocation("mac")).toBe(2);
    expect(store.countParkedByLocation("office")).toBe(1);
    expect(store.countParkedByLocation("none")).toBe(0);
  });

  it("deleteParkedByChannel returns the row and removes it", () => {
    store.upsertParked(makeParked());
    const gone = store.deleteParkedByChannel("discord", "thread-1");
    expect(gone?.id).toBe("park-1");
    expect(store.getParkedByChannel("discord", "thread-1")).toBeNull();
    expect(store.deleteParkedByChannel("discord", "thread-1")).toBeNull();
  });

  it("deleteAllParked clears every row bot-wide", () => {
    store.upsertParked(makeParked({ id: "a", channelRef: "t1" }));
    store.upsertParked(makeParked({ id: "b", channelRef: "t2", location: "office" }));
    const rows = store.deleteAllParked();
    expect(rows).toHaveLength(2);
    expect(store.listParked()).toEqual([]);
  });

  it("persists kind user_queue vs bridge_offline (#89)", () => {
    store.upsertParked(makeParked({ id: "q", kind: "user_queue", prompt: "next" }));
    expect(store.getParked("q")?.kind).toBe("user_queue");
    store.close();
    store = new SessionStore(path.join(dir, "test.db"));
    expect(store.getParked("q")?.kind).toBe("user_queue");
  });

  it("corrupt attachments_json degrades to []", () => {
    store.upsertParked(makeParked({ attachments: [] }));
    const raw = new Database(path.join(dir, "test.db"));
    raw.prepare("UPDATE parked_prompts SET attachments_json = 'not-json' WHERE id = 'park-1'").run();
    raw.close();
    expect(store.getParked("park-1")?.attachments).toEqual([]);
  });
});

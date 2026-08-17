import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../src/core/session-store.js";
import { INBOX_MAX_PER_SESSION } from "../src/core/inbox/types.js";

let dir: string;
let store: SessionStore;

const OWNER = "discord:thread-owner";
const OTHER = "discord:thread-other";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-inbox-store-"));
  store = new SessionStore(path.join(dir, "test.db"));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("SessionStore inbox (#61)", () => {
  it("pushes a message and reads it back via listInbox (non-destructive)", () => {
    const stored = store.pushInbox(OWNER, "discord:thread-sender", "hello there");
    expect(stored.id).toBeTruthy();
    expect(stored.sessionRef).toBe(OWNER);
    expect(stored.fromRef).toBe("discord:thread-sender");
    expect(stored.body).toBe("hello there");

    const listed = store.listInbox(OWNER);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(stored);
    // listInbox does not consume — a second read still sees it.
    expect(store.listInbox(OWNER)).toHaveLength(1);
  });

  it("drainInbox returns all messages oldest-first and deletes them (deliver-once)", () => {
    store.pushInbox(OWNER, "a", "first");
    store.pushInbox(OWNER, "b", "second");
    store.pushInbox(OWNER, "c", "third");

    const drained = store.drainInbox(OWNER);
    expect(drained.map((m) => m.body)).toEqual(["first", "second", "third"]);
    expect(drained.map((m) => m.fromRef)).toEqual(["a", "b", "c"]);

    // Consumed — a second drain yields nothing.
    expect(store.drainInbox(OWNER)).toEqual([]);
    expect(store.countInbox(OWNER)).toBe(0);
  });

  it("drainInbox on an empty inbox returns an empty array", () => {
    expect(store.drainInbox(OWNER)).toEqual([]);
  });

  it("is self-scoped: a drain only touches the owning session's messages", () => {
    store.pushInbox(OWNER, "x", "for owner");
    store.pushInbox(OTHER, "y", "for other");

    const drained = store.drainInbox(OWNER);
    expect(drained.map((m) => m.body)).toEqual(["for owner"]);
    // The other session's message is untouched.
    expect(store.countInbox(OTHER)).toBe(1);
    expect(store.listInbox(OTHER)[0]!.body).toBe("for other");
  });

  it("countInbox reflects the queue size per session", () => {
    store.pushInbox(OWNER, null, "one");
    store.pushInbox(OWNER, null, "two");
    store.pushInbox(OTHER, null, "solo");
    expect(store.countInbox(OWNER)).toBe(2);
    expect(store.countInbox(OTHER)).toBe(1);
    expect(store.countInbox("discord:nobody")).toBe(0);
  });

  it("persistence survives a reopen of the DB (durability across restart)", () => {
    store.pushInbox(OWNER, "sender", "survive the restart");
    store.close();
    store = new SessionStore(path.join(dir, "test.db"));
    const drained = store.drainInbox(OWNER);
    expect(drained).toHaveLength(1);
    expect(drained[0]!.body).toBe("survive the restart");
  });

  it("enforces the per-session cap by dropping the oldest messages", () => {
    // Push one over the cap; the oldest (message 0) must be evicted.
    for (let i = 0; i < INBOX_MAX_PER_SESSION + 1; i++) {
      store.pushInbox(OWNER, null, `msg-${i}`);
    }
    expect(store.countInbox(OWNER)).toBe(INBOX_MAX_PER_SESSION);
    const bodies = store.listInbox(OWNER).map((m) => m.body);
    // Oldest dropped, newest retained, order preserved.
    expect(bodies[0]).toBe("msg-1");
    expect(bodies.at(-1)).toBe(`msg-${INBOX_MAX_PER_SESSION}`);
    expect(bodies).not.toContain("msg-0");
  });

  it("migration is idempotent: re-opening the store keeps queued messages", () => {
    store.pushInbox(OWNER, "s", "keep me");
    store.close();
    store = new SessionStore(path.join(dir, "test.db"));
    store.close();
    store = new SessionStore(path.join(dir, "test.db"));
    expect(store.listInbox(OWNER).map((m) => m.body)).toEqual(["keep me"]);
  });
});

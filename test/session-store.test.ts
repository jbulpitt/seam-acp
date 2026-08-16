import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SessionStore,
  makeSessionId,
} from "../src/core/session-store.js";
import type { SessionRecord } from "../src/core/types.js";

let dir: string;
let store: SessionStore;

const sample = (): SessionRecord => ({
  id: makeSessionId("discord", "thread-1"),
  platform: "discord",
  channelRef: "thread-1",
  parentRef: "channel-1",
  agentId: "copilot",
  acpSessionId: "acp-abc",
  repoPath: "/tmp/r",
  configJson: JSON.stringify({ model: "gpt-5.4" }),
  createdUtc: new Date().toISOString(),
  updatedUtc: new Date().toISOString(),
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-store-"));
  store = new SessionStore(path.join(dir, "test.db"));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("SessionStore", () => {
  it("returns null for missing session", () => {
    expect(store.get("nope")).toBeNull();
    expect(store.getByChannel("discord", "nope")).toBeNull();
  });

  it("upserts and reads back", () => {
    const r = sample();
    store.upsert(r);
    expect(store.get(r.id)).toEqual(r);
    expect(store.getByChannel("discord", "thread-1")).toEqual(r);
  });

  it("upsert updates existing row", () => {
    const r = sample();
    store.upsert(r);
    const updated: SessionRecord = {
      ...r,
      repoPath: "/tmp/other",
      updatedUtc: new Date(Date.now() + 1000).toISOString(),
    };
    store.upsert(updated);
    expect(store.get(r.id)?.repoPath).toBe("/tmp/other");
  });

  it("list returns most recently updated first", () => {
    const a: SessionRecord = { ...sample(), id: "discord:a", channelRef: "a", updatedUtc: "2025-01-01T00:00:00Z" };
    const b: SessionRecord = { ...sample(), id: "discord:b", channelRef: "b", updatedUtc: "2026-01-01T00:00:00Z" };
    store.upsert(a);
    store.upsert(b);
    const list = store.list();
    expect(list.map((s) => s.id)).toEqual(["discord:b", "discord:a"]);
  });

  it("readConfig parses JSON, returns {} on bad data", () => {
    const r = sample();
    expect(store.readConfig(r)).toEqual({ model: "gpt-5.4" });
    const broken: SessionRecord = { ...r, configJson: "not json" };
    expect(store.readConfig(broken)).toEqual({});
  });

  it("writeConfig produces parseable JSON", () => {
    const json = store.writeConfig({ model: "claude-haiku-4.5" });
    expect(JSON.parse(json)).toEqual({ model: "claude-haiku-4.5" });
  });
});

describe("SessionStore active_projects (#22)", () => {
  const now = new Date().toISOString();

  it("returns null / false for an unknown channel", () => {
    expect(store.getActiveProject("nope")).toBeNull();
    expect(store.isChannelActive("nope")).toBe(false);
    expect(store.listActiveProjects()).toEqual([]);
  });

  it("upserts, reads back, and reports active", () => {
    store.upsertActiveProject({
      channelRef: "chan-1",
      enabled: true,
      configJson: JSON.stringify({ description: "docs channel" }),
      createdUtc: now,
      updatedUtc: now,
    });
    expect(store.getActiveProject("chan-1")).toEqual({
      channelRef: "chan-1",
      enabled: true,
      configJson: JSON.stringify({ description: "docs channel" }),
      createdUtc: now,
      updatedUtc: now,
    });
    expect(store.isChannelActive("chan-1")).toBe(true);
  });

  it("upsert on the same channel_ref updates in place (PK conflict)", () => {
    store.upsertActiveProject({ channelRef: "chan-1", enabled: true, configJson: null, createdUtc: now, updatedUtc: now });
    const later = new Date(Date.now() + 1000).toISOString();
    store.upsertActiveProject({ channelRef: "chan-1", enabled: true, configJson: JSON.stringify({ description: "x" }), createdUtc: now, updatedUtc: later });
    expect(store.listActiveProjects()).toHaveLength(1);
    expect(store.getActiveProject("chan-1")?.configJson).toBe(JSON.stringify({ description: "x" }));
  });

  it("setProjectEnabled(false) keeps the row but stops granting access", () => {
    store.upsertActiveProject({ channelRef: "chan-1", enabled: true, configJson: null, createdUtc: now, updatedUtc: now });
    store.setProjectEnabled("chan-1", false);
    expect(store.getActiveProject("chan-1")?.enabled).toBe(false);
    expect(store.isChannelActive("chan-1")).toBe(false);
    store.setProjectEnabled("chan-1", true);
    expect(store.isChannelActive("chan-1")).toBe(true);
  });

  it("removeActiveProject deletes the row", () => {
    store.upsertActiveProject({ channelRef: "chan-1", enabled: true, configJson: null, createdUtc: now, updatedUtc: now });
    store.removeActiveProject("chan-1");
    expect(store.getActiveProject("chan-1")).toBeNull();
    expect(store.isChannelActive("chan-1")).toBe(false);
  });

  it("listActiveProjects returns oldest-created first", () => {
    store.upsertActiveProject({ channelRef: "chan-b", enabled: true, configJson: null, createdUtc: "2026-01-01T00:00:00Z", updatedUtc: now });
    store.upsertActiveProject({ channelRef: "chan-a", enabled: false, configJson: null, createdUtc: "2025-01-01T00:00:00Z", updatedUtc: now });
    expect(store.listActiveProjects().map((p) => p.channelRef)).toEqual(["chan-a", "chan-b"]);
  });
});

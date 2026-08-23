import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SessionStore,
  makeSessionId,
} from "../packages/core/src/core/session-store.js";
import type { Preset, SessionRecord } from "../packages/core/src/core/types.js";
import type { ScheduledPrompt } from "../packages/core/src/core/scheduled-prompts/types.js";

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
    expect(store.countSessions()).toBe(2);
  });

  it("listSessionsByParent filters to one channel, newest first (#73)", () => {
    // Two threads under channel-1, one under channel-2, on different platforms.
    const t1: SessionRecord = { ...sample(), id: "discord:t1", channelRef: "t1", parentRef: "channel-1", updatedUtc: "2026-01-01T00:00:00Z" };
    const t2: SessionRecord = { ...sample(), id: "discord:t2", channelRef: "t2", parentRef: "channel-1", updatedUtc: "2026-02-01T00:00:00Z" };
    const other: SessionRecord = { ...sample(), id: "discord:o", channelRef: "o", parentRef: "channel-2", updatedUtc: "2026-03-01T00:00:00Z" };
    const slack: SessionRecord = { ...sample(), id: "slack:s", platform: "slack", channelRef: "s", parentRef: "channel-1", updatedUtc: "2026-04-01T00:00:00Z" };
    store.upsert(t1);
    store.upsert(t2);
    store.upsert(other);
    store.upsert(slack);
    const list = store.listSessionsByParent("discord", "channel-1");
    // Only discord threads under channel-1, newest-updated first.
    expect(list.map((s) => s.id)).toEqual(["discord:t2", "discord:t1"]);
  });

  it("listSessionsByParent surfaces a quiet-but-bound thread past a global newest-N cap (#73)", () => {
    // The quiet thread under channel-1 predates 100 newer sessions in OTHER
    // channels. A list(100)+in-memory filter would lose it; the SQL query keeps it.
    const quiet: SessionRecord = { ...sample(), id: "discord:quiet", channelRef: "quiet", parentRef: "channel-1", updatedUtc: "2020-01-01T00:00:00Z" };
    store.upsert(quiet);
    for (let i = 0; i < 120; i++) {
      store.upsert({ ...sample(), id: `discord:n${i}`, channelRef: `n${i}`, parentRef: "other-channel", updatedUtc: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z` });
    }
    // list(100) drops the quiet thread (it's not in the newest 100 globally)...
    expect(store.list(100).some((s) => s.id === "discord:quiet")).toBe(false);
    // ...but the per-channel query still finds it.
    const list = store.listSessionsByParent("discord", "channel-1");
    expect(list.map((s) => s.id)).toContain("discord:quiet");
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

describe("SessionStore project-scoped presets (#21)", () => {
  const now = new Date().toISOString();

  const preset = (over: Partial<Preset> & { id: string; name: string }): Preset => ({
    projectRef: null,
    description: null,
    agentId: null,
    model: null,
    effort: null,
    repoPath: null,
    permission: null,
    toolsAllow: null,
    toolsExclude: null,
    instructions: null,
    statusCardStyle: null,
    createdBy: "u1",
    createdUtc: now,
    updatedUtc: now,
    ...over,
  });

  it("round-trips projectRef (scoped and global)", () => {
    store.upsertPreset(preset({ id: "p1", name: "deploy", projectRef: "projA" }));
    store.upsertPreset(preset({ id: "p2", name: "review", projectRef: null }));
    expect(store.getPreset("p1")?.projectRef).toBe("projA");
    expect(store.getPreset("p2")?.projectRef).toBeNull();
  });

  it("a project preset beats a global of the same name", () => {
    store.upsertPreset(preset({ id: "g", name: "build", projectRef: null, model: "global-model" }));
    store.upsertPreset(preset({ id: "a", name: "build", projectRef: "projA", model: "projA-model" }));
    const hit = store.getPresetByNameScoped("build", "projA");
    expect(hit?.id).toBe("a");
    expect(hit?.model).toBe("projA-model");
  });

  it("falls back to the global preset when the project has none of that name", () => {
    store.upsertPreset(preset({ id: "g", name: "build", projectRef: null, model: "global-model" }));
    const hit = store.getPresetByNameScoped("build", "projB");
    expect(hit?.id).toBe("g");
    // No project context at all → still resolves the global.
    expect(store.getPresetByNameScoped("build", null)?.id).toBe("g");
  });

  it("returns null when neither a scoped nor a global match exists", () => {
    store.upsertPreset(preset({ id: "a", name: "build", projectRef: "projA" }));
    expect(store.getPresetByNameScoped("build", "projB")).toBeNull();
    expect(store.getPresetByNameScoped("missing", "projA")).toBeNull();
  });

  it("resolves an explicit qualified `proj/name` reference", () => {
    store.upsertPreset(preset({ id: "a", name: "build", projectRef: "projA", model: "a-model" }));
    store.upsertPreset(preset({ id: "b", name: "build", projectRef: "projB", model: "b-model" }));
    // From projB, reach projA's preset by qualifying the name.
    const hit = store.getPresetByNameScoped("projA/build", "projB");
    expect(hit?.id).toBe("a");
    expect(hit?.model).toBe("a-model");
  });

  it("a qualified ref falls back to global when that project lacks the name", () => {
    store.upsertPreset(preset({ id: "g", name: "build", projectRef: null }));
    // projA has no `build`; the global one answers the qualified lookup.
    expect(store.getPresetByNameScoped("projA/build", "projA")?.id).toBe("g");
  });

  it("two projects reuse the same short name independently", () => {
    store.upsertPreset(preset({ id: "a", name: "ship", projectRef: "projA", model: "a-model" }));
    store.upsertPreset(preset({ id: "b", name: "ship", projectRef: "projB", model: "b-model" }));
    expect(store.getPresetByNameScoped("ship", "projA")?.model).toBe("a-model");
    expect(store.getPresetByNameScoped("ship", "projB")?.model).toBe("b-model");
  });

  it("rejects a duplicate name within the same scope (unique per scope)", () => {
    store.upsertPreset(preset({ id: "a1", name: "same", projectRef: "projA" }));
    expect(() =>
      store.upsertPreset(preset({ id: "a2", name: "same", projectRef: "projA" }))
    ).toThrow();
    // Case-insensitively, too.
    expect(() =>
      store.upsertPreset(preset({ id: "a3", name: "SAME", projectRef: "projA" }))
    ).toThrow();
  });

  it("allows the same name globally and per-project side by side", () => {
    store.upsertPreset(preset({ id: "g", name: "same", projectRef: null }));
    expect(() =>
      store.upsertPreset(preset({ id: "a", name: "same", projectRef: "projA" }))
    ).not.toThrow();
  });

  it("listPresetsForProject returns project + global, scoped first", () => {
    store.upsertPreset(preset({ id: "g", name: "build", projectRef: null }));
    store.upsertPreset(preset({ id: "a", name: "build", projectRef: "projA" }));
    store.upsertPreset(preset({ id: "other", name: "zeta", projectRef: "projB" }));
    const forA = store.listPresetsForProject("projA");
    // projB's preset is excluded; projA's `build` sorts before the global `build`.
    expect(forA.map((p) => p.id)).toEqual(["a", "g"]);
    // Null scope → globals only.
    expect(store.listPresetsForProject(null).map((p) => p.id)).toEqual(["g"]);
  });

  it("getPresetByName prefers the global when a name repeats across scopes", () => {
    store.upsertPreset(preset({ id: "a", name: "build", projectRef: "projA" }));
    store.upsertPreset(preset({ id: "g", name: "build", projectRef: null }));
    expect(store.getPresetByName("build")?.id).toBe("g");
  });

  it("round-trips statusCardStyle (#96)", () => {
    store.upsertPreset(preset({ id: "p1", name: "quiet", statusCardStyle: "simple" }));
    store.upsertPreset(preset({ id: "p2", name: "loud", statusCardStyle: "full" }));
    store.upsertPreset(preset({ id: "p3", name: "plain" }));
    expect(store.getPreset("p1")?.statusCardStyle).toBe("simple");
    expect(store.getPreset("p2")?.statusCardStyle).toBe("full");
    expect(store.getPreset("p3")?.statusCardStyle).toBeNull();
  });
});

describe("SessionStore — scheduled prompts (sessionMode)", () => {
  const schedule = (over: Partial<ScheduledPrompt> = {}): ScheduledPrompt => ({
    id: "sch_1",
    platform: "discord",
    channelRef: "thread-1",
    parentRef: "channel-1",
    name: "nightly",
    promptText: "run the tests",
    cron: "0 9 * * *",
    timezone: "America/Chicago",
    model: null,
    cwd: null,
    targetChannel: null,
    outputType: "card",
    sessionMode: "isolated",
    catchupSeconds: 900,
    enabled: true,
    attachments: [],
    createdBy: "user-1",
    createdUtc: new Date().toISOString(),
    updatedUtc: new Date().toISOString(),
    lastRunUtc: null,
    lastStatus: null,
    nextRunUtc: null,
    pinnedSessionId: null,
    ...over,
  });

  it("round-trips both session modes on insert", () => {
    const iso = schedule({ id: "iso" });
    const live = schedule({ id: "live", sessionMode: "live" });
    store.upsertScheduled(iso);
    store.upsertScheduled(live);
    expect(store.getScheduled("iso")).toEqual(iso);
    expect(store.getScheduled("live")).toEqual(live);
  });

  it("persists session_mode through the ON CONFLICT update path", () => {
    const s = schedule({ id: "flip", sessionMode: "isolated" });
    store.upsertScheduled(s);
    expect(store.getScheduled("flip")?.sessionMode).toBe("isolated");
    // Same id → hits ON CONFLICT DO UPDATE. If session_mode were omitted from the
    // SET clause this edit would silently keep the old value.
    store.upsertScheduled({ ...s, sessionMode: "live", updatedUtc: new Date(Date.now() + 1000).toISOString() });
    expect(store.getScheduled("flip")?.sessionMode).toBe("live");
    // …and back again.
    store.upsertScheduled({ ...s, sessionMode: "isolated", updatedUtc: new Date(Date.now() + 2000).toISOString() });
    expect(store.getScheduled("flip")?.sessionMode).toBe("isolated");
  });

  it("mapScheduled narrows unknown/legacy session_mode to isolated", () => {
    store.upsertScheduled(schedule({ id: "narrow", sessionMode: "live" }));
    // Poke raw values a live process could never write (garbage / legacy NULL from
    // a pre-migration row) via a second connection, then confirm the read narrows.
    const raw = new Database(path.join(dir, "test.db"));
    const set = (v: string | null) =>
      raw.prepare("UPDATE scheduled_prompts SET session_mode = ? WHERE id = 'narrow'").run(v);

    set("garbage");
    expect(store.getScheduled("narrow")?.sessionMode).toBe("isolated");
    // Sanity: the one legitimate non-default value still survives the round trip.
    set("live");
    expect(store.getScheduled("narrow")?.sessionMode).toBe("live");
    raw.close();
  });

  it("defaults an existing row with no session_mode column to isolated", () => {
    // Simulate a pre-migration DB: drop the column the schema/migration adds, then
    // reopen through SessionStore (which re-runs the defensive column-add) and read.
    store.upsertScheduled(schedule({ id: "legacy", sessionMode: "live" }));
    store.close();
    const raw = new Database(path.join(dir, "test.db"));
    raw.exec("ALTER TABLE scheduled_prompts DROP COLUMN session_mode");
    raw.close();
    store = new SessionStore(path.join(dir, "test.db"));
    expect(store.getScheduled("legacy")?.sessionMode).toBe("isolated");
  });
});

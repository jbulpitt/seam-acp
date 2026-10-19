import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { TurnAttemptStore } from "../packages/core/src/core/dispatch/attempt-store.js";
import { listSiblingThreadEntries } from "../packages/core/src/core/mcp/thread-inventory.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import type { AutocompleteRegistry } from "../packages/core/src/platforms/discord/autocomplete.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { testSessionRouter } from "./helpers/session-fixture.js";

const logger = pino({ level: "silent" }) as unknown as Logger;
const now = "2026-10-19T12:52:00.000Z";
let dir: string;
let store: SessionStore;
let db: Database.Database;
let host: Orchestrator;
let channels: string[];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "seam-queue-diagnostics-"));
  store = new SessionStore(path.join(dir, "seam.db"));
  db = (store as unknown as { db: Database.Database }).db;
  const insert = db.prepare(`INSERT INTO turn_attempts
    (id,generation,owner_boot,state,identity,spec_json,updated_utc,delivery_done)
    VALUES (?,1,'old-boot','completed','identity',?,?,1)`);
  db.transaction(() => {
    const spec = JSON.stringify({ target: "historical", session: "live", prompt: "x".repeat(2048) });
    for (let i = 0; i < 5000; i++) insert.run(`history-${i}`, spec, now);
  })();
  channels = Array.from({ length: 46 }, (_, i) => `thread-${i}`);
  for (const channelRef of channels) {
    store.upsert({ id: `discord:${channelRef}`, platform: "discord", channelRef,
      parentRef: "project", agentId: "codex", acpSessionId: "", repoPath: "/repo",
      configJson: "{}", createdUtc: now, updatedUtc: now });
    store.turnAttempts.admit({ id: `pending-${channelRef}`, target: channelRef, session: "live", prompt: "work" });
  }
  host = new Orchestrator({
    logger, store, modelCatalog: fixtureModelCatalog([]),
    config: { DATA_DIR: dir, REPOS_ROOT: "/repo", CHANNEL_QUEUE_WEDGE_GRACE_SECONDS: 30,
      channelPresets: new Map(), threadPresets: new Map(), bridgePresets: new Map() } as never,
    router: testSessionRouter({ isBusy: () => false, listProfiles: () => [],
      describeConfig: () => ({ agent: { value: "codex" }, model: { value: "default" },
        effort: { value: null }, cwd: { value: "/repo" } }) }) as never,
    adapter: {} as never, renderer: {} as never,
  });
  await host.loadPlugins();
});

afterEach(async () => {
  vi.restoreAllMocks();
  store.close();
  await rm(dir, { recursive: true, force: true });
});

function attemptReads() {
  const prepare = vi.spyOn(db, "prepare");
  return () => prepare.mock.calls.map(([sql]) => sql)
    .filter(sql => /^\s*SELECT\b/i.test(sql) && /\bturn_attempts\b/i.test(sql));
}

function observeYield() {
  const inspect = vi.spyOn(host, "inspectChannelQueue");
  const observed = new Promise<number>(resolve => setImmediate(() => resolve(inspect.mock.calls.length)));
  return async () => {
    const count = await observed;
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(channels.length);
  };
}

async function inventory() {
  const deps = {
    listSessionsByParent: (platform: string, parent: string) => store.listSessionsByParent(platform, parent),
    describeConfig: () => ({ agent: { value: "codex" }, model: { value: "default" },
      effort: { value: null }, cwd: { value: "/repo" } }) as never,
    isRuntimeBusy: () => false, adapter: {},
    inspectQueue: (ref: string) => host.inspectChannelQueue(ref),
    inspectWorkProgress: (ref: string, at: number, queue: ReturnType<Orchestrator["inspectChannelQueue"]>) =>
      host.inspectThreadWorkProgress(ref, at, queue),
    inspectChannels: (refs: readonly string[]) => (host as any).inspectChannelQueues(refs),
    locationFor: () => ({ location: "local", hostEmoji: "" }),
  };
  return listSiblingThreadEntries(store.get(`discord:${channels[0]}`)!, deps);
}

describe("queue diagnostics scale with current work, not siblings times history", () => {
  it("reads attempt rows a bounded number of times for a 46-sibling inventory", async () => {
    const reads = attemptReads();
    const entries = await inventory();
    expect(entries).toHaveLength(channels.length);
    expect(entries.every(entry => entry.workProgress?.queuedDispatchIds.length === 1)).toBe(true);
    expect(reads()).toHaveLength(2);
  });

  it("yields a macrotask before the inventory has inspected every sibling", async () => {
    const check = observeYield();
    await inventory();
    await check();
  });

  it("reads once and yields during a queue sweep without fencing any owner", async () => {
    Object.assign(host, { channelQueueMeta: new Map(channels.map(ref => [ref,
      { epoch: 0, queued: 1, runtimeIdleSinceMs: Date.now() - 60_000 }])) });
    const reads = attemptReads();
    const check = observeYield();
    expect(await host.sweepWedgedQueues()).toHaveLength(channels.length);
    expect(reads()).toHaveLength(2);
    await check();
    expect(channels.every(ref => host.inspectChannelQueue(ref).epoch === 0)).toBe(true);
  });

  it.each(["steer", "recover"])("batches and yields in %s autocomplete", async subcommand => {
    const autocomplete = (host as unknown as { autocomplete: AutocompleteRegistry }).autocomplete;
    const responder = autocomplete.get(null, subcommand, "thread")!;
    const reads = attemptReads();
    const check = observeYield();
    const choices = await responder({ group: null, subcommand, optionName: "thread",
      focusedValue: "", projectScopeId: "project" });
    expect(choices.length).toBeGreaterThan(0);
    expect(reads()).toHaveLength(2);
    await check();
  });

  it("migrates existing ledgers to selective state and unsettled indexes", () => {
    db.exec("DROP INDEX IF EXISTS idx_turn_attempt_state_id; DROP INDEX IF EXISTS idx_turn_attempt_unsettled");
    new TurnAttemptStore(db);
    const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
      .map(row => row.detail).join("\n");
    expect(plan("SELECT id FROM turn_attempts WHERE state='suspended' ORDER BY id"))
      .toMatch(/SEARCH .*USING (?:COVERING )?INDEX idx_turn_attempt_state_id/);
    expect(plan(`SELECT * FROM turn_attempts WHERE state='completed' AND delivery_done=0
      AND delivery_abandoned_reason IS NULL AND delivery_uncertain_reason IS NULL ORDER BY updated_utc,id`))
      .toMatch(/USING INDEX idx_turn_attempt_unsettled/);
  });
});

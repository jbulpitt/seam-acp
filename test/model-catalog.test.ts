import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  catalogScopeFingerprint,
  type AdapterCatalogCandidate,
  type CatalogModel,
} from "@seam/adapters";
import { ModelCatalogService } from "../packages/core/src/core/model-catalog/service.js";
import { ModelCatalogStore } from "../packages/core/src/core/model-catalog/store.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { catalogEffortChoices } from "../packages/core/src/platforms/discord/orchestrator.js";
import type { AgentProfile } from "@seam/adapters";

const logger = pino({ level: "silent" }) as unknown as Logger;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function db(): { dir: string; file: string; store: ModelCatalogStore } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-model-catalog-"));
  dirs.push(dir);
  const file = path.join(dir, "seam.db");
  return { dir, file, store: new ModelCatalogStore(file) };
}

function model(id: string, over: Partial<CatalogModel> = {}): CatalogModel {
  const choices = over.effort?.choices ?? [
    { id: "swift", raw: "SPEED::1" },
    { id: "deliberate", raw: "THINK::9000" },
  ];
  const effort = over.effort ?? {
    mechanism: "configOption" as const,
    configId: "cognition.mode/v9",
    choices,
    selectionDefault: "deliberate",
  };
  return {
    id,
    runtimeId: `vendor::${id}@2026`,
    displayName: `Odd ${id}`,
    aliases: [`alias-${id}`],
    default: id === "nebula",
    context: { native: 777_777, maximum: 888_888, effective: 700_000 },
    modalities: { input: ["text", "image"], output: ["text"] },
    visionMode: "native",
    availability: "available",
    lifecycle: "stable",
    serviceTiers: ["strange"],
    effort,
    pricingCategory: "purple",
    compatibility: "fake-v9",
    applicationMode: "live",
    bindings: choices.map((choice) => ({
      model: id,
      effort: choice.id,
      rawModel: `vendor::${id}@2026`,
      rawEffort: choice.raw,
    })),
    ...over,
  };
}

function candidate(ids = ["nebula"], provider = "architectural-outlier"): AdapterCatalogCandidate {
  return {
    schemaVersion: 1,
    scope: {
      fingerprint: catalogScopeFingerprint({ provider, credentialProfile: "fixture-account" }),
      provider,
      credentialProfile: "fixture-account",
    },
    models: ids.map((id) => model(id, { default: id === ids[0] })),
    source: "fake-adapter-probe",
    sourceVersion: "catalog/v17",
    adapterVersion: 91,
    cliVersion: "fake-cli 2031.4",
    fetchedAt: "2026-09-08T12:00:00.000Z",
  };
}

function service(opts: {
  store: ModelCatalogStore;
  fetch: (binding: { agentId: string; location: string }) => Promise<AdapterCatalogCandidate>;
  bindings?: Array<{ agentId: string; location: string }>;
  online?: (binding: { agentId: string; location: string }) => boolean;
  scope?: (binding: { agentId: string; location: string }) => AdapterCatalogCandidate["scope"];
}) {
  return new ModelCatalogService({
    store: opts.store,
    logger,
    bindings: () => opts.bindings ?? [{ agentId: "fake", location: "local" }],
    ...(opts.scope ? { scope: opts.scope } : {}),
    fetch: opts.fetch,
    isOnline: opts.online,
    refreshCron: "0 0 1 1 *",
  });
}

describe("ModelCatalogService", () => {
  it("renders adapter-defined effort names without a core allowlist", () => {
    expect(catalogEffortChoices(["astronomical", "low", "default"])).toEqual([
      expect.objectContaining({ value: "low", label: "Low" }),
      expect.objectContaining({ value: "astronomical", label: "astronomical" }),
      expect.objectContaining({ value: "default", label: "Default" }),
    ]);
  });

  it("migrates pre-version observation tables in place", () => {
    const opened = db();
    opened.store.close();
    const sqlite = new Database(opened.file);
    sqlite.exec("DROP TABLE model_catalog_observations; CREATE TABLE model_catalog_observations (binding_key TEXT PRIMARY KEY, agent_id TEXT NOT NULL, location TEXT NOT NULL, scope_key TEXT NOT NULL, checksum TEXT NOT NULL, adapter_version INTEGER NOT NULL, cli_version TEXT, source TEXT NOT NULL, fetched_at TEXT NOT NULL, drift TEXT)");
    sqlite.close();
    const migrated = new ModelCatalogStore(opened.file);
    migrated.close();
    const check = new Database(opened.file, { readonly: true });
    const columns = check.prepare("PRAGMA table_info(model_catalog_observations)").all() as Array<{ name: string }>;
    check.close();
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "schema_version", "source_version",
    ]));
  });

  it("migrates checksum-deduplicated generations without losing the active snapshot", () => {
    const opened = db();
    opened.store.close();
    const sqlite = new Database(opened.file);
    sqlite.exec(`
      DROP TABLE model_catalog_scopes;
      DROP TABLE model_catalog_generations;
      CREATE TABLE model_catalog_generations (
        generation INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_key TEXT NOT NULL,
        checksum TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        published_at TEXT NOT NULL,
        UNIQUE(scope_key, checksum)
      );
      CREATE TABLE model_catalog_scopes (
        scope_key TEXT PRIMARY KEY,
        active_generation INTEGER NOT NULL REFERENCES model_catalog_generations(generation),
        updated_at TEXT NOT NULL
      );
    `);
    sqlite.close();
    const migrated = new ModelCatalogStore(opened.file);
    const first = candidate();
    const observation = {
      bindingKey: "fake@local", agentId: "fake", location: "local",
      scopeKey: "scope:test", checksum: "a", adapterVersion: 1,
      schemaVersion: 1, cliVersion: null, sourceVersion: null,
      source: "test", fetchedAt: first.fetchedAt, drift: null,
    };
    expect(migrated.publish({ scopeKey: "scope:test", checksum: "a", candidate: first, publishedAt: first.fetchedAt, observation }).generation).toBe(1);
    expect(migrated.publish({ scopeKey: "scope:test", checksum: "b", candidate: first, publishedAt: first.fetchedAt, observation: { ...observation, checksum: "b" } }).generation).toBe(2);
    expect(migrated.publish({ scopeKey: "scope:test", checksum: "a", candidate: first, publishedAt: first.fetchedAt, observation }).generation).toBe(3);
    migrated.close();
  });

  it("publishes an immutable generation and applies the adapter's outlier codec", async () => {
    const opened = db();
    const catalog = service({ store: opened.store, fetch: async () => candidate() });
    const binding = { agentId: "fake", location: "local" };
    expect(catalog.lookup(binding).state).toBe("warming");

    const refreshed = await catalog.refresh(binding);
    expect(refreshed).toMatchObject({
      ok: true,
      result: "published",
      generation: 1,
      sourceVersion: "catalog/v17",
      cliVersion: "fake-cli 2031.4",
    });
    expect(catalog.model(binding, "alias-nebula")?.context.effective).toBe(700_000);
    expect(catalog.resolve(binding, { model: "alias-nebula" })).toMatchObject({
      normalized: { model: "nebula", effort: "deliberate" },
      raw: { model: "vendor::nebula@2026", effort: "THINK::9000" },
      generation: 1,
    });
    expect(catalog.decode(binding, {
      model: "vendor::nebula@2026",
      effort: "SPEED::1",
    })).toEqual({ model: "nebula", effort: "swift" });

    opened.store.close();
    const reopened = new ModelCatalogStore(opened.file);
    const fetch = vi.fn(async () => { throw new Error("offline"); });
    const restored = service({ store: reopened, fetch });
    expect(restored.lookup(binding).snapshot?.generation).toBe(1);
    expect(restored.resolve(binding, { model: "nebula", effort: "swift" }).raw.effort).toBe("SPEED::1");
    expect(restored.model(binding, "alias-nebula")?.id).toBe("nebula");
    expect(fetch).not.toHaveBeenCalled();
    reopened.close();
  });

  it("keeps normalized persistence while the runtime plan receives only raw adapter values", async () => {
    const opened = db();
    let active = candidate();
    const catalog = service({ store: opened.store, fetch: async () => structuredClone(active) });
    await catalog.refresh({ agentId: "fake", location: "local" });
    const sessions = new SessionStore(opened.file);
    const profile = {
      id: "fake",
      displayName: "Fake outlier",
      defaultModel: "nebula",
      catalog: { fetch: async () => candidate() },
      effort: { mechanism: "configOption", configId: "cognition.mode/v9", levels: ["swift", "deliberate"] },
    } as unknown as AgentProfile;
    const router = new SessionRouter({
      logger,
      store: sessions,
      profiles: [profile],
      modelCatalog: catalog,
      defaultAgentId: "fake",
      defaultModel: "nebula",
      defaultPermissionMode: "ask",
      defaultCwd: "/tmp",
    });
    const record = router.ensureSessionRecord({
      platform: "discord",
      channelRef: "outlier",
      cwd: "/tmp",
    });
    sessions.upsert({
      ...record,
      configJson: sessions.writeConfig({
        ...sessions.readConfig(record),
        model: "nebula",
        reasoningEffort: "deliberate",
      }),
    });
    const plan = router.planRuntimeSpawn(sessions.get(record.id)!);
    expect(plan).toMatchObject({
      model: "vendor::nebula@2026",
      effort: "THINK::9000",
      effortDescriptor: {
        configId: "cognition.mode/v9",
        selectionDefault: "deliberate",
      },
    });

    active = candidate();
    active.models[0]!.runtimeId = "vendor::nebula@2032";
    for (const binding of active.models[0]!.bindings) binding.rawModel = "vendor::nebula@2032";
    expect(await catalog.refresh({ agentId: "fake", location: "local" })).toMatchObject({
      result: "published",
      generation: 2,
      changed: 1,
    });
    expect(router.planRuntimeSpawn(sessions.get(record.id)!)).toMatchObject({
      model: "vendor::nebula@2032",
    });
    sessions.close();
    opened.store.close();
  });

  it("retains last-known-good across thrown, invalid, and suspiciously collapsed refreshes", async () => {
    const opened = db();
    let next = candidate(["nebula", "two", "three", "four", "five", "six"]);
    let failure: Error | null = null;
    const catalog = service({
      store: opened.store,
      fetch: async () => {
        if (failure) throw failure;
        return structuredClone(next);
      },
    });
    const binding = { agentId: "fake", location: "local" };
    expect((await catalog.refresh(binding)).result).toBe("published");
    const generation = catalog.lookup(binding).snapshot?.generation;

    failure = new Error("provider exploded");
    expect(await catalog.refresh(binding)).toMatchObject({ result: "retained", ok: false });
    expect(catalog.lookup(binding).snapshot?.generation).toBe(generation);

    failure = null;
    next.models = [];
    expect(await catalog.refresh(binding)).toMatchObject({ result: "retained", ok: false });
    expect(catalog.models(binding)).toHaveLength(6);

    next = candidate(["nebula"]);
    expect(await catalog.refresh(binding)).toMatchObject({ result: "quarantined", ok: false });
    expect(catalog.models(binding)).toHaveLength(6);
    expect(await catalog.refresh(binding)).toMatchObject({ result: "published", ok: true });
    expect(catalog.models(binding)).toHaveLength(1);
    opened.store.close();
  });

  it("single-flights refresh by observed semantic scope", async () => {
    const opened = db();
    const bindings = [
      { agentId: "fake", location: "local" },
      { agentId: "fake", location: "remote-a" },
    ];
    let calls = 0;
    let release: (() => void) | undefined;
    let blocked = false;
    const fetch = vi.fn(async () => {
      calls += 1;
      if (blocked) await new Promise<void>((resolve) => { release = resolve; });
      return candidate();
    });
    const catalog = service({ store: opened.store, fetch, bindings });
    await catalog.refresh(bindings[0]!);
    await catalog.refresh(bindings[1]!);
    calls = 0;
    blocked = true;
    const first = catalog.refresh(bindings[0]!);
    const second = catalog.refresh(bindings[1]!);
    await vi.waitFor(() => expect(calls).toBe(1));
    release?.();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
    opened.store.close();
  });

  it("single-flights equivalent bindings on their first cold fetch", async () => {
    const opened = db();
    const bindings = [
      { agentId: "fake-a", location: "local" },
      { agentId: "fake-b", location: "remote-a" },
    ];
    let release: (() => void) | undefined;
    const fetch = vi.fn(() => new Promise<AdapterCatalogCandidate>((resolve) => {
      release = () => resolve(candidate());
    }));
    const catalog = service({
      store: opened.store,
      fetch,
      bindings,
      scope: () => candidate().scope,
    });
    const both = bindings.map((binding) => catalog.refresh(binding));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    release?.();
    const results = await Promise.all(both);
    expect(results.map((result) => result.result).sort()).toEqual(["published", "unchanged"]);
    expect(fetch).toHaveBeenCalledOnce();
    opened.store.close();
  });

  it("single-flights startup, scheduled, and manual refresh triggers for a binding", async () => {
    const opened = db();
    const binding = { agentId: "fake", location: "local" };
    let release: (() => void) | undefined;
    const fetch = vi.fn(() => new Promise<AdapterCatalogCandidate>((resolve) => {
      release = () => resolve(candidate());
    }));
    const catalog = service({ store: opened.store, fetch, bindings: [binding] });
    catalog.start();
    const manual = catalog.refresh(binding, "manual");
    const scheduled = catalog.refresh(binding, "scheduled");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    release?.();
    const [manualResult, scheduledResult] = await Promise.all([manual, scheduled]);
    await catalog.drain();
    expect(manualResult.generation).toBe(1);
    expect(scheduledResult.generation).toBe(1);
    expect(fetch).toHaveBeenCalledOnce();
    catalog.stop();
    opened.store.close();
  });

  it("isolates equivalent-scope disagreement and refuses the drifted binding", async () => {
    const opened = db();
    const local = { agentId: "fake", location: "local" };
    const remote = { agentId: "fake", location: "remote-a" };
    const catalog = service({
      store: opened.store,
      fetch: async (binding) => binding.location === "local"
        ? candidate(["nebula"])
        : candidate(["nebula", "remote-only"]),
    });
    await catalog.refresh(local);
    const result = await catalog.refresh(remote);
    expect(result.error).toContain("conflicts with active generation");
    expect(catalog.lookup(remote).state).toBe("drift");
    expect(catalog.models(remote)).toEqual([]);
    expect(() => catalog.resolve(remote, { model: "nebula" })).toThrow(/unavailable/);
    expect(catalog.models(local).map((entry) => entry.id)).toEqual(["nebula"]);
    opened.store.close();
  });

  it("shares equal catalog content across a scope despite host provenance differences", async () => {
    const opened = db();
    const local = { agentId: "fake", location: "local" };
    const remote = { agentId: "fake", location: "remote-a" };
    const catalog = service({
      store: opened.store,
      fetch: async (binding) => ({
        ...candidate(["nebula"]),
        cliVersion: binding.location === "local" ? "fake-cli 1" : "fake-cli 2",
        sourceVersion: binding.location === "local" ? "feed-1" : "feed-2",
      }),
    });
    expect(await catalog.refresh(local)).toMatchObject({ result: "published", generation: 1 });
    expect(await catalog.refresh(remote)).toMatchObject({ result: "unchanged", generation: 1 });
    expect(catalog.lookup(remote)).toMatchObject({ state: "ready", snapshot: { generation: 1 } });
    expect(catalog.lookup(remote).observation).toMatchObject({ cliVersion: "fake-cli 2", sourceVersion: "feed-2" });

    // One binding may observe a legitimate next generation before its peer;
    // the peer's observation of the current active generation is merely stale,
    // not conflicting drift.
    const nextCatalog = candidate(["nebula", "second"]);
    const evolving = service({
      store: opened.store,
      fetch: async () => nextCatalog,
    });
    expect(await evolving.refresh(local)).toMatchObject({ result: "published", generation: 2 });
    expect(evolving.models(local).map((entry) => entry.id)).toEqual(["nebula", "second"]);
    opened.store.close();
  });

  it("allows repeated canonical advances while a peer observation remains stale", async () => {
    const opened = db();
    const local = { agentId: "fake", location: "local" };
    const remote = { agentId: "fake", location: "remote-a" };
    let localIds = ["nebula", "a"];
    const catalog = service({
      store: opened.store,
      fetch: async (binding) => candidate(binding.location === "local" ? localIds : ["nebula", "a"]),
      scope: () => candidate().scope,
    });
    expect(await catalog.refresh(local)).toMatchObject({ generation: 1, result: "published" });
    expect(await catalog.refresh(remote)).toMatchObject({ generation: 1, result: "unchanged" });
    localIds = ["nebula", "b"];
    expect(await catalog.refresh(local)).toMatchObject({ generation: 2, result: "published" });
    localIds = ["nebula", "c"];
    expect(await catalog.refresh(local)).toMatchObject({ generation: 3, result: "published" });
    expect(catalog.lookup(local).state).toBe("ready");
    expect(catalog.lookup(remote).observation?.checksum).not.toBe(catalog.lookup(local).snapshot?.checksum);
    opened.store.close();
  });

  it("never moves generation backwards when content returns to an earlier checksum", async () => {
    const opened = db();
    let ids = ["nebula", "a"];
    const catalog = service({ store: opened.store, fetch: async () => candidate(ids) });
    const binding = { agentId: "fake", location: "local" };
    expect((await catalog.refresh(binding)).generation).toBe(1);
    ids = ["nebula", "b"];
    expect((await catalog.refresh(binding)).generation).toBe(2);
    ids = ["nebula", "a"];
    expect((await catalog.refresh(binding)).generation).toBe(3);
    opened.store.close();
  });

  it("serves a remote last-known-good snapshot as stale while offline", async () => {
    const opened = db();
    const binding = { agentId: "fake", location: "remote-a" };
    let online = true;
    const catalog = service({
      store: opened.store,
      fetch: async () => candidate(),
      online: () => online,
    });
    await catalog.refresh(binding);
    online = false;
    expect(catalog.lookup(binding).state).toBe("stale");
    expect(catalog.models(binding)).toHaveLength(1);
    expect(await catalog.refresh(binding)).toMatchObject({ result: "unavailable", ok: true });
    expect(catalog.models(binding)).toHaveLength(1);
    opened.store.close();
  });

  it("starts refresh after readiness without blocking startup", async () => {
    const opened = db();
    let release: (() => void) | undefined;
    const fetch = vi.fn(() => new Promise<AdapterCatalogCandidate>((resolve) => {
      release = () => resolve(candidate());
    }));
    const catalog = service({ store: opened.store, fetch });
    catalog.start();
    expect(fetch).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(catalog.lookup({ agentId: "fake", location: "local" }).state).toBe("warming");
    release?.();
    await catalog.drain();
    expect(catalog.lookup({ agentId: "fake", location: "local" }).state).toBe("ready");
    catalog.stop();
    opened.store.close();
  });
});

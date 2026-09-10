import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_ADAPTER_VERSION,
  agyNativeCatalogScope,
  catalogContentChecksum,
  makeAgyProfile,
  manifestCatalogScope,
  type AdapterCatalogCandidate,
  type CatalogModel,
} from "@seam/adapters";
import {
  AGY_CATALOG_IDENTITY_MIGRATION,
  migrateAgyCatalogIdentity,
} from "../packages/core/src/core/agy-catalog-migration.js";
import { ModelCatalogService } from "../packages/core/src/core/model-catalog/service.js";
import { ModelCatalogStore } from "../packages/core/src/core/model-catalog/store.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import { loadHostAdapters } from "../packages/bridge/src/inventory.js";
import { createManagedAgyFixture } from "./helpers/agy-runtime-fixture.js";

const logger = pino({ level: "silent" }) as unknown as Logger;
const dirs: string[] = [];
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function database(): { file: string; store: ModelCatalogStore } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agy-catalog-migration-"));
  dirs.push(dir);
  const file = path.join(dir, "seam.db");
  const store = new ModelCatalogStore(file);
  const raw = new Database(file);
  raw.exec(`
    CREATE TABLE IF NOT EXISTS sessions_fixture (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agy_identity_restore_fixture (
      id TEXT PRIMARY KEY, before_json TEXT NOT NULL, after_json TEXT NOT NULL,
      rebuild_required INTEGER NOT NULL
    );
  `);
  raw.prepare("INSERT INTO sessions_fixture VALUES (?, ?)").run("thread-pending", "byte-identical-config");
  raw.prepare("INSERT INTO agy_identity_restore_fixture VALUES (?, ?, ?, ?)")
    .run("thread-pending", "before-image", "after-image", 1);
  raw.close();
  for (let i = 1; i <= 4; i += 1) {
    store.recordObservation({
      bindingKey: `agy@remote-${i}`, agentId: "agy", location: `remote-${i}`,
      scopeKey: `scope:remote-${i}`, checksum: String(i).repeat(64),
      adapterVersion: AGENT_ADAPTER_VERSION, schemaVersion: 1,
      cliVersion: "1.1.28", sourceVersion: null, source: "agy-language-server",
      fetchedAt: `2026-09-09T17:0${i}:00.000Z`, drift: null,
    });
    store.recordAttempt({
      bindingKey: `agy@remote-${i}`, attemptedAt: `2026-09-09T17:0${i}:00.000Z`,
      result: "unchanged", error: null, source: "agy-language-server",
      candidateChecksum: String(i).repeat(64),
    });
    store.recordReductionQuarantine({
      bindingKey: `agy@remote-${i}`, scopeKey: `scope:remote-${i}`,
      priorGeneration: i, rule: "fixture", removed: [`legacy-${i}`],
      fingerprint: String(i).repeat(64), observedAt: `2026-09-09T17:0${i}:00.000Z`,
    });
  }
  return { file, store };
}

const PACKAGE_SCOPE = manifestCatalogScope({
  provider: "google-antigravity",
  credentialProfile: "antigravity-oauth:primary",
  policy: "unsafe-ack-v1",
});

function catalogModel(
  scopeRef: string,
  id: string,
  isDefault: boolean,
  observedAt: string,
): CatalogModel {
  return {
    id,
    runtimeId: id,
    displayName: id,
    aliases: [],
    default: isDefault,
    context: { native: null, maximum: null, effective: null },
    modalities: { input: ["text"], output: ["text"] },
    visionMode: "none",
    availability: "available",
    lifecycle: "stable",
    serviceTiers: [],
    effort: {
      mechanism: "modelBaked",
      choices: [{ id: "default" }],
      selectionDefault: "default",
    },
    pricingCategory: null,
    compatibility: null,
    applicationMode: "freshSession",
    bindings: [{ model: id, effort: "default", rawModel: id }],
    evidence: [{
      kind: "live-observation",
      source: "agy-models+antigravity-acp-selection",
      observedAt,
      runtimeVersion: "agy 1.1.28",
      adapterVersion: AGENT_ADAPTER_VERSION,
      scopeRef,
      resolvedModel: id,
      effort: {
        choices: ["default"],
        selectionDefault: "default",
        method: "adapter-observed",
      },
    }],
  };
}

function candidate(
  scope: AdapterCatalogCandidate["scope"],
  observedAt: string,
  defaultModel = "gemini-3.8-flash-high",
  ids = ["gemini-3.8-flash-high", "claude-opus-4-6-thinking"],
  source = "agy-models+antigravity-acp-selection",
): AdapterCatalogCandidate {
  return {
    schemaVersion: 1,
    scope,
    models: ids.map((id) => catalogModel(scope.fingerprint, id, id === defaultModel, observedAt)),
    source,
    sourceVersion: "1.1.0-e0a3d22",
    adapterVersion: AGENT_ADAPTER_VERSION,
    cliVersion: "1.1.28",
    fetchedAt: observedAt,
  };
}

function publish(
  store: ModelCatalogStore,
  binding: { agentId: string; location: string },
  snapshot: AdapterCatalogCandidate,
  drift: string | null = null,
): number {
  const checksum = catalogContentChecksum(snapshot);
  return store.publish({
    scopeKey: `scope:${snapshot.scope.fingerprint}`,
    checksum,
    candidate: snapshot,
    publishedAt: snapshot.fetchedAt,
    observation: {
      bindingKey: `${binding.agentId}@${binding.location}`,
      agentId: binding.agentId,
      location: binding.location,
      scopeKey: `scope:${snapshot.scope.fingerprint}`,
      checksum,
      adapterVersion: snapshot.adapterVersion,
      schemaVersion: snapshot.schemaVersion,
      cliVersion: snapshot.cliVersion ?? null,
      sourceVersion: snapshot.sourceVersion ?? null,
      source: snapshot.source,
      fetchedAt: snapshot.fetchedAt,
      drift,
    },
  }).generation;
}

function protectedRows(file: string): unknown {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return {
      remote: db.prepare("SELECT * FROM model_catalog_observations WHERE location != 'local' ORDER BY binding_key").all(),
      remoteStatus: db.prepare("SELECT * FROM model_catalog_refresh_status WHERE binding_key LIKE '%@remote-%' ORDER BY binding_key").all(),
      remoteReduction: db.prepare("SELECT * FROM model_catalog_reduction_quarantine WHERE binding_key LIKE '%@remote-%' ORDER BY binding_key").all(),
      sessions: db.prepare("SELECT * FROM sessions_fixture ORDER BY id").all(),
      restore: db.prepare("SELECT * FROM agy_identity_restore_fixture ORDER BY id").all(),
    };
  } finally {
    db.close();
  }
}

function generations(file: string): unknown[] {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT * FROM model_catalog_generations ORDER BY generation").all();
  } finally {
    db.close();
  }
}

function service(
  store: ModelCatalogStore,
  next: () => Promise<AdapterCatalogCandidate>,
): ModelCatalogService {
  return new ModelCatalogService({
    store,
    logger,
    bindings: () => [],
    scope: () => PACKAGE_SCOPE,
    fetch: next,
  });
}

describe("AGY native semantic catalog scope", () => {
  it("shares only equivalent account, runtime, default, and configured model policy", async () => {
    const common = {
      credentialScope: "antigravity-oauth:primary",
      defaultModel: "gemini-high",
      staticModels: [
        { modelId: "gemini-high", name: "Gemini High", contextLimit: 1_000_000 },
        { modelId: "claude-thinking", name: "Claude Thinking", contextLimit: 200_000 },
      ],
    };
    const direct = agyNativeCatalogScope(common);
    const reordered = agyNativeCatalogScope({ ...common, staticModels: [...common.staticModels].reverse() });
    expect(reordered).toEqual(direct);
    expect(agyNativeCatalogScope({
      ...common,
      staticModels: common.staticModels.map((model) => ({ ...model, name: `Renamed ${model.name}` })),
    })).toEqual(direct);
    expect(agyNativeCatalogScope({ ...common, credentialScope: "antigravity-oauth:family" }).fingerprint)
      .not.toBe(direct.fingerprint);
    expect(agyNativeCatalogScope({ ...common, defaultModel: "claude-thinking" }).fingerprint)
      .not.toBe(direct.fingerprint);
    expect(agyNativeCatalogScope({ ...common, staticModels: common.staticModels.slice(0, 1) }).fingerprint)
      .not.toBe(direct.fingerprint);

    const managed = createManagedAgyFixture({ credentialScope: common.credentialScope });
    cleanups.push(managed.cleanup);
    const profile = makeAgyProfile({
      runtime: managed.runtime,
      defaultModel: common.defaultModel,
      staticModels: common.staticModels,
    });
    expect(await profile.catalog.scope()).toEqual(direct);
    expect((await profile.catalog.fetch()).scope).toEqual(direct);

    const bridged = loadHostAdapters("/bin/false", {
      exists: () => true,
      env: {
        HOME: os.homedir(),
        PATH: process.env.PATH,
        AGY_ENABLED: "true",
        AGY_CLI_PATH: managed.executable,
        AGY_BIN: managed.executable,
        AGY_RUNTIME_ROOT: managed.runtimeRoot,
        AGY_VERSION: "agy-test 1.0",
        AGY_SHA256: managed.sha256,
        AGY_DEFAULT_MODEL: common.defaultModel,
        AGY_CREDENTIAL_SCOPE: common.credentialScope,
        AGY_MODELS: "gemini-high:Gemini High,claude-thinking:Claude Thinking",
      },
    }).get("agy");
    expect(await bridged!.catalog.scope()).toEqual(agyNativeCatalogScope({
      ...common,
      staticModels: common.staticModels.map(({ modelId, name }) => ({ modelId, name })),
    }));
  });
});

describe("AGY catalog identity migration", () => {
  it("atomically renames the healthy pre-cutover local package binding and nothing else", () => {
    const { file, store } = database();
    const packageSnapshot = candidate(PACKAGE_SCOPE, "2026-09-09T15:22:57.674Z");
    publish(store, { agentId: "agy", location: "local" }, packageSnapshot);
    publish(store, { agentId: "agy", location: "home-hub" }, candidate(
      agyNativeCatalogScope({ credentialScope: "antigravity-oauth:remote", defaultModel: "claude-opus-4-6-thinking" }),
      "2026-09-09T17:09:25.959Z",
      "claude-opus-4-6-thinking",
      undefined,
      "agy-language-server",
    ));
    store.recordAttempt({
      bindingKey: "agy@local", attemptedAt: packageSnapshot.fetchedAt, result: "published",
      error: null, source: packageSnapshot.source,
      candidateChecksum: catalogContentChecksum(packageSnapshot),
    });
    const before = protectedRows(file);
    const immutableBefore = generations(file);

    expect(migrateAgyCatalogIdentity(store, PACKAGE_SCOPE)).toBe("renamed");
    const observations = store.loadObservations();
    expect(observations.find((row) => row.bindingKey === "agy@local")).toBeUndefined();
    expect(observations.find((row) => row.bindingKey === "agy-package@local")).toMatchObject({
      agentId: "agy-package",
      location: "local",
      scopeKey: `scope:${PACKAGE_SCOPE.fingerprint}`,
      drift: null,
    });
    expect(store.getRefreshStatus("agy-package@local")?.result).toBe("published");
    expect(store.bindingMigration(AGY_CATALOG_IDENTITY_MIGRATION)?.status).toBe("complete");
    expect(protectedRows(file)).toEqual(before);
    expect(generations(file)).toEqual(immutableBefore);
    expect(migrateAgyCatalogIdentity(store, PACKAGE_SCOPE)).toBe("already-complete");
    store.close();
  });

  it("repairs the already-failed cutover only after fresh substantive equivalence", async () => {
    const { file, store } = database();
    const active = candidate(PACKAGE_SCOPE, "2026-09-09T18:17:01.721Z");
    const generation = publish(store, { agentId: "legacy-publisher", location: "local" }, active);
    store.recordObservation({
      bindingKey: "agy-package@local", agentId: "agy-package", location: "local",
      scopeKey: `scope:${PACKAGE_SCOPE.fingerprint}`,
      checksum: "f".repeat(64), adapterVersion: AGENT_ADAPTER_VERSION, schemaVersion: 1,
      cliVersion: "1.1.28", sourceVersion: "1.1.0-e0a3d22",
      source: active.source, fetchedAt: "2026-09-09T18:20:41.868Z",
      drift: `catalog conflicts with active generation ${generation}; binding quarantined`,
    });
    store.recordObservation({
      bindingKey: "agy@local", agentId: "agy", location: "local",
      scopeKey: "scope:old-native", checksum: "e".repeat(64),
      adapterVersion: AGENT_ADAPTER_VERSION, schemaVersion: 1,
      cliVersion: "1.1.28", sourceVersion: null, source: "agy-language-server",
      fetchedAt: "2026-09-09T18:20:38.524Z",
      drift: "catalog conflicts with active native generation; binding quarantined",
    });
    const before = protectedRows(file);
    const immutableBefore = generations(file);
    expect(migrateAgyCatalogIdentity(store, PACKAGE_SCOPE)).toBe("pending-proof");
    expect(store.bindingMigration(AGY_CATALOG_IDENTITY_MIGRATION)).toMatchObject({
      status: "pending-proof",
      activeGeneration: generation,
      targetBindingKey: "agy-package@local",
    });
    expect(protectedRows(file)).toEqual(before);
    expect(generations(file).slice(0, immutableBefore.length)).toEqual(immutableBefore);

    const freshEquivalent = candidate(PACKAGE_SCOPE, "2026-09-09T19:00:00.000Z");
    expect(catalogContentChecksum(freshEquivalent)).not.toBe(catalogContentChecksum(active));
    const result = await service(store, async () => freshEquivalent)
      .refresh({ agentId: "agy-package", location: "local" });
    expect(result.result).toBe("published");
    expect(store.bindingMigration(AGY_CATALOG_IDENTITY_MIGRATION)?.status).toBe("complete");
    expect(service(store, async () => { throw new Error("offline fixture"); })
      .lookup({ agentId: "agy-package", location: "local" }).state).toBe("ready");
    expect(protectedRows(file)).toEqual(before);

    const rightfulChange = candidate(
      PACKAGE_SCOPE,
      "2026-09-09T19:01:00.000Z",
      "gemini-3.8-flash-high",
      ["gemini-3.8-flash-high", "claude-opus-4-6-thinking", "gemini-new"],
    );
    const rightful = await service(store, async () => rightfulChange)
      .refresh({ agentId: "agy-package", location: "local" });
    expect(rightful.result).toBe("published");
    const stalePeer = await service(store, async () => candidate(
      PACKAGE_SCOPE,
      "2026-09-09T19:02:00.000Z",
      "gemini-3.8-flash-high",
      [...rightfulChange.models.map((row) => row.id), "peer-only"],
    )).refresh({ agentId: "agy-package", location: "remote-peer" });
    expect(stalePeer.result).toBe("quarantined");

    store.close();
    const restarted = new ModelCatalogStore(file);
    expect(migrateAgyCatalogIdentity(restarted, PACKAGE_SCOPE)).toBe("already-complete");
    expect(restarted.loadActive().some((row) => row.generation === rightful.generation)).toBe(true);
    expect(generations(file).some((row) => (row as { generation: number }).generation === result.generation)).toBe(true);
    restarted.close();
  });

  it("keeps genuine conflicts quarantined and retains LKG and pending proof across errors/restarts", async () => {
    const { file, store } = database();
    const active = candidate(PACKAGE_SCOPE, "2026-09-09T18:17:01.721Z");
    const generation = publish(store, { agentId: "legacy-publisher", location: "local" }, active);
    store.recordObservation({
      bindingKey: "agy-package@local", agentId: "agy-package", location: "local",
      scopeKey: `scope:${PACKAGE_SCOPE.fingerprint}`, checksum: "f".repeat(64),
      adapterVersion: AGENT_ADAPTER_VERSION, schemaVersion: 1, cliVersion: "1.1.28",
      sourceVersion: "1.1.0-e0a3d22", source: active.source,
      fetchedAt: "2026-09-09T18:20:41.868Z", drift: "prior failed cutover",
    });
    expect(migrateAgyCatalogIdentity(store, PACKAGE_SCOPE)).toBe("pending-proof");
    const before = protectedRows(file);

    const divergent = candidate(
      PACKAGE_SCOPE,
      "2026-09-09T19:00:00.000Z",
      "gemini-new-default",
      ["gemini-new-default", "gemini-3.8-flash-high"],
    );
    const conflict = await service(store, async () => divergent)
      .refresh({ agentId: "agy-package", location: "local" });
    expect(conflict).toMatchObject({ result: "quarantined", generation });
    expect(store.bindingMigration(AGY_CATALOG_IDENTITY_MIGRATION)?.status).toBe("pending-proof");
    expect(store.loadActive().find((row) => row.scopeKey === `scope:${PACKAGE_SCOPE.fingerprint}`)?.generation)
      .toBe(generation);
    expect(protectedRows(file)).toEqual(before);

    const failed = await service(store, async () => { throw new Error("offline fixture"); })
      .refresh({ agentId: "agy-package", location: "local" });
    expect(failed).toMatchObject({ result: "retained", generation });
    expect(store.bindingMigration(AGY_CATALOG_IDENTITY_MIGRATION)?.status).toBe("pending-proof");
    store.close();

    const restarted = new ModelCatalogStore(file);
    expect(migrateAgyCatalogIdentity(restarted, PACKAGE_SCOPE)).toBe("already-pending-proof");
    expect(restarted.loadActive().find((row) => row.scopeKey === `scope:${PACKAGE_SCOPE.fingerprint}`)?.generation)
      .toBe(generation);
    restarted.close();
  });

  it("is a no-op on fresh state and rolls back ambiguous ownership atomically", () => {
    const fresh = database();
    expect(migrateAgyCatalogIdentity(fresh.store, PACKAGE_SCOPE)).toBe("fresh");
    expect(fresh.store.bindingMigration(AGY_CATALOG_IDENTITY_MIGRATION)?.status).toBe("complete");
    fresh.store.close();

    const conflict = database();
    const active = candidate(PACKAGE_SCOPE, "2026-09-09T18:17:01.721Z");
    publish(conflict.store, { agentId: "agy", location: "local" }, active);
    conflict.store.recordObservation({
      ...conflict.store.loadObservations().find((row) => row.bindingKey === "agy@local")!,
      bindingKey: "agy-package@local",
      agentId: "unexpected-agent",
      source: "unexpected-source",
    });
    const before = new Database(conflict.file, { readonly: true });
    const observations = before.prepare("SELECT * FROM model_catalog_observations ORDER BY binding_key").all();
    before.close();
    expect(() => migrateAgyCatalogIdentity(conflict.store, PACKAGE_SCOPE)).toThrow(/ambiguous/i);
    const after = new Database(conflict.file, { readonly: true });
    expect(after.prepare("SELECT * FROM model_catalog_observations ORDER BY binding_key").all()).toEqual(observations);
    expect(after.prepare("SELECT COUNT(*) AS n FROM model_catalog_binding_migrations").get()).toEqual({ n: 0 });
    after.close();
    conflict.store.close();
  });

  it("rejects every non-time continuity delta and leaves proof single-use", async () => {
    const { store } = database();
    const active = candidate(PACKAGE_SCOPE, "2026-09-09T18:17:01.721Z");
    publish(store, { agentId: "legacy-publisher", location: "local" }, active);
    expect(migrateAgyCatalogIdentity(store, PACKAGE_SCOPE)).toBe("pending-proof");
    const changes: Array<(value: AdapterCatalogCandidate) => void> = [
      (value) => { value.source = "different-source"; },
      (value) => { value.sourceVersion = "1.1.1-other"; },
      (value) => { value.cliVersion = "1.1.29"; },
      (value) => { value.adapterVersion += 1; },
      (value) => { value.models[0]!.evidence![0]!.runtimeVersion = "agy changed"; },
      (value) => { value.models[0]!.default = false; value.models[1]!.default = true; },
    ];
    for (const change of changes) {
      const altered = structuredClone(candidate(PACKAGE_SCOPE, "2026-09-09T19:00:00.000Z"));
      change(altered);
      const result = await service(store, async () => altered)
        .refresh({ agentId: "agy-package", location: "local" });
      expect(result.result).toBe("quarantined");
      expect(store.bindingMigration(AGY_CATALOG_IDENTITY_MIGRATION)?.status).toBe("pending-proof");
    }
    const wrongScope = candidate(
      manifestCatalogScope({
        provider: "google-antigravity",
        credentialProfile: "antigravity-oauth:different",
        policy: "unsafe-ack-v1",
      }),
      "2026-09-09T19:05:00.000Z",
    );
    expect((await service(store, async () => wrongScope)
      .refresh({ agentId: "agy-package", location: "local" })).result).toBe("retained");
    expect(store.bindingMigration(AGY_CATALOG_IDENTITY_MIGRATION)?.status).toBe("pending-proof");
    const equivalent = candidate(PACKAGE_SCOPE, "2026-09-09T19:10:00.000Z");
    expect((await service(store, async () => equivalent)
      .refresh({ agentId: "agy-package", location: "local" })).result).toBe("published");
    expect(store.bindingMigration(AGY_CATALOG_IDENTITY_MIGRATION)?.status).toBe("complete");
    store.close();
  });

  it("rolls back marker, observation, and status together on a forced SQLite interruption", () => {
    const { file, store } = database();
    const active = candidate(PACKAGE_SCOPE, "2026-09-09T15:22:57.674Z");
    publish(store, { agentId: "agy", location: "local" }, active);
    store.recordAttempt({
      bindingKey: "agy@local", attemptedAt: active.fetchedAt, result: "published",
      error: null, source: active.source, candidateChecksum: catalogContentChecksum(active),
    });
    const raw = new Database(file);
    raw.exec(`CREATE TRIGGER force_binding_rename_failure
      BEFORE UPDATE OF binding_key ON model_catalog_observations
      WHEN OLD.binding_key = 'agy@local'
      BEGIN SELECT RAISE(ABORT, 'forced migration interruption'); END;`);
    raw.close();
    const before = new Database(file, { readonly: true });
    const observations = before.prepare("SELECT * FROM model_catalog_observations ORDER BY binding_key").all();
    const statuses = before.prepare("SELECT * FROM model_catalog_refresh_status ORDER BY binding_key").all();
    before.close();

    expect(() => migrateAgyCatalogIdentity(store, PACKAGE_SCOPE)).toThrow(/forced migration interruption/);
    const after = new Database(file, { readonly: true });
    expect(after.prepare("SELECT * FROM model_catalog_observations ORDER BY binding_key").all()).toEqual(observations);
    expect(after.prepare("SELECT * FROM model_catalog_refresh_status ORDER BY binding_key").all()).toEqual(statuses);
    expect(after.prepare("SELECT COUNT(*) AS n FROM model_catalog_binding_migrations").get()).toEqual({ n: 0 });
    after.close();
    store.close();
  });

  it("publishes and resolves both fresh local identities on distinct scopes", async () => {
    const { store } = database();
    expect(migrateAgyCatalogIdentity(store, PACKAGE_SCOPE)).toBe("fresh");
    const packageCatalog = candidate(PACKAGE_SCOPE, "2026-09-09T19:00:00.000Z");
    const nativeScope = agyNativeCatalogScope({
      credentialScope: "antigravity-oauth:primary",
      defaultModel: "gemini-3.8-flash-high",
      staticModels: packageCatalog.models.map((row) => ({ modelId: row.id, name: row.displayName })),
    });
    const nativeCatalog = candidate(
      nativeScope,
      "2026-09-09T19:00:01.000Z",
      "gemini-3.8-flash-high",
      undefined,
      "agy-language-server",
    );
    const packageService = service(store, async () => packageCatalog);
    expect((await packageService.refresh({ agentId: "agy-package", location: "local" })).result)
      .toBe("published");
    const nativeService = new ModelCatalogService({
      store, logger, bindings: () => [], scope: () => nativeScope, fetch: async () => nativeCatalog,
    });
    expect((await nativeService.refresh({ agentId: "agy", location: "local" })).result).toBe("published");
    expect(packageService.model({ agentId: "agy-package", location: "local" }, "default")?.id)
      .toBe("gemini-3.8-flash-high");
    expect(nativeService.model({ agentId: "agy", location: "local" }, "default")?.id)
      .toBe("gemini-3.8-flash-high");
    expect(nativeScope.fingerprint).not.toBe(PACKAGE_SCOPE.fingerprint);
    store.close();
  });
});

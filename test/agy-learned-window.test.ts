import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { pino } from "pino";
import { agyNativeCatalogScope, makeAgyProfile, manifestCatalogSource,
  type AdapterCatalogCandidate, type AgentProfile } from "@seam/adapters";
import { ModelCatalogService } from "../packages/core/src/core/model-catalog/service.js";
import { ModelCatalogStore } from "../packages/core/src/core/model-catalog/store.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { createOrdinaryAgyFixture } from "./helpers/agy-runtime-fixture.js";
import { localBridgeWiring } from "./local-bridge-fixture.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const logger = pino({ level: "silent" }) as unknown as Logger;
const window = 1_048_576;
const binding = { agentId: "agy", location: "gh-server" };
const dirs: string[] = [];
const temporary = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agy-window-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

async function candidate(limit?: number, identity = "runtime-a"): Promise<AdapterCatalogCandidate> {
  const source = manifestCatalogSource({ provider: "google-antigravity", backend: "agy-native-language-server-v1",
    credentialProfile: "antigravity-oauth:durable-test", policy: identity, defaultModel: "argon-high",
    source: "agy-models", adapterVersion: 4,
    models: () => [{ modelId: "argon-high", name: "Argon 4", ...(limit ? { contextLimit: limit } : {}) }],
  });
  const result = await source.fetch();
  if (limit) result.models[0]!.evidence = [{ kind: "live-observation", source: "agy language server",
    observedAt: "2026-10-17T16:00:00.000Z", runtimeVersion: "1.3.5", adapterVersion: 4,
    scopeRef: result.scope.fingerprint, resolvedModel: "argon-high",
    context: { native: limit, maximum: limit, effective: limit, method: "GetAvailableModels" } }];
  return result;
}

function service(store: ModelCatalogStore, fetch: () => Promise<AdapterCatalogCandidate>) {
  return new ModelCatalogService({ store, logger, bindings: () => [binding], fetch });
}

describe("durable AGY learned context windows", () => {
  it("leaves an unobserved window unknown instead of publishing the sizing fallback", async () => {
    const store = new ModelCatalogStore(path.join(temporary(), "seam.db"));
    try {
      const catalog = service(store, () => candidate());
      await catalog.refresh(binding);
      expect(catalog.model(binding, "argon-high")?.context).toEqual({ native: null, maximum: null, effective: null });
    } finally { store.close(); }
  });

  it("publishes the session observation instead of re-probing a cold catalog process", async () => {
    const store = new ModelCatalogStore(path.join(temporary(), "seam.db"));
    const cold = await candidate();
    const catalog = service(store, async () => cold);
    try {
      await catalog.refresh(binding);
      const rich = await candidate(window);
      await catalog.refresh(binding, "session", { candidate: rich } as never);
      expect(catalog.model(binding, "argon-high")?.context.effective).toBe(window);
    } finally { store.close(); }
  });

  it("retains exact observed windows through a cold refresh and controller restart", async () => {
    const db = path.join(temporary(), "seam.db");
    const store = new ModelCatalogStore(db);
    await service(store, () => candidate(window)).refresh(binding);
    store.close();
    const reopened = new ModelCatalogStore(db);
    try {
      const catalog = service(reopened, () => candidate());
      await catalog.refresh(binding);
      const model = catalog.model(binding, "argon-high")!;
      expect(model.context.effective).toBe(window);
      expect(model.evidence).toContainEqual(expect.objectContaining({ source: "agy language server",
        observedAt: "2026-10-17T16:00:00.000Z", resolvedModel: "argon-high" }));
    } finally { reopened.close(); }
  });

  it("does not lend a learned limit to another host, runtime, account or model", async () => {
    const store = new ModelCatalogStore(path.join(temporary(), "seam.db"));
    let current = await candidate(window);
    const catalog = service(store, async () => current);
    try {
      await catalog.refresh(binding);
      current = await candidate();
      await catalog.refresh({ ...binding, location: "another-host" });
      expect(catalog.model({ ...binding, location: "another-host" }, "argon-high")?.context.effective).toBeNull();
      current = await candidate(undefined, "another-runtime-or-account");
      await catalog.refresh(binding);
      expect(catalog.model(binding, "argon-high")?.context.effective).toBeNull();
      expect(catalog.model(binding, "argon-high-alias")).toBeNull();
    } finally { store.close(); }
  });

  it("accepts a newly observed smaller window rather than making the learned size a floor", async () => {
    const store = new ModelCatalogStore(path.join(temporary(), "seam.db"));
    let current = await candidate(window);
    const catalog = service(store, async () => current);
    try {
      await catalog.refresh(binding);
      current = await candidate(200_000);
      await catalog.refresh(binding);
      expect(catalog.model(binding, "argon-high")?.context.effective).toBe(200_000);
    } finally { store.close(); }
  });

  it("does not let an in-flight cold refresh swallow the real session observation", async () => {
    const store = new ModelCatalogStore(path.join(temporary(), "seam.db"));
    const cold = await candidate(), rich = await candidate(window);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const catalog = service(store, async () => { await held; return cold; });
    const polling = catalog.refresh(binding);
    let observed = false;
    const learning = catalog.refresh(binding, "session", { candidate: rich } as never).then(() => { observed = true; });
    try {
      try {
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(observed).toBe(true);
      } finally { release(); await Promise.all([polling, learning]); }
      expect(catalog.model(binding, "argon-high")?.context.effective).toBe(window);
    } finally { store.close(); }
  });

  it("includes the native runtime identity in the AGY catalog scope", () => {
    const opts = { defaultModel: "argon-high", credentialScope: "antigravity-oauth:primary" };
    const first = agyNativeCatalogScope({ ...opts, runtimeIdentity: "runtime-a" } as never);
    const second = agyNativeCatalogScope({ ...opts, runtimeIdentity: "runtime-b" } as never);
    expect(first.fingerprint).not.toBe(second.fingerprint);
  });

  it("starts a second fresh adapter process at its durable learned limit without a new metadata RPC", async () => {
    const dir = temporary();
    const mode = path.join(dir, "metadata-mode");
    fs.writeFileSync(mode, "late");
    const fixtureDir = fileURLToPath(new URL("./fixtures/agy-native-capabilities/", import.meta.url));
    const fixture = createOrdinaryAgyFixture({ source: path.join(fixtureDir, "fake-native-agy.mjs"),
      version: "agy fixture 1.3.5", credentialScope: "antigravity-oauth:durable-test", cwd: dir,
      environment: { SEAM_AGY_CAPABILITY_FIXTURE_DIR: fixtureDir,
        SEAM_AGY_R4B_METADATA_MODE_FILE: mode, SEAM_AGY_R4B_CONTEXT_WINDOW: String(window) } });
    const native = makeAgyProfile({ runtime: fixture.runtime, dataDir: dir, defaultModel: "fixture-native-model", exposeGlobalStaging: false });
    const pids: number[] = [];
    const profile: AgentProfile = { ...native, spawn() {
      const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/agy-catalog-child.mjs", import.meta.url))], {
        cwd: dir, env: { ...process.env, SEAM_TEST_DATA: dir,
          PATH: `${path.dirname(fixture.executable)}${path.delimiter}${process.env.PATH ?? ""}` },
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (child.pid) pids.push(child.pid);
      return child;
    } };
    const cold = await native.catalog.fetch();
    const db = path.join(dir, "seam.db");
    let catalogs = new ModelCatalogStore(db);
    let sessions = new SessionStore(db);
    const open = () => {
      const catalog = new ModelCatalogService({ store: catalogs, logger, bindings: () => [{ agentId: "agy", location: "local" }],
        scope: () => profile.catalog.scope(), fetch: async () => structuredClone(cold) });
      const router = new SessionRouter({ logger, store: sessions, profiles: [profile], modelCatalog: catalog,
        defaultAgentId: "agy", defaultModel: "fixture-native-model", defaultCwd: dir, seamMcp: localBridgeWiring(profile) });
      return { catalog, router };
    };
    let h = open();
    try {
      await h.catalog.refresh({ agentId: "agy", location: "local" });
      const record = h.router.ensureSessionRecord({ platform: "google-chat", channelRef: "update-tracker", cwd: dir });
      const first = await h.router.getOrStartRuntime(record);
      const firstUsage: number[] = [];
      first.onEvent(async event => { if (event.kind === "usage-update") firstUsage.push(event.size); });
      await first.prompt("capability-turn-one"); await first.idle();
      expect(firstUsage[0]).toBe(128_000);
      expect(firstUsage.at(-1)).toBe(window);
      const session = first.getSessionInfo()!.sessionId;
      expect(h.catalog.model({ agentId: "agy", location: "local" }, "fixture-native-model")?.context.effective).toBe(window);
      await h.router.disposeAll(); catalogs.close(); sessions.close();
      fs.writeFileSync(mode, "unavailable");
      catalogs = new ModelCatalogStore(db); sessions = new SessionStore(db); h = open();
      await h.catalog.refresh({ agentId: "agy", location: "local" });
      const second = await h.router.getOrStartRuntime(sessions.get(record.id)!);
      const secondUsage: number[] = [];
      second.onEvent(async event => { if (event.kind === "usage-update") secondUsage.push(event.size); });
      await second.prompt("capability-turn-two"); await second.idle();
      expect(second.getSessionInfo()?.sessionId).toBe(session);
      expect(pids).toHaveLength(2); expect(pids[0]).not.toBe(pids[1]);
      expect(secondUsage.length).toBeGreaterThan(0);
      expect(secondUsage.every(size => size === window)).toBe(true);
    } finally { await h.router.disposeAll(); catalogs.close(); sessions.close(); fixture.cleanup(); }
  }, 45_000);
});

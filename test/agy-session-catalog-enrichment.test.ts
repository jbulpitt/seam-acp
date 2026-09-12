/**
 * #346 (AGY R4b) — a real session's already-running language server enriches
 * the binding catalog. No probe process or synthetic prompt is involved.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { AGY_ASSUMED_CONTEXT_WINDOW, makeAgyProfile, type AgentProfile } from "@seam/adapters";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { ModelCatalogService } from "../packages/core/src/core/model-catalog/service.js";
import { ModelCatalogStore } from "../packages/core/src/core/model-catalog/store.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import { createManagedAgyFixture } from "./helpers/agy-runtime-fixture.js";

const fixtureDir = fileURLToPath(new URL("./fixtures/agy-native-capabilities/", import.meta.url));
const fakeCli = path.join(fixtureDir, "fake-native-agy.mjs");
const logger = pino({ level: "silent" }) as unknown as Logger;

function managedProfile(
  root: string,
  credentialScope: string,
  metadataUnavailable = false,
  invocationLog?: string,
) {
  const managed = createManagedAgyFixture({
    source: fakeCli,
    version: "agy fixture 1.1.28",
    credentialScope,
    cwd: root,
    approvedEnvironment: {
      SEAM_AGY_CAPABILITY_FIXTURE_DIR: fixtureDir,
      ...(metadataUnavailable ? { SEAM_AGY_R4B_METADATA_MODE: "unavailable" } : {}),
      ...(invocationLog ? { SEAM_AGY_CAPABILITY_INVOCATIONS: invocationLog } : {}),
    },
  });
  const profile = makeAgyProfile({
    runtime: managed.runtime,
    dataDir: root,
    defaultModel: "fixture-native-model",
    exposeGlobalStaging: false,
  });
  return { managed, profile };
}

describe.sequential("#346 real-session catalog enrichment", () => {
  it("publishes rich LS metadata for the exact binding and never lends it as host evidence", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agy-r4b-publish-"));
    const invocationLog = path.join(root, "invocations.ndjson");
    const local = managedProfile(root, "antigravity-oauth:local", false, invocationLog);
    const peerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agy-r4b-peer-"));
    const peer = managedProfile(peerRoot, "antigravity-oauth:peer");
    const db = path.join(root, "seam.db");
    const catalogStore = new ModelCatalogStore(db);
    const sessionStore = new SessionStore(db);
    const localBinding = { agentId: "agy", location: "local" };
    const peerBinding = { agentId: "agy", location: "other-host" };
    const profiles = new Map<string, AgentProfile>([
      ["local", local.profile],
      ["other-host", peer.profile],
    ]);
    const catalog = new ModelCatalogService({
      store: catalogStore,
      logger,
      bindings: () => [localBinding, peerBinding],
      scope: (binding) => profiles.get(binding.location)!.catalog.scope(),
      fetch: (binding) => profiles.get(binding.location)!.catalog.fetch(),
    });
    const router = new SessionRouter({
      logger,
      store: sessionStore,
      profiles: [local.profile],
      modelCatalog: catalog,
      defaultAgentId: "agy",
      defaultModel: "fixture-native-model",
      defaultCwd: root,
    });
    try {
      expect(await catalog.refresh(localBinding)).toMatchObject({ result: "published", generation: 1 });
      expect(catalog.model(localBinding, "fixture-native-model")?.context.maximum).toBeNull();

      const record = router.ensureSessionRecord({
        platform: "discord",
        channelRef: "agy-r4b",
        cwd: root,
      });
      const runtime = await router.getOrStartRuntime(record);
      await runtime.prompt("capability-turn-one");
      await runtime.idle();

      const learned = catalog.model(localBinding, "fixture-native-model");
      expect(catalog.lookup(localBinding).snapshot?.generation).toBe(2);
      expect(catalog.lookup(localBinding).snapshot?.candidate.source)
        .toBe("agy-models+session-language-server");
      expect(learned).toMatchObject({
        context: { native: 4_096, maximum: 4_096, effective: 4_096 },
        modalities: { input: ["text"], output: ["text"] },
        visionMode: "none",
      });
      expect(learned?.evidence).toEqual([
        expect.objectContaining({
          kind: "live-observation",
          source: "agy language server",
          scopeRef: local.profile.catalog.scope().fingerprint,
          resolvedModel: "fixture-native-model",
          context: expect.objectContaining({ maximum: 4_096 }),
        }),
      ]);
      expect(catalog.resolve(localBinding, { model: "fixture-native-model" }).verification)
        .toBe("binding");
      const invocations = fs.readFileSync(invocationLog, "utf8").trim().split("\n")
        .map((line) => JSON.parse(line) as { pid?: number; scenario: string; args?: string[]; prompt?: string });
      const processes = invocations.filter((entry) => entry.pid !== undefined);
      expect(processes.map((entry) => entry.scenario)).toEqual(["catalog", "turn-one"]);
      expect(processes.filter((entry) => entry.prompt === "capability-turn-one")).toHaveLength(1);
      expect(processes.filter((entry) => (entry.args ?? []).includes("models"))).toHaveLength(1);

      // The exact same agent id on another host may use this as a labeled hint,
      // never as authoritative metadata for that host.
      expect(catalog.models(peerBinding)).toEqual([]);
      expect(catalog.resolve(peerBinding, { model: "fixture-native-model" })).toMatchObject({
        verification: "unverified",
      });
      expect(await catalog.refresh(peerBinding)).toMatchObject({ result: "published", generation: 3 });
      expect(catalog.model(peerBinding, "fixture-native-model")?.context.maximum).toBeNull();
      expect(catalog.resolve(peerBinding, { model: "fixture-native-model" }).verification)
        .toBe("binding");
    } finally {
      await router.disposeAll().catch(() => {});
      sessionStore.close();
      catalogStore.close();
      local.managed.cleanup();
      peer.managed.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(peerRoot, { recursive: true, force: true });
    }
  });

  it("keeps AGY usable with the conservative window when its LS cannot provide metadata", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agy-r4b-unavailable-"));
    const subject = managedProfile(root, "antigravity-oauth:unavailable", true);
    const db = path.join(root, "seam.db");
    const catalogStore = new ModelCatalogStore(db);
    const sessionStore = new SessionStore(db);
    const binding = { agentId: "agy", location: "local" };
    const catalog = new ModelCatalogService({
      store: catalogStore,
      logger,
      bindings: () => [binding],
      scope: () => subject.profile.catalog.scope(),
      fetch: () => subject.profile.catalog.fetch(),
    });
    const router = new SessionRouter({
      logger,
      store: sessionStore,
      profiles: [subject.profile],
      modelCatalog: catalog,
      defaultAgentId: "agy",
      defaultModel: "fixture-native-model",
      defaultCwd: root,
    });
    try {
      await catalog.refresh(binding);
      const record = router.ensureSessionRecord({
        platform: "discord",
        channelRef: "agy-r4b-unavailable",
        cwd: root,
      });
      const runtime = await router.getOrStartRuntime(record);
      const usage: Array<{ used: number; size: number }> = [];
      runtime.onEvent((event) => {
        if (event.kind === "usage-update") usage.push({ used: event.used, size: event.size });
      });

      await expect(runtime.prompt("capability-turn-one")).resolves.toMatchObject({
        stopReason: "end_turn",
        cancelled: false,
      });
      await runtime.idle();

      expect(catalog.lookup(binding).snapshot?.generation).toBe(1);
      expect(catalog.model(binding, "fixture-native-model")?.context.maximum).toBeNull();
      expect(catalog.models(binding).map((model) => model.id)).toEqual([
        "fixture-native-model",
        "fixture-native-model-low",
      ]);
      expect(usage.length).toBeGreaterThan(0);
      expect(usage.every((event) => event.size === AGY_ASSUMED_CONTEXT_WINDOW)).toBe(true);
    } finally {
      await router.disposeAll().catch(() => {});
      sessionStore.close();
      catalogStore.close();
      subject.managed.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

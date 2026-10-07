import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import type { AgentProfile } from "@seam/adapters";
import { PresetsFileSchema, type Config, type ThreadPreset } from "../packages/core/src/config.js";
import { createConfigFacades } from "../packages/core/src/core/config-apply-plan.js";
import { ConfigMutationService } from "../packages/core/src/core/config-mutation.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { passthroughCatalog } from "./catalog-passthrough-fixture.js";
import { localBridgeWiring } from "./local-bridge-fixture.js";

const boundary = vi.hoisted(() => ({
  attempts: [] as Array<{ model?: string; effort?: string }>,
  rejection: undefined as Error | undefined,
}));

// Only the provider boundary is synthetic. Catalog resolution, overlays,
// session acquisition and each public transition use their real services.
vi.mock("../packages/core/src/agents/agent-runtime.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../packages/core/src/agents/agent-runtime.js")>();
  return { ...actual, AgentRuntime: class {
    modelOverride?: string;
    effortOverride?: string;
    busy = false;
    sessionId = "";
    lastActivityAtMs = Date.now();
    async start() {
      boundary.attempts.push({ model: this.modelOverride, effort: this.effortOverride });
      if (boundary.rejection) throw boundary.rejection;
    }
    async loadSession(input: { sessionId: string }) { this.sessionId = input.sessionId; }
    async newSession() { this.sessionId = "fresh-provider-session"; return { sessionId: this.sessionId }; }
    getSessionInfo() { return { sessionId: this.sessionId, currentModelId: this.modelOverride, availableModels: [] }; }
    async dispose() {}
    async setModel(model: string) { this.modelOverride = model; }
    async setConfigOption() {}
  } };
});

const logger = pino({ level: "silent" });
const typed = "My-Typed-Model";
const paths = ["command", "configure_thread", "migrate_self"] as const;
const cleanup: Array<() => Promise<void> | void> = [];
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-model-parity-"));
  boundary.attempts.length = 0;
  boundary.rejection = undefined;
});
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function fixture(warm: boolean) {
  const cache = await passthroughCatalog(warm, "local");
  cleanup.push(cache.close);
  const store = new SessionStore(path.join(dir, "seam.db"));
  cleanup.push(() => store.close());
  const profile = { id: "claude", defaultModel: "known", effort: { mechanism: "meta", levels: ["low", "high"] } } as AgentProfile;
  const previousPreset: ThreadPreset = { effort: { value: "low" } };
  const threadPresets = new Map<string, ThreadPreset>([["worker", previousPreset]]);
  const presetsFile = path.join(dir, "presets.json");
  fs.writeFileSync(presetsFile, JSON.stringify({ channels: {}, threads: { worker: previousPreset } }));
  const router = new SessionRouter({
    logger, store, profiles: [profile], modelCatalog: cache.catalog, threadPresets,
    defaultAgentId: "claude", defaultModel: "known", seamMcp: localBridgeWiring(profile),
  });
  const initial = router.ensureSessionRecord({ platform: "discord", channelRef: "worker", parentRef: "parent", cwd: dir });
  store.upsert({ ...initial, acpSessionId: "existing-provider-session", configJson: JSON.stringify({ model: "known", reasoningEffort: "low" }) });
  const mutation = new ConfigMutationService({
    logger, store, modelCatalog: cache.catalog, describeConfig: row => router.describeConfig(row), presetsFile,
    isAgentAvailable: id => id === "claude", ollamaCloudEnabled: false,
    reloadPresets: () => {
      const doc = PresetsFileSchema.parse(JSON.parse(fs.readFileSync(presetsFile, "utf8")));
      threadPresets.clear();
      for (const [id, preset] of Object.entries(doc.threads ?? {})) threadPresets.set(id, preset);
      return { ok: true };
    },
  });
  const { runtime } = createConfigFacades({
    store, router, mutation, modelCatalog: cache.catalog, logger,
    config: { REPOS_ROOT: dir, channelPresets: new Map(), threadPresets } as Config,
    identityCommitted: async () => {},
    persistConfig: (row, cfg) => store.upsert({ ...row, configJson: store.writeConfig(cfg) }),
    repoDisplay: repo => repo ?? "", unregisteredAgentMessage: (_id, message) => message,
    parkedSelectMessage: () => null,
  });
  cleanup.push(() => router.invalidate(initial.id));
  const record = () => store.get(initial.id)!;
  const replies: string[] = [];
  const apply = async (route: typeof paths[number], model = typed, effort?: string) => {
    if (route === "command") {
      const selected = await runtime.applyModelChange({ platform: "discord", id: initial.channelRef, parentId: "parent" }, record(), model,
        { id: "operator", name: "Operator" }, async text => { replies.push(text); });
      expect(selected).toMatchObject({ ok: true });
      return router.getOrStartRuntime(record());
    }
    if (route === "configure_thread") return runtime.configure(record(), record(), { model, effort });
    const prepared = await runtime.prepareSelfMigration(record(), { model, effort, manifest: "Continue." });
    expect(prepared).toMatchObject({ ok: true });
    if (!prepared.ok) throw new Error(prepared.error);
    return runtime.executeSelfMigration(record(), prepared.migration);
  };
  return { apply, record, store, threadPresets, replies };
}

describe.each([false, true])("unlisted model path parity (warm catalog=%s)", warm => {
  it.each(paths)("%s sends the exact typed id without inventing effort defaults", async route => {
    const h = await fixture(warm);
    const result = await h.apply(route);
    expect(boundary.attempts).toEqual([{ model: typed, effort: undefined }]);
    expect(h.store.readConfig(h.record()).model).toBe(typed);
    expect(h.store.readConfig(h.record()).reasoningEffort).toBeUndefined();
    expect(h.threadPresets.get("worker")?.model?.value).toBe(typed);
    if (route === "command") expect(h.replies[0]).toContain("unverified");
    if (route === "configure_thread") expect(result).toMatchObject({ ok: true, verification: "unverified" });
    if (route === "migrate_self") expect(result).toMatchObject({ ok: true, model: typed, warnings: [expect.stringContaining("unverified")] });
  });

  it.each(paths)("%s surfaces the provider's own rejection rather than a cache refusal", async route => {
    const h = await fixture(warm);
    const previous = { ...h.record() };
    const cause = Object.assign(new Error(`Provider rejected model '${typed}': model does not exist (HTTP 400)`), { code: 400 });
    boundary.rejection = cause;
    if (route === "migrate_self") {
      expect(await h.apply(route)).toEqual({ ok: false, error: cause.message });
      expect(h.record()).toEqual(previous);
      expect(h.threadPresets.get("worker")).toEqual({ effort: { value: "low" } });
    } else {
      await expect(h.apply(route)).rejects.toBe(cause);
    }
    expect(boundary.attempts).toEqual([{ model: typed, effort: undefined }]);
  });
});

describe("listed model behavior and explicit unlisted effort", () => {
  it.each(paths)("%s still canonicalizes listed aliases and applies their default effort", async route => {
    const h = await fixture(true);
    h.store.upsert({ ...h.record(), configJson: JSON.stringify({ model: "old-provider-model", reasoningEffort: "low" }) });
    await h.apply(route, "Known-Alias");
    expect(boundary.attempts).toEqual([{ model: "known", effort: undefined }]);
    expect(h.store.readConfig(h.record())).toMatchObject({ model: "known", reasoningEffort: "default" });
    expect(h.threadPresets.get("worker")?.effort?.value).toBe("default");
  });

  it.each(["configure_thread", "migrate_self"] as const)("%s forwards explicit effort for an unlisted model", async route => {
    const h = await fixture(false);
    await h.apply(route, typed, "high");
    expect(boundary.attempts).toEqual([{ model: typed, effort: "high" }]);
    expect(h.store.readConfig(h.record())).toMatchObject({ model: typed, reasoningEffort: "high" });
  });
});

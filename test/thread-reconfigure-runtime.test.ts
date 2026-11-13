import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { readErrorClassification, unclassified, type AgentAdapter } from "@seam/adapters";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import { PresetsFileSchema, type Config, type ThreadPreset } from "../packages/core/src/config.js";
import { createConfigFacades } from "../packages/core/src/core/config-apply-plan.js";
import { ConfigMutationService } from "../packages/core/src/core/config-mutation.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { ThreadReconfiguration } from "../packages/core/src/core/thread-reconfigure.js";
import type { BulkPlan } from "../packages/core/src/plugins/thread-reconfigure/ports.js";
import type { ModelMetadata } from "../packages/core/src/core/model-metadata/types.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { localBridgeWiring } from "./local-bridge-fixture.js";

const logger = pino({ level: "silent" });
const actor = { id: "operator", name: "Operator" };
const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); vi.restoreAllMocks(); });
const fast = (currentValue: string) => ({ id: "fast", name: "Fast", type: "select", currentValue,
  options: [{ value: "on", name: "On" }, { value: "off", name: "Off" }] });

async function fixture(options: { fallback?: boolean; fastMode?: boolean; echo?: "missing-fast" | "none" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-bulk-runtime-"));
  const store = new SessionStore(path.join(dir, "seam.db"));
  const threadPresets = new Map<string, ThreadPreset>();
  // Live Fast is deliberate: this exercises the retained model setter rather
  // than the distinct fresh-session transition covered by thread-reconfigure.
  const profile = { id: "claude", defaultModel: "old",
    staticModels: ["old", "new", "sibling"].map(modelId => ({ modelId, name: modelId, contextLimit: 1_000_000 })),
    fastMode: { configId: "fast", onValue: "on", offValue: "off", applicationMode: "live" },
    classifyError: (error: unknown) => readErrorClassification(error) ?? unclassified("claude"),
    spawn: () => { throw new Error("No provider process allowed"); },
  } as unknown as AgentAdapter;
  let switching = false;
  const conn = {
    newSession: vi.fn(async () => ({ sessionId: "fixture-session", configOptions: [fast("off")] })),
    setSessionConfigOption: vi.fn(async ({ configId, value }: { configId: string; value: string }) => {
      if (switching && options.fallback && value === "new") throw Object.assign(new Error("Requested model unavailable"),
        { data: { errorKind: "model_not_found", agentId: "claude" } });
      if (switching && options.echo === "none") return {};
      return { configOptions: switching && options.echo === "missing-fast" ? [] : [fast(configId === "fast" ? value : options.fastMode ? "on" : "off")] };
    }),
  };
  vi.spyOn(AgentRuntime.prototype, "start").mockImplementation(async function () {
    Object.assign(this, { connection: conn, promptCapabilities: {} });
  });
  const metadata = (id: string): ModelMetadata => ({ id, name: id, aliases: [], slug: null, source_id: null, source_name: null,
    provider: "Fixture", creator: null, agents: ["claude"], agent_models: [], context_window: 1_000_000,
    intelligence_index: 60, benchmarks: {}, pricing: null, released_at: "2026-09-01", description: null,
    evidence: [], source: "fixture", fetched_at: "2026-09-21" });
  const catalog = fixtureModelCatalog([profile]);
  const config = { REPOS_ROOT: dir, CHANNEL_PRESETS_FILE: path.join(dir, "presets.json"),
    DISCORD_ALLOWED_USER_IDS: new Set([actor.id]), channelPresets: new Map(), threadPresets } as unknown as Config;
  fs.writeFileSync(config.CHANNEL_PRESETS_FILE!, JSON.stringify({ threads: {} }));
  const router = new SessionRouter({ store, logger, profiles: [profile], modelCatalog: catalog, threadPresets,
    modelMetadata: { getAll: () => [metadata("new"), metadata("sibling")] },
    defaultAgentId: "claude", defaultModel: "old", seamMcp: localBridgeWiring(profile) });
  close.push(async () => { await router.disposeAll(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const mutation = new ConfigMutationService({ store, logger, modelCatalog: catalog,
    describeConfig: record => router.describeConfig(record), presetsFile: config.CHANNEL_PRESETS_FILE,
    isAgentAvailable: id => !!router.getProfile(id), ollamaCloudEnabled: true,
    reloadPresets: () => {
      const doc = PresetsFileSchema.parse(JSON.parse(fs.readFileSync(config.CHANNEL_PRESETS_FILE!, "utf8")));
      threadPresets.clear(); for (const [id, preset] of Object.entries(doc.threads ?? {})) threadPresets.set(id, preset);
      return { ok: true };
    } });
  const facades = createConfigFacades({ store, router, mutation, modelCatalog: catalog, logger, config,
    identityCommitted: async () => {}, persistConfig: (row, cfg) => store.upsert({ ...row, configJson: JSON.stringify(cfg) }),
    repoDisplay: repo => repo ?? "", unregisteredAgentMessage: (_id, fallback) => fallback, parkedSelectMessage: () => null });
  const record = router.ensureSessionRecord({ platform: "discord", channelRef: "1000", parentRef: "200", cwd: dir });
  store.upsert({ ...record, configJson: JSON.stringify({ model: "old", fastMode: options.fastMode === true }) });
  const initial = facades.plan.applyThreadOverlay({ threadId: "1000", parentRef: "200", actor,
    changes: { model: "old", fastMode: options.fastMode === true } });
  expect(initial, JSON.stringify(initial)).toMatchObject({ ok: true });
  const row = () => store.get(record.id)!;
  const runtime = await router.getOrStartRuntime(row());
  expect(runtime).toBeInstanceOf(AgentRuntime);
  expect(runtime.getFastModeOutcome()).toEqual({ requested: options.fastMode === true, applied: options.fastMode === true });
  const adapter = { configParentChannels: async () => [{ id: "200", guildId: "300" }],
    configurationThread: async () => ({ name: "Fixture", parentId: "200", guildId: "300" }),
    getThreadLiveState: async () => ({ archived: false, locked: false }) };
  const service = new ThreadReconfiguration({ store, router, config, adapter: adapter as never,
    runtime: () => facades.runtime, plan: () => facades.plan, allowed: () => true, busy: () => false });
  const request = { scope: "all" as const, targetModel: "new" };
  const plan: BulkPlan = { id: "fixture-plan", actor, origin: "origin", request, ...await service.preview(actor, request) };
  expect(plan.rows[0].status).toBe("eligible");
  switching = true; conn.setSessionConfigOption.mockClear();
  return { runtime, conn, router, row, store, apply: () => service.apply(actor, plan) };
}

describe("bulk results from the real AgentRuntime ACP selection boundary", () => {
  it("keeps the requested config when allowed fallback selects a different model, and reports its existing notice", async () => {
    const h = await fixture({ fallback: true });
    const [result] = await h.apply();
    expect(result, JSON.stringify(result)).toMatchObject({ status: "changed", saved: true });
    expect(h.conn.setSessionConfigOption.mock.calls.map(([p]) => p.value)).toEqual(["new", "sibling"]);
    expect(h.runtime.getSessionInfo()?.currentModelId).toBe("sibling");
    expect(h.router.describeConfig(h.row()).model.value).toBe("new");
    expect(result).toMatchObject({ status: "changed", saved: true, after: { model: "new" }, runtime: "unverified",
      runtimeSelection: { model: "sibling", fastMode: { requested: false, applied: false } } });
    expect(result.warnings).toContain(h.runtime.getLastModelFallbackNotice());
    expect(result.warnings?.join(" ")).toContain("new");
    expect(result.warnings?.join(" ")).toContain("sibling");
  });
  it.each([
    { echo: "missing-fast" as const, applied: false, error: /no longer offered/ },
    { echo: "none" as const, applied: null, error: /could not be re-checked/ },
  ])("retains the successful model switch and the actual Fast $applied cause", async ({ echo, applied, error }) => {
    const h = await fixture({ fastMode: true, echo });
    const [result] = await h.apply();
    expect(result, JSON.stringify(result)).toMatchObject({ status: "changed", saved: true });
    expect(h.conn.setSessionConfigOption.mock.calls.map(([p]) => p.value)).toEqual(["new"]);
    expect(h.runtime.getSessionInfo()?.currentModelId).toBe("new");
    expect(h.runtime.getFastModeOutcome()).toMatchObject({ requested: true, applied, error: expect.stringMatching(error) });
    expect(h.router.describeConfig(h.row()).fastMode.value).toBe(true);
    expect(result).toMatchObject({ status: "changed", saved: true, after: { model: "new", fastMode: true }, runtime: "unverified",
      runtimeSelection: { model: "new", fastMode: { requested: true, applied, error: expect.stringMatching(error) } } });
  });
  it("reports observed Fast off separately from the saved identity without making another ACP call", async () => {
    const h = await fixture(); const [result] = await h.apply();
    expect(result, JSON.stringify(result)).toMatchObject({ status: "changed", saved: true });
    expect(h.conn.setSessionConfigOption.mock.calls.map(([p]) => [p.configId, p.value])).toEqual([["model", "new"]]);
    expect(result).toMatchObject({ saved: true, after: { model: "new", fastMode: false },
      runtimeSelection: { model: "new", fastMode: { requested: false, applied: false } } });
  });
});

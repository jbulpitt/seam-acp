import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { readErrorClassification, unclassified, type AgentProfile } from "@seam/adapters";
import { AgentRuntime, type AgentEvent } from "../packages/core/src/agents/agent-runtime.js";
import { SessionRouter, type SeamMcpWiring } from "../packages/core/src/core/session-router.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import type { ModelMetadata } from "../packages/core/src/core/model-metadata/types.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";

const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const f of cleanup.splice(0).reverse()) f(); });
const rejection = () => Object.assign(new Error("model unavailable"), { data: { agentId: "claude", errorKind: "model_not_found" } });
function setup(location: string, existing = true, failAt: "spawn" | "selection" = "spawn") {
  const dir = mkdtempSync(join(tmpdir(), "model-acquisition-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "test.db");
  let store = new SessionStore(db);
  cleanup.push(() => store.close());
  const localSpawns = vi.fn(); const remoteSpawns = vi.fn();
  const select = vi.fn(async ({ value }: { value: string }) => { if (value === "original") throw rejection(); return { configOptions: [] }; });
  const load = vi.fn(async () => ({ configOptions: [] }));
  const create = vi.fn(async () => ({ sessionId: "history", configOptions: [] }));
  const prompt = vi.fn(async () => ({ stopReason: "end_turn" }));
  const profile = { id: "claude", defaultModel: "original", effort: { mechanism: "spawnArgs", levels: ["high"] },
    staticModels: ["original", "sibling"].map(modelId => ({ modelId, name: modelId, contextLimit: 1_000_000 })),
    classifyError: (error: unknown) => readErrorClassification(error) ?? unclassified("claude"),
    spawn: (model: string) => { localSpawns(model); if (model === "original" && failAt === "spawn") throw rejection(); return {}; },
  } as unknown as AgentProfile;
  const mux = { spawn: () => ({ slot: 3, kill: vi.fn() }), releaseStdin: vi.fn(),
    rpc: async (_method: string, args: any) => { remoteSpawns(args.model); if (args.model === "original" && failAt === "spawn") throw rejection(); return { ok: true }; },
  };
  const metadata = ["original", "sibling"].map(id => ({ id, name: id, aliases: [], provider: "same-vendor", creator: null,
    agents: ["claude"], agent_models: [], context_window: 1_000_000, intelligence_index: null, benchmarks: {},
    pricing: null, released_at: null, evidence: [], source: "fixture" } as unknown as ModelMetadata));
  const now = new Date().toISOString();
  store.upsert({ id: "discord:worker", platform: "discord", channelRef: "worker", parentRef: null,
    agentId: "claude", acpSessionId: existing ? "history" : "", repoPath: dir, createdUtc: now, updatedUtc: now,
    configJson: JSON.stringify({ model: "original", reasoningEffort: "high", location,
      lastContextUsage: { budget: { agentId: "claude", location, acpSessionId: "history", model: "original",
        requestedTier: null, observedTier: null, used: 400_000, promptBudget: 1_000_000, totalWindow: null,
        outputAllocation: null, source: "acp-usage", atUtc: now, previousPromptBudget: null } } }) });
  vi.spyOn(AgentRuntime.prototype, "start").mockImplementation(async function () {
    await (this as any).spawnFn(this.modelOverride, this.effortOverride);
    Object.assign(this, { connection: { loadSession: load, newSession: create, setSessionConfigOption: select, prompt },
      promptCapabilities: {}, loadSessionSupported: true });
  });
  const make = () => new SessionRouter({ logger: pino({ level: "silent" }), store, profiles: [profile],
    modelCatalog: fixtureModelCatalog([profile]), modelMetadata: { getAll: () => metadata },
    defaultAgentId: "claude", defaultModel: "original", threadPresets: new Map([["worker", { location }]]), ...(location === "local" ? {} : {
      seamMcp: { getPort: () => undefined, isRemoteSession: () => true, bindSessionLocation: vi.fn(), muxForSession: () => mux } as unknown as SeamMcpWiring,
    }) });
  return { make, profile, metadata, get store() { return store; }, localSpawns, remoteSpawns, select, load, create, prompt,
    reopen: () => { store.close(); store = new SessionStore(db); } };
}

describe("production acquisition with persisted model selection", () => {
  it.each(["local", "remote-one"])("reopens SQL and loads the same conversation on %s, with notice and no original replay", async location => {
    const h = setup(location);
    const rt = await h.make().getOrStartRuntime(h.store.get("discord:worker")!, { resumeSessionId: "history" });
    expect(rt.getSessionInfo()).toMatchObject({ sessionId: "history", currentModelId: "sibling" });
    expect(h.create).not.toHaveBeenCalled();
    expect(h.prompt).not.toHaveBeenCalled();
    const spawns = location === "local" ? h.localSpawns : h.remoteSpawns;
    expect(spawns.mock.calls.map(c => c[0])).toEqual(["original", "sibling"]);
    expect((location === "local" ? h.remoteSpawns : h.localSpawns)).not.toHaveBeenCalled();
    const cfg = h.store.readConfig(h.store.get("discord:worker")!);
    expect(cfg.model).toBe("original");
    expect(cfg.modelAcquisition).toMatchObject({ phase: "selected", index: 0, identity: { acpSessionId: "history", location } });
    await rt.dispose(); h.reopen(); spawns.mockClear();
    const resumed = await h.make().getOrStartRuntime(h.store.get("discord:worker")!, { resumeSessionId: "history" });
    expect(spawns.mock.calls.map(c => c[0])).toEqual(["sibling"]);
    expect(h.load.mock.calls).toHaveLength(2);
    expect(h.create).not.toHaveBeenCalled();
    const events: AgentEvent[] = []; resumed.onEvent(event => { events.push(event); });
    await resumed.prompt("continue");
    expect(events).toContainEqual({ kind: "recovery", message: cfg.modelAcquisition!.plan.alternatives[0]!.notice });
    expect(h.prompt.mock.calls).toHaveLength(1);
    expect(JSON.stringify(h.prompt.mock.calls)).toContain("continue");
    await resumed.dispose();
  });
  it("commits a fresh startup's ACP id and model decision together before prompting", async () => {
    const h = setup("local", false);
    const rt = await h.make().getOrStartRuntime(h.store.get("discord:worker")!);
    const row = h.store.get("discord:worker")!;
    expect(row.acpSessionId).toBe("history");
    expect(h.store.readConfig(row).modelAcquisition?.identity.acpSessionId).toBe("history");
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.prompt).not.toHaveBeenCalled();
    await rt.dispose();
  });
  it("moves a model refusal during load to one replacement child, never to session/new", async () => {
    const h = setup("local", true, "selection");
    const rt = await h.make().getOrStartRuntime(h.store.get("discord:worker")!, { resumeSessionId: "history" });
    expect(h.load).toHaveBeenCalledTimes(2);
    expect(h.select.mock.calls.map(c => c[0].value)).toEqual(["original", "sibling"]);
    expect(h.localSpawns.mock.calls.map(c => c[0])).toEqual(["original", "sibling"]);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.prompt).not.toHaveBeenCalled();
    await rt.dispose();
  });
  it("will not announce or prompt a substitute whose configuration was not applied", async () => {
    const h = setup("local", false);
    h.select.mockRejectedValue(new Error("config transport disconnected"));
    await expect(h.make().getOrStartRuntime(h.store.get("discord:worker")!)).rejects.toThrow("failed to set initial model");
    expect(h.store.readConfig(h.store.get("discord:worker")!).modelAcquisition?.phase).toBe("trying");
    expect(h.prompt).not.toHaveBeenCalled();
  });
  it("uses an identity-matched selected-model capacity sample, never one from another session", async () => {
    const h = setup("local");
    const rt = await h.make().getOrStartRuntime(h.store.get("discord:worker")!, { resumeSessionId: "history" });
    await rt.dispose();
    const row = h.store.get("discord:worker")!;
    const cfg = h.store.readConfig(row);
    const budget = cfg.lastContextUsage!.budget!;
    budget.model = "sibling"; budget.promptBudget = 2_000_000;
    budget.acpSessionId = "other-history";
    h.store.upsert({ ...row, configJson: JSON.stringify(cfg) });
    const unaffected = await h.make().getOrStartRuntime(h.store.get(row.id)!, { resumeSessionId: "history" });
    await unaffected.dispose();
    budget.acpSessionId = "history";
    h.store.upsert({ ...h.store.get(row.id)!, configJson: JSON.stringify(cfg) });
    h.localSpawns.mockClear();
    await expect(h.make().getOrStartRuntime(h.store.get(row.id)!, { resumeSessionId: "history" }))
      .rejects.toMatchObject({ acquisitionRecoveryExhausted: true });
    expect(h.localSpawns).not.toHaveBeenCalled();
  });
  it("keeps a boot budget exhausted but lets a new user turn retry a repaired original", async () => {
    const h = setup("local", true, "selection");
    h.select.mockRejectedValue(rejection());
    await expect(h.make().getOrStartRuntime(h.store.get("discord:worker")!, { resumeSessionId: "history" }))
      .rejects.toMatchObject({ acquisitionRecoveryExhausted: true });
    h.localSpawns.mockClear();
    await expect(h.make().getOrStartRuntime(h.store.get("discord:worker")!, { resumeSessionId: "history" }))
      .rejects.toMatchObject({ acquisitionRecoveryExhausted: true });
    expect(h.localSpawns).not.toHaveBeenCalled();
    h.select.mockResolvedValue({ configOptions: [] });
    const rt = await h.make().getOrStartRuntime(h.store.get("discord:worker")!);
    expect(h.localSpawns.mock.calls.map(c => c[0])).toEqual(["original"]);
    expect(h.store.readConfig(h.store.get("discord:worker")!).modelAcquisition).toBeUndefined();
    await rt.dispose();
  });
  it("does not use an original-model sample to shrink history after a larger substitution", async () => {
    const h = setup("local", true, "selection");
    const models = h.profile.staticModels as Array<{ modelId: string; name: string; contextLimit: number }>;
    models[1]!.contextLimit = 2_000_000;
    h.metadata[1]!.context_window = 2_000_000;
    models.push({ modelId: "smaller", name: "smaller", contextLimit: 1_000_000 });
    h.metadata.push({ ...h.metadata[1]!, id: "smaller", name: "smaller", context_window: 1_000_000 });
    const rt = await h.make().getOrStartRuntime(h.store.get("discord:worker")!, { resumeSessionId: "history" });
    await rt.dispose(); h.reopen(); h.localSpawns.mockClear();
    h.select.mockImplementation(async ({ value }) => {
      if (value === "sibling") throw rejection();
      return { configOptions: [] };
    });
    // Die after durably advancing past the larger model, before checking the
    // smaller candidate. The next process must retain the larger history bound.
    const upsert = h.store.upsert.bind(h.store);
    vi.spyOn(h.store, "upsert").mockImplementation(row => {
      upsert(row);
      const state = h.store.readConfig(row).modelAcquisition;
      if (state?.index === 1 && state.phase === "trying") throw new Error("crash after rejection");
    });
    await expect(h.make().getOrStartRuntime(h.store.get("discord:worker")!, { resumeSessionId: "history" }))
      .rejects.toThrow("crash after rejection");
    h.reopen();
    await expect(h.make().getOrStartRuntime(h.store.get("discord:worker")!, { resumeSessionId: "history" }))
      .rejects.toMatchObject({ acquisitionRecoveryExhausted: true });
    expect(h.localSpawns.mock.calls.map(c => c[0])).toEqual(["sibling"]);
    expect(h.store.readConfig(h.store.get("discord:worker")!).modelAcquisition?.plan.requiredContextTokens).toBe(2_000_000);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.prompt).not.toHaveBeenCalled();
  });
});

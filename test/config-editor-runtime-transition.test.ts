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
import { snapshotFromDescribe, type DraftOverlay, type ThreadConfigDraft } from "../packages/core/src/platforms/discord/config-editor.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { localBridgeWiring } from "./local-bridge-fixture.js";

// Only the provider boundary is synthetic; Save, overlays, audits and runtime
// acquisition use their production implementations.
vi.mock("../packages/core/src/agents/agent-runtime.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../packages/core/src/agents/agent-runtime.js")>();
  return { ...actual, AgentRuntime: class {
    modelOverride?: string;
    effortOverride?: string;
    disposed = false;
    busy = false;
    lastActivityAtMs = Date.now();
    sessionId = "";
    finishPrompt?: () => void;
    rejectPrompt?: (err: Error) => void;
    constructor(readonly options: { profile: AgentProfile }) {}
    async start() {}
    markActivity() { this.lastActivityAtMs = Date.now(); }
    async loadSession(input: { sessionId: string }) { this.sessionId = input.sessionId; }
    async newSession() { this.sessionId = `fresh-${this.options.profile.id}`; return { sessionId: this.sessionId }; }
    getSessionInfo() { return { sessionId: this.sessionId, currentModelId: this.modelOverride }; }
    async dispose() {
      this.disposed = true;
      this.rejectPrompt?.(new Error("provider disposed during prompt"));
    }
    async prompt() {
      this.busy = true;
      try {
        await new Promise<void>((resolve, reject) => {
          this.finishPrompt = resolve;
          this.rejectPrompt = reject;
        });
        return {
          stopReason: "end_turn", cancelled: false,
          agent: this.options.profile.id, model: this.modelOverride, effort: this.effortOverride,
        };
      } finally {
        this.busy = false;
        this.finishPrompt = this.rejectPrompt = undefined;
      }
    }
    async setModel(model: string) { this.modelOverride = model; }
    async setConfigOption(_id: string, value: string) { this.effortOverride = value; }
  } };
});

const logger = pino({ level: "silent" });
const actor = { id: "operator", name: "Operator" };
const threadId = "111111111111111111";
const parentRef = "222222222222222222";
const profiles = ["claude", "codex", "ollama-cloud", "copilot", "agy"].map(id => ({
  id, defaultModel: "old", staticModels: ["old", "new"].map(modelId => ({ modelId, name: modelId })),
  effort: id === "copilot" || id === "codex"
    ? { mechanism: "configOption", configId: "effort", levels: ["low", "high"] }
    : { mechanism: "meta", levels: ["low", "high"] },
})) as unknown as AgentProfile[];
let dir: string;
let store: SessionStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-editor-runtime-"));
  store = new SessionStore(path.join(dir, "seam.db"));
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function fixture(agent = "claude") {
  const modelCatalog = fixtureModelCatalog(profiles);
  const threadPresets = new Map<string, ThreadPreset>();
  const presetsFile = path.join(dir, "presets.json");
  fs.writeFileSync(presetsFile, JSON.stringify({ channels: {}, threads: {} }));
  const router = new SessionRouter({
    store, logger, profiles, modelCatalog, threadPresets, defaultAgentId: agent,
    defaultModel: "old", defaultPermissionMode: "ask", seamMcp: localBridgeWiring(profiles),
  });
  const row = router.ensureSessionRecord({ platform: "discord", channelRef: threadId, parentRef, cwd: dir });
  store.upsert({ ...row, acpSessionId: "existing-context", configJson: JSON.stringify({ model: "old", reasoningEffort: "low" }) }, { source: "fixture", cause: "set provider binding for test" });
  const record = store.get(row.id)!;
  const warm = await router.getOrStartRuntime(record);
  const mutation = new ConfigMutationService({
    store, logger, modelCatalog, describeConfig: row => router.describeConfig(row), presetsFile,
    isAgentAvailable: id => Boolean(router.getProfile(id)), ollamaCloudEnabled: true,
    reloadPresets: () => {
      const doc = PresetsFileSchema.parse(JSON.parse(fs.readFileSync(presetsFile, "utf8")));
      threadPresets.clear();
      for (const [id, preset] of Object.entries(doc.threads ?? {})) threadPresets.set(id, preset);
      return { ok: true };
    },
  });
  const { plan } = createConfigFacades({
    store, router, mutation, modelCatalog, logger,
    config: { REPOS_ROOT: dir, channelPresets: new Map(), threadPresets } as Config,
    identityCommitted: async () => {}, persistConfig: () => {}, repoDisplay: repo => repo ?? "",
    unregisteredAgentMessage: (_id, fallback) => fallback, parkedSelectMessage: () => null,
  });
  const d = router.describeConfig(record);
  const draft: ThreadConfigDraft = {
    id: "draft", threadId, parentRef, userId: actor.id,
    createdAt: Date.now(), updatedAt: Date.now(), warnings: [], overlay: {},
    snapshot: snapshotFromDescribe(d, {
      location: d.location.value, agent: d.agent.value, model: d.model.value, effort: d.effort.value,
      cwd: d.cwd.value, permission: d.permission.value, detached: d.detached.value,
      fastMode: false, statusCardStyle: "full", simpleCardGif: false, role: null, disableThreadPrefix: false,
    }),
  };
  return {
    router, record, warm,
    save: (overlay: DraftOverlay) => plan.saveEditor({ ...draft, overlay }, actor, () => true),
    next: () => router.getOrStartRuntime(store.get(record.id)!),
  };
}

describe("warm config editor Save", () => {
  it.each([
    ["claude", { agent: "codex", model: "new", effort: "high" }, "codex", "new", "high", "fresh-codex"],
    ["codex", { model: "new" }, "codex", "new", "low", "fresh-codex"],
    ["claude", { model: "new" }, "claude", "new", "low", "existing-context"],
    ["copilot", { model: "new" }, "copilot", "new", "low", "existing-context"],
    ["claude", { effort: "high" }, "claude", "old", "high", "existing-context"],
    ["codex", { effort: "high" }, "codex", "old", "high", "existing-context"],
  ] as const)("keeps an in-flight %s turn alive when saving %j, then applies the next selection", async (agent, overlay, nextAgent, model, effort, sessionId) => {
    const h = await fixture(agent);
    const running = h.warm.prompt("old turn");
    expect(h.warm.busy).toBe(true);
    expect((await h.save(overlay)).ok).toBe(true);
    expect((h.warm as any).disposed).toBe(false);
    expect(store.get(h.record.id)?.acpSessionId).toBe("existing-context");
    expect(await h.next()).toBe(h.warm);

    (h.warm as any).finishPrompt();
    expect(await running).toMatchObject({ stopReason: "end_turn", cancelled: false, agent, model: "old", effort: "low" });
    const acquiredRecord = store.get(h.record.id)!;
    const next = await h.router.getOrStartRuntime(acquiredRecord);
    expect(next.getSessionInfo()?.sessionId).toBe(sessionId);
    expect(acquiredRecord.acpSessionId).toBe(sessionId);
    const following = next.prompt("next turn");
    (next as any).finishPrompt();
    expect(await following).toMatchObject({ stopReason: "end_turn", cancelled: false, agent: nextAgent, model, effort });
    expect(store.listConfigMutations()).toHaveLength(1);
  });

  it("coalesces in-flight saves against the original runtime and uses the latest selection", async () => {
    const h = await fixture();
    const running = h.warm.prompt("old turn");
    expect((await h.save({ agent: "codex", model: "old" })).ok).toBe(true);
    expect((await h.save({ agent: "codex", model: "new", effort: "high" })).ok).toBe(true);
    (h.warm as any).finishPrompt();
    expect(await running).toMatchObject({ agent: "claude", model: "old" });
    const next = await h.next();
    expect(next.getSessionInfo()).toMatchObject({ sessionId: "fresh-codex", currentModelId: "new" });
    expect(next.effortOverride).toBe("high");
    expect(store.listConfigMutations()).toHaveLength(2);
  });

  it("keeps the original runtime when in-flight saves return to its selection", async () => {
    const h = await fixture();
    const running = h.warm.prompt("old turn");
    expect((await h.save({ agent: "codex", model: "new" })).ok).toBe(true);
    expect((await h.save({ agent: "claude", model: "old", effort: "low" })).ok).toBe(true);
    (h.warm as any).finishPrompt();
    expect(await running).toMatchObject({ agent: "claude", model: "old" });
    expect(await h.next()).toBe(h.warm);
    expect((h.warm as any).disposed).toBe(false);
  });

  it.each(["claude", "agy"])("switches a warm %s runtime to Codex on the next acquisition, with one audit row", async agent => {
    const h = await fixture(agent);
    expect((await h.save({ agent: "codex", model: "new", effort: "high" })).ok).toBe(true);
    const next = await h.next();
    expect(next).not.toBe(h.warm);
    expect((next as any).options.profile.id).toBe("codex");
    expect(next.getSessionInfo()).toMatchObject({ sessionId: "fresh-codex", currentModelId: "new" });
    expect(next.effortOverride).toBe("high");
    expect(store.listConfigMutations()).toEqual([expect.objectContaining({ actorId: actor.id, tier: "thread-preset" })]);
  });

  it.each(["codex", "ollama-cloud"])("starts a fresh %s session for a model change", async agent => {
    const h = await fixture(agent);
    expect((await h.save({ model: "new" })).ok).toBe(true);
    const next = await h.next();
    expect(next).not.toBe(h.warm);
    expect(next.getSessionInfo()).toMatchObject({ sessionId: `fresh-${agent}`, currentModelId: "new" });
  });

  it("reloads a catalog reload model with the existing context", async () => {
    const h = await fixture();
    expect((await h.save({ model: "new" })).ok).toBe(true);
    const next = await h.next();
    expect(next).not.toBe(h.warm);
    expect(next.getSessionInfo()).toMatchObject({ sessionId: "existing-context", currentModelId: "new" });
  });

  it("applies a catalog live model without replacing the runtime", async () => {
    const h = await fixture("copilot");
    expect((await h.save({ model: "new" })).ok).toBe(true);
    const next = await h.next();
    expect(next).toBe(h.warm);
    expect(next.getSessionInfo()).toMatchObject({ sessionId: "existing-context", currentModelId: "new" });
  });

  it.each(["claude", "codex"])("applies %s effort without clearing context", async agent => {
    const h = await fixture(agent);
    expect((await h.save({ effort: "high" })).ok).toBe(true);
    const next = await h.next();
    expect(next.getSessionInfo()?.sessionId).toBe("existing-context");
    expect(next.effortOverride).toBe("high");
    expect(store.listConfigMutations()).toHaveLength(1);
  });

  it("keeps the warm runtime for naming-only changes", async () => {
    const h = await fixture();
    expect((await h.save({ role: "worker" })).ok).toBe(true);
    expect(await h.next()).toBe(h.warm);
    expect(store.listConfigMutations()).toHaveLength(1);
  });
});

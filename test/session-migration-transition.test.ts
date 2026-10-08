import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import type { AgentProfile } from "@seam/adapters";
import { PresetsFileSchema, type Config, type ThreadPreset } from "../packages/core/src/config.js";
import { createConfigFacades } from "../packages/core/src/core/config-apply-plan.js";
import { ConfigMutationService } from "../packages/core/src/core/config-mutation.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { localBridgeWiring } from "./local-bridge-fixture.js";

// Only the provider boundary is synthetic; overlay, audit, retirement and load are real.
vi.mock("../packages/core/src/agents/agent-runtime.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../packages/core/src/agents/agent-runtime.js")>();
  return { ...actual, AgentRuntime: class {
    modelOverride?: string;
    effortOverride?: string;
    disposed = false;
    busy = false;
    sessionId = "";
    lastActivityAtMs = Date.now();
    finishPrompt?: () => void;
    rejectPrompt?: (error: Error) => void;
    constructor(readonly options: { profile: AgentProfile }) {}
    async start() {}
    markActivity() { this.lastActivityAtMs = Date.now(); }
    async loadSession(input: { sessionId: string }) { this.sessionId = input.sessionId; }
    async newSession() { this.sessionId = `fresh-${this.options.profile.id}`; return { sessionId: this.sessionId }; }
    getSessionInfo() { return { sessionId: this.sessionId, currentModelId: this.modelOverride }; }
    async setModel(model: string) { this.modelOverride = model; }
    async setConfigOption(_id: string, value: string) { this.effortOverride = value; }
    async dispose() { this.disposed = true; this.rejectPrompt?.(new Error("disposed during prompt")); }
    async prompt() {
      this.busy = true;
      try {
        await new Promise<void>((resolve, reject) => { this.finishPrompt = resolve; this.rejectPrompt = reject; });
        return { agent: this.options.profile.id, model: this.modelOverride, sessionId: this.sessionId };
      } finally { this.busy = false; this.finishPrompt = this.rejectPrompt = undefined; }
    }
  } };
});

const cleanup: Array<() => void> = [];
afterEach(() => { for (const run of cleanup.splice(0).reverse()) run(); });
const logger = pino({ level: "silent" });
const actor = { id: "operator", name: "Operator" };
const threadId = "111111111111111111";
const parentId = "222222222222222222";
const profiles = ["claude", "copilot"].map(id => ({
  id, defaultModel: `${id}-default`,
  staticModels: ["default", "other"].map(model => ({ modelId: `${id}-${model}`, name: `${id}-${model}` })),
  effort: { mechanism: id === "copilot" ? "configOption" : "meta", configId: "effort", levels: ["low", "high"] },
})) as unknown as AgentProfile[];

async function fixture(location = "local") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-migration-transition-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new SessionStore(path.join(dir, "seam.db"));
  cleanup.push(() => store.close());
  const modelCatalog = fixtureModelCatalog(profiles);
  const threadPresets = new Map<string, ThreadPreset>([[threadId, {
    agent: { value: "claude" }, model: { value: "claude-other" }, effort: { value: "high" }, location,
  }]]);
  const presetsFile = path.join(dir, "presets.json");
  fs.writeFileSync(presetsFile, JSON.stringify({ channels: {}, threads: Object.fromEntries(threadPresets) }));
  const router = new SessionRouter({ store, logger, profiles, modelCatalog, threadPresets,
    defaultAgentId: "claude", defaultModel: "claude-default", defaultPermissionMode: "ask", seamMcp: localBridgeWiring(profiles) });
  const record = router.ensureSessionRecord({ platform: "discord", channelRef: threadId, parentRef: parentId, cwd: dir });
  store.upsert({ ...record, acpSessionId: "source-context", configJson: JSON.stringify({ model: "claude-other" }) }, {
    source: "fixture", cause: "attach source context before migration",
  });
  Object.assign(record, store.get(record.id));
  const warm = await router.getOrStartRuntime(record);
  const mutation = new ConfigMutationService({ store, logger, modelCatalog,
    tierCEnabled: false, reschedule: () => {}, defaultTimezone: "UTC",
    describeConfig: record => router.describeConfig(record), presetsFile,
    isAgentAvailable: id => Boolean(router.getProfile(id)), ollamaCloudEnabled: true,
    reloadPresets: () => {
      const doc = PresetsFileSchema.parse(JSON.parse(fs.readFileSync(presetsFile, "utf8")));
      threadPresets.clear();
      for (const [id, preset] of Object.entries(doc.threads ?? {})) threadPresets.set(id, preset);
      return { ok: true };
    },
  });
  const identityCommitted = vi.fn(async () => {});
  const { runtime, plan } = createConfigFacades({ store, router, mutation, modelCatalog, logger,
    config: { REPOS_ROOT: dir, channelPresets: new Map(), threadPresets } as Config,
    identityCommitted, persistConfig: () => {}, repoDisplay: repo => repo ?? "",
    unregisteredAgentMessage: (_id, fallback) => fallback, parkedSelectMessage: () => null });
  const adopt = (acpSessionId = "seeded-copilot") => runtime.adoptMigratedSession(record, {
    agent: "copilot", model: "copilot-default", effort: "default", acpSessionId,
  }, actor);
  return { store, router, record, warm, plan, runtime, adopt, threadPresets, identityCommitted,
    next: () => router.getOrStartRuntime(store.get(record.id)!) };
}

describe("seeded migration transition", () => {
  it.each(["local", "remote"])("overrides an explicit source selection on %s and loads the seeded target", async location => {
    const h = await fixture(location);
    await h.adopt();
    const record = h.store.get(h.record.id)!;
    expect(h.router.describeConfig(record)).toMatchObject({ agent: { value: "copilot" }, model: { value: "copilot-default" }, location: { value: location } });
    expect(h.threadPresets.get(threadId)).toMatchObject({ agent: { value: "copilot" }, model: { value: "copilot-default" }, effort: { value: "default" }, location });
    expect(record.acpSessionId).toBe("seeded-copilot");
    expect(h.store.readConfig(record).model).toBe("copilot-default");
    const next = await h.next();
    expect(next.getSessionInfo()).toMatchObject({ sessionId: "seeded-copilot", currentModelId: "copilot-default" });
    const turn = next.prompt("next turn");
    (next as any).finishPrompt();
    expect(await turn).toEqual({ agent: "copilot", model: "copilot-default", sessionId: "seeded-copilot" });
    expect(h.store.listConfigMutations()).toEqual([expect.objectContaining({ actorId: actor.id, actorName: actor.name, tier: "thread-preset", scope: threadId })]);
    expect(h.identityCommitted).toHaveBeenCalledWith(h.record.id);
  });

  it("lets an in-flight source prompt finish before retiring and loading the migrated session", async () => {
    const h = await fixture();
    const running = h.warm.prompt("source turn");
    await h.adopt();
    expect((h.warm as any).disposed).toBe(false);
    expect(await h.next()).toBe(h.warm);
    (h.warm as any).finishPrompt();
    expect(await running).toEqual({ agent: "claude", model: "claude-other", sessionId: "source-context" });
    expect((await h.next()).getSessionInfo()?.sessionId).toBe("seeded-copilot");
    expect((h.warm as any).disposed).toBe(true);
  });

  it("supersedes a queued editor reset without throwing away the migration seed", async () => {
    const h = await fixture();
    const running = h.warm.prompt("source turn");
    const before = h.router.describeConfig(h.record);
    expect(h.plan.applyTargetIdentity(h.record, { agent: "copilot", model: "copilot-other" }, actor).ok).toBe(true);
    await h.runtime.applySavedSelection(h.store.get(h.record.id)!, before);
    await h.adopt();
    (h.warm as any).finishPrompt();
    await running;
    expect((await h.next()).getSessionInfo()?.sessionId).toBe("seeded-copilot");
    expect(h.store.listConfigMutations()).toHaveLength(2);
  });

  it("honors a later saved agent change after the migrated selection", async () => {
    const h = await fixture();
    const running = h.warm.prompt("source turn");
    await h.adopt();
    const before = h.router.describeConfig(h.store.get(h.record.id)!);
    expect(h.plan.applyTargetIdentity(h.record, { agent: "claude", model: "claude-default" }, actor).ok).toBe(true);
    await h.runtime.applySavedSelection(h.store.get(h.record.id)!, before);
    (h.warm as any).finishPrompt();
    await running;
    expect((await h.next()).getSessionInfo()?.sessionId).toBe("fresh-claude");
    expect(h.store.listConfigMutations()).toHaveLength(2);
  });
});

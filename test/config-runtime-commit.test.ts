import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentProfile } from "@seam/adapters";
import { loadConfig } from "../packages/core/src/config.js";
import { watchChannelPresets } from "../packages/core/src/core/config-reload.js";
import { type ConfigSetRequest } from "../packages/core/src/core/config-apply-plan.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { localBridgeWiring } from "./local-bridge-fixture.js";

// Only the provider is fake; commits, reloads, queues and acquisition are real.
vi.mock("../packages/core/src/agents/agent-runtime.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../packages/core/src/agents/agent-runtime.js")>();
  return { ...actual, AgentRuntime: class TestRuntime {
    static nextSlot = 0;
    readonly slot = TestRuntime.nextSlot++;
    busy = false;
    disposed = false;
    detached = false;
    lastActivityAtMs = Date.now();
    modelOverride?: string;
    effortOverride?: string;
    sessionId = "";
    finishPrompt?: () => void;
    constructor(readonly options: any) {}
    async start() {}
    async loadSession(input: { sessionId: string }) { this.sessionId = input.sessionId; }
    async newSession() {
      this.sessionId = `fresh-${this.options.profile.id}`;
      return { sessionId: this.sessionId };
    }
    getSessionInfo() { return { sessionId: this.sessionId, currentModelId: this.modelOverride, availableModels: [] }; }
    getSlot() { return this.slot; }
    hasDelegatedTurnInFlight() { return false; }
    supportsSessionLoad() { return true; }
    getConfigSelectValues() { return []; }
    markActivity() { this.lastActivityAtMs = Date.now(); }
    async dispose() { this.disposed = true; }
    async detach() { this.detached = true; }
    async setModel(model: string) { this.modelOverride = model; }
    async setConfigOption(_id: string, value: string) { this.effortOverride = value; }
    async prompt() {
      this.busy = true;
      try {
        await new Promise<void>(resolve => { this.finishPrompt = resolve; });
        return { agent: this.options.profile.id, location: this.options.modelFallbacks("old", null).location };
      } finally { this.busy = false; }
    }
  } };
});

const logger = pino({ level: "silent" });
const actor = { id: "123", name: "Operator" };
const channel = { platform: "discord", id: "111111111111111111", parentId: "222222222222222222" };
const profiles = ["claude", "codex"].map(id => ({ id, displayName: id, defaultModel: "old",
  staticModels: [{ modelId: "old", name: "Old" }, { modelId: "new", name: "New" }], effort: { mechanism: "meta", levels: ["low", "high"] },
})) as unknown as AgentProfile[];
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const stop of cleanups.splice(0).reverse()) await stop(); vi.restoreAllMocks(); });

async function fixture(threadPreset?: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-runtime-commit-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "presets.json");
  fs.writeFileSync(file, JSON.stringify({ channels: {}, threads: threadPreset ? { [channel.id]: threadPreset } : {} }));
  const config = loadConfig({ env: { DISCORD_BOT_TOKEN: "fixture", DISCORD_ALLOWED_USER_IDS: actor.id,
    DEFAULT_AGENT: "claude", DEFAULT_MODEL: "old", REPOS_ROOT: dir, DATA_DIR: dir, AGY_ENABLED: "false",
    CHANNEL_PRESETS_FILE: file, SEAM_CONFIG_MUTATION_TIER_C_ENABLED: "true" }, warn: () => {} });
  const store = new SessionStore(path.join(dir, "seam.db")); cleanups.push(() => store.close());
  const catalog = fixtureModelCatalog(profiles);
  const router = new SessionRouter({ store, logger, profiles, modelCatalog: catalog,
    channelPresets: config.channelPresets, threadPresets: config.threadPresets,
    defaultAgentId: "claude", defaultModel: "old", defaultCwd: dir, seamMcp: localBridgeWiring(profiles) });
  cleanups.push(() => router.disposeAll());
  const row = router.ensureSessionRecord({ platform: channel.platform, channelRef: channel.id, parentRef: channel.parentId, cwd: dir });
  store.upsert({ ...row, acpSessionId: "retained-acp" }, { source: "fixture", cause: "existing provider conversation" });
  const adapter = { sendMessage: vi.fn(async (channel: any) => ({ channel, id: "message" })),
    sendPanel: vi.fn(async (channel: any) => ({ channel, id: "card" })), editPanel: vi.fn(async () => {}),
    getThreadName: vi.fn(async () => "test"), renameThread: vi.fn(async () => {}),
    getThreadLiveState: vi.fn(async () => ({ exists: true, archived: false, locked: false })) };
  const orchestrator = new Orchestrator({ config, logger, store, router, modelCatalog: catalog,
    adapter: adapter as never, renderer: discordRenderer });
  await orchestrator.loadPlugins();
  cleanups.push(() => (orchestrator as any).plugins.dispose());
  const mutation = orchestrator.getConfigMutation(), plan = orchestrator.getConfigApplyPlan();
  const record = () => store.get(row.id)!;
  const warm = await router.getOrStartRuntime(record());
  cleanups.push(() => { (warm as any).finishPrompt?.(); });
  const next = () => router.getOrStartRuntime(record());
  const reload = () => (mutation as any).deps.reloadPresets() as { ok: boolean; error?: string };
  const write = (doc: unknown) => fs.writeFileSync(file, JSON.stringify(doc));
  const watch = () => {
    const stop = (watchChannelPresets as (...args: any[]) => () => void)(file, config, logger, 5,
      () => (orchestrator as any).reloadPresets());
    cleanups.push(stop);
  };
  return { dir, file, config, store, router, orchestrator, mutation, plan, record, warm, next, reload, write, watch };
}

const location = (runtime: any) => runtime.options.modelFallbacks("old", null).location;
const namedRequest = (values: Partial<ConfigSetRequest["values"]>): ConfigSetRequest => ({
  json: null, rebuild: false, supplied: Object.keys(values) as ConfigSetRequest["supplied"],
  values: { agent: null, model: null, effort: null, repo: null, role: null, permissions: null, card: null, gif: null, ...values },
});
const pinned = { agent: { value: "claude" }, model: { value: "old" }, effort: { value: "low" }, location: "remote" };

async function applyNamed(h: Awaited<ReturnType<typeof fixture>>, request: ConfigSetRequest) {
  const prepared = await h.plan.prepareConfigSet(h.record(), channel, request);
  if (!prepared.ok) throw new Error(prepared.message);
  return h.plan.applyPreparedConfigSet(h.record(), channel, request, prepared.prepared, actor, { retireRuntime: true, applyName: false });
}

describe("committed agent and location selection follows a warm runtime", () => {
  it.each(["agent", "model", "effort", "repo", "all"] as const)("identical named config-set (%s) keeps the runtime, slot and ACP", async field => {
    const h = await fixture(pinned);
    const values = { agent: "claude@remote", model: "old", effort: "low", repo: h.dir };
    const request = namedRequest(field === "all" ? values : { [field]: values[field] });
    const before = h.router.describeConfig(h.record());
    const slot = h.warm.getSlot();
    const applied = await applyNamed(h, request);
    expect(applied.ok).toBe(true);
    expect((h.warm as any).disposed).toBe(false);
    expect(await h.next()).toBe(h.warm);
    expect((await h.next()).getSlot()).toBe(slot);
    expect(h.record().acpSessionId).toBe("retained-acp");
    expect(applied.ok && applied.restartRequested).toBe(false);
    if (applied.ok) for (const key of ["agent", "model", "effort", "cwd", "location"] as const) {
      expect(applied.effective[key].value).toBe(before[key].value);
    }
  });

  it.each(["agent", "model", "effort", "repo", "location"] as const)("a real named config-set %s change still replaces the runtime", async field => {
    const h = await fixture(pinned);
    const repo = path.join(h.dir, "other"); fs.mkdirSync(repo);
    const values = { agent: "codex@remote", model: "new", effort: "high", repo, location: "claude@elsewhere" };
    const request = namedRequest(field === "location" ? { agent: values.location } : { [field]: values[field] });
    const applied = await applyNamed(h, request);
    expect(applied.ok).toBe(true);
    expect(applied.ok && applied.restartRequested).toBe(true);
    const next = await h.next();
    expect(next).not.toBe(h.warm); expect(next.getSlot()).not.toBe(h.warm.getSlot());
    expect((h.warm as any).disposed).toBe(true);
    expect(h.record().acpSessionId).toBe(field === "agent" ? "fresh-codex" : field === "location" ? "fresh-claude" : "retained-acp");
  });

  it("compares the live effective selection rather than a stale config-set preparation", async () => {
    const h = await fixture(pinned);
    const request = namedRequest({ model: "old" });
    const prepared = await h.plan.prepareConfigSet(h.record(), channel, request);
    if (!prepared.ok) throw new Error(prepared.message);
    expect((await applyNamed(h, namedRequest({ model: "new" }))).ok).toBe(true);
    const changed = await h.next();
    const applied = await h.plan.applyPreparedConfigSet(h.record(), channel, request, prepared.prepared, actor, { retireRuntime: true, applyName: false });
    expect(applied.ok && applied.restartRequested).toBe(true);
    expect((changed as any).disposed).toBe(true); expect(await h.next()).not.toBe(changed);
    expect(h.record().acpSessionId).toBe("retained-acp");
  });

  it("reports a location-only proposal as a reset without changing anything before Apply", async () => {
    const h = await fixture();
    const built = h.plan.prepare(h.record(), { threadPreset: { location: "remote" } }, actor);
    expect(built.ok).toBe(true);
    expect(built.ok && built.plan.consequence).toBe("reset");
    expect(h.store.listConfigMutations()).toHaveLength(0);
    expect(h.record().acpSessionId).toBe("retained-acp"); expect(await h.next()).toBe(h.warm);
  });

  it("applies a location-only config-set overlay through the saved-selection transition", async () => {
    const h = await fixture();
    const applied = await h.plan.applyPreparedConfigSet(h.record(), channel, {} as never,
      { kind: "overlay", changes: { location: "remote" } }, actor, { retireRuntime: true, applyName: false });
    expect(applied.ok).toBe(true);
    const next = await h.next();
    expect(next).not.toBe(h.warm); expect(location(next)).toBe("remote");
    expect(next.getSessionInfo()?.sessionId).toBe("fresh-claude");
    expect(h.store.listConfigMutations()).toHaveLength(1);
  });

  it("a committed location-only overlay takes effect before the next cached acquisition", async () => {
    const h = await fixture();
    expect(h.mutation.applyThreadLocation({ threadId: channel.id, parentRef: channel.parentId, location: "remote", actor }).ok).toBe(true);
    const next = await h.next();
    expect(next).not.toBe(h.warm); expect(location(next)).toBe("remote");
    expect(next.getSessionInfo()?.sessionId).toBe("fresh-claude");
    expect(h.store.listConfigMutations()[0]).toMatchObject({ tier: "thread-preset", actorId: actor.id });
  });

  it.each([
    { location: "remote" },
    { agent: { value: "codex" }, location: "remote" },
  ])("raw preset watcher transitions a warm selection to %j", async preset => {
    const h = await fixture(); h.watch();
    h.write({ channels: {}, threads: { [channel.id]: preset } });
    await vi.waitFor(() => expect(h.config.threadPresets.get(channel.id)?.location).toBe("remote"));
    const next = await h.next();
    expect(next).not.toBe(h.warm); expect(location(next)).toBe("remote");
    expect((next as any).options.profile.id).toBe("agent" in preset ? "codex" : "claude");
    expect(next.getSessionInfo()?.sessionId).not.toBe("retained-acp");
    expect(h.store.listConfigMutations()).toHaveLength(0);
  });

  it("a channel-preset commit transitions every affected warm session, not a pinned sibling", async () => {
    const h = await fixture();
    const sibling = h.router.ensureSessionRecord({ platform: "discord", channelRef: "333333333333333333", parentRef: channel.parentId, cwd: h.dir });
    const pinned = h.router.ensureSessionRecord({ platform: "discord", channelRef: "444444444444444444", parentRef: channel.parentId, cwd: h.dir });
    h.write({ channels: {}, threads: { [pinned.channelRef]: { agent: { value: "claude" } } } });
    expect(h.reload().ok).toBe(true);
    const siblingWarm = await h.router.getOrStartRuntime(sibling), pinnedWarm = await h.router.getOrStartRuntime(pinned);
    expect(h.mutation.applyChannelOverlay({ channelId: channel.parentId, changes: { agent: "codex" }, actor }).ok).toBe(true);
    for (const [row, original] of [[h.record(), h.warm], [sibling, siblingWarm]] as const) {
      const next = await h.router.getOrStartRuntime(h.store.get(row.id)!);
      expect(next).not.toBe(original); expect((next as any).options.profile.id).toBe("codex");
    }
    expect(await h.router.getOrStartRuntime(pinned)).toBe(pinnedWarm);
    expect(h.store.listConfigMutations()).toHaveLength(1);
  });

  it("does not interrupt a busy runtime when the location is committed", async () => {
    const h = await fixture(); const held = (h.warm as any).prompt();
    expect(h.mutation.applyThreadLocation({ threadId: channel.id, parentRef: channel.parentId, location: "remote", actor }).ok).toBe(true);
    expect((h.warm as any).disposed).toBe(false); expect(h.record().acpSessionId).toBe("retained-acp");
    expect(await h.next()).toBe(h.warm);
    (h.warm as any).finishPrompt(); expect(await held).toMatchObject({ agent: "claude", location: "local" });
    const next = await h.next(); expect(next).not.toBe(h.warm); expect(location(next)).toBe("remote");
  });

  it("a no-op location commit does not retire or reset the warm ACP", async () => {
    const h = await fixture();
    const applied = h.mutation.applyThreadLocation({ threadId: channel.id, parentRef: channel.parentId, location: "local", actor });
    expect(applied.ok).toBe(true); expect(await h.next()).toBe(h.warm);
    expect(h.record().acpSessionId).toBe("retained-acp"); expect((h.warm as any).disposed).toBe(false);
  });

  it("a raw reload that changes provenance but not effective agent/location keeps the warm ACP", async () => {
    const h = await fixture(); h.watch();
    h.write({ channels: {}, threads: { [channel.id]: { agent: { value: "claude" }, location: "local" } } });
    await vi.waitFor(() => expect(h.config.threadPresets.get(channel.id)?.agent?.value).toBe("claude"));
    expect(await h.next()).toBe(h.warm); expect(h.record().acpSessionId).toBe("retained-acp");
  });

  it("coalesces reloads back to a busy runtime's original binding without resetting it", async () => {
    const h = await fixture(); const held = (h.warm as any).prompt();
    h.write({ channels: {}, threads: { [channel.id]: { location: "remote" } } }); expect(h.reload().ok).toBe(true);
    h.write({ channels: {}, threads: {} }); expect(h.reload().ok).toBe(true);
    (h.warm as any).finishPrompt(); await held;
    expect(await h.next()).toBe(h.warm); expect(h.record().acpSessionId).toBe("retained-acp");
  });

  it("a rejected raw reload preserves the real error, maps and warm ACP", async () => {
    const h = await fixture(); fs.writeFileSync(h.file, "{ invalid json");
    const result = h.reload(); expect(result.ok).toBe(false); expect(result.error).toMatch(/JSON|Unexpected|property name/);
    expect(h.router.describeConfig(h.record()).location.value).toBe("local");
    expect(await h.next()).toBe(h.warm); expect(h.record().acpSessionId).toBe("retained-acp");
  });
});

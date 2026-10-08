import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import type { AgentProfile } from "@seam/adapters";
import type { Config } from "../packages/core/src/config.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { ConfigMutationService } from "../packages/core/src/core/config-mutation.js";
import { createConfigFacades } from "../packages/core/src/core/config-apply-plan.js";
import { buildChannelPresetMaps } from "../packages/core/src/config.js";
import { reloadChannelPresets } from "../packages/core/src/core/config-reload.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { Preset } from "../packages/core/src/core/types.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { DiscordAdapter } from "../packages/core/src/platforms/discord/adapter.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { localBridgeWiring } from "./local-bridge-fixture.js";
import { visualConfig } from "./plugin-card-visuals-fixture.js";

const logger = pino({ level: "silent" }) as Logger;
const actor = { id: "operator", name: "Operator" };
const channel = { platform: "discord", id: "333333333333333333", parentId: "111111111111111111" };
const profiles = ["claude", "codex"].map(id => ({
  id, defaultModel: `${id}-default`,
  staticModels: ["default", "channel", "explicit"].map(kind => ({ modelId: `${id}-${kind}`, name: `${id}-${kind}` })),
  effort: { mechanism: "meta", levels: ["low", "high"] },
})) as unknown as AgentProfile[];
let dir: string;
let store: SessionStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-channel-resolution-"));
  store = new SessionStore(path.join(dir, "seam.db"));
});
afterEach(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const file = path.join(dir, "presets.json");
  fs.writeFileSync(file, JSON.stringify({ channels: { "111111111111111111": {
    agent: { value: "codex" }, model: { value: "codex-channel" },
    effort: { value: "high" }, cwd: { value: dir },
  } }, threads: {} }));
  const maps = buildChannelPresetMaps(file);
  const catalog = fixtureModelCatalog(profiles);
  const router = new SessionRouter({ store, logger, profiles, modelCatalog: catalog,
    defaultAgentId: "claude", defaultModel: "claude-default", defaultPermissionMode: "ask",
    defaultCwd: dir, ...maps, seamMcp: localBridgeWiring(profiles) });
  const mutation = new ConfigMutationService({ store, logger, modelCatalog: catalog,
    describeConfig: row => router.describeConfig(row), presetsFile: file,
    isAgentAvailable: id => Boolean(router.getProfile(id)), tierCEnabled: true,
    reloadPresets: () => reloadChannelPresets(maps, file, logger) });
  const config = { REPOS_ROOT: dir, DATA_DIR: dir, ...maps, ...visualConfig,
    CHANNEL_PRESETS_FILE: file, REPO_EMOJIS: new Map(), TURN_TIMEOUT_SECONDS: 60,
    SEAM_DISPATCH_STATUS_PANEL: true, SEAM_DISPATCH_OUTPUT_STYLE: "messages" } as Config;
  const host = { workspaceRoot: dir };
  const bridgeHub = { get: (_location: string) => ({ host }), markSessionBridge: vi.fn() };
  const { plan, runtime } = createConfigFacades({ store, router, mutation, modelCatalog: catalog, logger, config,
    bridgeHub: bridgeHub as any,
    resolveRequestedRepoPath: async (_channel, requested) => path.resolve(requested),
    identityCommitted: async () => {}, persistConfig: (row, cfg) => store.upsert({ ...row, configJson: JSON.stringify(cfg) }),
    repoDisplay: repo => repo ?? "", unregisteredAgentMessage: (_id, message) => message,
  });
  const created = router.ensureSessionRecord({ platform: "discord", channelRef: channel.id, parentRef: channel.parentId, cwd: dir });
  const record = store.get(created.id)!;
  const bare = Object.assign(Object.create(Orchestrator.prototype), { store, router, config, logger,
    adapter: { resolveChannel: vi.fn(async (ref: typeof channel) => ({ ...ref, parentId: "111111111111111111" })) } });
  return { maps, catalog, router, mutation, plan, runtime, config, record, bare, host };
}

describe("one channel configuration resolution", () => {
  it("spawn uses the same inherited selection and provenance as the config view", () => {
    const h = fixture();
    store.upsert({ ...h.record, agentId: "claude", configJson: JSON.stringify({ model: "claude-explicit", reasoningEffort: "low" }) });
    const row = store.get(h.record.id)!;
    const resolved = h.router.describeConfig(row);
    const spawn = h.router.planRuntimeSpawn(row);
    expect(resolved.agent).toEqual({ value: "codex", source: "channel preset" });
    expect(resolved.model).toEqual({ value: "codex-channel", source: "channel preset" });
    expect(spawn).toMatchObject({ agentId: "codex", model: "codex-channel", effort: "high", cwd: dir });
    expect(store.get(row.id)).toEqual(row);
  });

  it("the inherited view ignores both thread pins and legacy session mirrors", () => {
    const h = fixture();
    h.mutation.applyThreadOverlay({ threadId: channel.id, parentRef: channel.parentId, actor,
      changes: { agent: "claude", model: "claude-explicit", effort: "low" } });
    const inherited = h.router.describeConfig(h.record, { inherit: true });
    expect(inherited.agent.value).toBe("codex");
    expect(inherited.model.value).toBe("codex-channel");
    expect(inherited.effort.value).toBe("high");
  });

  it("a remote thread keeps its host when inspecting inherited model and effort", () => {
    const h = fixture();
    h.maps.threadPresets.set(channel.id, { location: "remote-645", agent: { value: "claude" } });
    vi.spyOn(h.catalog, "effortChoices").mockImplementation(binding =>
      binding.location === "remote-645" ? ["default", "high"] : ["default", "low"]);
    const inherited = h.router.describeConfig(h.record, { inherit: true });
    expect(inherited.location.value).toBe("remote-645");
    expect(inherited.agent.value).toBe("codex");
    expect(inherited.model.value).toBe("codex-channel");
    expect(inherited.effort.value).toBe("high");
    expect(h.catalog.effortChoices).toHaveBeenCalledWith(
      { agentId: "codex", location: "remote-645" }, "codex-channel");
  });

  it("a channel model proposal uses the caller's actual remote binding", () => {
    const h = fixture();
    h.maps.threadPresets.set(channel.id, { location: "remote-645" });
    const model = h.catalog.model.bind(h.catalog);
    vi.spyOn(h.catalog, "model").mockImplementation((binding, id) => {
      const found = model(binding, id);
      return found && binding.location === "local" ? { ...found, availability: "unavailable" } : found;
    });
    const proposal = h.mutation.buildProposal(h.record, { channelPreset: { model: "codex-explicit" } });
    expect(proposal).toMatchObject({ ok: true });
    expect(h.catalog.model).toHaveBeenCalledWith(
      { agentId: "codex", location: "remote-645" }, "codex-explicit");
  });

  it("an explicit worker agent never receives another agent's channel model", () => {
    const h = fixture();
    const selected = h.router.describeConfig(h.record, { agent: "claude", location: "local" });
    expect(selected.agent.value).toBe("claude");
    expect(selected.model.value).toBe("claude-default");
    expect(selected.effort.value).toBeNull();
    expect(store.get(h.record.id)).toEqual(h.record);
  });

  it("worker model and effort overrides win without mutating the target thread", () => {
    const h = fixture();
    const selected = h.router.describeConfig(h.record, { model: "codex-explicit", effort: "low" });
    expect(selected.model.value).toBe("codex-explicit");
    expect(selected.effort.value).toBe("low");
    expect(h.router.describeConfig(store.get(h.record.id)!).model.value).toBe("codex-channel");
  });

  it.each(["local", "remote-645"])("config set uses %s's advertised workspace root", async location => {
    const h = fixture();
    h.host.workspaceRoot = path.join(dir, "host-root");
    h.maps.threadPresets.set(channel.id, { location });
    const prepare = (repo: string) => h.plan.prepareConfigSet(h.record, channel, {
      json: null, rebuild: false, supplied: ["repo"],
      values: { agent: null, model: null, effort: null, repo, role: null, permissions: null, card: null, gif: null },
    });
    const withinHost = path.join(dir, "host-root", "project");
    expect(await prepare(withinHost)).toMatchObject({ ok: true, prepared: { resolvedRepo: withinHost } });
    const outsideHost = path.join(dir, "controller-only");
    expect(await prepare(outsideHost)).toMatchObject({
      ok: false, message: expect.stringContaining(`outside host \`${location}\` workspace root`),
    });
  });

  it("backfills a parent without replacing context, agent, or explicit config", () => {
    const h = fixture();
    store.upsert({ ...h.record, parentRef: null, acpSessionId: "kept-context", agentId: "claude", configJson: '{"model":"claude-explicit"}' });
    const before = store.get(h.record.id)!;
    const linked = h.router.ensureSessionRecord({ platform: "discord", channelRef: channel.id, parentRef: "111111111111111111", cwd: dir });
    expect(linked).toMatchObject({ ...before, parentRef: "111111111111111111", updatedUtc: expect.any(String) });
    expect(h.router.describeConfig(linked).model.value).toBe("codex-channel");
    expect(h.router.ensureSessionRecord({ platform: "discord", channelRef: channel.id, parentRef: "111111111111111112", cwd: dir }).parentRef).toBe("111111111111111111");
  });

  it("first-touch binding resolves the real Discord parent, not the caller's channel", async () => {
    const h = fixture();
    const linked = await h.bare.bindThreadRecord({ platform: "discord", id: "333333333333333334" });
    expect(h.bare.adapter.resolveChannel).toHaveBeenCalledWith({ platform: "discord", id: "333333333333333334" });
    expect(linked.parentRef).toBe("111111111111111111");
    expect(h.router.describeConfig(linked).agent.value).toBe("codex");
    await h.bare.bindThreadRecord({ platform: "discord", id: "333333333333333334" });
    expect(h.bare.adapter.resolveChannel).toHaveBeenCalledTimes(1);
  });

  it("a real lookup error is not converted into an unlinked session", async () => {
    const h = fixture();
    h.bare.adapter.resolveChannel.mockRejectedValue(new Error("Discord lookup failed: 503"));
    await expect(h.bare.bindThreadRecord({ platform: "discord", id: "333333333333333335" })).rejects.toThrow("Discord lookup failed: 503");
    expect(store.getByChannel("discord", "333333333333333335")).toBeNull();
  });

  it.each(["dispatch", "interrupt", "compact", "steer", "reauth"])("%s resolves the parent on first touch", async entry => {
    const h = fixture();
    const target = "1111";
    const lookupError = new Error("first-touch lookup");
    h.bare.adapter.resolveChannel.mockRejectedValue(lookupError);
    const spec = { id: "333333333333333334", kind: "handoff", target, session: "live", prompt: "work", createdUtc: new Date().toISOString() };
    const invoke = async () => {
      switch (entry) {
        case "dispatch": return h.bare.dispatchInjectTurnOwned(spec, {});
        case "interrupt": return h.bare.interruptRedirect(h.record, target, "redirect", false);
        case "compact": return h.bare.dispatchCompact(spec);
        case "reauth": return h.bare.postReauthCard(target, "attempt", {});
        case "steer":
          h.bare.normalizeAutocompleteSubmission = async () => target;
          return h.bare.cmdSteer({ channelId: channel.id, channel: { parentId: channel.parentId, isThread: () => true },
            options: { getString: (key: string) => key === "thread" ? target : "steer", getBoolean: () => false } });
      }
    };
    if (entry === "reauth") expect(await invoke()).toBeUndefined();
    else await expect(invoke()).rejects.toBe(lookupError);
    expect(h.bare.adapter.resolveChannel).toHaveBeenCalledWith({ platform: "discord", id: target });
    expect(store.getByChannel("discord", target)).toBeNull();
  });

  it.each([true, false])("Discord parent resolution distinguishes a thread from a category (%s)", async isThread => {
    const ref = { platform: "discord", id: "333333333333333336" };
    const adapter = Object.assign(Object.create(DiscordAdapter.prototype), { platform: "discord",
      client: { channels: { fetch: async () => ({ id: ref.id, parentId: "111111111111111113", isThread: () => isThread }) } } });
    expect(await adapter.resolveChannel(ref)).toEqual({ ...ref, ...(isThread ? { parentId: "111111111111111113" } : {}) });
  });

  it("preset agent, model, effort and repo become authoritative thread overrides", async () => {
    const h = fixture();
    const preset = { agentId: "claude", model: "claude-explicit", effort: "low", repoPath: path.join(dir, "explicit"),
      disableThreadPrefix: null } as Preset;
    await h.plan.applyPresetToSession(channel, h.record, preset);
    const selected = h.router.describeConfig(store.get(h.record.id)!);
    expect(selected.agent).toEqual({ value: "claude", source: "thread preset" });
    expect(selected.model).toEqual({ value: "claude-explicit", source: "thread preset" });
    expect(selected.effort).toEqual({ value: "low", source: "thread preset" });
    expect(selected.cwd).toEqual({ value: preset.repoPath, source: "thread preset" });
  });

  it("direct agent-only switch inherits matching channel model/effort without pins", async () => {
    const h = fixture();
    h.plan.applyTargetIdentity(h.record, { agent: "claude", model: "claude-explicit", effort: "low" }, actor);
    const respond = vi.fn(async () => {});
    expect(await h.runtime.applyAgentChange(channel, store.get(h.record.id)!, "codex", actor, respond))
      .toEqual({ ok: true, message: expect.any(String) });
    expect(h.maps.threadPresets.get(channel.id)).toMatchObject({ agent: { value: "codex" } });
    expect(h.maps.threadPresets.get(channel.id)?.model).toBeUndefined();
    expect(h.maps.threadPresets.get(channel.id)?.effort).toBeUndefined();
    expect(store.readConfig(store.get(h.record.id)!)).not.toHaveProperty("model");
    h.mutation.applyChannelOverlay({ channelId: "111111111111111111", actor, changes: { model: "codex-explicit", effort: "low" } });
    expect(h.router.planRuntimeSpawn(store.get(h.record.id)!)).toMatchObject({ agentId: "codex", model: "codex-explicit", effort: "low" });
  });

  it("config set agent prepares inheritance through the same router", async () => {
    const h = fixture();
    h.plan.applyTargetIdentity(h.record, { agent: "claude", model: "claude-explicit", effort: "low" }, actor);
    const values = { agent: "codex", model: null, effort: null, repo: null, role: null, permissions: null, card: null, gif: null };
    const request = { json: null, rebuild: false, values, supplied: ["agent"] as const };
    const row = store.get(h.record.id)!;
    const prepared = await h.plan.prepareConfigSet(row, channel, { ...request, supplied: ["agent"] });
    expect(prepared).toMatchObject({ ok: true, prepared: { model: "codex-channel", pinnedEffort: "high", inheritSelection: true } });
    if (!prepared.ok) throw new Error(prepared.message);
    expect(await h.plan.applyPreparedConfigSet(row, channel, { ...request, supplied: ["agent"] }, prepared.prepared, actor,
      { retireRuntime: true, applyName: true })).toMatchObject({ ok: true });
    expect(h.maps.threadPresets.get(channel.id)?.model).toBeUndefined();
    expect(h.maps.threadPresets.get(channel.id)?.effort).toBeUndefined();
  });

  it("configure_thread agent-only uses channel selection for its replacement runtime", async () => {
    const h = fixture();
    h.plan.applyTargetIdentity(h.record, { agent: "claude", model: "claude-explicit", effort: "low" }, actor);
    const spawnPlans: unknown[] = [];
    vi.spyOn(h.router, "getOrStartRuntime").mockImplementation(async row => {
      spawnPlans.push(h.router.planRuntimeSpawn(row));
      store.upsert({ ...row, acpSessionId: "new-context" });
      return { getSessionInfo: () => ({ sessionId: "new-context" }) } as any;
    });
    const result = await h.runtime.configure(h.record, store.get(h.record.id)!, { agent: "codex" });
    expect(result).toMatchObject({ ok: true, applied: { agent: "codex", model: "codex-channel", effort: "high" }, sessionReset: true });
    expect(spawnPlans).toEqual([expect.objectContaining({ agentId: "codex", model: "codex-channel", effort: "high" })]);
    expect(h.maps.threadPresets.get(channel.id)?.model).toBeUndefined();
    expect(h.maps.threadPresets.get(channel.id)?.effort).toBeUndefined();
  });

  it("self migration stages the matching inherited selection without changing the source", async () => {
    const h = fixture();
    h.plan.applyTargetIdentity(h.record, { agent: "claude", model: "claude-explicit", effort: "low" }, actor);
    const row = store.get(h.record.id)!;
    const staged = await h.runtime.prepareSelfMigration(row, { agent: "codex", manifest: "continue" });
    expect(staged).toMatchObject({ ok: true, migration: { agent: "codex", model: "codex-channel", effort: "high", inheritSelection: true } });
    expect(store.get(row.id)).toEqual(row);
    expect(h.router.describeConfig(row).agent.value).toBe("claude");
  });

  it.each([false, true])("self migration commits inheritance or restores the exact overlay on failure (%s)", async fail => {
    const h = fixture();
    h.plan.applyTargetIdentity(h.record, { agent: "claude", model: "claude-explicit", effort: "low" }, actor);
    store.upsert({ ...store.get(h.record.id)!, acpSessionId: "original-context" });
    const before = store.get(h.record.id)!;
    const overlay = h.mutation.readThreadPresetEntry(channel.id);
    const staged = await h.runtime.prepareSelfMigration(before, { agent: "codex", manifest: "continue" });
    if (!staged.ok) throw new Error(staged.error);
    const start = vi.spyOn(h.router, "getOrStartRuntime").mockImplementation(async row => {
      expect(h.router.planRuntimeSpawn(row)).toMatchObject({ agentId: "codex", model: "codex-channel", effort: "high" });
      if (fail) throw new Error("provider load failed");
      store.upsert({ ...row, acpSessionId: "migrated-context" });
      return { getSessionInfo: () => ({ sessionId: "migrated-context" }) } as any;
    });
    const result = await h.runtime.executeSelfMigration(before, staged.migration);
    expect(start).toHaveBeenCalledTimes(1);
    if (fail) {
      expect(result).toEqual({ ok: false, error: "provider load failed" });
      expect(store.get(before.id)).toEqual(before);
      expect(h.mutation.readThreadPresetEntry(channel.id)).toEqual(overlay);
    } else {
      expect(result).toMatchObject({ ok: true, agent: "codex", model: "codex-channel", effort: "high", newSessionId: "migrated-context" });
      expect(h.maps.threadPresets.get(channel.id)?.model).toBeUndefined();
      expect(h.maps.threadPresets.get(channel.id)?.effort).toBeUndefined();
    }
  });

  it.each([false, true])("isolated spawn, attempt and panel share one inherited identity (explicit=%s)", async explicit => {
    const h = fixture();
    store.upsert({ ...h.record, agentId: "claude", acpSessionId: "live-context", configJson: '{"model":"claude-explicit","reasoningEffort":"low"}' });
    const before = store.get(h.record.id)!;
    const mux = { spawn: vi.fn(() => ({ slot: 1 })),
      rpc: vi.fn(async () => ({ projectMcpInjection: true })), releaseStdin: vi.fn() };
    const adapter = { sendPanel: vi.fn(async () => ({ channel, id: "status-card" })), editPanel: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({ channel, id: "answer" })), resolveChannel: vi.fn(async ref => ({ ...ref, parentId: "111111111111111111" })) };
    const orch = new Orchestrator({ logger, config: h.config, store, router: h.router,
      modelCatalog: h.catalog, renderer: discordRenderer, adapter: adapter as any });
    (orch as any).bridgeHub = { isBridgeReady: () => true, markSessionBridge: vi.fn(), get: () => ({ mux, host: h.host }), defaultCwdForLocation: () => dir, mcpServersForBridgeSpawn: () => undefined };
    await (orch as any).cardVisualsReady;
    const panel = vi.spyOn(orch as any, "startDispatchStatusPanel");
    const inject = vi.spyOn(orch, "injectTurn").mockImplementation(async (_row, _prompt, opts) => {
      await opts.spawnFn!();
      await opts.onSession?.("isolated-context");
      opts.lifecycle!.beforePrompt();
      // Editing defaults mid-turn must not rewrite this attempt's identity.
      h.mutation.applyChannelOverlay({ channelId: "111111111111111111", actor, changes: { model: "codex-explicit", effort: "low" } });
      const result = { text: "done", stopReason: "end_turn" };
      opts.lifecycle!.onOutcome(result);
      return result;
    });
    try {
      await expect(orch.dispatchInjectTurn({ id: "isolated-proof", target: channel.id, kind: "handoff", session: "isolated", stream: false,
        prompt: "work", createdUtc: new Date().toISOString(), ...(explicit ? { model: "codex-explicit", effort: "low" } : {}) })).resolves.toEqual({ output: "done", stopReason: "end_turn" });
      const model = explicit ? "codex-explicit" : "codex-channel";
      const effort = explicit ? "low" : "high";
      expect(inject.mock.calls[0][2]).toMatchObject({ profile: { id: "codex" }, model, effort });
      expect(mux.rpc).toHaveBeenCalledWith("spawn", expect.objectContaining({ agentId: "codex", model, effort, cwd: dir }), { agentId: "codex" });
      expect(panel.mock.calls[0][2]).toMatchObject({ profile: { id: "codex" }, model, effort });
      const attempt = store.turnAttempts.get("isolated-proof")!;
      expect(attempt).toMatchObject({ state: "completed", generation: 1, promptStarted: true });
      expect(JSON.parse(attempt.identity)).toMatchObject({ agent: "codex", model, effort, cwd: dir });
      expect(store.get(before.id)).toEqual(before);
    } finally {
      orch.suspendForRestart();
    }
  });
});

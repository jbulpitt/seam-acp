import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { pino } from "pino";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentProfile } from "@seam/adapters";
import type { Config } from "../packages/core/src/config.js";
import { reloadChannelPresets } from "../packages/core/src/core/config-reload.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { renderStatusPanel, TurnStatus } from "../packages/core/src/core/status-panel.js";
import { DispatchStatusPanel } from "../packages/core/src/core/dispatch-status-panel.js";
import type { StructuredPanel } from "../packages/core/src/core/types.js";
import { PluginHost } from "../packages/core/src/plugins/host.js";
import type { Plugin } from "../packages/core/src/plugins/types.js";
import { CARD_VISUAL_KEYS, createCardVisualsPlugin } from "../packages/core/src/plugins/card-visuals/index.js";
import { DEFAULT_GIF_REFRESH_MS } from "../packages/core/src/plugins/card-visuals/card-gifs.js";
import { buildSlashRegistrationBody } from "../packages/core/src/platforms/discord/commands.js";
import { buildSeamHelpPages } from "../packages/core/src/platforms/discord/help-text.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { visualConfig } from "./plugin-card-visuals-fixture.js";

const THREAD = "333333333333333333";
const PARENT = "111111111111111111";
const USER = "222222222222222222";
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function logging() {
  const logs: any[] = [];
  const logger = pino({ level: "info" }, new Writable({ write(chunk, _encoding, done) { logs.push(JSON.parse(String(chunk))); done(); } }));
  return { logger, logs };
}
async function fixture() {
  const { logger, logs } = logging();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "seam-visuals-"));
  const file = path.join(directory, "presets.json");
  fs.writeFileSync(file, JSON.stringify({ channels: { [PARENT]: { statusCardStyle: { value: "simple" }, simpleCardGif: { value: true } } }, threads: {} }));
  const store = new SessionStore(path.join(directory, "seam.db"));
  const profile = { id: "codex", displayName: "Codex", defaultModel: "gpt-6.1-sol" } as AgentProfile;
  const modelCatalog = fixtureModelCatalog([profile]);
  const config = { ...visualConfig, DATA_DIR: directory, REPOS_ROOT: directory, DEFAULT_AGENT: "codex", DEFAULT_MODEL: profile.defaultModel,
    CHANNEL_PRESETS_FILE: file, REPO_EMOJIS: new Map(), DISCORD_ALLOWED_USER_IDS: new Set([USER]), SEAM_CONFIG_MUTATION_TIER_C_ENABLED: true,
    channelPresets: new Map(), threadPresets: new Map(), bridgePresets: new Map() } as Config;
  reloadChannelPresets(config, file, logger);
  const router = new SessionRouter({ logger, store, profiles: [profile], modelCatalog, defaultAgentId: profile.id, defaultModel: profile.defaultModel,
    channelPresets: config.channelPresets, threadPresets: config.threadPresets });
  const record = router.ensureSessionRecord({ platform: "discord", channelRef: THREAD, parentRef: PARENT, cwd: directory });
  record.acpSessionId = "retained-acp-session";
  store.upsert(record);
  const panels: StructuredPanel[] = [];
  const adapter = { sendPanel: vi.fn(async (_channel, panel) => { panels.push(panel); return { channel: { platform: "discord", id: THREAD }, id: "card" }; }),
    editPanel: vi.fn(async (_ref, panel) => { panels.push(panel); }), sendMessage: vi.fn(async () => ({ id: "message" })), deleteMessage: vi.fn(async () => {}) };
  const host = new PluginHost(logger, { slash: buildSlashRegistrationBody() });
  const orchestrator = new Orchestrator({ logger, config, store, router, modelCatalog, plugins: host, adapter: adapter as never, renderer: discordRenderer });
  await orchestrator.loadPlugins();
  cleanups.push(async () => { await host.dispose(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const slash = async (leaf: "card" | "gif", values: Record<string, string> = {}) => {
    const reply = vi.fn(async () => {});
    const native = { deferred: false, ephemeral: true, commandName: "seam", channelId: THREAD, channel: { isThread: () => true, parentId: PARENT }, user: { id: USER, username: "tester" },
      options: { getSubcommand: () => leaf, getSubcommandGroup: () => "config", getString: (name: string) => values[name] ?? null, getBoolean: () => null }, reply, editReply: reply,
      deferReply: async () => { native.deferred = true; } };
    await orchestrator.handleSlashInteraction(native as never);
    return reply;
  };
  return { logs, host, router, store, record, config, panels, adapter, orchestrator, slash };
}

describe("card-visuals built-in", () => {
  it("publishes the same keys and slash declarations to registration, gates and help", async () => {
    const h = await fixture();
    expect(h.host.configKeys.list()).toEqual(CARD_VISUAL_KEYS);
    const config = buildSlashRegistrationBody(h.host.slash)[0]!.options!.find(option => option.name === "config")!;
    expect("options" in config && config.options?.filter(option => option.name === "card" || option.name === "gif").length).toBe(2);
    expect(buildSeamHelpPages(undefined, h.host.slash.help()).join("\n")).toContain("/seam config card");
    const shown = await h.slash("card");
    expect(shown).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("simple` (from channel preset)") }));
    expect(h.store.listConfigMutations()).toHaveLength(0);
  });

  it("writes every scope through the real mutation service without changing precedence or ACP identity", async () => {
    const h = await fixture();
    const invalidate = vi.spyOn(h.router, "invalidate");
    await h.slash("card", { style: "full", scope: "thread" });
    await h.slash("gif", { state: "off", scope: "thread" });
    await h.slash("card", { style: "simple", scope: "session" });
    await h.slash("gif", { state: "on", scope: "session" });
    await h.slash("card", { style: "full", scope: "channel" });
    await h.slash("gif", { state: "off", scope: "channel" });
    const current = h.store.get(h.record.id)!;
    expect(h.router.describeConfig(current)).toMatchObject({ statusCardStyle: { value: "simple", source: "session config" }, simpleCardGif: { value: true, source: "session config" } });
    expect(h.config.threadPresets.get(THREAD)).toMatchObject({ statusCardStyle: { value: "full" }, simpleCardGif: { value: false } });
    expect(current.acpSessionId).toBe(h.record.acpSessionId);
    expect(invalidate).not.toHaveBeenCalled();
    const audits = h.store.listConfigMutations();
    expect(audits).toHaveLength(6);
    expect(audits.every(audit => audit.actorId === USER)).toBe(true);
    expect(new Set(audits.map(audit => audit.tier))).toEqual(new Set(["session", "thread-preset", "channel-preset"]));
    h.store.upsert({ ...current, configJson: h.store.writeConfig({}) });
    expect(h.router.describeConfig(h.store.get(current.id)!)).toMatchObject({ statusCardStyle: { value: "full", source: "thread preset" }, simpleCardGif: { value: false, source: "thread preset" } });
  });

  it("respects read-only/mutating gates before a plugin config write", async () => {
    const h = await fixture();
    h.config.channelPresets.get(PARENT)!.locked = true;
    expect((await h.slash("gif"))).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("on` (from channel preset)") }));
    expect((await h.slash("gif", { state: "off" }))).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringMatching(/channel is locked/) }));
    expect(h.store.listConfigMutations()).toHaveLength(0);
  });

  it("validates contributed keys before any audited mutation", async () => {
    const h = await fixture();
    const mutation = (h.orchestrator as any).configMutation;
    const actor = { kind: "slash", id: USER };
    const result = mutation.applySessionConfig(h.record, { statusCardStyle: "unknown" }, actor);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Invalid statusCardStyle") });
    expect(h.router.describeConfig(h.store.get(h.record.id)!)).toMatchObject({ statusCardStyle: { value: "simple", source: "channel preset" } });
    expect(h.store.listConfigMutations()).toHaveLength(0);
    expect(h.host.configKeys.parseChanges({ statusCardStyle: null, simpleCardGif: "off" })).toEqual({ statusCardStyle: null, simpleCardGif: false });
  });

  it("refreshes only as an admitted job and drains/aborts it on shutdown", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ gifs: ["https://gifs.example/one.gif"] }) }));
    vi.stubGlobal("fetch", fetch);
    const h = await fixture();
    const facts = { state: "Working" as const, agentId: "codex", model: "gpt-6.1-sol", style: "simple" as const, gifOn: true };
    expect(h.host.statusCards.decorate(facts).icon).toMatch(/codex.webp$/);
    expect(h.host.statusCards.decorate(facts).thumbnail).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    await h.host.jobs.startAfterAdmission(Promise.resolve());
    await h.host.jobs.drain();
    expect(h.host.statusCards.decorate(facts)).toMatchObject({ style: "simple", thumbnail: "https://gifs.example/one.gif" });
    expect(h.host.statusCards.decorate({ ...facts, style: "full" }).thumbnail).toBeUndefined();
    expect(h.host.statusCards.decorate({ ...facts, gifOn: false }).thumbnail).toBeUndefined();
    await vi.advanceTimersByTimeAsync(DEFAULT_GIF_REFRESH_MS);
    expect(fetch).toHaveBeenCalledTimes(2);
    h.host.jobs.stop();
    await h.host.jobs.drain();
    await vi.advanceTimersByTimeAsync(DEFAULT_GIF_REFRESH_MS);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("falls back to a plain Done card when decoration throws, without changing projection", async () => {
    const h = await fixture();
    h.host.statusCards.remove("card-visuals");
    h.host.statusCards.register("broken", [{ name: "throws", decorate: facts => {
      expect(Object.isFrozen(facts)).toBe(true);
      expect(() => { (facts as any).state = "Failed"; }).toThrow();
      throw new Error("visual fixture unavailable");
    } }], { logger: pino({ level: "silent" }), config: undefined });
    const panel = await (h.orchestrator as any).startDispatchStatusPanel({ platform: "discord", id: THREAD },
      { id: "test-turn", target: THREAD, session: "live", prompt: "Run the proof command", kind: "wake", createdUtc: new Date().toISOString() }, { model: "gpt-6.1-sol", cwd: h.record.repoPath, profile: h.router.getProfile("codex"), isolated: false });
    await panel.start();
    await panel.finalize("Done", "end_turn");
    expect(h.panels.at(-1)).toMatchObject({ title: expect.stringContaining("Done"), fields: expect.arrayContaining([{ name: "Action", value: "end_turn", inline: true }]) });
    expect(h.panels.at(-1)).not.toHaveProperty("authorIconURL");
    expect(h.logs.find(log => log.msg === "plugin status-card decorator failed").err.message).toBe("visual fixture unavailable");
  });

  it("accepts only visual output, leaving action and state in the kernel", async () => {
    const h = await fixture();
    h.host.statusCards.remove("card-visuals");
    h.host.statusCards.register("overreach", [{ name: "visuals", decorate: () => ({ icon: "https://icons.example/ok.webp", state: "Failed", action: "hide output", complete: true } as any) }], { logger: pino({ level: "silent" }), config: undefined });
    const visuals = h.host.statusCards.decorate({ state: "Working", model: "test", agentId: "codex", style: "full", gifOn: false });
    expect(visuals).toEqual({ icon: "https://icons.example/ok.webp" });
    const status = new TurnStatus({ model: "test", repoDisplay: "repo", style: visuals.style, brandIconURL: visuals.icon });
    const panel = new DispatchStatusPanel(discordRenderer, status, { post: async () => "card", edit: async () => {} });
    await panel.start(); await panel.finalize("Done", "end_turn");
    expect(renderStatusPanel(discordRenderer, status.toInput(), status.startedUtc)).toMatchObject({ title: "Done", authorIconURL: visuals.icon, fields: expect.arrayContaining([{ name: "Action", value: "end_turn", inline: true }]) });
  });

  it("keeps configured visuals on an adopted dispatch's original card", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ gifs: ["https://gifs.example/adopted.gif"] }) })));
    const h = await fixture();
    await h.host.jobs.startAfterAdmission(Promise.resolve());
    await h.host.jobs.drain();
    const ref = { channelId: THREAD, messageId: "original-card" };
    const panel = await (h.orchestrator as any).startDispatchStatusPanel({ platform: "discord", id: THREAD },
      { id: "adopted", target: THREAD, session: "live", prompt: "Continue recorded turn", kind: "wake" },
      { model: "gpt-6.1-sol", cwd: h.record.repoPath, profile: h.router.getProfile("codex"), isolated: false }, undefined, ref);
    await panel.finalize("Done", "end_turn");
    expect(h.adapter.editPanel).toHaveBeenLastCalledWith(expect.objectContaining({ id: "original-card" }), expect.objectContaining({ author: "Done", authorIconURL: expect.stringMatching(/codex.webp$/), fields: [] }));
    expect(h.adapter.sendPanel).toHaveBeenCalledOnce();
    expect(h.adapter.sendPanel).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ imageUrl: "https://gifs.example/adopted.gif" }));
    expect(h.adapter.deleteMessage).toHaveBeenCalledOnce();
  });

  it("disables only the plugin with an invalid default or boot config", async () => {
    const { logger, logs } = logging();
    const host = new PluginHost(logger);
    cleanups.push(() => host.dispose());
    const bad: Plugin = { id: "bad-key", apiVersion: 1, builtin: true, contributions: { configKeys: [{ key: "bad", schema: z.boolean(), defaultValue: "wrong", description: "Bad default" }] } };
    await host.loadBuiltins([{ id: "bad-key", load: async () => bad }, { id: "card-visuals", load: async () => createCardVisualsPlugin({ read: () => undefined, write: () => ({ ok: true }) }) },
      { id: "healthy", load: async () => ({ id: "healthy", apiVersion: 1, builtin: true, contributions: { fences: [{ tag: "healthy", instruction: "still available", handle: async () => {} }] } }) }], { "card-visuals": { ...visualConfig, BRAND_ICON_BASE_URL: "not a URL" } });
    expect(host.configKeys.list()).toEqual([]);
    expect(host.statusCards.decorate({ state: "Working", model: "test", agentId: "codex", style: "simple", gifOn: true })).toEqual({});
    expect(host.fences.instructions).toEqual(["still available"]);
    expect(logs.filter(log => log.msg === "plugin disabled").map(log => log.plugin)).toEqual(["bad-key", "card-visuals"]);
  });
});

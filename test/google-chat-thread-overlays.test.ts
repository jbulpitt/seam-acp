import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import type { AgentProfile } from "@seam/adapters";
import { buildChannelPresetMaps, PresetsFileSchema, type Config } from "../packages/core/src/config.js";
import { ConfigMutationService } from "../packages/core/src/core/config-mutation.js";
import { createConfigFacades } from "../packages/core/src/core/config-apply-plan.js";
import { reloadChannelPresets } from "../packages/core/src/core/config-reload.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { GoogleChatAdapter } from "../packages/core/src/platforms/google-chat/adapter.js";
import { logger as journal } from "../packages/core/src/lib/logger.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { localBridgeWiring } from "./local-bridge-fixture.js";

// Only the provider boundary is fake; SQL, overlay validation and transitions are real.
vi.mock("../packages/core/src/agents/agent-runtime.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../packages/core/src/agents/agent-runtime.js")>();
  return { ...actual, AgentRuntime: class {
    modelOverride?: string;
    effortOverride?: string;
    busy = false;
    sessionId = "";
    lastActivityAtMs = Date.now();
    async start() {}
    async loadSession(input: { sessionId: string }) { this.sessionId = input.sessionId; }
    async newSession() { this.sessionId = "fresh-provider-context"; return { sessionId: this.sessionId }; }
    getSessionInfo() { return { sessionId: this.sessionId, currentModelId: this.modelOverride, availableModels: [] }; }
    getConfigSelectValues() { return []; }
    hasDelegatedTurnInFlight() { return false; }
    supportsSessionLoad() { return true; }
    markActivity() { this.lastActivityAtMs = Date.now(); }
    async dispose() {}
    async setModel(model: string) { this.modelOverride = model; }
    async setConfigOption() {}
  } };
});

const chat = { platform: "google-chat", id: "nk7nBqAAAAE.bdu-1mvFHog", parentId: "nk7nBqAAAAE" };
const discord = { platform: "discord", id: "333333333333333333", parentId: "111111111111111111" };
const key = `google-chat:${chat.id}`;
const actor = { id: "42", name: "Tester" };
const logger = pino({ level: "silent" });
const profiles = ["claude", "codex"].map(id => ({ id, displayName: id, defaultModel: `${id}-default`,
  staticModels: ["default", "reviewed"].map(kind => ({ modelId: `${id}-${kind}`, name: `${id}-${kind}` })),
  effort: { mechanism: "meta", levels: ["low", "high"] },
})) as unknown as AgentProfile[];
let dir: string;
const cleanup: Array<() => void | Promise<void>> = [];
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-gchat-overlays-")); });
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function fixture(channel = chat) {
  const file = path.join(dir, "presets.json");
  const sibling = { model: { value: "discord-kept" }, role: { value: "worker" } };
  fs.writeFileSync(file, JSON.stringify({ channels: {}, threads: { "222222222222222222": sibling } }));
  const maps = buildChannelPresetMaps(file);
  const store = new SessionStore(path.join(dir, "seam.db"));
  cleanup.push(() => store.close());
  const catalog = fixtureModelCatalog(profiles);
  const router = new SessionRouter({ store, logger, profiles, modelCatalog: catalog, ...maps,
    defaultAgentId: "claude", defaultModel: "claude-default", defaultCwd: dir,
    defaultPermissionMode: "always", seamMcp: localBridgeWiring(profiles) });
  cleanup.push(() => router.disposeAll());
  const mutation = new ConfigMutationService({ store, logger, modelCatalog: catalog, presetsFile: file,
    describeConfig: row => router.describeConfig(row), isAgentAvailable: id => Boolean(router.getProfile(id)),
    tierCEnabled: true, reloadPresets: () => reloadChannelPresets(maps, file, logger) });
  const { plan, runtime } = createConfigFacades({ store, router, mutation, modelCatalog: catalog, logger,
    config: { ...maps, REPOS_ROOT: dir, CHANNEL_PRESETS_FILE: file } as Config,
    identityCommitted: async () => {}, persistConfig: (row, cfg) => store.upsert({ ...row, configJson: store.writeConfig(cfg) }),
    repoDisplay: repo => repo ?? "", unregisteredAgentMessage: (_id, message) => message,
  });
  const initial = router.ensureSessionRecord({ platform: channel.platform, channelRef: channel.id,
    parentRef: channel.parentId, cwd: dir });
  store.upsert({ ...initial, acpSessionId: "saved-provider-context" }, { source: "fixture", cause: "seed owned context" });
  return { file, sibling, store, router, mutation, maps, plan, runtime, record: () => store.get(initial.id)! };
}

describe("platform-aware persisted thread overlays", () => {
  it("persists and reloads real agent/model changes for a flat shared Chat session", async () => {
    const flat = { platform: "google-chat", id: "nk7nBqAAAAE", parentId: undefined } as any;
    const h = fixture(flat);
    const replies: string[] = [];
    const respond = async (text: string) => { replies.push(text); };
    expect((await h.runtime.applyAgentChange(flat, h.record(), "codex", actor, respond)).ok).toBe(true);
    expect((await h.runtime.applyModelChange(flat, h.record(), "codex-reviewed", actor, respond)).ok).toBe(true);
    const stored = JSON.parse(fs.readFileSync(h.file, "utf8"));
    expect(stored.threads["google-chat:nk7nBqAAAAE"]).toMatchObject({ agent: { value: "codex" }, model: { value: "codex-reviewed" } });
    expect(stored.threads["222222222222222222"]).toEqual(h.sibling);
    const maps = buildChannelPresetMaps(h.file);
    expect(maps.threadPresets.get(flat.id)?.model?.value).toBe("codex-reviewed");
    expect(h.router.describeConfig(h.record()).model.value).toBe("codex-reviewed");
  });

  it.each([[3, "agent", "claude"], [4, "model", "claude-default"]])
    ("bare command %s leaves real SQL, overlays and the warm runtime unchanged", async (commandId, command, current) => {
      const h = fixture();
      const warm = await h.router.getOrStartRuntime(h.record());
      const before = structuredClone(h.record());
      const presetBefore = fs.readFileSync(h.file, "utf8");
      const agent = vi.spyOn(h.runtime, "applyAgentChange");
      const model = vi.spyOn(h.runtime, "applyModelChange");
      const request = vi.fn(async (_scope: string, req: any) => ({
        name: `spaces/${chat.parentId}/messages/app`, thread: req.data.thread,
      }));
      const adapter = new GoogleChatAdapter({ api: { request }, logger, subscription: "projects/test/subscriptions/events",
        defaultCwd: dir, allowedUserIds: new Set(["users/42"]), writeIntervalMs: 0 });
      adapter.setCommandDeps({ store: h.store, router: h.router, mutation: h.mutation, runtimeTransition: h.runtime, cancelChannel: vi.fn() } as any);
      await adapter.receiveEvent({ type: "MESSAGE", space: { name: `spaces/${chat.parentId}` },
        user: { name: "users/42", displayName: "Tester" }, message: {
          name: `spaces/${chat.parentId}/messages/bare-${commandId}`, text: `/${command}`, argumentText: null,
          thread: { name: `spaces/${chat.parentId}/threads/bdu-1mvFHog` }, threadReply: true, slashCommand: { commandId },
        } });
      expect(agent).not.toHaveBeenCalled();
      expect(model).not.toHaveBeenCalled();
      expect(h.record()).toEqual(before);
      expect(fs.readFileSync(h.file, "utf8")).toBe(presetBefore);
      expect(h.router.getRuntime(before.id)).toBe(warm);
      expect(request.mock.calls[0]![1].data.text).toBe(`Usage: /${command} <id> — current: ${current}`);
    });

  it("loads qualified Chat keys alongside unchanged numeric Discord keys", () => {
    const document = { threads: { [key]: { agent: { value: "codex" }, model: { value: "codex-reviewed" } },
      [discord.id]: { agent: { value: "claude" } } } };
    expect(PresetsFileSchema.safeParse(document).success).toBe(true);
    const file = path.join(dir, "mixed.json");
    fs.writeFileSync(file, JSON.stringify(document));
    const maps = buildChannelPresetMaps(file);
    expect(maps.threadPresets.get(chat.id)?.model?.value).toBe("codex-reviewed");
    expect(maps.threadPresets.get(discord.id)?.agent?.value).toBe("claude");
  });

  it.each(["not-a-snowflake", chat.id, "discord:123", "google-chat:space.", "google-chat:space.thread.extra"])
    ("does not loosen legacy Discord keys or accept malformed Chat keys: %s", invalid => {
      expect(PresetsFileSchema.safeParse({ threads: { [invalid]: { agent: { value: "codex" } } } }).success).toBe(false);
    });

  it("routes real command actions through SQL and persisted overlays, surviving a reload", async () => {
    const h = fixture();
    let seq = 0;
    const request = vi.fn(async (scope: string, req: any) => scope === "pubsub" ? {} : ({
      name: `spaces/${chat.parentId}/messages/app-${++seq}`, thread: req.data.thread,
    }));
    const adapter = new GoogleChatAdapter({ api: { request }, logger, subscription: "projects/test/subscriptions/events",
      defaultCwd: dir, allowedUserIds: new Set(["users/42"]), writeIntervalMs: 0 });
    adapter.setCommandDeps({ store: h.store, router: h.router, mutation: h.mutation, runtimeTransition: h.runtime, cancelChannel: vi.fn() } as any);
    const normal = vi.fn(); adapter.onMessage(normal);
    const deliver = async (commandId: number, text: string) => {
      const event = { type: "MESSAGE", space: { name: `spaces/${chat.parentId}` },
        user: { name: "users/42", displayName: "Tester" }, message: {
          name: `spaces/${chat.parentId}/messages/command-${commandId}`, text, argumentText: text,
          thread: { name: `spaces/${chat.parentId}/threads/bdu-1mvFHog` }, threadReply: true, slashCommand: { commandId },
        } };
      await (adapter as any).transport.process({ ackId: `ack-${commandId}`, message: {
        messageId: `delivery-${commandId}`, data: Buffer.from(JSON.stringify(event)).toString("base64"),
      } }, new AbortController().signal);
    };
    await deliver(3, "/agent codex");
    expect(h.record()).toMatchObject({ agentId: "codex", acpSessionId: "" });
    expect(h.router.describeConfig(h.record()).agent.value).toBe("codex");
    await deliver(4, "/model codex-reviewed");
    const doc = JSON.parse(fs.readFileSync(h.file, "utf8"));
    expect(doc.threads[key]).toMatchObject({ agent: { value: "codex" }, model: { value: "codex-reviewed" } });
    expect(doc.threads[chat.id]).toBeUndefined();
    expect(doc.threads["222222222222222222"]).toEqual(h.sibling);
    expect(normal).not.toHaveBeenCalled();
    expect(request.mock.calls.filter(([scope]) => scope === "pubsub")).toHaveLength(2);
    expect(request.mock.calls.filter(([scope]) => scope === "chat").every(([, req]) =>
      req.data.thread.name === `spaces/${chat.parentId}/threads/bdu-1mvFHog`)).toBe(true);
    const reloaded = buildChannelPresetMaps(h.file);
    expect(reloaded.threadPresets.get(chat.id)).toMatchObject({ agent: { value: "codex" }, model: { value: "codex-reviewed" } });
    h.maps.threadPresets.clear();
    for (const [id, preset] of reloaded.threadPresets) h.maps.threadPresets.set(id, preset);
    h.store.upsert({ ...h.record(), agentId: "claude", configJson: "{}" });
    expect(h.router.planRuntimeSpawn(h.record())).toMatchObject({ agentId: "codex", model: "codex-reviewed" });
  });

  it("a permanent Google reply error never rolls back the committed core model change", async () => {
    const h = fixture();
    const cause = Object.assign(new Error("NOT_FOUND: command thread is not replyable"), { response: { status: 404 } });
    const request = vi.fn(async (_scope: string, _req: any): Promise<any> => { throw cause; });
    const adapter = new GoogleChatAdapter({ api: { request }, logger, subscription: "projects/test/subscriptions/events",
      defaultCwd: dir, allowedUserIds: new Set(["users/42"]), writeIntervalMs: 0 });
    adapter.setCommandDeps({ store: h.store, router: h.router, mutation: h.mutation, runtimeTransition: h.runtime, cancelChannel: vi.fn() } as any);
    await adapter.receiveEvent({ type: "MESSAGE", space: { name: `spaces/${chat.parentId}` },
      user: { name: "users/42", displayName: "Tester" }, message: {
        name: `spaces/${chat.parentId}/messages/model-reply-fails`, text: "/model claude-reviewed",
        argumentText: "/model claude-reviewed", slashCommand: { commandId: 4 },
        thread: { name: `spaces/${chat.parentId}/threads/bdu-1mvFHog` }, threadReply: true,
      } });
    expect(h.router.describeConfig(h.record()).model.value).toBe("claude-reviewed");
    expect(JSON.parse(fs.readFileSync(h.file, "utf8")).threads[key].model.value).toBe("claude-reviewed");
    expect(request).toHaveBeenCalledOnce();
  });

  it("uses the same qualified root for proposals and cross-thread identity settings", () => {
    const h = fixture();
    const proposed = h.mutation.buildProposal(h.record(), { threadPreset: { role: "worker" } });
    expect(proposed).toMatchObject({ ok: true });
    if (!proposed.ok) throw new Error(proposed.error);
    expect(proposed.proposal.apply(actor)).toMatchObject({ ok: true });
    expect(h.plan.applyTargetIdentity(h.record(), { model: "claude-reviewed" }, actor)).toEqual({ ok: true });
    const doc = JSON.parse(fs.readFileSync(h.file, "utf8"));
    expect(doc.threads[key]).toMatchObject({ role: { value: "worker" }, model: { value: "claude-reviewed" } });
    expect(doc.threads[chat.id]).toBeUndefined();
  });

  it("retires and clears an accepted switch only after the Chat overlay is committed", async () => {
    const h = fixture();
    await h.router.getOrStartRuntime(h.record());
    const observed: Array<{ agent: string; acp: string }> = [];
    const invalidate = h.router.invalidate.bind(h.router);
    vi.spyOn(h.router, "invalidate").mockImplementation(async (...args) => {
      observed.push({ agent: JSON.parse(fs.readFileSync(h.file, "utf8")).threads[key]?.agent?.value,
        acp: h.record().acpSessionId });
      await invalidate(...args);
    });
    const result = await h.runtime.applyAgentChange(chat, h.record(), "codex", actor, async () => {});
    expect(result).toMatchObject({ ok: true });
    expect(observed).toEqual([{ agent: "codex", acp: "saved-provider-context" }]);
    expect(h.record()).toMatchObject({ agentId: "codex", acpSessionId: "" });
    expect(h.router.hasRuntime(h.record().id)).toBe(false);
  });

  it("restores an existing qualified Chat overlay when model verification refuses it", async () => {
    const h = fixture();
    const original = { agent: { value: "claude" }, model: { value: "claude-default" }, role: { value: "worker" } };
    fs.writeFileSync(h.file, JSON.stringify({ channels: {}, threads: {
      [key]: original, "222222222222222222": h.sibling,
    } }));
    expect(reloadChannelPresets(h.maps, h.file, logger)).toMatchObject({ ok: true });
    const presetBefore = structuredClone(h.maps.threadPresets.get(chat.id));
    const warm = await h.router.getOrStartRuntime(h.record());
    const before = { ...h.record() };
    const spawn = h.router.planRuntimeSpawn.bind(h.router);
    vi.spyOn(h.router, "planRuntimeSpawn").mockImplementation(row => ({ ...spawn(row), model: "wrong-model" }));
    const retired = vi.spyOn(h.router, "invalidate");
    const result = await h.runtime.applyModelChange(chat, h.record(), "claude-reviewed", actor, async () => {});
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("effective configuration did not match") });
    const doc = JSON.parse(fs.readFileSync(h.file, "utf8"));
    expect(doc.threads[key]).toEqual(original);
    expect(doc.threads[chat.id]).toBeUndefined();
    expect(doc.threads["222222222222222222"]).toEqual(h.sibling);
    expect(h.maps.threadPresets.get(chat.id)).toEqual(presetBefore);
    expect(h.record()).toMatchObject({ agentId: before.agentId, configJson: before.configJson, acpSessionId: before.acpSessionId });
    expect(retired).not.toHaveBeenCalled();
    expect(h.router.getRuntime(before.id)).toBe(warm);
  });

  it.each([chat, discord])("refused $platform agent switches preserve the warm runtime and every ACP binding write", async channel => {
    const h = fixture(channel);
    const warm = await h.router.getOrStartRuntime(h.record());
    const before = { ...h.record() };
    const invalid = JSON.stringify({ channels: {}, threads: { "222222222222222222": { model: { value: 123 } } } });
    fs.writeFileSync(h.file, invalid);
    const bindings: string[] = [];
    const unsubscribe = h.store.onSessionWrite(row => { if (row.id === before.id) bindings.push(row.acpSessionId); });
    cleanup.push(unsubscribe);
    const clear = vi.spyOn(journal, "info").mockImplementation(() => {});
    const retired = vi.spyOn(h.router, "invalidate");
    const respond = vi.fn(async () => {});
    const result = await h.runtime.applyAgentChange(channel, h.record(), "codex", actor, respond);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Nothing written") });
    expect(h.record()).toMatchObject({ agentId: before.agentId, acpSessionId: before.acpSessionId, configJson: before.configJson });
    expect(fs.readFileSync(h.file, "utf8")).toBe(invalid);
    expect(retired).not.toHaveBeenCalled();
    expect(h.router.getRuntime(before.id)).toBe(warm);
    expect(bindings).not.toContain("");
    expect(clear.mock.calls.filter(([row, message]) => message === "cleared stored acp session id" &&
      (row as any).sessionId === before.id)).toHaveLength(0);
  });
});

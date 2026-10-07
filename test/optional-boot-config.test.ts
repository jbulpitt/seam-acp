import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import type { AgentProfile } from "@seam/adapters";
import { buildChannelPresetMaps, loadConfig } from "../packages/core/src/config.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import type { IncomingMessage } from "../packages/core/src/platforms/chat-adapter.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { localBridgeWiring } from "./local-bridge-fixture.js";

const roots: string[] = [];
const stores: SessionStore[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  stores.splice(0).forEach((store) => store.close());
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});
const env = { DISCORD_BOT_TOKEN: "fixture", DISCORD_ALLOWED_USER_IDS: "123", REPOS_ROOT: os.tmpdir(), DEFAULT_AGENT: "claude" };
const silent = pino({ level: "silent" }) as unknown as Logger;
const profile = { id: "claude", defaultModel: "default", spawn: vi.fn(() => { throw new Error("unexpected local spawn"); }) } as unknown as AgentProfile;

describe("#614 optional startup settings", () => {
  it.each([
    { AGY_ENABLED: "true", AGY_CLI_PATH: "relative", AGY_DEFAULT_MODEL: "model" },
    { AGY_PIN: "bad-mode" },
    { AGY_AUTO_COMPACT_THRESHOLD: "2" },
    { AGY_NATIVE_RESTORE: "true", AGY_ENABLED: "false" },
  ])("refuses only AGY and logs its actual validation cause: %j", (bad) => {
    const warnings: string[] = [];
    const config = loadConfig({ env: { ...env, ...bad }, warn: (message) => warnings.push(message) });
    expect(config.AGY_ENABLED).toBe(false);
    expect(config.AGY_NATIVE_RESTORE).toBe(false);
    expect(config.agyDisabledReason).toBeTruthy();
    expect(warnings).toContain(`AGY disabled: ${config.agyDisabledReason}`);
    expect(config.DISCORD_BOT_TOKEN).toBe("fixture");
    expect(config.DEFAULT_AGENT).toBe("claude");
  });

  it("keeps mandatory Discord settings fatal even alongside bad AGY config", () => {
    expect(() => loadConfig({ env: { ...env, DISCORD_BOT_TOKEN: "", AGY_PIN: "invalid" }, warn: () => {} }))
      .toThrow("DISCORD_BOT_TOKEN");
  });

  it("drops only invalid preset entries at boot, keeps valid siblings, and leaves the file and strict reload untouched", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-614-presets-")); roots.push(root);
    const file = path.join(root, "presets.json");
    const raw = JSON.stringify({
      channels: { "111": { agent: { value: "claude" } }, "112": { location: "local" }, invalidId: {} },
      threads: { "222": { agent: { value: "codex" } }, "223": { agent: "claude" } },
      bridges: { good: { tokenHash: "a".repeat(64) }, bad: { tokenHash: "invalid" } },
    });
    fs.writeFileSync(file, raw);
    const warnings: string[] = [];
    const config = loadConfig({ env: { ...env, CHANNEL_PRESETS_FILE: file }, warn: (message) => warnings.push(message) });
    expect([...config.channelPresets.keys()]).toEqual(["111"]);
    expect([...config.threadPresets.keys()]).toEqual(["222"]);
    expect([...config.bridgePresets.keys()]).toEqual(["good"]);
    expect(warnings.join("\n")).toMatch(/channels.112.location.*thread-only/);
    expect(warnings.join("\n")).toContain("channels.invalidId");
    expect(warnings.join("\n")).toContain("threads.223.agent");
    expect(warnings.join("\n")).toContain("bridges.bad.tokenHash");
    expect(fs.readFileSync(file, "utf8")).toBe(raw);
    expect(() => buildChannelPresetMaps(file)).toThrow("Invalid CHANNEL_PRESETS_FILE");
  });

  it.each([
    { DEFAULT_AGENT: "opencode" },
  ])("refuses only new sessions depending on bad DEFAULT_AGENT: %j", (bad) => {
    const warnings: string[] = [];
    const config = loadConfig({ env: { ...env, ...bad }, warn: (message) => warnings.push(message) });
    const store = new SessionStore(":memory:"); stores.push(store);
    const router = new SessionRouter({ logger: silent, store, profiles: [profile], modelCatalog: fixtureModelCatalog([profile]),
      defaultAgentId: config.DEFAULT_AGENT, defaultAgentDisabledReason: config.defaultAgentDisabledReason,
      defaultModel: "default", channelPresets: new Map([["111", { agent: { value: "claude" }, locked: false }]]), seamMcp: localBridgeWiring(profile) });
    const opts = { platform: "discord", channelRef: "222", cwd: os.tmpdir() };
    expect(() => router.ensureSessionRecord(opts)).toThrow(config.defaultAgentDisabledReason);
    expect(store.countSessions()).toBe(0);
    const explicit = router.ensureSessionRecord({ ...opts, parentRef: "111" });
    expect(explicit.agentId).toBe("claude");
    expect(router.planRuntimeSpawn(explicit).agentId).toBe("claude");
    expect(router.ensureSessionRecord(opts)).toMatchObject(explicit);
    expect(warnings.join(" ")).toContain(config.defaultAgentDisabledReason);
  });


  it.each([
    { DEFAULT_AGENT: "opencode" },
  ].flatMap((bad) => [false, true].flatMap((deliveryFails) => [false, true].map((offline) => ({ bad, deliveryFails, offline })))))("reports an unavailable default before admission or parking, retaining its cause if delivery fails: %j", async ({ bad, deliveryFails, offline }) => {
    const config = loadConfig({ env: { ...env, ...bad }, warn: () => {} });
    const store = new SessionStore(":memory:"); stores.push(store);
    const catalog = fixtureModelCatalog([profile]);
    const router = new SessionRouter({ logger: silent, store, profiles: [profile], modelCatalog: catalog,
      defaultAgentId: config.DEFAULT_AGENT, defaultAgentDisabledReason: config.defaultAgentDisabledReason,
      defaultModel: "default", seamMcp: localBridgeWiring(profile) });
    const sendMessage = vi.fn(async () => {
      if (deliveryFails) throw new Error("staging refusal transport unavailable");
      return { id: "notice", channel: { platform: "discord", id: "222" } };
    });
    const host = new Orchestrator({ logger: silent, config, store, router, modelCatalog: catalog,
      adapter: { sendMessage } as never, renderer: {} as never });
    const boundary = host as unknown as { bridgeHub: unknown; parkUserPrompt: (...args: unknown[]) => Promise<unknown> };
    boundary.bridgeHub = { isBridgeReady: () => !offline };
    const park = vi.spyOn(boundary, "parkUserPrompt");
    const logError = vi.spyOn((host as unknown as { logger: Logger }).logger, "error");
    const message: IncomingMessage = { messageId: "614", channel: { platform: "discord", id: "222" },
      authorId: "123", authorIsBot: false, text: "never submitted", raw: {} };
    await expect((host as unknown as { handleIncomingMessage(msg: IncomingMessage): Promise<void> }).handleIncomingMessage(message))
      .rejects.toThrow(config.defaultAgentDisabledReason);
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(message.channel, `❌ Cannot start this session: ${config.defaultAgentDisabledReason}`);
    expect(store.countSessions()).toBe(0);
    expect(store.getInbound("614")).toBeNull();
    expect(store.turnAttempts.list("active")).toEqual([]);
    expect(park).not.toHaveBeenCalled();
    if (deliveryFails) {
      expect(logError).toHaveBeenCalledWith({ err: expect.objectContaining({ message: "staging refusal transport unavailable" }),
        refusal: config.defaultAgentDisabledReason }, "failed to send default-agent refusal");
    } else {
      expect(logError).not.toHaveBeenCalled();
    }
  });

  it("MCP-off still binds and spawns through the execution bridge, with no Seam tool injection", async () => {
    const store = new SessionStore(":memory:"); stores.push(store);
    const hostSpawn = vi.fn(() => Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
    }) as any);
    const wire = localBridgeWiring(hostSpawn);
    const mux = wire.muxForSession!("fixture")!;
    const spawn = vi.spyOn(mux, "spawn");
    const router = new SessionRouter({ logger: silent, store, profiles: [profile], modelCatalog: fixtureModelCatalog([profile]),
      defaultAgentId: "claude", defaultModel: "default", executionBridge: { isBridgeSession: wire.isBridgeSession!, muxForSession: () => mux },
      bindSessionLocation: wire.bindSessionLocation });
    const record = router.ensureSessionRecord({ platform: "discord", channelRef: "222", cwd: os.tmpdir() });
    const plan = router.planRuntimeSpawn(record);
    expect(plan.mcpServers).toEqual([]);
    const child = await plan.spawnChild();
    expect(child).toBe(spawn.mock.results[0]!.value);
    expect(hostSpawn).toHaveBeenCalledWith(expect.objectContaining({ agentId: "claude", mcpServers: [] }));
    expect(spawn).toHaveBeenCalledWith({ holdStdinUntilReady: true });
    expect(profile.spawn).not.toHaveBeenCalled();
  });
});

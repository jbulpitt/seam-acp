import { describe, expect, it } from "vitest";
import { pino } from "pino";
import { loadConfig } from "../packages/core/src/config.js";
import { inventoryFromAdapters, loadHostAdapters } from "../packages/bridge/src/inventory.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { agentLocationPickerChoices } from "../packages/core/src/platforms/discord/location.js";
import { spawnRemoteSlot } from "../packages/core/src/core/remote-spawn.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { localBridgeWiring } from "./local-bridge-fixture.js";
import { asLocalAdapter, CLAUDE_FAST_MODE } from "@seam/adapters";

describe("the bridge is authoritative on every host", () => {
  it("a controller Copilot opt-out does not remove another host's offering or catalog", async () => {
    const config = loadConfig({ env: {
      DISCORD_BOT_TOKEN: "test", DISCORD_ALLOWED_USER_IDS: "123", REPOS_ROOT: process.cwd(),
      COPILOT_ENABLED: "false",
    } });
    expect(config).not.toHaveProperty("COPILOT_ENABLED");
    const env = { PATH: process.env.PATH, AGY_ENABLED: "false" };
    const local = loadHostAdapters("copilot", { env: { ...env, COPILOT_ENABLED: "false" }, exists: bin => bin === "copilot" });
    const remote = loadHostAdapters("copilot", {
      env, exists: bin => bin === "copilot",
      copilotCatalogProbe: async () => ({
        defaultModel: "host-copilot-model",
        models: [{ modelId: "host-copilot-model", displayName: "Host model", effortChoices: ["high"], effortDefault: "high" }],
      }),
    });
    const inventories = new Map([
      ["local", new Map(inventoryFromAdapters(local, "copilot", env).map(entry => [entry.agentId, entry]))],
      ["remote-645", new Map(inventoryFromAdapters(remote, "copilot", env).map(entry => [entry.agentId, entry]))],
    ]);
    const agentsByHost = new Map([...inventories].map(([host, rows]) =>
      [host, new Set(rows.keys())]));
    const router = new SessionRouter({
      logger: pino({ level: "silent" }) as any, store: {} as any,
      profiles: [], modelCatalog: fixtureModelCatalog([...remote.values()]),
      defaultAgentId: "copilot", defaultModel: "gpt-6.1-sol",
      profileIds: location => agentsByHost.get(location) ?? [],
      profileMetadata: (id, location) => inventories.get(location)?.get(id)?.metadata,
      profileCatalog: (id, location) => (location === "local" ? local : remote).get(id)?.catalog,
    });
    expect(router.listProfiles("local")).toEqual([]);
    expect(router.listProfiles("remote-645").map(profile => profile.id)).toEqual(["copilot"]);
    const choices = agentLocationPickerChoices(router.listProfiles(), {
      bridges: [{ id: "remote-645", shortName: "remote", emoji: "🌐" }],
      connected: new Set(inventories.keys()), agentsByHost,
    } as any);
    expect(choices.some(choice => choice.value === "copilot@remote-645")).toBe(true);
    expect(choices.some(choice => choice.value === "copilot@local")).toBe(false);
    expect((await router.getProfile("copilot", "remote-645")!.catalog.fetch()).models.map(model => model.id))
      .toEqual(["host-copilot-model"]);

    const wiring = localBridgeWiring([...local.values()]);
    await expect(spawnRemoteSlot(wiring.muxForSession!("discord:645-absent")!, {
      agentId: "copilot", cwd: process.cwd(), mcpServers: [],
    })).rejects.toThrow('this bridge does not offer agent "copilot"');
  });

  it("cold local metadata is usable before a model snapshot is published", () => {
    const adapters = loadHostAdapters("copilot", {
      env: { PATH: process.env.PATH, AGY_ENABLED: "false" }, exists: bin => bin === "copilot",
    });
    const inventory = inventoryFromAdapters(adapters, "copilot")[0]!;
    const router = new SessionRouter({
      logger: pino({ level: "silent" }) as any, store: {} as any, profiles: [],
      modelCatalog: { lookup: () => ({ snapshot: null }) } as any,
      defaultAgentId: "copilot", defaultModel: "gpt-6.1-sol",
      profileIds: () => ["copilot"], profileMetadata: () => inventory.metadata,
      profileCatalog: () => adapters.get("copilot")!.catalog,
    });
    expect(router.listProfiles()[0]).toMatchObject({
      id: "copilot", displayName: inventory.metadata!.displayName,
      defaultModel: inventory.metadata!.defaultModel, mcpServersAtSpawn: true,
    });
    expect(router.getProfile("copilot")!.classifyError!(new Error("copilot ACP advertised no model config options")))
      .toMatchObject({ errorKind: "capability_absent", agentId: "copilot" });
  });

  it.each(["local", "remote-645"])("keeps Claude ACP client policy on %s without a launch profile", location => {
    const metadata = {
      displayName: "Claude", defaultModel: "claude-opus-5-5",
      claudeSessionOptions: {}, sessionManagement: null,
      catalogScope: { fingerprint: "c".repeat(64), provider: "anthropic" },
    };
    const catalog = { scope: () => metadata.catalogScope, fetch: async () => { throw new Error("unused catalog fetch"); } };
    const router = new SessionRouter({
      logger: pino({ level: "silent" }) as any, store: {} as any, profiles: [],
      modelCatalog: { lookup: () => ({ snapshot: null }) } as any,
      defaultAgentId: "claude", defaultModel: metadata.defaultModel,
      profileMetadata: () => metadata, profileCatalog: () => catalog,
      claudeSessionOptions: { thinkingDisplay: "summarized" },
    });
    expect(router.getProfile("claude", location)!.newSessionMeta!(metadata.defaultModel, "high"))
      .toMatchObject({ claudeCode: { options: {
        effort: "high", thinking: { type: "adaptive", display: "summarized" },
      } } });
  });

  it.each(["local", "remote-645"])("retains client policy on %s with a metadata-free hello, cold and cached", location => {
    const hello = { agents: [
      { agentId: "claude", version: 4, installed: true, ready: false },
      { agentId: "copilot", version: 4, installed: true, ready: false },
    ] };
    const profiles = hello.agents.map(row => asLocalAdapter({
      id: row.agentId, displayName: row.agentId,
      defaultModel: row.agentId === "claude" ? "claude-opus-5-5" : "gpt-6.1-sol",
      spawn: () => { throw new Error("controller must not spawn"); },
    }));
    for (const modelCatalog of [{ lookup: () => ({ snapshot: null }) }, fixtureModelCatalog(profiles)]) {
      const router = new SessionRouter({
        logger: pino({ level: "silent" }) as any, store: {} as any, profiles: [],
        modelCatalog: modelCatalog as any,
        defaultAgentId: "claude", defaultModel: "default",
        profileIds: () => hello.agents.map(row => row.agentId),
        profileMetadata: () => undefined,
        profileCatalog: () => ({
          scope: () => ({ fingerprint: "f".repeat(64), provider: "fixture" }),
          fetch: async () => { throw new Error("unused catalog fetch"); },
        }),
        claudeSessionOptions: { thinkingDisplay: "summarized" },
      });
      expect(router.listProfiles(location).map(profile => profile.id)).toEqual(["claude", "copilot"]);
      const claude = router.getProfile("claude", location)!;
      expect(claude.newSessionMeta!("claude-opus-5-5", "high")).toEqual({
        claudeCode: {
          options: {
            effort: "high", thinking: { type: "adaptive", display: "summarized" },
          },
          emitRawSDKMessages: [{ type: "command_lifecycle" }, { type: "stream_event" }],
        },
      });
      expect(claude.effort).toMatchObject({ mechanism: "meta", levels: expect.arrayContaining(["high"]) });
      expect(claude.fastMode).toEqual(CLAUDE_FAST_MODE);
      expect(claude.submissionSignals).toBe("claude_sdk");
      expect(claude.classifyError!(Object.assign(new Error("Authentication required"), {
        data: { errorKind: "authentication_failed" },
      }))).toMatchObject({ errorKind: "auth_required", agentId: "claude" });
      const copilot = router.getProfile("copilot", location)!;
      expect(copilot.mcpServersAtSpawn).toBe(true);
      expect(copilot.effort).toMatchObject({ mechanism: "configOption", configId: "reasoning_effort" });
      expect(copilot.classifyError!(new Error("copilot ACP advertised no model config options")))
        .toMatchObject({ errorKind: "capability_absent", agentId: "copilot" });
    }
  });
});

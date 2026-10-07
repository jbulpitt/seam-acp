import { describe, expect, it } from "vitest";
import { pino } from "pino";
import { loadConfig } from "../packages/core/src/config.js";
import { inventoryFromAdapters, loadHostAdapters } from "../packages/bridge/src/inventory.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { agentLocationPickerChoices } from "../packages/core/src/platforms/discord/location.js";
import { spawnRemoteSlot } from "../packages/core/src/core/remote-spawn.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { localBridgeWiring } from "./local-bridge-fixture.js";

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
});

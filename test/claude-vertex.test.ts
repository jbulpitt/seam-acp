import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { makeClaudeProfile, type AgentProfile } from "@seam/adapters";
import { inventoryFromAdapters, loadHostAdapterInventory } from "../packages/bridge/src/inventory.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { agentLocationPickerChoices } from "../packages/core/src/platforms/discord/location.js";
import { resolveAgentBrand, brandIconUrl } from "../packages/core/src/plugins/card-visuals/agent-brand.js";
import { loadConfig } from "../packages/core/src/config.js";
import { controllerQuotaProfiles } from "../packages/core/src/core/quota/controller-profiles.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";

const models = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
const cli = path.resolve("test/fixtures/claude-spawn-env.mjs");
const env = {
  AGY_ENABLED: "false", CLAUDE_CLI_PATH: cli,
  CLAUDE_VERTEX_AGENT_ID: "vertex-test", CLAUDE_VERTEX_DISPLAY_NAME: "Vertex test",
  CLAUDE_VERTEX_PROJECT_ID: "test-project", CLAUDE_VERTEX_CREDENTIALS_FILE: "/test/vertex-key.json",
  CLAUDE_VERTEX_CONFIG_DIR: "/test/vertex-claude",
};
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function load(overrides: NodeJS.ProcessEnv = {}) {
  return loadHostAdapterInventory("copilot", { env: { ...env, ...overrides }, exists: bin => bin === cli });
}

async function spawnFacts(profile: AgentProfile, model?: string) {
  const child = profile.spawn(model);
  const output: Buffer[] = [];
  child.stdout.on("data", chunk => output.push(Buffer.from(chunk)));
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(`fixture exit ${code}`)));
  });
  return JSON.parse(Buffer.concat(output).toString("utf8"));
}

describe("bridge-configured Vertex Claude", () => {
  it("publishes the separate agent and all three models in a project-scoped manifest", async () => {
    const { adapters, adapterRefusals } = load();
    expect([...adapters.keys()]).toEqual(["claude", "vertex-test"]);
    expect(adapterRefusals).toEqual([]);
    const vertex = adapters.get("vertex-test")!;
    expect(vertex).toMatchObject({ displayName: "Vertex test", brand: "vertex", configDir: env.CLAUDE_VERTEX_CONFIG_DIR });
    const catalog = await vertex.catalog.fetch();
    expect(catalog.scope).toMatchObject({ backend: "vertex", project: "test-project", region: "global" });
    expect(catalog.models.map(row => row.id)).toEqual(models);
    expect(catalog.models.every(row => row.context.effective === null)).toBe(true);
    expect(catalog.models.find(row => row.default)?.id).toBe("claude-sonnet-5-5");
    const hello = inventoryFromAdapters(adapters, "copilot", env);
    expect(hello.find(row => row.agentId === "vertex-test")).toMatchObject({
      installed: true, metadata: { brand: "vertex", displayName: "Vertex test", claudeSessionOptions: {} },
    });
    expect(JSON.stringify(hello)).not.toContain(env.CLAUDE_VERTEX_CREDENTIALS_FILE);
  });

  it("omits Vertex on an unconfigured bridge and names the missing keys for partial configuration", () => {
    const empty = loadHostAdapterInventory("copilot", { env: { AGY_ENABLED: "false", CLAUDE_CLI_PATH: cli }, exists: bin => bin === cli });
    expect([...empty.adapters.keys()]).toEqual(["claude"]);
    expect(empty.adapterRefusals).toEqual([]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const partial = load({ CLAUDE_VERTEX_CREDENTIALS_FILE: undefined, CLAUDE_VERTEX_CONFIG_DIR: undefined });
    expect([...partial.adapters.keys()]).toEqual(["claude"]);
    expect(partial.adapterRefusals).toEqual([{
      agentId: "vertex-test", code: "configuration_incomplete",
      missing: ["CLAUDE_VERTEX_CREDENTIALS_FILE", "CLAUDE_VERTEX_CONFIG_DIR"],
    }]);
    expect(load({ CLAUDE_VERTEX_PROJECT_ID: undefined }).adapterRefusals).toEqual([{
      agentId: "vertex-test", code: "configuration_incomplete", missing: ["CLAUDE_VERTEX_PROJECT_ID"],
    }]);
  });

  it("does not let the Vertex profile reuse subscription history", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const loaded = load({ CLAUDE_CONFIG_DIR: "/test/subscription", CLAUDE_VERTEX_CONFIG_DIR: "/test/subscription" });
    expect(loaded.adapters.has("vertex-test")).toBe(false);
    expect(loaded.adapterRefusals).toEqual([{
      agentId: "vertex-test", code: "configuration_incomplete",
      missing: ["CLAUDE_VERTEX_CONFIG_DIR (separate from subscription Claude)"],
    }]);
  });

  it("honors the host's configured region, model list and default", async () => {
    const vertex = load({
      CLAUDE_VERTEX_REGION: "us-east5", CLAUDE_VERTEX_DEFAULT_MODEL: "claude-haiku-5-5",
      CLAUDE_VERTEX_MODELS: "claude-haiku-5-5:Haiku test,claude-sonnet-5-5:Sonnet test",
    }).adapters.get("vertex-test")!;
    const catalog = await vertex.catalog.fetch();
    expect(catalog.scope.region).toBe("us-east5");
    expect(catalog.models.map(row => [row.id, row.displayName])).toEqual([
      ["claude-haiku-5-5", "Haiku test"], ["claude-sonnet-5-5", "Sonnet test"],
    ]);
    expect(vertex.defaultModel).toBe("claude-haiku-5-5");
  });

  it("the real spawned child gets Vertex settings without changing subscription Claude", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "fixture-subscription-key");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/test/subscription");
    const adapters = load().adapters;
    for (const model of models) {
      expect(await spawnFacts(adapters.get("vertex-test")!, model)).toEqual({
        model, vertex: "1", project: "test-project", region: "global",
        credentialsFile: env.CLAUDE_VERTEX_CREDENTIALS_FILE, configDir: env.CLAUDE_VERTEX_CONFIG_DIR,
        anthropicApiKeyPresent: false,
      });
    }
    expect(await spawnFacts(adapters.get("vertex-test")!)).toMatchObject({ model: "claude-sonnet-5-5" });
    expect(await spawnFacts(adapters.get("claude")!, "claude-haiku-5-5")).toMatchObject({
      model: "claude-haiku-5-5", vertex: null, project: null,
      configDir: "/test/subscription", anthropicApiKeyPresent: true,
    });
    expect(process.env.ANTHROPIC_API_KEY).toBe("fixture-subscription-key");
  });

  it("pins the Vertex default even when the caller supplies no model override", async () => {
    const vertex = makeClaudeProfile({
      id: "vertex-test", cliPath: cli, defaultModel: "claude-sonnet-5-5",
      configDir: env.CLAUDE_VERTEX_CONFIG_DIR,
      extraEnv: { CLAUDE_CODE_USE_VERTEX: "1" },
    });
    expect(await spawnFacts(vertex)).toMatchObject({ model: "claude-sonnet-5-5", vertex: "1" });
  });

  it("receives controller policy, picker identity and Vertex branding from hello", () => {
    const adapters = load().adapters;
    const inventory = new Map(inventoryFromAdapters(adapters, "copilot", env).map(row => [row.agentId, row]));
    const router = new SessionRouter({
      logger: pino({ level: "silent" }) as any, store: {} as any, profiles: [],
      modelCatalog: fixtureModelCatalog([...adapters.values()]),
      defaultAgentId: "claude", defaultModel: "default",
      profileIds: () => inventory.keys(), profileMetadata: id => inventory.get(id)?.metadata,
      profileCatalog: id => adapters.get(id)?.catalog,
      claudeSessionOptions: { thinkingDisplay: "summarized" },
    });
    const profile = router.getProfile("vertex-test", "host-test")!;
    expect(profile.newSessionMeta!(models[0], "high")).toMatchObject({
      claudeCode: { options: { effort: "high", thinking: { type: "adaptive", display: "summarized" } } },
    });
    expect(profile.fastMode).toBeUndefined();
    expect(resolveAgentBrand(profile.id, profile.brand)).toBe("vertex");
    expect(brandIconUrl(profile.brand!)).toMatch(/\/vertex\.webp$/);
    const choices = agentLocationPickerChoices(router.listProfiles("host-test"), {
      bridges: [{ id: "host-test", shortName: "test", emoji: "🌐" }],
      connected: new Set(["host-test"]), agentsByHost: new Map([["host-test", new Set(inventory.keys())]]),
    } as any);
    expect(choices.some(choice => choice.value === "vertex-test@host-test")).toBe(true);
  });

  it("keeps GCP authentication, model access and quota failures' real details", () => {
    const profile = makeClaudeProfile({ id: "vertex-test", defaultModel: models[1], brand: "vertex" });
    for (const [message, errorKind] of [
      ["Could not load the default credentials from /test/missing-key.json", "authentication_failed"],
      ["Publisher model projects/test-project/locations/global/publishers/anthropic/models/not-enabled was not found", "model_not_found"],
      ["Quota exceeded for aiplatform.googleapis.com online_prediction_requests", "rate_limit"],
    ]) {
      const error = Object.assign(new Error(message), { data: { errorKind } });
      expect(profile.classifyError!(error).details).toBe(message);
      expect(error.message).toBe(message);
    }
  });

  it("uses only the isolated config directory for history and served model evidence", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vertex-history-"));
    try {
      const configDir = path.join(root, "vertex");
      const project = path.join(configDir, "projects", "-test-cwd");
      fs.mkdirSync(project, { recursive: true });
      const history = path.join(project, "session.jsonl");
      fs.writeFileSync(history, JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(),
        message: { model: models[2], usage: { input_tokens: 5, output_tokens: 2 } } }) + "\n");
      const profile = makeClaudeProfile({ configDir, defaultModel: models[1] });
      expect(await profile.sessionManager!.getHistoryPath!("/test/cwd", "session")).toBe(history);
      expect(await profile.sessionManager!.getUsage!("/test/cwd", "session")).toMatchObject({ model: models[2] });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("removes the controller-only Vertex config and phantom quota profile", () => {
    const config = loadConfig({ env: { DISCORD_BOT_TOKEN: "test", DISCORD_ALLOWED_USER_IDS: "123",
      REPOS_ROOT: process.cwd(), CLAUDE_VERTEX_PROJECT_ID: "test-project" } });
    expect(config).not.toHaveProperty("CLAUDE_VERTEX_PROJECT_ID");
    expect(config).not.toHaveProperty("CLAUDE_VERTEX_REGION");
    expect(controllerQuotaProfiles(config, pino({ level: "silent" }) as any).profiles.some(row => row.id === "claude-vertex")).toBe(false);
  });
});

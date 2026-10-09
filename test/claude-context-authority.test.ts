import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { pino } from "pino";
import { CLAUDE_VERIFIED_OVERLAY, makeClaudeProfile, manifestCatalogSource, mergeClaudeCatalogModels, type AgentProfile } from "@seam/adapters";
import { AgentRuntime, type AgentEventHandler } from "../packages/core/src/agents/agent-runtime.js";
import { controllerMetadataAdapter } from "../packages/core/src/agents/controller-metadata.js";
import { loadConfig } from "../packages/core/src/config.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { testSessionRouter } from "./helpers/session-fixture.js";
import { attachLocalBridge } from "./local-bridge-fixture.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { visualConfig } from "./plugin-card-visuals-fixture.js";

const model = "claude-catalog-only-6";
const sessionId = "context605-session";
let dir: string;
let store: SessionStore;
const cleanups: Array<() => void> = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-context605-"));
  store = new SessionStore(path.join(dir, "seam.db"));
});
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function profileFixture() {
  const profile = makeClaudeProfile({ configDir: dir, defaultModel: model });
  const project = path.join(dir, "projects", dir.replace(/\//g, "-"));
  fs.mkdirSync(project, { recursive: true });
  const writeUsage = () => fs.writeFileSync(path.join(project, `${sessionId}.jsonl`), JSON.stringify({
    type: "assistant", timestamp: new Date().toISOString(),
    message: { model, usage: { input_tokens: 100, cache_read_input_tokens: 20,
      cache_creation_input_tokens: 30, output_tokens: 5 } },
  }) + "\n");
  return { profile, writeUsage };
}

async function ordinaryTurn(capacity: "catalog" | "acp" | "unknown" | "wrong-host") {
  const { profile, writeUsage } = profileFixture();
  const rows = mergeClaudeCatalogModels({
    probe: { models: [], wrapperCurrentValue: "default" },
    overlay: [{ ...CLAUDE_VERIFIED_OVERLAY[0]!, modelId: model, resolvedModel: model,
      contextWindow: 1_000_000, credentialScope: "default" }],
    effortMechanism: "meta", credentialScope: "default",
  });
  const candidate = await manifestCatalogSource({ provider: "anthropic", defaultModel: model,
    models: () => rows }).fetch();
  const catalog = fixtureModelCatalog([profile]);
  vi.spyOn(catalog, "model").mockImplementation((binding, id) =>
    capacity !== "unknown" && binding.agentId === "claude" && binding.location === "local"
      ? candidate.models.find(row => row.id === id) ?? null : null);
  const record = { id: "discord:context605-thread", platform: "discord", channelRef: "context605-thread",
    parentRef: "context605-channel", agentId: "claude", repoPath: dir, acpSessionId: sessionId,
    configJson: "{}", createdUtc: new Date().toISOString(), updatedUtc: new Date().toISOString() };
  store.upsert({ ...record, acpSessionId: sessionId }, { source: "fixture", cause: "bind synthetic session" });
  if (capacity === "acp" || capacity === "wrong-host") {
    const budget = store.contextBudgets.record({ agentId: "claude", model, acpSessionId: sessionId,
      location: capacity === "acp" ? "local" : "other-host", requestedTier: null,
      used: 50, promptBudget: 272_000, totalWindow: null, outputAllocation: null,
      observedTier: null, source: "acp-usage", atUtc: new Date().toISOString() });
    record.configJson = store.writeConfig({ lastContextUsage: { model, used: 50, size: 272_000, budget } });
    store.upsert(record);
  }
  let handler: AgentEventHandler | undefined;
  const runtime = {
    onEvent(h: AgentEventHandler) { handler = h; },
    prompt: vi.fn(async () => {
      writeUsage();
      await handler?.({ kind: "text", text: "CONTEXT605_OK" });
      return { stopReason: "end_turn" };
    }),
    idle: async () => {},
    getSessionInfo: () => ({ sessionId }), getFastModeOutcome: () => undefined,
    getPromptCapabilities: () => ({}), getProcessId: () => undefined,
    getProviderIdentity: () => "synthetic",
  };
  const panels: unknown[] = [];
  const logs: string[] = [];
  const orch = new Orchestrator({
    logger: pino({ level: "debug" }, { write: (line: string) => { logs.push(line); } }) as never,
    store, modelCatalog: catalog, renderer: discordRenderer,
    config: { ...visualConfig, DATA_DIR: dir, REPOS_ROOT: dir, TURN_TIMEOUT_SECONDS: 60,
      REPO_EMOJIS: new Map(), DEFAULT_MODEL: model, channelPresets: new Map(), threadPresets: new Map() } as never,
    router: testSessionRouter({
      listProfiles: () => [profile], ensureSessionRecord: () => store.get(record.id)!,
      getProfile: () => profile, assertAgentAllowedForRecord: () => {}, getOrStartRuntime: async () => runtime,
      describeConfig: () => ({ agent: { value: "claude" }, location: { value: "local" }, model: { value: model },
        effort: { value: null }, cwd: { value: dir }, fastMode: { value: false }, role: { value: null },
        disableThreadPrefix: { value: false } }),
    }) as never,
    adapter: {
      async sendPanel(channel: unknown, panel: unknown) { panels.push(panel); return { channel, id: "panel" }; },
      async editPanel(_ref: unknown, panel: unknown) { panels.push(panel); },
      async sendMessage(channel: unknown) { return { channel, id: "message" }; },
      async editMessage() {}, async sendFile() {},
    } as never,
  });
  attachLocalBridge(orch, [profile], dir);
  await orch.loadPlugins();
  await (orch as any).handleIncomingMessageInner({ messageId: `context605-${capacity}`,
    channel: { platform: "discord", id: record.channelRef }, authorId: "fixture-user",
    authorIsBot: false, text: "tiny offline turn" });
  expect(runtime.prompt, logs.join("\n")).toHaveBeenCalledTimes(1);
  expect(logs.filter(line => line.includes('"level":50'))).toEqual([]);
  expect(JSON.stringify(panels.at(-1))).toContain("Done");
  return { panel: JSON.stringify(panels.at(-1)), profile, catalog };
}

describe("Claude context authority on the ordinary turn path", () => {
  it("a verified catalog-only model gets its catalog capacity, without a JSONL guess", async () => {
    const h = await ordinaryTurn("catalog");
    expect(h.panel).toContain("1m");
    expect(h.panel).not.toContain("200k");
    expect(await h.profile.sessionManager!.getUsage!(dir, sessionId))
      .toEqual({ model, totalUsed: 155 });
  });

  it("a matching ACP observation wins over a larger catalog on a quiet turn", async () => {
    const h = await ordinaryTurn("acp");
    expect(h.panel).toContain("272k");
    expect(h.panel).not.toContain("1m");
  });

  it("does not use another host's ACP budget", async () => {
    const h = await ordinaryTurn("wrong-host");
    expect(h.panel).toContain("1m");
    expect(h.panel).not.toContain("272k");
  });

  it("unknown capacity stays unknown while the turn completes and actual model/tokens survive", async () => {
    const h = await ordinaryTurn("unknown");
    expect(h.panel).toContain("unknown");
    expect(h.panel).not.toContain("200k");
    expect(h.panel).toContain(model);
    expect(await h.profile.sessionManager!.getUsage!(dir, sessionId))
      .toEqual({ model, totalUsed: 155 });
  });
});

describe("Claude native compaction owns the launch", () => {
  it("sends no compaction option on new or resumed ACP sessions, preserving effort and thinking", async () => {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    cleanups.push(() => { stdin.destroy(); stdout.destroy(); stderr.destroy(); });
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, killed: false,
      kill() { this.killed = true; return true; } });
    const requests: unknown[] = [];
    agent({ name: "context605-peer" })
      .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true } }))
      .onRequest(methods.agent.session.new, ({ params }) => { requests.push(params); return { sessionId }; })
      .onRequest(methods.agent.session.load, ({ params }) => { requests.push(params); return {}; })
      .onRequest(methods.agent.session.prompt, () => ({ stopReason: "end_turn" }))
      .connect(ndJsonStream(Writable.toWeb(stdout) as WritableStream<Uint8Array>,
        Readable.toWeb(stdin) as ReadableStream<Uint8Array>));
    const config = loadConfig({ env: { DISCORD_BOT_TOKEN: "fixture", DISCORD_ALLOWED_USER_IDS: "123",
      REPOS_ROOT: dir } });
    const profile = controllerMetadataAdapter(makeClaudeProfile({ defaultModel: "default" }), undefined, undefined,
      { thinkingDisplay: "summarized", compactionTokenThreshold: (config as any).CLAUDE_COMPACTION_TOKEN_THRESHOLD } as any);
    const runtime = new AgentRuntime({ profile: profile as AgentProfile, logger: pino({ level: "silent" }),
      spawnFn: () => child as never });
    await runtime.start();
    await runtime.newSession({ cwd: dir, effort: "high" });
    await expect(runtime.prompt("tiny offline prompt")).resolves.toMatchObject({ stopReason: "end_turn" });
    await runtime.loadSession({ cwd: dir, sessionId, effort: "low" });
    await expect(runtime.prompt("tiny offline resume")).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(requests).toHaveLength(2);
    for (const [i, request] of requests.entries()) {
      expect(request).toMatchObject({ _meta: { claudeCode: { options: {
        effort: i === 0 ? "high" : "low", thinking: { type: "adaptive", display: "summarized" },
      } } } });
      expect(JSON.stringify(request)).not.toMatch(/compactionControl|contextTokenThreshold/);
    }
  });
});

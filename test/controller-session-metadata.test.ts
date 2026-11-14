import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION, type McpServer } from "@agentclientprotocol/sdk";
import * as adapters from "@seam/adapters";
import type { AgentAdapter, AgentClientMetadata } from "@seam/adapters";
import { loadHostAdapterInventory, inventoryFromAdapters } from "../packages/bridge/src/inventory.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import { controllerMetadataAdapter } from "../packages/core/src/agents/controller-metadata.js";

const logger = { warn() {}, info() {}, error() {}, debug() {}, child() { return this; } };
const catalog = adapters.manifestCatalogSource({ provider: "fixture", defaultModel: "default", adapterVersion: 4,
  models: () => [{ modelId: "default", name: "Fixture" }] });
const meta = (fields: Record<string, unknown> = {}): AgentClientMetadata => ({
  displayName: "Fixture", defaultModel: "default", sessionManagement: null, ...fields,
} as AgentClientMetadata);
const servers: McpServer[] = [{ type: "http", name: "fixture-mcp", url: "http://fixture.invalid/mcp", headers: [] }];
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); vi.restoreAllMocks(); });

function published(profile: AgentAdapter) {
  return JSON.parse(JSON.stringify(inventoryFromAdapters(new Map([[profile.id, profile]]), process.execPath,
    { HOME: "/fixture/home" })[0]!.metadata)) as AgentClientMetadata;
}

function copilotHost(id: string) {
  const make = adapters.makeCopilotProfile;
  const spy = vi.spyOn(adapters, "makeCopilotProfile").mockImplementation(options =>
    make({ ...options, id, configDir: "/fixture/copilot" }));
  try {
    const loaded = loadHostAdapterInventory(process.execPath, {
      env: { HOME: "/fixture/home", AGY_ENABLED: "false" }, exists: binary => binary === process.execPath,
    });
    const profile = loaded.adapters.get("copilot")!;
    expect(spy).toHaveBeenCalledOnce();
    expect(profile.id).toBe(id);
    return { profile, metadata: published(profile) };
  } finally { spy.mockRestore(); }
}

function router(hosts: Record<string, { profile: AgentAdapter; metadata: AgentClientMetadata }>,
  options?: AgentClientMetadata["claudeSessionOptions"]) {
  return new SessionRouter({ logger, profiles: [], store: {} as never,
    defaultAgentId: "fixture", defaultModel: "default", modelCatalog: { lookup: () => ({}) } as never,
    profileMetadata: (id, host) => hosts[host]?.profile.id === id ? hosts[host].metadata : undefined,
    profileCatalog: (id, host) => hosts[host]?.profile.id === id ? hosts[host].profile.catalog : undefined,
    claudeSessionOptions: options });
}

async function wire(profile: AgentAdapter, currentModel = profile.defaultModel) {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, killed: false,
    kill() { this.killed = true; return true; } });
  cleanups.push(() => { stdin.destroy(); stdout.destroy(); stderr.destroy(); });
  const requests: Array<{ kind: string; params: any }> = [], events: any[] = [];
  const configOptions = [{ id: "model", name: "Model", type: "select" as const, currentValue: currentModel,
    options: [{ name: "Current", value: currentModel }] }];
  agent({ name: "controlled-acp" })
    .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true } }))
    .onRequest(methods.agent.session.new, ({ params }) => {
      requests.push({ kind: "new", params }); return { sessionId: "own-session", configOptions };
    })
    .onRequest(methods.agent.session.load, ({ params }) => {
      requests.push({ kind: "load", params }); return { sessionId: params.sessionId, configOptions };
    })
    .onRequest(methods.agent.session.setConfigOption, () => ({ configOptions }))
    .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
      requests.push({ kind: "prompt", params });
      // Even an unsolicited feed cannot opt a receiver in or certify another session.
      for (const sessionId of ["unrelated-session", params.sessionId]) {
        await client.notify("_claude/sdkMessage", { sessionId, message: { type: "command_lifecycle",
          command_uuid: "cmd-own", state: "started", content: "UNRETAINED-SDK-BODY" } });
        await client.notify("_claude/sdkMessage", { sessionId, message: { type: "stream_event", parent_tool_use_id: null,
          event: { type: "message_start", message: { id: "msg-own", model: "fixture", content: "UNRETAINED-SDK-BODY" } } } });
      }
      return { stopReason: "end_turn" };
    })
    .onNotification(methods.agent.session.cancel, () => {})
    .connect(ndJsonStream(Writable.toWeb(stdout) as WritableStream<Uint8Array>, Readable.toWeb(stdin) as ReadableStream<Uint8Array>));
  const runtime = new AgentRuntime({ profile, logger, mcpServers: servers, spawnFn: () => child as never });
  runtime.onEvent(event => { events.push(event); });
  await runtime.start();
  return { runtime, requests, events };
}

async function request(profile: AgentAdapter, method: "new" | "load", input: { model?: string; effort?: string; meta?: Record<string, unknown> } = {}) {
  const h = await wire(profile, input.model ?? profile.defaultModel);
  if (method === "new") await h.runtime.newSession({ cwd: "/fixture", ...input });
  else await h.runtime.loadSession({ cwd: "/fixture", sessionId: "own-session", ...input });
  expect(h.requests).toHaveLength(1);
  return { ...h, params: h.requests[0]!.params };
}

const neutral = { sessionMetaCodec: "unknown", effort: null, mcpServersAtSpawn: false, submissionSignals: null };

describe("factory session policy through hello, empty router and actual ACP requests", () => {
  it.each(["new", "load"] as const)("does not invent Claude metadata/feed for a real misleading Copilot factory during %s", async method => {
    const host = copilotHost("claude-looking");
    const profile = router({ remote: host }).getProfile(host.profile.id, "remote")!;
    const h = await request(profile, method);
    expect(h.params._meta).toBeUndefined();
    expect(h.params.mcpServers).toEqual([]);
    expect(profile.effort).toEqual(host.profile.effort);
    expect(profile.submissionSignals).toBeUndefined();
    await h.runtime.prompt("one controlled submission");
    expect(h.requests.filter(row => row.kind === "prompt")).toHaveLength(1);
    expect(h.events.filter(event => event.kind === "submission-evidence").at(-1)?.evidence.providerMessage.state).toBe("unknown");
  });

  it("publishes explicit wire absence without changing direct adapter types", () => {
    const p = adapters.asLocalAdapter({ id: "copilot-empty", displayName: "Empty", defaultModel: "default", catalog,
      spawn() { throw new Error("no native process"); } });
    const host = published(p) as unknown as Record<string, unknown>;
    expect(host).toMatchObject({ effort: null, submissionSignals: null, mcpServersAtSpawn: false });
    const profile = router({ remote: { profile: p, metadata: host as AgentClientMetadata } }).getProfile(p.id, "remote")!;
    expect(profile.effort).toBeUndefined();
    expect(profile.submissionSignals).toBeUndefined();
    expect(profile.mcpServersAtSpawn).toBe(false);
  });

  it("keeps same-selector codec decisions host-local and independent of identity", async () => {
    const p = adapters.makeClaudeProfile({ id: "same", defaultModel: "default", configDir: "/fixture/claude" });
    const first = meta({ ...neutral, sessionMetaCodec: "claude", harness: "copilot", provider: "same", brand: "same" });
    const second = meta({ ...neutral, harness: "claude", provider: "same", brand: "same" });
    const r = router({ first: { profile: p, metadata: first }, second: { profile: p, metadata: second } });
    expect((await request(r.getProfile("same", "first")!, "new")).params._meta).toMatchObject({ claudeCode: { options: {} } });
    expect((await request(r.getProfile("same", "second")!, "new")).params._meta).toBeUndefined();
  });
});

describe("fieldwise host authority, independent of codec", () => {
  it.each(["unknown", null, "future-codec", undefined])("does not guess a builder for an own codec %s", async codec => {
    const supplied = vi.fn(() => ({ forbidden: true }));
    const p = controllerMetadataAdapter({ id: "claude", catalog, newSessionMeta: supplied },
      meta({ sessionMetaCodec: codec }));
    expect((await request(p, "new")).params._meta).toBeUndefined();
    expect(supplied).not.toHaveBeenCalled();
    // Codec says nothing about these separately absent legacy fields or Fast.
    expect(p.submissionSignals).toBe("claude_sdk");
    expect(p.fastMode).toEqual(adapters.CLAUDE_FAST_MODE);
  });

  it.each([null, undefined])("normalizes own no-control/feed %s even without a codec", value => {
    const p = controllerMetadataAdapter({ id: "claude", catalog }, meta({ effort: value, submissionSignals: value }));
    expect(p.effort).toBeUndefined();
    expect(p.submissionSignals).toBeUndefined();
    expect(p.newSessionMeta?.()).toHaveProperty("claudeCode");
  });

  it("retains an explicit none effort descriptor without treating it as a codec restriction", async () => {
    const effort = { mechanism: "none" as const, levels: [] };
    const factory = adapters.makeClaudeProfile({ id: "claude-variant", defaultModel: "default", effort });
    const p = router({ remote: { profile: factory, metadata: published(factory) } }).getProfile(factory.id, "remote")!;
    expect(p.effort).toEqual(effort);
    // Preserve direct serializer behavior for an explicit raw/unlisted caller value.
    expect((await request(p, "new", { effort: "explicit-unlisted" })).params._meta)
      .toMatchObject({ claudeCode: { options: { effort: "explicit-unlisted" } } });
  });

  it.each(["new", "load", "fork"] as const)("retains explicit false MCP during %s instead of a Copilot prefix override", async method => {
    const p = controllerMetadataAdapter({ id: "copilot-renamed", catalog }, meta({ mcpServersAtSpawn: false }));
    if (method !== "fork") expect((await request(p, method)).params.mcpServers).toEqual(servers);
    else {
      const boundary = vi.fn().mockResolvedValue({ sessionId: "forked" });
      const runtime = new AgentRuntime({ profile: p, logger, mcpServers: servers });
      Object.assign(runtime, { connection: { request: boundary } });
      expect(await runtime.forkSession({ sessionId: "original", cwd: "/fixture" })).toBe("forked");
      expect(boundary).toHaveBeenCalledExactlyOnceWith("session/fork", { sessionId: "original", cwd: "/fixture", mcpServers: servers });
    }
  });

  it.each(["claude_sdk", null])("receiver feed %s is independent of serializer selection and retains only correlated bounded evidence", async feed => {
    const p = controllerMetadataAdapter({ id: "fixture", catalog }, meta({ ...neutral, submissionSignals: feed }));
    const h = await request(p, "new");
    expect(h.params._meta).toBeUndefined();
    await h.runtime.prompt("one controlled submission");
    const evidence = h.events.filter(event => event.kind === "submission-evidence").at(-1)?.evidence;
    expect(evidence.providerMessage.state).toBe(feed ? "accepted" : "unknown");
    if (feed) {
      expect(evidence.providerMessage.lastId).toBe("msg-own");
      expect(evidence.wrapperCommand.observations).toBe(1);
    }
    expect(JSON.stringify(evidence)).not.toContain("UNRETAINED-SDK-BODY");
  });
});

describe("known Claude codec preserves payload and global spread precedence", () => {
  it.each(["new", "load"] as const)("preserves neutral/default/explicit effort and adaptive display in %s", async method => {
    for (const [model, effort, options] of [
      ["default", undefined, { thinking: { type: "adaptive", display: "summarized" } }],
      ["claude-opus-5-5", "default", { thinking: { type: "adaptive", display: "summarized" } }],
      ["claude-opus-5-5", "high", { effort: "high", thinking: { type: "adaptive", display: "summarized" } }],
      ["claude-haiku-4-5", "high", { effort: "high" }],
    ] as const) {
      const factory = adapters.makeClaudeProfile({ id: "workbench", defaultModel: model, thinkingDisplay: "omitted" });
      const p = router({ host: { profile: factory, metadata: published(factory) } }, { thinkingDisplay: "summarized" })
        .getProfile(factory.id, "host")!;
      expect((await request(p, method, { effort })).params._meta).toEqual({ claudeCode: { options,
        emitRawSDKMessages: [{ type: "command_lifecycle" }, { type: "stream_event" }] } });
    }
  });

  it.each(["omitted", undefined] as const)("lets global own %s override host and profile values", async global => {
    const p = controllerMetadataAdapter({ id: "arbitrary", catalog, defaultModel: "profile-model",
      claudeSessionOptions: { thinkingDisplay: "omitted" } },
    meta({ sessionMetaCodec: "claude", defaultModel: "default", claudeSessionOptions: { thinkingDisplay: "summarized" } }),
    catalog, { thinkingDisplay: global });
    const options = (await request(p, "load")).params._meta.claudeCode.options;
    expect(options).toEqual(global ? { thinking: { type: "adaptive", display: global } } : {});
  });

  it("preserves explicit model precedence, host options and new caller shallow meta override", async () => {
    const p = controllerMetadataAdapter({ id: "arbitrary", catalog, defaultModel: "claude-haiku-4-5",
      claudeSessionOptions: { thinkingDisplay: "omitted" } },
    meta({ sessionMetaCodec: "claude", defaultModel: "default", claudeSessionOptions: { thinkingDisplay: "summarized" } }));
    expect((await request(p, "new", { model: "claude-haiku-4-5" })).params._meta.claudeCode.options).toEqual({});
    expect((await request(p, "load")).params._meta.claudeCode.options.thinking.display).toBe("summarized");
    const ownMeta = { claudeCode: { callerOwned: true }, unrelated: "preserved" };
    expect((await request(p, "new", { meta: ownMeta })).params._meta).toEqual(ownMeta);
  });
});

describe("absent declarations retain exact legacy partials", () => {
  it.each([
    ["claude", undefined, "meta", "claude_sdk", false, true],
    ["claude-alt", undefined, "meta", "claude_sdk", false, true],
    ["copilotish", undefined, "configOption", undefined, true, false],
    ["copilotish", {}, "meta", "claude_sdk", false, true],
    ["codex-alt", {}, "meta", "claude_sdk", false, true],
    ["renamed", {}, "meta", "claude_sdk", false, true],
    ["codex-alt", undefined, "spawnArgs", undefined, false, false],
    ["claudeish", undefined, "spawnArgs", undefined, false, false],
  ] as const)("keeps %s with legacy options %s", (id, options, mechanism, feed, mcp, codec) => {
    const supplied = () => ({ supplied: true });
    const p = controllerMetadataAdapter({ id, catalog, effort: { mechanism: "spawnArgs", levels: ["fixture"] },
      mcpServersAtSpawn: false, newSessionMeta: supplied }, meta(options ? { claudeSessionOptions: options } : {}));
    expect(p.effort?.mechanism).toBe(mechanism);
    expect(p.submissionSignals).toBe(feed);
    expect(p.mcpServersAtSpawn).toBe(mcp);
    if (codec) expect(p.newSessionMeta?.()).toHaveProperty("claudeCode");
    else expect(p.newSessionMeta).toBe(supplied);
  });

  it("does not treat profile-only codec/options as a new host declaration or inject global options into a supplied callable", () => {
    const supplied = vi.fn(() => ({ supplied: true }));
    const p = controllerMetadataAdapter({ id: "renamed", catalog, newSessionMeta: supplied,
      claudeSessionOptions: { thinkingDisplay: "omitted" }, ...{ sessionMetaCodec: "unknown" } },
    meta(), catalog, { thinkingDisplay: "summarized" });
    expect(p.newSessionMeta).toBe(supplied);
    expect(p.newSessionMeta?.("default", "high")).toEqual({ supplied: true });
    expect(supplied).toHaveBeenCalledExactlyOnceWith("default", "high");
  });
});

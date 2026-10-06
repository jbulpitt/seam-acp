import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION, type ClientCapabilities, type SessionUpdate, type PromptResponse } from "@agentclientprotocol/sdk";
import { classifyCodexError, classifyClaudeError, providerRetryBackoff, type AgentProfile } from "@seam/adapters";
import { pino } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime, type AgentEvent } from "../packages/core/src/agents/agent-runtime.js";
import { DispatchStatusPanel } from "../packages/core/src/core/dispatch-status-panel.js";
import { TurnStatus } from "../packages/core/src/core/status-panel.js";
import type { SessionRecord, StructuredPanel } from "../packages/core/src/core/types.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { PluginHost } from "../packages/core/src/plugins/host.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });

async function runtime(agentId: string, updates: SessionUpdate[], response: PromptResponse = { stopReason: "end_turn" }, typed = false) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const childEvents = new EventEmitter();
  const child = Object.assign(childEvents, {
    stdin, stdout, stderr, pid: undefined, killed: false,
    kill() { this.killed = true; childEvents.emit("exit", 0, null); return true; },
  });
  let capabilities: ClientCapabilities | undefined;
  const prompts: unknown[] = [];
  const transport = agent({ name: "notice-test" })
    .onRequest(methods.agent.initialize, ({ params }) => {
      capabilities = params.clientCapabilities;
      return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, ...(typed
        ? { _meta: { jetbrains: { air: { version: 1, capabilities: ["sessionFailure"] } } } } : {}) };
    })
    .onRequest(methods.agent.session.new, () => ({ sessionId: "wire-session" }))
    .onRequest(methods.agent.session.prompt, async ({ client, params }) => {
      prompts.push(params);
      for (const update of updates) await client.notify(methods.client.session.update, { sessionId: "wire-session", update });
      return response;
    })
    .onNotification(methods.agent.session.cancel, () => {});
  const connection = transport.connect(ndJsonStream(
    Writable.toWeb(stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(stdin) as ReadableStream<Uint8Array>,
  ));
  const logs: Array<Record<string, unknown>> = [];
  const logger = pino({ level: "debug" }, new Writable({ write(chunk, _encoding, callback) {
    logs.push(JSON.parse(String(chunk))); callback();
  } })) as unknown as Logger;
  const profile = { id: agentId, defaultModel: "default",
    classifyError: agentId === "codex" ? classifyCodexError : agentId === "claude" ? classifyClaudeError : undefined } as unknown as AgentProfile;
  const rt = new AgentRuntime({ profile, logger, spawnFn: () => child as never });
  cleanups.push(async () => { await rt.dispose(); connection.close(); stdin.destroy(); stdout.destroy(); stderr.destroy(); });
  await rt.start();
  await rt.newSession({ cwd: "/tmp" });
  return { rt, logger, logs, capabilities, prompts };
}

function injectedTurn(rt: AgentRuntime, logger: Logger, onEvent: (event: AgentEvent) => Promise<void> | void) {
  const messages: string[] = [];
  const now = new Date().toISOString();
  const record: SessionRecord = { id: "discord:thread", platform: "discord", channelRef: "thread", parentRef: null,
    agentId: "test", acpSessionId: "wire-session", repoPath: "/tmp", configJson: "{}", createdUtc: now, updatedUtc: now };
  const orch = Object.create(Orchestrator.prototype) as Orchestrator;
  Object.assign(orch, { logger, config: { REPOS_ROOT: "/tmp" },
    store: { turnAttempts: { get: () => undefined } },
    plugins: new PluginHost(logger),
    router: { getOrStartRuntime: async () => rt, describeConfig: () => ({ location: { value: "local" } }) },
    adapter: { sendMessage: async (_channel: unknown, text: string) => { messages.push(text); } },
    ensureOwnSession: async () => {}, contextBudgetIdentity: () => undefined,
  });
  return { messages, run: () => orch.injectTurn(record, "go", { session: "live", outputTo: { platform: "discord", id: "thread" }, onEvent }) };
}

describe("ACP session notices", () => {
  const rollout = JSON.stringify({ type: "error", error: { message: "model 'gpt-6.1-sol' is not enabled in rustponsesapi",
    type: "invalid_request_error", code: null }, status: 400 });

  function failedResponse(title: string, category = "service", actions = ["retry"]): PromptResponse {
    return { stopReason: "end_turn", _meta: { jetbrains: { air: { version: 1, sessionFailure: {
      id: "wire-turn:error", revision: 1, category, severity: "error", title, actions,
    } } } } };
  }

  it("exhausts pre-update AIR retries through the actual SDK exchange, preserving the provider cause", async () => {
    const timeout = globalThis.setTimeout;
    const backoff = providerRetryBackoff("overloaded")!;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) =>
      timeout(fn, backoff.includes(ms ?? 0) ? 0 : ms)) as typeof setTimeout);
    const { rt, logs, prompts } = await runtime("codex", [], failedResponse(rollout), true);
    const events: AgentEvent[] = [];
    rt.onEvent(event => { events.push(event); });
    await expect(rt.prompt("go", undefined, { recoveryScope: "ephemeral" })).rejects.toMatchObject({
      message: rollout, data: { status: 400, errorKind: "overloaded" },
    });
    expect(events.filter(event => event.kind === "agent-text")).toEqual([]);
    expect(prompts).toHaveLength(1 + backoff.length);
    expect(logs.find(log => log.msg === "adapter error classified")).toMatchObject({ errorKind: "overloaded",
      errorMessage: rollout, errorStatus: 400 });
  });

  it("splits and recognises the legacy Codex capacity answer on the actual ACP reader", async () => {
    const title = "Selected model is at capacity. Please try a different model.";
    const { rt } = await runtime("codex", [
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: title.slice(0, 24) } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: title.slice(24) } },
    ]);
    const events: AgentEvent[] = [];
    rt.onEvent(event => { events.push(event); });
    await expect(rt.prompt("go", undefined, { recoveryScope: "ephemeral" })).rejects.toMatchObject({ message: title,
      data: { errorKind: "overloaded" } });
    expect(events.filter(event => event.kind === "agent-text")).toEqual([]);
  });

  it("pauses quota with its exact notice and keeps typed auth on the existing reauth path", async () => {
    const title = "You've hit your usage limit. Try again at 12:00.";
    const quota = await runtime("codex", [], failedResponse(title, "limit", []));
    const events: AgentEvent[] = [];
    quota.rt.onEvent(event => { events.push(event); });
    await expect(quota.rt.prompt("go", undefined, { recoveryScope: "ephemeral" })).rejects.toMatchObject({ message: title,
      data: { errorKind: "quota_exhausted" } });
    expect(events.find(event => event.kind === "notice")).toMatchObject({ title: "Paused — quota or balance exhausted",
      description: expect.stringContaining(title) });
    const auth = await runtime("codex", [], failedResponse("Please sign in", "access", ["login"]));
    await expect(auth.rt.prompt("go", undefined, { recoveryScope: "ephemeral" })).rejects.toMatchObject({ name: "ReauthParked",
      message: "Please sign in" });
  });

  it("leaves agents without typed failures and ordinary short JSON replies unchanged", async () => {
    for (const [id, text] of [["grok", "Selected model is at capacity. Please try a different model."], ["codex", '{"answer":42}']]) {
      const { rt } = await runtime(id!, [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: text! } }]);
      const events: AgentEvent[] = [];
      rt.onEvent(event => { events.push(event); });
      await expect(rt.prompt("go", undefined, { recoveryScope: "ephemeral" })).resolves.toMatchObject({ stopReason: "end_turn" });
      expect(events.filter(event => event.kind === "agent-text").map(event => event.kind === "agent-text" ? event.text : "").join("")).toBe(text);
    }
  });

  it("does not parse replies from an agent that negotiated typed failures", async () => {
    const title = "Selected model is at capacity. Please try a different model.";
    const { rt } = await runtime("codex", [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: title } }], { stopReason: "end_turn" }, true);
    const events: AgentEvent[] = [];
    rt.onEvent(event => { events.push(event); });
    await expect(rt.prompt("quote this provider message", undefined, { recoveryScope: "ephemeral" })).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(events.find(event => event.kind === "agent-text")).toMatchObject({ text: title });
  });

  it.each(["codex", "claude", "grok"])("advertises notices on %s's actual initialize exchange", async (agentId) => {
    const { capabilities } = await runtime(agentId, []);
    expect(capabilities?.session?.notices).toEqual({});
    expect(capabilities?.fs).toEqual({ readTextFile: false, writeTextFile: false });
    expect(capabilities?._meta).toEqual({ jetbrains: { air: { version: 1, capabilities: ["sessionFailure"] } } });
  });

  it.each(["full", "simple"] as const)("keeps a warning off chat and on the %s status card, without changing tool state", async (style) => {
    const warning: SessionUpdate = { sessionUpdate: "notice", severity: "warning", title: "Falling back from WebSockets to HTTPS transport", description: "websocket closed by server before response.completed" };
    const { rt, logger, logs } = await runtime("codex", [warning,
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } }]);
    const status = new TurnStatus({ model: "default", repoDisplay: "/tmp" });
    status.style = style;
    const edits: StructuredPanel[] = [];
    const panel = new DispatchStatusPanel(discordRenderer, status, { post: async () => "card", edit: async (_ref, value) => { edits.push(value); } }, { debounceMs: 0 });
    cleanups.push(() => panel.finalize("Done"));
    await panel.start();
    const events: AgentEvent[] = [];
    const turn = injectedTurn(rt, logger, (event) => { events.push(event); panel.handleEvent(event); });
    expect(await turn.run()).toMatchObject({ text: "answer", stopReason: "end_turn" });
    await (panel as unknown as { refresh(): Promise<void> }).refresh();
    expect(JSON.stringify(edits.at(-1))).toContain(warning.title);
    expect(status.activity).toEqual([]);
    expect(status.action).toBe("Starting…");
    expect(turn.messages).toEqual([]);
    expect(events.find((event) => event.kind === "notice")).toMatchObject({ agent: "codex", severity: "warning", title: warning.title, description: warning.description });
    expect(logs.find((log) => log.msg === "ACP session notice")).toMatchObject({ agent: "codex", severity: "warning", title: warning.title, description: warning.description });
    await panel.finalize("Done");
    expect(JSON.stringify(edits.at(-1))).toContain(warning.title);
  });

  it("posts an error note without adding it to the answer or treating it as a turn failure", async () => {
    const { rt, logger, logs } = await runtime("claude", [
      { sessionUpdate: "notice", severity: "error", title: "Account update", description: "Sign in again to refresh credentials" },
      { sessionUpdate: "notice", severity: "info", title: "Model rerouted" },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } },
    ]);
    const events: AgentEvent[] = [];
    const turn = injectedTurn(rt, logger, (event) => { events.push(event); });
    expect(await turn.run()).toMatchObject({ text: "done", stopReason: "end_turn" });
    expect(turn.messages).toEqual(["❗ Account update — Sign in again to refresh credentials"]);
    expect(events.filter((event) => event.kind === "notice")).toHaveLength(2);
    expect(logs.filter((log) => log.msg === "ACP session notice").map((log) => log.severity)).toEqual(["error", "info"]);
  });

  it("leaves non-supporting agents' reply text untouched, including warning-like prose", async () => {
    const text = "Warning: this is ordinary agent reply text";
    const { rt, logger, logs } = await runtime("grok", [
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    ]);
    const events: AgentEvent[] = [];
    const turn = injectedTurn(rt, logger, (event) => { events.push(event); });
    expect(await turn.run()).toMatchObject({ text, stopReason: "end_turn" });
    expect(events.some((event) => event.kind === "notice")).toBe(false);
    expect(logs.some((log) => log.msg === "ACP session notice")).toBe(false);
    expect(turn.messages).toEqual([]);
  });
});

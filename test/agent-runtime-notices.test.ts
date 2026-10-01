import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION, type ClientCapabilities, type SessionUpdate } from "@agentclientprotocol/sdk";
import type { AgentProfile } from "@seam/adapters";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRuntime, type AgentEvent } from "../packages/core/src/agents/agent-runtime.js";
import { DispatchStatusPanel } from "../packages/core/src/core/dispatch-status-panel.js";
import { TurnStatus } from "../packages/core/src/core/status-panel.js";
import type { SessionRecord, StructuredPanel } from "../packages/core/src/core/types.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function runtime(agentId: string, updates: SessionUpdate[]) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin, stdout, stderr, pid: undefined, killed: false,
    kill() { this.killed = true; this.emit("exit", 0, null); return true; },
  });
  let capabilities: ClientCapabilities | undefined;
  const transport = agent({ name: "notice-test" })
    .onRequest(methods.agent.initialize, ({ params }) => {
      capabilities = params.clientCapabilities;
      return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} };
    })
    .onRequest(methods.agent.session.new, () => ({ sessionId: "wire-session" }))
    .onRequest(methods.agent.session.prompt, async ({ client }) => {
      for (const update of updates) await client.notify(methods.client.session.update, { sessionId: "wire-session", update });
      return { stopReason: "end_turn" };
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
  const profile = { id: agentId, defaultModel: "default" } as unknown as AgentProfile;
  const rt = new AgentRuntime({ profile, logger, spawnFn: () => child as never });
  cleanups.push(async () => { await rt.dispose(); connection.close(); stdin.destroy(); stdout.destroy(); stderr.destroy(); });
  await rt.start();
  await rt.newSession({ cwd: "/tmp" });
  return { rt, logger, logs, capabilities };
}

function injectedTurn(rt: AgentRuntime, logger: Logger, onEvent: (event: AgentEvent) => Promise<void> | void) {
  const messages: string[] = [];
  const now = new Date().toISOString();
  const record: SessionRecord = { id: "discord:thread", platform: "discord", channelRef: "thread", parentRef: null,
    agentId: "test", acpSessionId: "wire-session", repoPath: "/tmp", configJson: "{}", createdUtc: now, updatedUtc: now };
  const orch = Object.create(Orchestrator.prototype) as Orchestrator;
  Object.assign(orch, { logger, config: { REPOS_ROOT: "/tmp" },
    router: { getOrStartRuntime: async () => rt },
    adapter: { sendMessage: async (_channel: unknown, text: string) => { messages.push(text); } },
    ensureOwnSession: async () => {}, contextBudgetIdentity: () => undefined,
  });
  return { messages, run: () => orch.injectTurn(record, "go", { session: "live", outputTo: { platform: "discord", id: "thread" }, onEvent }) };
}

describe("ACP session notices", () => {
  it.each(["codex", "claude", "grok"])("advertises notices on %s's actual initialize exchange", async (agentId) => {
    const { capabilities } = await runtime(agentId, []);
    expect(capabilities?.session?.notices).toEqual({});
    expect(capabilities?.fs).toEqual({ readTextFile: false, writeTextFile: false });
    expect(capabilities?._meta).toBeUndefined();
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
    await panel.refresh();
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

import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { AgentProfile } from "@seam/adapters";
import { pino } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime, type AgentEvent } from "../packages/core/src/agents/agent-runtime.js";
import { DispatchStatusPanel } from "../packages/core/src/core/dispatch-status-panel.js";
import { TurnStatus } from "../packages/core/src/core/status-panel.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { serializePanelText } from "../packages/core/src/platforms/renderer.js";
import type { StatusCardStyle, StructuredPanel } from "../packages/core/src/core/types.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(agentId = "grok", style: StatusCardStyle = "full") {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin, stdout, stderr, pid: undefined, killed: false,
    kill() { this.killed = true; this.emit("exit", 0, null); return true; },
  });
  let finish!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const send = (update: Record<string, unknown>, sessionId = "wire-session") => {
    stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "_x.ai/session/update", params: { sessionId, update } }) + "\n");
  };
  let prompts = 0, cancels = 0;
  const server = agent({ name: "grok-compaction-fixture" })
    .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true } }))
    .onRequest(methods.agent.session.new, () => ({ sessionId: "wire-session" }))
    .onRequest(methods.agent.session.load, async () => {
      send({ sessionUpdate: "auto_compact_started", tokens_used: 220_000, context_window: 256_000, percentage: 86, reason: "threshold" });
      await new Promise<void>(resolve => setImmediate(resolve));
      return {};
    })
    .onRequest(methods.agent.session.prompt, async ({ client }) => {
      prompts += 1; entered(); await held;
      await client.notify(methods.client.session.update, { sessionId: "wire-session", update: {
        sessionUpdate: "agent_message_chunk", content: { type: "text", text: "continued answer" },
      } });
      return { stopReason: "end_turn" };
    })
    .onNotification(methods.agent.session.cancel, () => { cancels += 1; });
  const connection = server.connect(ndJsonStream(
    Writable.toWeb(stdout) as WritableStream<Uint8Array>, Readable.toWeb(stdin) as ReadableStream<Uint8Array>,
  ));
  const rt = new AgentRuntime({ profile: { id: agentId } as AgentProfile,
    logger: pino({ level: "silent" }) as Logger, spawnFn: () => child as never });
  const status = new TurnStatus({ model: "grok-4.7", repoDisplay: "repo" });
  status.style = style;
  const edits: StructuredPanel[] = [], events: AgentEvent[] = [];
  const panel = new DispatchStatusPanel(discordRenderer, status, {
    post: async () => "card", edit: async (_ref, value) => { edits.push(value); },
  }, { debounceMs: 0 });
  let turn: Promise<unknown> | undefined;
  cleanups.push(async () => {
    finish(); await turn?.catch(() => {}); panel.stop(); await rt.dispose(); connection.close();
    stdin.destroy(); stdout.destroy(); stderr.destroy();
  });
  await rt.start(); await rt.newSession({ cwd: "/tmp" }); await panel.start();
  rt.onEvent(event => { events.push(event); panel.handleEvent(event); });
  return { rt, status, edits, events, send, finish,
    counts: () => ({ prompts, cancels }),
    start: async () => { turn = rt.prompt("keep working", undefined, { recoveryScope: "ephemeral" }); await started; return { turn }; },
  };
}

describe("Grok compaction notifications on the real ACP reader", () => {
  it.each(["full", "simple"] as const)("shows compaction on the %s card, then continues the same prompt without posting the summary", async style => {
    const h = await fixture("grok", style); const { turn } = await h.start();
    h.send({ sessionUpdate: "auto_compact_started", tokens_used: 220_000, context_window: 256_000, percentage: 86, reason: "threshold" });
    await vi.waitFor(() => expect(h.status.action).toBe("Compacting memory…"));
    await vi.waitFor(() => expect(h.edits.map(serializePanelText).join("\n")).toContain("Compacting memory…"));
    h.send({ sessionUpdate: "auto_compact_completed", tokens_before: 220_000, tokens_after: 30_000, elapsed_ms: 60_000, summary_preview: "private retained context" });
    await vi.waitFor(() => expect(h.status.action).toBe("Compaction complete · continuing…"));
    await vi.waitFor(() => expect(h.edits.map(serializePanelText).join("\n")).toContain("Compaction complete · continuing…"));
    h.finish(); await turn;
    expect(h.events.filter(event => event.kind === "agent-text")).toEqual([{ kind: "agent-text", text: "continued answer" }]);
    expect(JSON.stringify(h.edits)).not.toContain("private retained context");
    expect(h.counts()).toEqual({ prompts: 1, cancels: 0 });
  });

  it.each([
    [{ sessionUpdate: "auto_compact_failed", error: "upstream summarization request failed" }, "Compaction failed: upstream summarization request failed"],
    [{ sessionUpdate: "auto_compact_cancelled", reason: "user_cancelled" }, "Compaction cancelled"],
  ])("clears compaction and preserves its terminal cause: %j", async (update, action) => {
    const h = await fixture(); const { turn } = await h.start();
    h.send({ sessionUpdate: "auto_compact_started", tokens_used: 220_000, context_window: 256_000, percentage: 86, reason: "threshold" });
    await vi.waitFor(() => expect(h.status.action).toBe("Compacting memory…"));
    h.send(update);
    await vi.waitFor(() => expect(h.status.action).toBe(action));
    h.finish(); await turn;
    expect(h.counts()).toEqual({ prompts: 1, cancels: 0 });
  });

  it("does not show a historical compaction replay or another session's compaction as live work", async () => {
    const h = await fixture();
    await h.rt.loadSession({ sessionId: "wire-session", cwd: "/tmp" });
    const { turn } = await h.start();
    h.send({ sessionUpdate: "auto_compact_started" }, "another-session");
    h.finish(); await turn;
    expect(h.events.filter(event => event.kind === "agent-state")).toEqual([]);
  });

  it("leaves other adapters on their own event contracts", async () => {
    const h = await fixture("codex"); const { turn } = await h.start();
    h.send({ sessionUpdate: "auto_compact_started" });
    h.finish(); await turn;
    expect(h.events.filter(event => event.kind === "agent-state")).toEqual([]);
  });
});

import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { pino } from "pino";
import { makeMux, type AgentProfile } from "@seam/adapters";
import { AgentRuntime, type AgentEvent } from "../packages/core/src/agents/agent-runtime.js";

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
};

class Bridge extends EventEmitter {
  readyState = 1;
  sent: any[] = [];
  input: any[] = [];
  send(raw: string) {
    const frame = JSON.parse(raw);
    this.sent.push(frame);
    if (frame.type === "data") {
      for (const line of frame.data.trim().split("\n")) this.input.push(JSON.parse(line));
    }
    if (frame.action === "ackOutput") queueMicrotask(() => this.reply(frame, {}));
  }
  deliver(frame: unknown) { this.emit("message", Buffer.from(JSON.stringify(frame))); }
  reply(frame: any, payload: unknown) { this.deliver({ type: "cmd_reply", cmdId: frame.cmdId, payload }); }
  command(action: string) { return this.sent.findLast(frame => frame.action === action); }
  data(message: unknown) { this.deliver({ slot: 42, type: "data", data: `${JSON.stringify(message)}\n` }); }
  ping() {}
  close() { this.readyState = 3; this.emit("close"); }
}

function setup(afterSeq = 0) {
  const bridge = new Bridge();
  const mux = makeMux({ id: "retained" });
  mux.attach(bridge as never);
  const child = mux.adopt(42, { allowAppTraffic: true, afterSeq });
  const permission = vi.fn(async () => ({ outcome: { outcome: "selected" as const, optionId: "allow" } }));
  const events: AgentEvent[] = [];
  const runtime = new AgentRuntime({
    profile: { id: "fixture", classifyError: () => ({ agentId: "fixture", errorKind: "invalid_request" }) } as AgentProfile,
    logger: pino({ level: "silent" }), permissionPolicy: permission,
    spawnFn: () => { throw new Error("adoption must not spawn"); },
  });
  runtime.onEvent(event => { events.push(event); });
  runtime.attachRecovery(child, "same-acp", undefined, undefined, { busy: false });
  return { bridge, runtime, permission, events, async close() { await runtime.detach(); bridge.close(); } };
}

describe("adopted ACP request-id collision", () => {
  it.each([0, 17])("never lets an old response settle a new prompt with cursor %s", async afterSeq => {
    const h = setup(afterSeq);
    let settled: unknown;
    const prompt = h.runtime.prompt("new request").then(value => { settled = value; }, error => { settled = error; });
    try {
      await flush();
      const request = h.bridge.input.find(frame => frame.method === "session/prompt");
      expect(request.params.prompt[0].text).toBe("new request");
      expect(h.bridge.command("replayOutput").payload.afterSeq).toBe(afterSeq);
      h.bridge.reply(h.bridge.command("replayOutput"), { frames: [{ seq: afterSeq + 1, type: "data",
        data: `${JSON.stringify({ jsonrpc: "2.0", id: 0, result: { stopReason: "cancelled" } })}\n` }] });
      await flush();
      expect(settled).toBeUndefined();
      h.bridge.data({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } });
      await prompt;
      expect(settled).toMatchObject({ stopReason: "end_turn", cancelled: false });
      expect(h.bridge.input.filter(frame => frame.method === "session/prompt")).toHaveLength(1);
      expect(h.bridge.sent.filter(frame => frame.type === "kill" || frame.type === "spawn")).toEqual([]);
    } finally {
      const request = h.bridge.input.find(frame => frame.method === "session/prompt");
      if (settled === undefined && request) h.bridge.data({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } });
      await prompt;
      await h.close();
    }
  });

  it("ignores an old error but surfaces the current request's real error", async () => {
    const h = setup();
    let settled: unknown;
    const prompt = h.runtime.prompt("new request").then(value => { settled = value; }, error => { settled = error; });
    try {
      await flush();
      const request = h.bridge.input.find(frame => frame.method === "session/prompt");
      h.bridge.reply(h.bridge.command("replayOutput"), { frames: [{ seq: 1, type: "data",
        data: `${JSON.stringify({ jsonrpc: "2.0", id: 0, error: { code: -32603, message: "old refusal" } })}\n` }] });
      await flush();
      expect(settled).toBeUndefined();
      h.bridge.data({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "current quota cause" } });
      await prompt;
      expect(settled).toBeInstanceOf(Error);
      expect((settled as Error).message).toContain("current quota cause");
    } finally {
      const request = h.bridge.input.find(frame => frame.method === "session/prompt");
      if (settled === undefined && request) h.bridge.data({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } });
      await prompt;
      await h.close();
    }
  });

  it("does not let a late response from the previous caller settle the next turn", async () => {
    const h = setup();
    let settled: unknown;
    let prompt: Promise<void> | undefined;
    try {
      await flush();
      h.bridge.reply(h.bridge.command("replayOutput"), { frames: [] });
      await flush();
      prompt = h.runtime.prompt("new request").then(value => { settled = value; }, error => { settled = error; });
      await flush();
      const request = h.bridge.input.find(frame => frame.method === "session/prompt");
      h.bridge.data({ jsonrpc: "2.0", id: 0, result: { stopReason: "cancelled" } });
      await flush();
      expect(settled).toBeUndefined();
      h.bridge.data({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } });
      await prompt;
      expect(settled).toMatchObject({ stopReason: "end_turn", cancelled: false });
    } finally {
      const request = h.bridge.input.find(frame => frame.method === "session/prompt");
      if (settled === undefined && request) h.bridge.data({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } });
      await prompt;
      await h.close();
    }
  });

  it("keeps replayed session updates and the original permission request id", async () => {
    const h = setup();
    try {
      await flush();
      h.bridge.reply(h.bridge.command("replayOutput"), { frames: [{ seq: 1, type: "data", data: [
        { jsonrpc: "2.0", method: "session/update", params: { sessionId: "same-acp",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "retained output" } } } },
        { jsonrpc: "2.0", id: 0, method: "session/request_permission", params: {
          sessionId: "same-acp", toolCall: { toolCallId: "tool", title: "retained question" },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } },
      ].map(message => JSON.stringify(message)).join("\n") + "\n" }] });
      await flush();
      expect(h.events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "agent-text", text: "retained output" })]));
      expect(h.permission).toHaveBeenCalledOnce();
      expect(h.bridge.input.filter(frame => frame.id === 0 && frame.result)).toEqual([
        { jsonrpc: "2.0", id: 0, result: { outcome: { outcome: "selected", optionId: "allow" } } },
      ]);
    } finally { await h.close(); }
  });

  it("still accepts an outstanding current response on a same-connection reconnect", async () => {
    const h = setup();
    let prompt: Promise<unknown> | undefined;
    try {
      await flush();
      h.bridge.reply(h.bridge.command("replayOutput"), { frames: [] });
      await flush();
      prompt = h.runtime.prompt("new request");
      await flush();
      const request = h.bridge.input.find(frame => frame.method === "session/prompt");
      h.bridge.deliver({ type: "hello", instanceId: "same-instance" });
      await flush();
      h.bridge.reply(h.bridge.command("listSlots"), { slots: [42] });
      await flush();
      h.bridge.reply(h.bridge.command("replayOutput"), { frames: [{ seq: 1, type: "data",
        data: `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })}\n` }] });
      expect(await prompt).toMatchObject({ stopReason: "end_turn", cancelled: false });
    } finally {
      const request = h.bridge.input.find(frame => frame.method === "session/prompt");
      if (request) h.bridge.data({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } });
      await prompt?.catch(() => {});
      await h.close();
    }
  });
});

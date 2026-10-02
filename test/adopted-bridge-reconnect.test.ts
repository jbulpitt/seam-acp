import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { makeMux, type AgentProfile } from "@seam/adapters";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const drain = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve));
};

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "seam-adopt-reconnect-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new SessionStore(path.join(dir, "test.db"));
  cleanups.push(() => store.close());
  const now = new Date().toISOString();
  const record = { id: "discord:thread", platform: "discord", channelRef: "thread",
    parentRef: null, agentId: "codex", acpSessionId: "acp", repoPath: "/synthetic",
    configJson: "{}", createdUtc: now, updatedUtc: now };
  store.upsert(record);
  store.turnAttempts.registerOwner("old-controller");
  const attempt = store.turnAttempts.claim({ id: "inbound-1", target: "thread",
    prompt: "work", session: "live", kind: "parked", createdUtc: now },
  "identity", "old-controller", "inbound");
  store.turnAttempts.bind(attempt, "acp");
  store.turnAttempts.bindStatusCard(attempt, { channelId: "thread", messageId: "card" });
  store.turnAttempts.startPrompt(attempt);
  store.turnAttempts.recordRemoteRecovery(attempt, { version: 1, location: "remote",
    slot: 6, submissionId: "submission", acpSessionId: "acp", delegatedUtc: now });
  store.turnAttempts.suspendBoot("old-controller");
  const snapshot = { version: 1, owner: "bridge", submissionId: "submission",
    acpSessionId: "acp", rung: 1, phase: "executing", retry: 0, budget: 3,
    remaining: 3, disposition: "none", updatedUtc: now };
  let seq = 10;
  const frames: Array<Record<string, unknown>> = [];
  const commands: Array<Record<string, any>> = [];
  class Socket extends EventEmitter {
    readyState = 1;
    send(raw: string) {
      const cmd = JSON.parse(raw);
      commands.push(cmd);
      if (cmd.type !== "cmd") return;
      queueMicrotask(() => this.deliver({ type: "cmd_reply", cmdId: cmd.cmdId,
        payload: cmd.action === "listSlots"
          ? { slots: [6], health: [{ slot: 6, alive: true, outputAckedThrough: 10, recovery: snapshot }] }
          : cmd.action === "replayOutput"
            ? { frames: frames.filter(frame => Number(frame.seq) > cmd.payload.afterSeq) }
            : null }));
    }
    close() {}
    deliver(frame: Record<string, unknown>) {
      this.emit("message", Buffer.from(JSON.stringify(frame)));
    }
  }
  let socket = new Socket();
  const mux = makeMux({ id: "remote" });
  mux.attach(socket as never);
  socket.deliver({ type: "hello", instanceId: "first", capabilities: { durableSlots: true } });
  let runtime!: AgentRuntime;
  const router = {
    describeConfig: () => ({ model: { value: "test" }, agent: { value: "codex" },
      location: { value: "remote" }, cwd: { value: "/synthetic" } }),
    adoptRecoveryRuntime: (_record: unknown, child: any, session: string) => {
      runtime = new AgentRuntime({ profile: { id: "codex" } as AgentProfile,
        logger: pino({ level: "silent" }) as any, spawnFn: () => { throw new Error("must not spawn"); } });
      runtime.attachRecovery(child, session);
      return runtime;
    },
    releaseRecoveryRuntime: (_id: string, rt: AgentRuntime) => rt.releaseRecovery(),
  };
  const visible: string[] = [];
  const nonces = new Set<string>();
  const adapter = {
    sendMessage: vi.fn(async (channel: any, text: string, delivery?: { nonce?: string }) => {
      if (!delivery?.nonce || !nonces.has(delivery.nonce)) visible.push(text);
      if (delivery?.nonce) nonces.add(delivery.nonce);
      return { channel, id: `message-${visible.length}` };
    }),
    editStatusPanelProjection: vi.fn(async () => {}),
  };
  const orch = new Orchestrator({ logger: pino({ level: "silent" }) as any,
    modelCatalog: fixtureModelCatalog([]), store, router: router as any,
    adapter: adapter as any, renderer: discordRenderer as any,
    config: { DATA_DIR: dir, REPOS_ROOT: "/synthetic", REPO_EMOJIS: new Map(),
      channelPresets: new Map(), threadPresets: new Map() } as any });
  orch.setBridgeHub({ muxFor: () => mux } as any);
  const run = (orch as any).adoptRemoteRecoveryOwned(store.turnAttempts.get(attempt.id)) as Promise<boolean>;
  const frame = (payload: Record<string, unknown>, live = true) => {
    const entry = { slot: 6, seq: ++seq, ...payload };
    frames.push(entry);
    if (live) socket.deliver(entry);
  };
  const update = (update: Record<string, unknown>, live = true) => frame({ type: "data",
    data: JSON.stringify({ jsonrpc: "2.0", method: "session/update",
      params: { sessionId: "acp", update } }) + "\n" }, live);
  const text = (content: string, live = true) => update({ sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: content } }, live);
  const complete = (output: string) => frame({ type: "recovery_result", recoveryResult: {
    version: 1, submissionId: "submission", acpSessionId: "acp", status: "completed",
    text: output, stopReason: "end_turn", finishedUtc: new Date().toISOString(),
  } });
  const reconnect = async () => {
    socket.readyState = 3;
    socket.emit("close");
    socket = new Socket();
    mux.attach(socket as never);
    socket.deliver({ type: "hello", instanceId: "second", capabilities: { durableSlots: true } });
    await drain();
  };
  return { orch, store, run, adapter, visible, commands, text, update, complete, reconnect,
    runtime: () => runtime };
}

describe("adopted turns across a bridge reconnect", () => {
  it("does not replay directive-only output after already rendering its choice", async () => {
    const h = setup();
    await drain();
    const publish = vi.spyOn(h.orch, "createChoice").mockResolvedValue({ ok: true, choiceId: "choice", messageId: "card" });
    const fence = '```seam-choice\n{"title":"Next","options":[{"label":"Continue","kind":"prompt","payload":"continue"}]}\n```';
    h.text(fence);
    h.complete(fence);
    await h.run;
    expect(publish).toHaveBeenCalledOnce();
    expect(h.visible).toEqual([]);
    expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({ state: "completed", deliveryDone: true });
  });

  it("still projects Done after an intermediate adopted card edit is rejected", async () => {
    const h = setup();
    await drain();
    h.adapter.editStatusPanelProjection.mockRejectedValueOnce(new Error("DiscordAPIError 50035"));
    h.update({ sessionUpdate: "tool_call", toolCallId: "long", title: "heredoc ".repeat(300),
      kind: "execute", status: "in_progress" });
    await drain();
    h.text("finished");
    h.complete("finished");
    await h.run;
    expect(h.adapter.editStatusPanelProjection).toHaveBeenLastCalledWith(
      { channel: { platform: "discord", id: "thread" }, id: "card" },
      { state: "Done", action: "end_turn" });
    expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({ state: "completed", deliveryDone: true });
  });

  it("delivers queued final text and leaves Done last when a card edit is slow", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = setup();
    await drain();
    h.text("adopted narration\n\n");
    h.update({ sessionUpdate: "tool_call", toolCallId: "before", title: "before reconnect",
      kind: "execute", status: "in_progress" });
    await drain();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    h.adapter.editStatusPanelProjection.mockImplementationOnce(async () => gate);
    h.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
    await drain();
    h.text("after reconnect\n\n", false);
    await h.reconnect();
    h.update({ sessionUpdate: "tool_call", toolCallId: "after", title: "after reconnect",
      kind: "execute", status: "in_progress" });
    const final = `FINAL ${"complete output ".repeat(200)} END`;
    h.text(final);
    h.complete("previously visible\n\nadopted narration\n\nafter reconnect\n\n" + final);
    await drain();
    await vi.advanceTimersByTimeAsync(5_001);
    await drain();
    release();
    await h.run;
    await drain();
    expect(h.commands.filter(cmd => cmd.action === "replayOutput").at(-1)?.payload.afterSeq).toBeGreaterThan(10);
    expect(h.visible.join(" ")).toContain("after reconnect");
    expect(h.visible.join(" ")).toContain("FINAL");
    expect(h.visible.join(" ")).toContain("END");
    expect(h.visible.filter(text => text.includes("FINAL"))).toHaveLength(1);
    expect(h.visible.every(text => text.length <= 1800)).toBe(true);
    expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({ state: "completed", deliveryDone: true });
    expect(h.adapter.editStatusPanelProjection).toHaveBeenLastCalledWith(
      { channel: { platform: "discord", id: "thread" }, id: "card" },
      { state: "Done", action: "end_turn" });
  });

  it("reconciles an unseen terminal suffix against the bridge result before recording delivery", async () => {
    const h = setup();
    await drain();
    h.text("adopted narration\n\n");
    h.update({ sessionUpdate: "tool_call", toolCallId: "tool", title: "read",
      kind: "read", status: "in_progress" });
    await drain();
    await h.reconnect();
    const final = `unseen FINAL ${"answer ".repeat(400)} END`;
    h.complete("before adoption\n\nadopted narration\n\n" + final);
    await h.run;
    expect(h.visible.filter(text => text.includes("adopted narration"))).toHaveLength(1);
    expect(h.visible.join(" ")).not.toContain("before adoption");
    expect(h.visible.join(" ")).toContain("unseen FINAL");
    expect(h.visible.join(" ")).toContain("END");
    expect(h.store.turnAttempts.get("inbound-1")?.deliveryPayload).toMatchObject({
      kind: "messages", texts: h.visible });
  });

  it("retains failed terminal delivery for replay while settling the card", async () => {
    const h = setup();
    await drain();
    await h.reconnect();
    h.adapter.sendMessage.mockRejectedValue(new Error("Discord transport unavailable"));
    h.complete("unseen final answer");
    await h.run;
    expect(h.visible).toEqual([]);
    expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({
      state: "completed", deliveryDone: false,
      deliveryPayload: { kind: "messages", texts: ["unseen final answer"] },
    });
    expect(h.adapter.editStatusPanelProjection).toHaveBeenLastCalledWith(
      { channel: { platform: "discord", id: "thread" }, id: "card" },
      { state: "Done", action: "end_turn" });
  });
});

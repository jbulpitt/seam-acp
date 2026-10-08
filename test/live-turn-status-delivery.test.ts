import { testSessionRouter } from "./helpers/session-fixture.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentProfile } from "@seam/adapters";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import type { StructuredPanel } from "../packages/core/src/core/types.js";
import type { IncomingMessage } from "../packages/core/src/platforms/chat-adapter.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { deliveryChunkNonce, deliveryNonce } from "../packages/core/src/core/dispatch/delivery-proof.js";

const ANSWER = "synthetic answer";
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise<void>((done) => setImmediate(done));
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup(mode: "held-status" | "failed-status" | "held-file" | "fast" = "fast",
  logger = pino({ level: "silent" })) {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const dir = mkdtempSync(path.join(tmpdir(), "seam-live-delivery-"));
  const store = new SessionStore(path.join(dir, "test.db"));
  const statusGate = deferred();
  const fileGate = deferred();
  const statusStarted = deferred();
  const fileStarted = deferred();
  let inPrompt = false;
  let heldStatus = false;
  let statusReleased = false;
  let run: Promise<void> | undefined;
  const pending: Promise<void>[] = [];
  const profile = { id: "claude", defaultModel: "fixture-model" } as AgentProfile;
  const runtime = new AgentRuntime({ profile, logger: logger as never,
    spawnFn: () => { throw new Error("provider spawning forbidden"); } });
  const feed = (update: SessionUpdate) => {
    const received = (runtime as unknown as {
      handleSessionUpdate(update: SessionUpdate): Promise<void>;
    }).handleSessionUpdate(update);
    pending.push(received);
    return received;
  };
  const updates: SessionUpdate[] = [
    { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } },
    { sessionUpdate: "tool_call", toolCallId: "bash", title: "Bash", kind: "execute" },
    { sessionUpdate: "tool_call_update", toolCallId: "bash", status: "completed" },
    { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "final thinking" } },
    ...(mode === "held-file" ? [{ sessionUpdate: "agent_message_chunk",
      content: { type: "image", data: "AA==", mimeType: "image/png" } } as SessionUpdate] : []),
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: ANSWER } },
  ];
  const prompt = vi.fn(async () => {
    inPrompt = true;
    vi.setSystemTime(Date.now() + 3_000);
    for (const update of updates) void feed(update);
    return { stopReason: "end_turn" };
  });
  Object.assign(runtime, { connection: { prompt }, sessionId: "fixture-acp", promptCapabilities: {},
    sessionInfo: { sessionId: "fixture-acp", availableModels: [], currentModelId: "fixture-model" } });
  const now = new Date().toISOString();
  const record = { id: "discord:100", platform: "discord", channelRef: "100", parentRef: null,
    agentId: "claude", acpSessionId: "fixture-acp", repoPath: dir, configJson: "{}",
    createdUtc: now, updatedUtc: now };
  store.upsert(record);
  store.admitInbound({ messageId: "1", platform: "discord", channelRef: record.channelRef,
    parentRef: null, sessionRecordId: record.id, authorId: "user", authorName: "User",
    text: "synthetic task", attachments: [], createdUtc: now });
  store.claimInbound("1", 0, now);
  const messages: string[] = [];
  const edits: Array<{ id: string; panel: StructuredPanel }> = [];
  const router = testSessionRouter({
    listProfiles: () => [profile], ensureSessionRecord: () => record, getProfile: () => profile,
    getRuntime: () => runtime, getOrStartRuntime: async () => runtime, isBusy: () => runtime.busy,
    abortTurn: vi.fn(async () => "idle"), invalidate: vi.fn(async () => {}),
    describeConfig: () => ({ agent: { value: "claude" }, location: { value: "local" },
      model: { value: "fixture-model" }, effort: { value: null }, cwd: { value: dir }, fastMode: { value: false } }),
  });
  const adapter = {
    sendPanel: vi.fn(async (channel: IncomingMessage["channel"]) => ({ channel, id: "card" })),
    editPanel: vi.fn(async (ref: { id: string }, panel: StructuredPanel) => {
      edits.push({ id: ref.id, panel });
      if (!inPrompt) return;
      if (mode === "failed-status") throw new Error("synthetic status write failed");
      if (mode === "held-status" && !statusReleased) {
        heldStatus = true;
        statusStarted.resolve();
        await statusGate.promise;
      }
    }),
    sendMessage: vi.fn(async (channel: IncomingMessage["channel"], text: string, _delivery?: { nonce?: string; enforceNonce?: boolean }) => {
      messages.push(text); return { channel, id: `message-${messages.length}` };
    }),
    sendFile: vi.fn(async () => {
      fileStarted.resolve();
      if (mode === "held-file") await fileGate.promise;
    }),
    findMessageByNonce: vi.fn(async () => ({ status: "absent" })),
    editMessage: vi.fn(async () => {}),
  };
  const orch = new Orchestrator({ logger: logger as never, store, renderer: discordRenderer,
    modelCatalog: fixtureModelCatalog([profile]), router: router as never, adapter: adapter as never,
    config: { DATA_DIR: dir, REPOS_ROOT: dir, TURN_TIMEOUT_SECONDS: 60, REPO_EMOJIS: new Map(),
      DEFAULT_MODEL: "fixture-model", CHANNEL_QUEUE_WEDGE_GRACE_SECONDS: 1,
      channelPresets: new Map(), threadPresets: new Map() } as never });
  const internals = orch as unknown as {
    queueOnChannel<T>(channel: string, task: (fence: { channelId: string; epoch: number }) => Promise<T>): Promise<T>;
    handleIncomingMessageInner(message: IncomingMessage, fence: { channelId: string; epoch: number }): Promise<void>;
  };
  const releaseStatus = () => { statusReleased = true; statusGate.resolve(); };
  cleanups.push(async () => {
    releaseStatus(); fileGate.resolve();
    await Promise.allSettled([...pending, ...(run ? [run] : [])]);
    await flush();
    orch.stopSentinelWatcher();
    store.close(); rmSync(dir, { recursive: true, force: true });
  });
  return { store, runtime, router, adapter, orch, prompt, messages, edits, feed, fileGate, releaseStatus,
    statusStarted: statusStarted.promise, fileStarted: fileStarted.promise,
    heldStatus: () => heldStatus,
    run: () => {
      run = internals.queueOnChannel("100", async (fence) => {
        await internals.handleIncomingMessageInner({ messageId: "1", channel: { platform: "discord", id: "100" },
          authorId: "user", authorIsBot: false, text: "synthetic task" }, fence);
        store.completeInbound("1", fence.epoch, new Date().toISOString());
      });
      void run.catch(() => {});
      return run;
    },
  };
}

describe("live-turn status and answer delivery", () => {
  it("records successful incremental text before the ACP terminal response", async () => {
    const h = setup();
    const terminal = deferred();
    const received = deferred();
    h.prompt.mockImplementationOnce(async () => {
      await h.feed({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: ANSWER } });
      received.resolve();
      await terminal.promise;
      return { stopReason: "end_turn" };
    });
    const running = h.run();
    await received.promise;
    await vi.advanceTimersByTimeAsync(4_001);
    try {
      expect(h.messages).toEqual([ANSWER]);
      expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({ state: "active", deliveryDone: false,
        deliveryNonce: deliveryNonce("inbound-1"), deliveryChannel: "100",
        deliveryPayload: { kind: "messages", texts: [ANSWER], stream: { delivered: 1 } } });
      expect(h.adapter.sendMessage.mock.calls[0]?.[2]).toEqual({
        nonce: deliveryChunkNonce(deliveryNonce("inbound-1"), 0), enforceNonce: true,
      });
    } finally { terminal.resolve(); await running; }
    expect(h.messages).toEqual([ANSWER]);
    expect(h.store.turnAttempts.get("inbound-1")?.deliveryDone).toBe(true);
  });
  it("drops a permanent 50035 rejection without resending it or logging it again", async () => {
    const logs: Array<Record<string, any>> = [];
    const logger = pino({ level: "warn" }, { write: line => { logs.push(JSON.parse(line)); } });
    const h = setup("fast", logger);
    const paragraph = "a".repeat(900);
    const error = Object.assign(new Error("Invalid Form Body"), { code: 50035, status: 400 });
    const send = h.adapter.sendMessage.getMockImplementation()!;
    const rejected: string[] = [];
    h.adapter.sendMessage.mockImplementation(async (channel, text) => {
      if (text.includes(paragraph)) { rejected.push(text); throw error; }
      return send(channel, text);
    });
    h.prompt.mockImplementationOnce(async () => {
      await h.feed({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${paragraph}\n\n` } });
      await flush();
      await h.feed({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Closing reply." } });
      return { stopReason: "end_turn" };
    });
    await h.run();
    expect(rejected).toEqual([paragraph]);
    expect(h.messages).toEqual(["Closing reply."]);
    expect(logs.filter(log => log.err?.message === error.message)).toEqual([
      expect.objectContaining({ msg: "assistant text send failed", thread: "100", turn: "inbound-1",
        chars: paragraph.length, err: expect.objectContaining({ code: 50035 }) }),
    ]);
  });

  it("logs a failed background text send once and delivers its retained source at the end", async () => {
    const logs: Array<Record<string, any>> = [];
    const logger = pino({ level: "warn" }, { write: line => { logs.push(JSON.parse(line)); } });
    const h = setup("fast", logger);
    const paragraph = "a".repeat(900);
    const error = Object.assign(new Error("Missing Access"), { code: 50001 });
    h.adapter.sendMessage.mockRejectedValueOnce(error);
    h.prompt.mockImplementationOnce(async () => {
      await h.feed({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${paragraph}\n\n` } });
      await flush();
      expect(h.messages).toEqual([]);
      await h.feed({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Closing reply." } });
      return { stopReason: "end_turn" };
    });
    await h.run();
    expect(h.messages).toEqual([paragraph, "Closing reply."]);
    expect(h.store.turnAttempts.get("inbound-1")?.outcome).toMatchObject({
      output: `${paragraph}\n\nClosing reply.`, status: "completed",
    });
    expect(logs.filter(log => log.msg === "assistant text send failed")).toEqual([
      expect.objectContaining({ thread: "100", turn: "inbound-1", chars: paragraph.length,
        err: expect.objectContaining({ message: "Missing Access", code: 50001 }) }),
    ]);
    expect(logs.filter(log => log.err?.message === error.message)).toHaveLength(1);
  });

  it("delivers and releases the turn while a >5 s status edit remains held, then survives queue recovery", async () => {
    const h = setup("held-status");
    let finished = false;
    const running = h.run().then(() => { finished = true; });
    await h.statusStarted;
    expect(h.heldStatus()).toBe(true);
    await vi.advanceTimersByTimeAsync(6_000);
    await running;

    expect(h.messages).toEqual([ANSWER]);
    expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({ state: "completed", deliveryDone: true,
      outcome: { output: ANSWER, status: "completed" } });
    expect(finished).toBe(true);
    expect(h.orch.isChannelBusy("100")).toBe(false);
    expect(await h.orch.recoverChannel("100", "force")).toMatchObject({ ok: true, epoch: 1 });

    h.releaseStatus();
    await running;
    await flush();
    expect(h.messages).toEqual([ANSWER]);
    expect(h.store.turnAttempts.get("inbound-1")?.outcome?.output).toBe(ANSWER);
    expect(h.edits.at(-1)?.panel.title).toBe("Done");
    expect(h.edits).toHaveLength(3); // Initial Thinking, held live edit, latest Done.
  });

  it("keeps received answer updates pending rather than completing empty after five seconds", async () => {
    const h = setup("held-file");
    const running = h.run();
    await h.fileStarted;
    expect(h.adapter.sendFile).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(6_000);
    await flush();

    expect(h.store.turnAttempts.get("inbound-1")?.state).toBe("active");
    expect(h.messages).toEqual([]);
    expect(h.orch.inspectChannelQueue("100")).toMatchObject({ state: "runtime_busy", epoch: 0 });
    expect(await h.orch.recoverChannel("100", "auto")).toMatchObject({ ok: false, epoch: 0 });

    h.fileGate.resolve();
    await running;
    expect(h.messages).toEqual([ANSWER]);
    expect(h.store.turnAttempts.get("inbound-1")).toMatchObject({ state: "completed", deliveryDone: true,
      outcome: { output: ANSWER, status: "completed" } });
  });

  it("does not fail or lose the answer when status edits reject", async () => {
    const h = setup("failed-status");
    await h.run();
    await flush();
    expect(h.messages).toEqual([ANSWER]);
    expect(h.store.turnAttempts.get("inbound-1")?.outcome).toMatchObject({ output: ANSWER, status: "completed" });
    expect(h.orch.isChannelBusy("100")).toBe(false);
  });

  it("drains notifications queued alongside the prompt response before deciding the answer is empty", async () => {
    const h = setup();
    h.prompt.mockImplementationOnce(async () => {
      setImmediate(() => {
        for (const text of ["synthetic", " ", "answer"]) {
          void h.feed({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
        }
      });
      return { stopReason: "end_turn" };
    });
    await h.run();
    expect(h.messages).toEqual([ANSWER]);
    expect(h.store.turnAttempts.get("inbound-1")?.outcome?.output).toBe(ANSWER);
  });
});

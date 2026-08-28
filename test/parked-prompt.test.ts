/**
 * #88: park one prompt per thread while its remote bridge is offline.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readdir } from "node:fs/promises";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { ParkedPromptManager } from "../packages/core/src/core/parked-prompts/manager.js";
import { dispatchDirs } from "../packages/core/src/core/dispatch/types.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import type { IncomingMessage } from "../packages/core/src/platforms/chat-adapter.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

let dir: string;
let store: SessionStore;

const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  id: "discord:thread-1",
  platform: "discord",
  channelRef: "thread-1",
  parentRef: "channel-1",
  agentId: "claude",
  acpSessionId: "acp-1",
  repoPath: "/repo",
  configJson: "{}",
  createdUtc: "2026-01-01T00:00:00.000Z",
  updatedUtc: "2026-01-01T00:00:00.000Z",
  ...over,
});

function userMsg(over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    channel: { platform: "discord", id: "thread-1", parentId: "channel-1" },
    authorId: "user-1",
    authorName: "Jesse",
    authorIsBot: false,
    text: "please keep going when you're back",
    raw: { id: "discord-msg" },
    ...over,
  };
}

function makeOrch(opts?: {
  ready?: boolean;
  getOrStartRuntime?: ReturnType<typeof vi.fn>;
  getThreadLiveState?: () => Promise<{ locked: boolean; archived: boolean } | undefined>;
  rpc?: ReturnType<typeof vi.fn>;
  hasRuntime?: () => boolean;
  abortTurn?: ReturnType<typeof vi.fn>;
}) {
  const getOrStartRuntime =
    opts?.getOrStartRuntime ??
    vi.fn(async () => {
      throw new Error("getOrStartRuntime must not run while the bridge is offline");
    });
  const abortTurn = opts?.abortTurn ?? vi.fn(async () => "idle");
  const killAll = vi.fn(async () => 0);
  const sent: string[] = [];
  const edited: string[] = [];
  const panels: Array<{ title?: string; description?: string }> = [];
  const router = {
    listProfiles: () => [],
    describeConfig: () => ({}),
    ensureSessionRecord: (o: { channelRef: string }) =>
      record({ id: `discord:${o.channelRef}`, channelRef: o.channelRef }),
    getProfile: () => ({ id: "claude" }),
    getOrStartRuntime,
    hasRuntime: opts?.hasRuntime ?? (() => false),
    abortTurn,
    invalidate: vi.fn(async () => {}),
    killAll,
  };
  const threadPresets = new Map([["thread-1", { location: "mac" }]]);
  const orch = new Orchestrator({
    logger: silent,
    config: {
      DATA_DIR: dir,
      REPOS_ROOT: dir,
      TURN_TIMEOUT_SECONDS: 60,
      DEFAULT_MODEL: "default",
      threadPresets,
      bridgePresets: new Map([["mac", { id: "mac", shortName: "mac", emoji: "💻" }]]),
    } as any,
    adapter: {
      async sendMessage(_ch: unknown, text: string) {
        sent.push(text);
        return { channel: { platform: "discord", id: "thread-1" }, id: "notice-1" };
      },
      async sendPanel(_ch: unknown, panel: { title?: string; description?: string }) {
        panels.push(panel);
        sent.push(`${panel.title ?? ""} ${panel.description ?? ""}`.trim());
        return { channel: { platform: "discord", id: "thread-1" }, id: "notice-1" };
      },
      async editMessage(_ref: unknown, text: string) {
        edited.push(text);
      },
      async editPanel(_ref: unknown, panel: { title?: string; description?: string }) {
        edited.push(`${panel.title ?? ""} ${panel.description ?? ""}`.trim());
      },
      getThreadLiveState:
        opts?.getThreadLiveState ?? (async () => ({ locked: false, archived: false })),
    } as any,
    router: router as any,
    store,
    renderer: {} as any,
  });
  const ready = opts?.ready === true;
  const rpc = opts?.rpc ?? vi.fn(async () => ({ path: "/repo/.seam-attachments/note.txt" }));
  orch.setBridgeHub({
    isBridgeReady: (id: string) => ready && id === "mac",
    onBridgeReady: () => () => {},
    markSessionBridge: () => {},
    rpc,
  } as any);
  return { orch, getOrStartRuntime, abortTurn, killAll, sent, edited, panels, rpc };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-parked-prompt-"));
  store = new SessionStore(path.join(dir, "test.db"));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("park while remote bridge offline (#88)", () => {
  it("parks a user message without starting a runtime or mux timeout", async () => {
    const { orch, getOrStartRuntime, sent } = makeOrch({ ready: false });
    await (orch as any).handleIncomingMessage(userMsg());
    expect(getOrStartRuntime).not.toHaveBeenCalled();
    const row = store.getParkedByChannel("discord", "thread-1");
    expect(row?.prompt).toBe("please keep going when you're back");
    expect(row?.location).toBe("mac");
    expect(sent.join(" ")).toMatch(/will run when \*\*mac\*\* reconnects/);
  });

  it("skips oversized attachments and still parks the prompt", async () => {
    const { orch, sent } = makeOrch({ ready: false });
    await (orch as any).handleIncomingMessage(
      userMsg({
        attachments: [
          {
            filename: "huge.bin",
            contentType: "application/octet-stream",
            url: "https://cdn.example/huge.bin",
            size: 26 * 1024 * 1024,
          },
        ],
      })
    );
    const row = store.getParkedByChannel("discord", "thread-1");
    expect(row?.prompt).toBe("please keep going when you're back");
    expect(row?.attachments).toEqual([]);
    expect(sent.join(" ")).toMatch(/Skipped oversized/);
    expect(sent.join(" ")).toMatch(/huge\.bin/);
  });

  it("does not park a local thread", async () => {
    const { orch } = makeOrch({ ready: false });
    (orch as any).config.threadPresets = new Map();
    const inner = vi.fn(async () => {});
    (orch as any).handleIncomingMessageInner = inner;
    await (orch as any).handleIncomingMessage(userMsg());
    expect(store.getParkedByChannel("discord", "thread-1")).toBeNull();
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("does not park when the bridge is already ready", async () => {
    const { orch } = makeOrch({ ready: true });
    const inner = vi.fn(async () => {});
    (orch as any).handleIncomingMessageInner = inner;
    await (orch as any).handleIncomingMessage(userMsg());
    expect(store.getParkedByChannel("discord", "thread-1")).toBeNull();
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("does not park a synthetic (no raw) message", async () => {
    const getOrStartRuntime = vi.fn(async () => {
      throw new Error("stop after getOrStartRuntime");
    });
    const { orch } = makeOrch({ ready: false, getOrStartRuntime });
    const msg = userMsg();
    delete msg.raw;
    await expect((orch as any).handleIncomingMessage(msg)).resolves.toBeUndefined();
    expect(store.getParkedByChannel("discord", "thread-1")).toBeNull();
  });

  it("replaces a previous parked prompt and cancels its notice", async () => {
    const { orch, edited } = makeOrch({ ready: false });
    await (orch as any).handleIncomingMessage(userMsg({ text: "first" }));
    const firstId = store.getParkedByChannel("discord", "thread-1")!.id;
    await (orch as any).handleIncomingMessage(userMsg({ text: "second" }));
    const second = store.getParkedByChannel("discord", "thread-1")!;
    expect(second.prompt).toBe("second");
    expect(second.id).not.toBe(firstId);
    expect(store.listParked()).toHaveLength(1);
    expect(edited.join(" ")).toMatch(/replaced by a newer parked prompt/);
  });

  it("live user message after reconnect cancels the parked prompt (D2)", async () => {
    const { orch, edited } = makeOrch({ ready: false });
    await (orch as any).handleIncomingMessage(userMsg({ text: "parked" }));
    expect(store.getParkedByChannel("discord", "thread-1")).not.toBeNull();
    orch.setBridgeHub({
      isBridgeReady: () => true,
      onBridgeReady: () => () => {},
      markSessionBridge: () => {},
      rpc: vi.fn(),
    } as any);
    const inner = vi.fn(async () => {});
    (orch as any).handleIncomingMessageInner = inner;
    await (orch as any).handleIncomingMessage(userMsg({ text: "running now" }));
    expect(store.getParkedByChannel("discord", "thread-1")).toBeNull();
    expect(inner).toHaveBeenCalledTimes(1);
    expect(edited.join(" ")).toMatch(/newer message is running/);
  });

  it("fireParked does not enqueue if a newer user message already took the thread", async () => {
    const { orch } = makeOrch({ ready: false });
    await (orch as any).handleIncomingMessage(userMsg({ text: "parked" }));
    const parked = store.getParkedByChannel("discord", "thread-1")!;
    orch.setBridgeHub({
      isBridgeReady: () => true,
      onBridgeReady: () => () => {},
      markSessionBridge: () => {},
      rpc: vi.fn(async () => ({ path: "/repo/file" })),
    } as any);
    (orch as any).handleIncomingMessageInner = vi.fn(async () => {});
    await (orch as any).handleIncomingMessage(userMsg({ text: "running now" }));
    await orch.fireParked(parked);
    const pending = await readdir(dispatchDirs(dir).pending).catch(() => []);
    expect(pending).toEqual([]);
  });

  it("cmdCancel on an idle thread with a parked prompt clears it and says so", async () => {
    const { orch } = makeOrch({ ready: false });
    await (orch as any).handleIncomingMessage(userMsg());
    expect(store.getParkedByChannel("discord", "thread-1")).not.toBeNull();
    let reply = "";
    await (orch as any).cmdCancel({
      options: { getString: () => null, getBoolean: () => false },
      deferReply: async () => {},
      editReply: async (text: string) => {
        reply = text;
      },
      reply: async () => {},
      channelId: "thread-1",
      channel: { parentId: "channel-1" },
    });
    expect(store.getParkedByChannel("discord", "thread-1")).toBeNull();
    expect(reply).toMatch(/Cancelled the parked prompt/);
    expect(reply).toMatch(/\*\*mac\*\*/);
  });

  it("cmdAbort force:true on an idle parked thread clears it and says so", async () => {
    const { orch } = makeOrch({ ready: false });
    await (orch as any).handleIncomingMessage(userMsg());
    let reply = "";
    await (orch as any).cmdAbort({
      options: { getString: () => null, getBoolean: () => true },
      reply: async (opts: { content?: string } | string) => {
        reply = typeof opts === "string" ? opts : (opts.content ?? "");
      },
      deferReply: async () => {},
      editReply: async () => {},
      channelId: "thread-1",
      channel: { parentId: "channel-1" },
    });
    expect(store.getParkedByChannel("discord", "thread-1")).toBeNull();
    expect(reply).toMatch(/Cancelled the parked prompt/);
  });

  it("cmdKill scope:all clears every parked row", async () => {
    store.upsertParked({
      id: "a",
      platform: "discord",
      channelRef: "t1",
      parentRef: null,
      location: "mac",
      kind: "bridge_offline",
      prompt: "one",
      authorId: "u",
      authorName: null,
      noticeMessageId: null,
      attachments: [],
      createdUtc: new Date().toISOString(),
    });
    store.upsertParked({
      id: "b",
      platform: "discord",
      channelRef: "t2",
      parentRef: null,
      location: "office",
      kind: "bridge_offline",
      prompt: "two",
      authorId: "u",
      authorName: null,
      noticeMessageId: null,
      attachments: [],
      createdUtc: new Date().toISOString(),
    });
    const { orch } = makeOrch({ ready: false });
    let reply = "";
    await (orch as any).cmdKill({
      deferReply: async () => {},
      editReply: async (text: string) => {
        reply = text;
      },
    });
    expect(store.listParked()).toEqual([]);
    expect(reply).toMatch(/Cleared 2 parked prompts/);
  });

  it("fire drops a Discord-locked thread and does not enqueue a dispatch", async () => {
    const { orch } = makeOrch({
      ready: true,
      getThreadLiveState: async () => ({ locked: true, archived: false }),
    });
    store.upsertParked({
      id: "park-locked",
      platform: "discord",
      channelRef: "thread-1",
      parentRef: "channel-1",
      location: "mac",
      kind: "bridge_offline",
      prompt: "hello",
      authorId: "u",
      authorName: null,
      noticeMessageId: null,
      attachments: [],
      createdUtc: new Date().toISOString(),
    });
    await orch.fireParked(store.getParked("park-locked")!);
    const pending = await readdir(dispatchDirs(dir).pending).catch(() => []);
    expect(pending).toEqual([]);
  });

  it("fire drops a deleted thread and does not enqueue a dispatch", async () => {
    const { orch } = makeOrch({
      ready: true,
      getThreadLiveState: async () => undefined,
    });
    store.upsertParked({
      id: "park-gone",
      platform: "discord",
      channelRef: "thread-1",
      parentRef: "channel-1",
      location: "mac",
      kind: "bridge_offline",
      prompt: "hello",
      authorId: "u",
      authorName: null,
      noticeMessageId: null,
      attachments: [],
      createdUtc: new Date().toISOString(),
    });
    await orch.fireParked(store.getParked("park-gone")!);
    const dirs = dispatchDirs(dir);
    const pending = await readdir(dirs.pending).catch(() => []);
    expect(pending).toEqual([]);
  });

  it("fire enqueues a live parked dispatch on the same host after writeAttachment", async () => {
    const rpc = vi.fn(async () => ({ path: "/Users/jesse/proj/.seam-attachments/note.txt" }));
    const { orch } = makeOrch({ ready: true, rpc });
    const parkedDir = path.join(dir, "parked-attachments", "park-fire");
    fs.mkdirSync(parkedDir, { recursive: true });
    fs.writeFileSync(path.join(parkedDir, "note.txt"), "hi");
    store.upsertParked({
      id: "park-fire",
      platform: "discord",
      channelRef: "thread-1",
      parentRef: "channel-1",
      location: "mac",
      kind: "bridge_offline",
      prompt: "use the note",
      authorId: "u",
      authorName: "Jesse",
      noticeMessageId: "notice-1",
      attachments: [{ filename: "note.txt", mime: "text/plain", size: 2 }],
      createdUtc: new Date().toISOString(),
    });
    await orch.fireParked(store.getParked("park-fire")!);
    expect(rpc).toHaveBeenCalledWith(
      "mac",
      "writeAttachment",
      expect.objectContaining({ filename: "note.txt", cwd: "/repo" }),
      "claude"
    );
    const dirs = dispatchDirs(dir);
    const pending = await readdir(dirs.pending);
    expect(pending).toHaveLength(1);
    const spec = JSON.parse(fs.readFileSync(path.join(dirs.pending, pending[0]!), "utf8"));
    expect(spec.kind).toBe("parked");
    expect(spec.session).toBe("live");
    expect(spec.location).toBe("mac");
    expect(spec.prompt).toContain("use the note");
    expect(spec.prompt).toContain("/Users/jesse/proj/.seam-attachments/note.txt");
  });

  it("manager + ready event fires the parked row", async () => {
    const { orch } = makeOrch({ ready: false });
    await (orch as any).handleIncomingMessage(userMsg());
    expect(store.listParked()).toHaveLength(1);
    const listeners: Array<(id: string) => void> = [];
    let ready = false;
    const hub = {
      isBridgeReady: (id: string) => ready && id === "mac",
      onBridgeReady: (fn: (id: string) => void) => {
        listeners.push(fn);
        return () => {};
      },
      markSessionBridge: () => {},
      rpc: vi.fn(async () => ({ path: "/repo/file" })),
    };
    orch.setBridgeHub(hub as any);
    const done = new Promise<void>((resolve, reject) => {
      const m = new ParkedPromptManager({
        store,
        hub,
        logger: silent,
        onFire: async (p) => {
          try {
            await orch.fireParked(p);
            resolve();
          } catch (err) {
            reject(err);
          }
        },
      });
      m.start();
      void (async () => {
        await new Promise((r) => setImmediate(r));
        ready = true;
        listeners[0]!("mac");
      })();
      (orch as any)._parkedTestManager = m;
    });
    await done;
    (orch as any)._parkedTestManager.stop();
    expect(store.listParked()).toEqual([]);
    const dirs = dispatchDirs(dir);
    const pending = await readdir(dirs.pending);
    expect(pending.length).toBe(1);
  });
});

function queueIx(prompt: string, over: Record<string, unknown> = {}) {
  let reply = "";
  const ix = {
    options: {
      getString: (name: string) => (name === "prompt" ? prompt : null),
      getBoolean: () => false,
    },
    deferReply: async () => {},
    editReply: async (text: string) => {
      reply = text;
    },
    reply: async (opts: { content?: string } | string) => {
      reply = typeof opts === "string" ? opts : (opts.content ?? "");
    },
    channelId: "thread-1",
    channel: { parentId: "channel-1" },
    user: { id: "user-1", username: "Jesse", globalName: null },
    ...over,
  };
  return {
    ix,
    get reply() {
      return reply;
    },
  };
}

function insertBufferedVoice(): void {
  store.insertThreadVoiceSession({
    id: "tv_cancel_guard",
    platform: "discord",
    channelRef: "thread-1",
    parentRef: "channel-1",
    guildId: "guild-1",
    voiceChannelId: "vc-1",
    ownerUserId: "user-1",
    ownerName: "Jesse",
    status: "ready",
    noticeMessageId: null,
    transmittedAudioMs: 0,
    createdUtc: "2026-08-27T12:00:00.000Z",
    updatedUtc: "2026-08-27T12:00:00.000Z",
    endedUtc: null,
    endReason: null,
  });
  store.appendThreadVoiceSegment({
    id: "tvs_cancel_guard",
    sessionId: "tv_cancel_guard",
    sequence: 1,
    authorId: "user-1",
    transcript: "must survive ACP cancellation",
    state: "pending",
    audioMs: 200,
    dispatchId: null,
    capturedStartedUtc: "start",
    capturedEndedUtc: "end",
    createdUtc: "2026-08-27T12:00:00.000Z",
    updatedUtc: "2026-08-27T12:00:00.000Z",
    error: null,
  });
}

function cancelIx() {
  return {
    options: { getString: () => null, getBoolean: () => false },
    deferReply: async () => {},
    editReply: async () => {},
    reply: async () => {},
    channelId: "thread-1",
    channel: { parentId: "channel-1" },
  };
}

describe("Thread Voice cancel coexistence", () => {
  it("plain cancel aborts ACP gracefully without stopping playback or deleting buffered voice", async () => {
    insertBufferedVoice();
    const abortTurn = vi.fn(async () => "cancelled");
    const { orch } = makeOrch({ ready: true, abortTurn, hasRuntime: () => true });
    const cancelSpeech = vi.fn();
    const stopPlayback = vi.fn(async () => {});
    (orch as any).threadVoiceSpeechByChannel.set("thread-1", { cancel: cancelSpeech });
    orch.setThreadVoiceManager({ stopPlayback } as any);

    await (orch as any).cmdCancel(cancelIx());

    expect(abortTurn).toHaveBeenCalledWith("discord:thread-1", { force: false });
    expect(cancelSpeech).not.toHaveBeenCalled();
    expect(stopPlayback).not.toHaveBeenCalled();
    expect(store.listThreadVoiceSegments("tv_cancel_guard")[0]).toMatchObject({
      state: "pending",
      transcript: "must survive ACP cancellation",
    });
  });

  it("force cancel stops playback but preserves capture session and buffered voice", async () => {
    insertBufferedVoice();
    const abortTurn = vi.fn(async () => "cancelled");
    const { orch } = makeOrch({ ready: true, abortTurn, hasRuntime: () => true });
    const cancelSpeech = vi.fn();
    const stopPlayback = vi.fn(async () => {});
    const stop = vi.fn();
    (orch as any).threadVoiceSpeechByChannel.set("thread-1", { cancel: cancelSpeech });
    orch.setThreadVoiceManager({ stopPlayback, stop } as any);

    await (orch as any).cmdAbort(cancelIx());

    expect(cancelSpeech).toHaveBeenCalledOnce();
    expect(stopPlayback).toHaveBeenCalledWith("tv_cancel_guard");
    expect(stop).not.toHaveBeenCalled();
    expect(abortTurn).toHaveBeenCalledWith("discord:thread-1", { force: true });
    expect(store.listThreadVoiceSegments("tv_cancel_guard")[0]).toMatchObject({
      state: "pending",
      transcript: "must survive ACP cancellation",
    });
  });

  it("scope-all stops every Thread Voice session without discarding its durable text", async () => {
    insertBufferedVoice();
    const { orch, killAll } = makeOrch({ ready: true });
    const cancelSpeech = vi.fn();
    const stopAll = vi.fn(async () => {});
    (orch as any).threadVoiceSpeechByChannel.set("thread-1", { cancel: cancelSpeech });
    orch.setThreadVoiceManager({ stopAll } as any);

    await (orch as any).cmdKill(cancelIx());

    expect(cancelSpeech).toHaveBeenCalledOnce();
    expect(stopAll).toHaveBeenCalledWith("global cancel");
    expect(killAll).toHaveBeenCalledOnce();
    expect(store.listThreadVoiceSegments("tv_cancel_guard")[0]).toMatchObject({
      state: "pending",
      transcript: "must survive ACP cancellation",
    });
  });
});

describe("/seam queue (#89)", () => {
  it.each(["pending", "batched"] as const)(
    "refuses to create a parallel parked prompt while Thread Voice text is %s",
    async (state) => {
      store.insertThreadVoiceSession({
        id: "tv_queue_guard",
        platform: "discord",
        channelRef: "thread-1",
        parentRef: "channel-1",
        guildId: "guild-1",
        voiceChannelId: "vc-1",
        ownerUserId: "user-1",
        ownerName: "Jesse",
        status: "ready",
        noticeMessageId: null,
        transmittedAudioMs: 0,
        createdUtc: "2026-08-27T12:00:00.000Z",
        updatedUtc: "2026-08-27T12:00:00.000Z",
        endedUtc: null,
        endReason: null,
      });
      store.appendThreadVoiceSegment({
        id: "tvs_queue_guard",
        sessionId: "tv_queue_guard",
        sequence: 1,
        authorId: "user-1",
        transcript: "already owned by Thread Voice",
        state: "pending",
        audioMs: 200,
        dispatchId: null,
        capturedStartedUtc: "start",
        capturedEndedUtc: "end",
        createdUtc: "2026-08-27T12:00:00.000Z",
        updatedUtc: "2026-08-27T12:00:00.000Z",
        error: null,
      });
      if (state === "batched") {
        store.claimPendingThreadVoiceBatch("tv_queue_guard", "tvd_queue_guard");
      }
      const { orch } = makeOrch({ ready: true });
      const q = queueIx("must not become a parallel prompt");

      await (orch as any).cmdQueue(q.ix);

      expect(q.reply).toMatch(/Thread Voice already has buffered or batched text/);
      expect(store.getParkedByChannel("discord", "thread-1")).toBeNull();
      expect(fs.existsSync(dispatchDirs(dir).pending)).toBe(false);
    }
  );

  it("mid-turn queue parks and does not abort the running turn", async () => {
    const abortTurn = vi.fn(async () => "cancelled");
    const { orch, sent } = makeOrch({ ready: true, abortTurn, hasRuntime: () => true });
    (orch as any).channelQueues.set("thread-1", new Promise(() => {}));
    const q = queueIx("do this next");
    await (orch as any).cmdQueue(q.ix);
    expect(abortTurn).not.toHaveBeenCalled();
    const row = store.getParkedByChannel("discord", "thread-1");
    expect(row?.prompt).toBe("do this next");
    expect(row?.kind).toBe("user_queue");
    expect(sent.join(" ")).toMatch(/Queued/);
    expect(sent.join(" ")).toMatch(/current turn ends/);
    expect(sent.join(" ")).toMatch(/Send a normal message to run now/);
    expect(q.reply).toMatch(/Queued/);
  });

  it("second /seam queue cancels the first notice; only the latest remains", async () => {
    const { orch, edited } = makeOrch({ ready: true });
    (orch as any).channelQueues.set("thread-1", new Promise(() => {}));
    await (orch as any).cmdQueue(queueIx("first").ix);
    const firstId = store.getParkedByChannel("discord", "thread-1")!.id;
    await (orch as any).cmdQueue(queueIx("second").ix);
    const second = store.getParkedByChannel("discord", "thread-1")!;
    expect(second.prompt).toBe("second");
    expect(second.id).not.toBe(firstId);
    expect(store.listParked()).toHaveLength(1);
    expect(edited.join(" ")).toMatch(/replaced by a newer parked prompt/);
  });

  it("idle + host ready replaces a sitting parked row so it cannot fire after", async () => {
    const { orch, edited } = makeOrch({ ready: false });
    await (orch as any).cmdQueue(queueIx("old parked").ix);
    expect(store.getParkedByChannel("discord", "thread-1")?.prompt).toBe("old parked");
    orch.setBridgeHub({
      isBridgeReady: () => true,
      onBridgeReady: () => () => {},
      markSessionBridge: () => {},
      rpc: vi.fn(),
    } as any);
    const q = queueIx("run me now");
    await (orch as any).cmdQueue(q.ix);
    expect(store.getParkedByChannel("discord", "thread-1")).toBeNull();
    expect(q.reply).toMatch(/Running now/);
    expect(edited.join(" ")).toMatch(/replaced by a newer parked prompt/);
    const pending = await readdir(dispatchDirs(dir).pending);
    expect(pending).toHaveLength(1);
    const spec = JSON.parse(
      fs.readFileSync(path.join(dispatchDirs(dir).pending, pending[0]!), "utf8")
    );
    expect(spec.prompt).toBe("run me now");
    await orch.tryFireParked("thread-1");
    const still = await readdir(dispatchDirs(dir).pending);
    expect(still).toHaveLength(1);
  });

  it("idle + host ready runs immediately with no parked row left sitting", async () => {
    const abortTurn = vi.fn(async () => "idle");
    const { orch } = makeOrch({ ready: true, abortTurn });
    const q = queueIx("run me now");
    await (orch as any).cmdQueue(q.ix);
    expect(store.getParkedByChannel("discord", "thread-1")).toBeNull();
    expect(abortTurn).not.toHaveBeenCalled();
    expect(q.reply).toMatch(/Running now/);
    const pending = await readdir(dispatchDirs(dir).pending);
    expect(pending).toHaveLength(1);
    const spec = JSON.parse(
      fs.readFileSync(path.join(dispatchDirs(dir).pending, pending[0]!), "utf8")
    );
    expect(spec.kind).toBe("parked");
    expect(spec.session).toBe("live");
    expect(spec.prompt).toBe("run me now");
    expect(spec.location).toBe("mac");
  });

  it("offline @bridge parks; does not start a runtime", async () => {
    const { orch, getOrStartRuntime } = makeOrch({ ready: false });
    await (orch as any).cmdQueue(queueIx("when mac is back").ix);
    expect(getOrStartRuntime).not.toHaveBeenCalled();
    const row = store.getParkedByChannel("discord", "thread-1");
    expect(row?.kind).toBe("user_queue");
    expect(row?.prompt).toBe("when mac is back");
    expect(row?.location).toBe("mac");
  });

  it("bare Discord message while queued aborts live and cancels the parked row", async () => {
    const abortTurn = vi.fn(async () => "cancelled");
    const { orch, edited } = makeOrch({ ready: true, abortTurn, hasRuntime: () => true });
    (orch as any).channelQueues.set("thread-1", Promise.resolve());
    await (orch as any).cmdQueue(queueIx("queued").ix);
    expect(store.getParkedByChannel("discord", "thread-1")).not.toBeNull();
    const inner = vi.fn(async () => {});
    (orch as any).handleIncomingMessageInner = inner;
    await (orch as any).handleIncomingMessage(userMsg({ text: "run this instead" }));
    expect(store.getParkedByChannel("discord", "thread-1")).toBeNull();
    expect(inner).toHaveBeenCalledTimes(1);
    expect(edited.join(" ")).toMatch(/newer message is running/);
    expect(abortTurn).toHaveBeenCalled();
  });

  it("tryFireParked on turn-end fires a user_queue row when idle and ready", async () => {
    const { orch } = makeOrch({ ready: true });
    (orch as any).channelQueues.set("thread-1", new Promise(() => {}));
    await (orch as any).cmdQueue(queueIx("after this turn").ix);
    expect(store.getParkedByChannel("discord", "thread-1")).not.toBeNull();
    (orch as any).channelQueues.delete("thread-1");
    await orch.tryFireParked("thread-1");
    expect(store.getParkedByChannel("discord", "thread-1")).toBeNull();
    const pending = await readdir(dispatchDirs(dir).pending);
    expect(pending).toHaveLength(1);
    const spec = JSON.parse(
      fs.readFileSync(path.join(dispatchDirs(dir).pending, pending[0]!), "utf8")
    );
    expect(spec.prompt).toBe("after this turn");
    expect(spec.kind).toBe("parked");
  });

  it("fireParked while the thread is busy restores the row and does not enqueue", async () => {
    const { orch } = makeOrch({ ready: true });
    (orch as any).channelQueues.set("thread-1", new Promise(() => {}));
    store.upsertParked({
      id: "park-busy",
      platform: "discord",
      channelRef: "thread-1",
      parentRef: "channel-1",
      location: "mac",
      kind: "user_queue",
      prompt: "after this turn",
      authorId: "u",
      authorName: null,
      noticeMessageId: null,
      attachments: [],
      createdUtc: new Date().toISOString(),
    });
    const parked = store.getParked("park-busy")!;
    store.deleteParked(parked.id);
    await orch.fireParked(parked);
    expect(store.getParkedByChannel("discord", "thread-1")?.id).toBe("park-busy");
    const pending = await readdir(dispatchDirs(dir).pending).catch(() => []);
    expect(pending).toEqual([]);
  });

  it("fireParked while busy does not restore a row a newer message already cancelled", async () => {
    const { orch } = makeOrch({ ready: true });
    (orch as any).channelQueues.set("thread-1", new Promise(() => {}));
    store.upsertParked({
      id: "park-old",
      platform: "discord",
      channelRef: "thread-1",
      parentRef: "channel-1",
      location: "mac",
      kind: "user_queue",
      prompt: "stale",
      authorId: "u",
      authorName: null,
      noticeMessageId: null,
      attachments: [],
      createdUtc: "2026-08-18T00:00:00.000Z",
    });
    const parked = store.getParked("park-old")!;
    store.deleteParked(parked.id);
    (orch as any).lastUserMessageAt.set("thread-1", Date.now());
    await orch.fireParked(parked);
    expect(store.getParkedByChannel("discord", "thread-1")).toBeNull();
    const pending = await readdir(dispatchDirs(dir).pending).catch(() => []);
    expect(pending).toEqual([]);
  });

  it("tryFireParked no-ops when the host is still down (row stays)", async () => {
    const { orch } = makeOrch({ ready: false });
    await (orch as any).cmdQueue(queueIx("wait for mac").ix);
    await orch.tryFireParked("thread-1");
    expect(store.getParkedByChannel("discord", "thread-1")?.prompt).toBe("wait for mac");
  });

  it("tryFireParked no-ops while the channel is still busy", async () => {
    const { orch } = makeOrch({ ready: true });
    (orch as any).channelQueues.set("thread-1", new Promise(() => {}));
    await (orch as any).cmdQueue(queueIx("not yet").ix);
    await orch.tryFireParked("thread-1");
    expect(store.getParkedByChannel("discord", "thread-1")?.prompt).toBe("not yet");
  });

  it("/seam cancel while running AND queued clears both; parked does not fire after", async () => {
    const abortTurn = vi.fn(async () => "cancelled");
    const { orch } = makeOrch({ ready: true, abortTurn, hasRuntime: () => true });
    (orch as any).channelQueues.set("thread-1", new Promise(() => {}));
    await (orch as any).cmdQueue(queueIx("should not fire").ix);
    let reply = "";
    await (orch as any).cmdCancel({
      options: { getString: () => null, getBoolean: () => false },
      deferReply: async () => {},
      editReply: async (text: string) => {
        reply = text;
      },
      reply: async () => {},
      channelId: "thread-1",
      channel: { parentId: "channel-1" },
    });
    expect(store.getParkedByChannel("discord", "thread-1")).toBeNull();
    expect(abortTurn).toHaveBeenCalled();
    expect(reply).toMatch(/queued prompt|Cancel sent/i);
    (orch as any).channelQueues.delete("thread-1");
    await orch.tryFireParked("thread-1");
    const pending = await readdir(dispatchDirs(dir).pending).catch(() => []);
    expect(pending).toEqual([]);
  });

  it("participants are allowed queue; lock-exempt; cancel scope:all stays privileged", () => {
    const locked = {
      channelPresets: new Map([["channel-1", { locked: true }]]),
      threadPresets: new Map(),
      SEAM_CONFIG_ADMIN_USER_IDS: new Set(["admin"]),
      SEAM_PARTICIPANT_USER_IDS: new Set(["student"]),
    } as any;
    const participants = {
      SEAM_PARTICIPANT_USER_IDS: new Set(["student"]),
      SEAM_CONFIG_ADMIN_USER_IDS: new Set(["admin"]),
    } as any;
    expect(Orchestrator.isLockedSlashRefused(locked, "channel-1", "queue", "student")).toBe(false);
    expect(Orchestrator.isParticipantSlashRefused(participants, "queue", "student")).toBe(false);
    expect(
      Orchestrator.isParticipantSlashRefused(participants, "cancel", "student", { scope: "all" })
    ).toBe(true);
  });
});

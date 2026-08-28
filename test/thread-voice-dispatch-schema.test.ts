import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { parseDispatchSpec, type DispatchSpec } from "../packages/core/src/core/dispatch/types.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import type { IncomingMessage } from "../packages/core/src/platforms/chat-adapter.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const base = {
  target: "thread-1",
  prompt: "voice prompt",
  session: "live",
  createdUtc: "2026-08-27T12:00:00.000Z",
};

describe("thread_voice dispatch schema", () => {
  it("accepts the complete trusted tuple only for the internal kind", () => {
    expect(parseDispatchSpec("tvd-1", JSON.stringify({
      ...base,
      kind: "thread_voice",
      authorId: "user-1",
      authorName: "Jesse",
      threadVoiceSessionId: "tv-1",
    }))).toMatchObject({
      id: "tvd-1",
      kind: "thread_voice",
      authorId: "user-1",
      authorName: "Jesse",
      threadVoiceSessionId: "tv-1",
      session: "live",
    });
  });

  it("rejects missing trusted fields and isolated Thread Voice runs", () => {
    expect(() => parseDispatchSpec("bad-1", JSON.stringify({
      ...base, kind: "thread_voice", authorId: "user-1",
    }))).toThrow(/requires authorId, authorName, and threadVoiceSessionId/);
    expect(() => parseDispatchSpec("bad-2", JSON.stringify({
      ...base,
      session: "isolated",
      kind: "thread_voice",
      authorId: "user-1",
      authorName: "Jesse",
      threadVoiceSessionId: "tv-1",
    }))).toThrow(/must use the live session/);
  });

  it("rejects speaker metadata on arbitrary dispatch kinds", () => {
    expect(() => parseDispatchSpec("bad-3", JSON.stringify({
      ...base, kind: "handoff", authorId: "user-1",
    }))).toThrow(/accepted only for kind thread_voice/);
  });
});

describe("trusted Thread Voice dispatch boundary", () => {
  let dir: string;
  let store: SessionStore;
  let abortTurn: ReturnType<typeof vi.fn>;
  let markDispatchSettled: ReturnType<typeof vi.fn>;
  let orch: Orchestrator;
  let batchPrompt: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-thread-voice-dispatch-"));
    store = new SessionStore(path.join(dir, "test.db"));
    store.insertThreadVoiceSession({
      id: "tv_trusted",
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
      createdUtc: base.createdUtc,
      updatedUtc: base.createdUtc,
      endedUtc: null,
      endReason: null,
    });
    store.appendThreadVoiceSegment({
      id: "tvs_trusted",
      sessionId: "tv_trusted",
      sequence: 1,
      authorId: "user-1",
      transcript: "voice prompt",
      state: "pending",
      audioMs: 200,
      dispatchId: null,
      capturedStartedUtc: "start",
      capturedEndedUtc: "end",
      createdUtc: base.createdUtc,
      updatedUtc: base.createdUtc,
      error: null,
    });
    batchPrompt = store.claimPendingThreadVoiceBatch("tv_trusted", "tvd-1")!.prompt;
    abortTurn = vi.fn(async () => "cancelled");
    const router = {
      listProfiles: () => [],
      describeConfig: () => ({}),
      ensureSessionRecord: ({ channelRef, parentRef }: { channelRef: string; parentRef?: string }) => ({
        id: `discord:${channelRef}`,
        platform: "discord",
        channelRef,
        parentRef: parentRef ?? null,
        agentId: "claude",
        acpSessionId: "acp-1",
        repoPath: dir,
        configJson: "{}",
        createdUtc: base.createdUtc,
        updatedUtc: base.createdUtc,
      }),
      abortTurn,
    };
    orch = new Orchestrator({
      logger: pino({ level: "silent" }) as unknown as Logger,
      config: {
        DATA_DIR: dir,
        REPOS_ROOT: dir,
        TURN_TIMEOUT_SECONDS: 60,
        threadPresets: new Map(),
        channelPresets: new Map(),
      } as any,
      adapter: {} as any,
      router: router as any,
      store,
      renderer: {} as any,
    });
    markDispatchSettled = vi.fn(async () => {});
    orch.setThreadVoiceManager({
      markDispatchSettled,
      releaseIfIdle: vi.fn(async () => false),
    } as any);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function trusted(over: Partial<DispatchSpec> = {}): DispatchSpec {
    return {
      id: "tvd-1",
      ...base,
      prompt: batchPrompt,
      kind: "thread_voice",
      authorId: "user-1",
      authorName: "Jesse",
      threadVoiceSessionId: "tv_trusted",
      ...over,
    };
  }

  it("rejects forged speaker metadata unless it matches the durable batch owner", async () => {
    const inner = vi.fn(async () => {});
    (orch as any).handleIncomingMessageInner = inner;

    await expect(orch.dispatchInjectTurn(trusted({ authorName: "Mallory" }))).rejects.toThrow(
      /does not match its durable batch owner/
    );

    expect(inner).not.toHaveBeenCalled();
    expect(markDispatchSettled).not.toHaveBeenCalled();
  });

  it("queues verified voice non-preemptively, while a later typed message interrupts it normally", async () => {
    let releaseVoice!: () => void;
    const voiceBlocked = new Promise<void>((resolve) => { releaseVoice = resolve; });
    const seen: IncomingMessage[] = [];
    const inner = vi.fn(async (message: IncomingMessage) => {
      seen.push(message);
      if (seen.length === 1) await voiceBlocked;
    });
    (orch as any).handleIncomingMessageInner = inner;

    const voiceTurn = orch.dispatchInjectTurn(trusted());
    await vi.waitFor(() => expect(inner).toHaveBeenCalledTimes(1));
    expect(seen[0]).toMatchObject({
      authorId: "user-1",
      authorName: "Jesse",
      authorIsBot: false,
      text: batchPrompt,
    });
    expect((orch as any).channelGenerations.get("thread-1")).toBeUndefined();
    expect(abortTurn).not.toHaveBeenCalled();

    const typedTurn = (orch as any).handleIncomingMessage({
      channel: { platform: "discord", id: "thread-1", parentId: "channel-1" },
      authorId: "user-1",
      authorName: "Jesse",
      authorIsBot: false,
      text: "typed correction",
      raw: { id: "discord-message" },
    } satisfies IncomingMessage);
    await vi.waitFor(() => expect(abortTurn).toHaveBeenCalledWith("discord:thread-1", { force: true }));
    expect((orch as any).channelGenerations.get("thread-1")).toBe(1);
    expect(markDispatchSettled).not.toHaveBeenCalled();

    releaseVoice();
    await expect(voiceTurn).resolves.toEqual({ output: "", stopReason: "end_turn" });
    await typedTurn;
    expect(seen.map((message) => message.text)).toEqual([batchPrompt, "typed correction"]);
    expect(markDispatchSettled).toHaveBeenCalledWith("tv_trusted", "tvd-1");
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionStore } from "../packages/core/src/core/session-store.js";
import { VoiceConsoleManager } from "../packages/core/src/core/voice-console/manager.js";
import type {
  ThreadVoiceBinding,
  VoiceConsoleDispatchHost,
  VoiceConsoleRuntimeHost,
  VoiceConsoleSession,
} from "../packages/core/src/core/voice-console/types.js";
import type { ThreadVoiceSession } from "../packages/core/src/core/thread-voice/types.js";
import { VoiceLeaseManager } from "../packages/core/src/core/voice-lease.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const NOW = "2026-08-28T12:00:00.000Z";
const silent = pino({ level: "silent" }) as unknown as Logger;
let dir: string;
let store: SessionStore;
let leases: VoiceLeaseManager;
let host: VoiceConsoleRuntimeHost;
let dispatch: VoiceConsoleDispatchHost;
let manager: VoiceConsoleManager;

function consoleRow(over: Partial<VoiceConsoleSession> = {}): VoiceConsoleSession {
  return {
    id: "tvc_1",
    platform: "discord",
    guildId: "guild-1",
    voiceChannelId: "vc-1",
    ownerUserId: "admin-1",
    ownerName: "Owner",
    status: "ready",
    cardChannelId: "vc-1",
    cardMessageId: null,
    cardPage: 0,
    revision: 1,
    fanoutArmed: false,
    forwardedAudioBytes: 0,
    forwardedAudioMs: 0,
    utteranceCount: 0,
    liveFinalCount: 0,
    unaryFallbackCount: 0,
    droppedCount: 0,
    sttFailureCount: 0,
    createdUtc: NOW,
    updatedUtc: NOW,
    endedUtc: null,
    endReason: null,
    ...over,
  };
}

function binding(id = "bind-a", over: Partial<ThreadVoiceBinding> = {}): ThreadVoiceBinding {
  return {
    id,
    consoleId: "tvc_1",
    platform: "discord",
    channelRef: `thread-${id}`,
    parentRef: "parent-1",
    guildId: "guild-1",
    voiceChannelId: "vc-1",
    ownerUserId: "admin-1",
    ownerName: "Owner",
    status: "active",
    noticeMessageId: null,
    alias: id,
    aliasNormalized: id,
    ttsVoice: "Aoede",
    ttsPace: "normal",
    ttsStyle: null,
    profileUpdatedUtc: NOW,
    outputEnabled: true,
    outputGeneration: 0,
    createdUtc: NOW,
    updatedUtc: NOW,
    endedUtc: null,
    endReason: null,
    ...over,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-voice-console-manager-"));
  store = new SessionStore(path.join(dir, "test.db"));
  leases = new VoiceLeaseManager({ now: () => NOW });
  host = {
    startConsole: vi.fn(async () => ({ ok: true })),
    addBinding: vi.fn(async () => ({ ok: true })),
    reconcileConsole: vi.fn(async () => ({ ok: true })),
    stopConsole: vi.fn(async () => {}),
    stopBinding: vi.fn(async () => {}),
    waitForBindingSpeechIdle: vi.fn(async () => {}),
  };
  dispatch = {
    isBindingBusy: vi.fn(async () => false),
    inspectArtifact: vi.fn(async () => "missing"),
    enqueue: vi.fn(async () => {}),
  };
  manager = new VoiceConsoleManager({
    store,
    logger: silent,
    host,
    dispatch,
    leases,
    now: () => NOW,
  });
});

afterEach(async () => {
  manager.shutdown();
  await flush();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("VoiceConsoleManager lifecycle", () => {
  it("leases by console id, invokes the platform-neutral host, and marks start ready", async () => {
    const result = await manager.start({
      console: consoleRow({ status: "starting" }),
      binding: binding("bind-a", { status: "adding" }),
    });
    expect(result.ok).toBe(true);
    expect(host.startConsole).toHaveBeenCalledOnce();
    expect(leases.get("guild-1")).toMatchObject({
      kind: "thread_voice",
      sessionId: "tvc_1",
      voiceChannelId: "vc-1",
    });
    expect(store.getVoiceConsole("tvc_1")).toMatchObject({ status: "ready", revision: 2 });
    expect(store.getVoiceConsoleBinding("bind-a")?.status).toBe("active");
  });

  it("upgrades active V1 state before host reconciliation and transfers lease authority", async () => {
    const legacy: ThreadVoiceSession = {
      id: "tv_legacy",
      platform: "discord",
      channelRef: "thread-legacy",
      parentRef: "parent-1",
      guildId: "guild-1",
      voiceChannelId: "vc-1",
      ownerUserId: "admin-1",
      ownerName: "Owner",
      status: "ready",
      noticeMessageId: "notice-1",
      transmittedAudioMs: 0,
      createdUtc: NOW,
      updatedUtc: NOW,
      endedUtc: null,
      endReason: null,
    };
    store.insertThreadVoiceSession(legacy);
    leases.acquire({
      kind: "thread_voice",
      sessionId: legacy.id,
      guildId: legacy.guildId,
      voiceChannelId: legacy.voiceChannelId,
    });
    const result = await manager.reconcileOnBoot({
      aliasFor: () => "Legacy",
      profileFor: () => ({ voice: "Aoede", pace: "normal", style: null }),
    });
    expect(result).toMatchObject({ upgraded: 1, reconciled: 1, failures: 0 });
    const active = store.getActiveVoiceConsoleForGuild("guild-1");
    expect(active?.id).toMatch(/^tvc_/);
    expect(leases.get("guild-1")?.sessionId).toBe(active?.id);
    expect(host.reconcileConsole).toHaveBeenCalledWith(
      expect.objectContaining({ id: active?.id }),
      [expect.objectContaining({ id: "tv_legacy", status: "active" })]
    );
  });
});

describe("VoiceConsoleManager dispatch and barriers", () => {
  beforeEach(() => {
    store.createVoiceConsole({ console: consoleRow(), binding: binding() });
  });

  it("fans out one actual speaker into independent authenticated dispatches", async () => {
    const added = store.addVoiceConsoleBinding({
      binding: binding("bind-b", { alias: "Beta" }),
      claim: false,
      expectedRevision: 1,
    });
    if (!added.ok) throw new Error(added.error);
    const selected = store.replaceVoiceConsoleInputTargets("tvc_1", {
      bindingIds: ["bind-a", "bind-b"],
      fanoutArmed: true,
      expectedRevision: added.value.console.revision,
    });
    if (!selected.ok) throw new Error(selected.error);
    const capture = manager.allocateCapture({
      consoleId: "tvc_1",
      speakerId: "speaker-7",
      speakerName: "Actual Speaker",
      captureId: "capture-fanout",
    });
    expect(capture?.assignments).toHaveLength(2);
    manager.commitCapture({
      captureId: "capture-fanout",
      speakerId: "speaker-7",
      speakerName: "Actual Speaker",
      transcript: "fan this out",
      audioMs: 800,
      capturedEndedUtc: NOW,
      speakerAuthorized: true,
    });
    await Promise.all([manager.releaseIfIdle("bind-a"), manager.releaseIfIdle("bind-b")]);
    expect(dispatch.enqueue).toHaveBeenCalledTimes(2);
    expect(vi.mocked(dispatch.enqueue).mock.calls.map(([request]) => request)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "thread-bind-a",
          authorId: "speaker-7",
          authorName: "Actual Speaker",
          consoleId: "tvc_1",
          bindingId: "bind-a",
        }),
        expect.objectContaining({ target: "thread-bind-b", bindingId: "bind-b" }),
      ])
    );
  });

  it("releases pending voice after an origin-agnostic visible binding turn settles", async () => {
    vi.mocked(dispatch.isBindingBusy).mockResolvedValue(true);
    manager.allocateCapture({
      consoleId: "tvc_1",
      speakerId: "speaker-1",
      speakerName: "Speaker",
      captureId: "capture-after-handoff",
    });
    manager.commitCapture({
      captureId: "capture-after-handoff",
      speakerId: "speaker-1",
      speakerName: "Speaker",
      transcript: "wait behind visible generic work",
      audioMs: 500,
      capturedEndedUtc: NOW,
      speakerAuthorized: true,
    });
    await manager.releaseIfIdle("bind-a");
    expect(dispatch.enqueue).not.toHaveBeenCalled();

    vi.mocked(dispatch.isBindingBusy).mockResolvedValue(false);
    expect(await manager.markBindingActivitySettled("bind-a")).toBe(true);
    expect(dispatch.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ bindingId: "bind-a", authorId: "speaker-1" })
    );
  });

  it("linearizes discard against an in-flight artifact inspection", async () => {
    manager.allocateCapture({
      consoleId: "tvc_1",
      speakerId: "speaker-1",
      speakerName: "Speaker",
      captureId: "capture-1",
    });
    manager.commitCapture({
      captureId: "capture-1",
      speakerId: "speaker-1",
      speakerName: "Speaker",
      transcript: "discard me",
      audioMs: 500,
      capturedEndedUtc: NOW,
      speakerAuthorized: true,
    });
    const inspection = deferred<"missing">();
    vi.mocked(dispatch.inspectArtifact)
      .mockImplementationOnce(async () => inspection.promise)
      .mockResolvedValue("missing");
    const releasing = manager.releaseIfIdle("bind-a");
    await flush();
    expect(dispatch.inspectArtifact).toHaveBeenCalledOnce();

    const removing = manager.removeBinding("bind-a", {
      expectedRevision: 1,
      discardPending: true,
      reason: "test removal",
    });
    await flush();
    inspection.resolve("missing");
    await releasing;
    const result = await removing;
    expect(result).toEqual({ ok: true, discarded: 1, consoleEnded: true });
    expect(dispatch.enqueue).not.toHaveBeenCalled();
    expect(store.listVoiceConsoleSegments("bind-a")[0]).toMatchObject({
      state: "discarded",
      transcript: "",
    });
    expect(store.getVoiceConsole("tvc_1")?.status).toBe("ended");
    expect(leases.get("guild-1")).toBeUndefined();
  });
});

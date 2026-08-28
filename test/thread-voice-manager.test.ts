import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import {
  ThreadVoiceManager,
  type ThreadVoiceDispatchHost,
  type ThreadVoiceHost,
} from "../packages/core/src/core/thread-voice/manager.js";
import type {
  OwnerVoiceState,
  ThreadVoiceSession,
} from "../packages/core/src/core/thread-voice/types.js";
import { VoiceLeaseManager } from "../packages/core/src/core/voice-lease.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

let dir: string;
let store: SessionStore;
let leases: VoiceLeaseManager;
let voiceState: OwnerVoiceState;
let runOpts: Parameters<ThreadVoiceHost["runSession"]>[0] | undefined;
let resolveRun: ((value: { reason: string }) => void) | undefined;
let busy: boolean;
let artifacts: Map<string, "missing" | "pending" | "running" | "done">;
let host: ThreadVoiceHost;
let dispatch: ThreadVoiceDispatchHost;
let manager: ThreadVoiceManager;

const startRequest = {
  platform: "discord",
  channelRef: "thread-1",
  parentRef: "channel-1",
  guildId: "guild-1",
  ownerUserId: "user-1",
  ownerName: "Jesse",
};

function durableSession(over: Partial<ThreadVoiceSession> = {}): ThreadVoiceSession {
  return {
    id: "tv_durable",
    platform: "discord",
    channelRef: "thread-durable",
    parentRef: "channel-1",
    guildId: "guild-durable",
    voiceChannelId: "vc-durable",
    ownerUserId: "user-durable",
    ownerName: "Owner",
    status: "ended",
    noticeMessageId: null,
    transmittedAudioMs: 0,
    createdUtc: "2026-08-27T12:00:00.000Z",
    updatedUtc: "2026-08-27T12:00:00.000Z",
    endedUtc: "2026-08-27T12:01:00.000Z",
    endReason: "stopped",
    ...over,
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-thread-voice-manager-"));
  store = new SessionStore(path.join(dir, "test.db"));
  leases = new VoiceLeaseManager({ now: () => "2026-08-27T12:00:00.000Z" });
  voiceState = {
    ok: true,
    guildId: "guild-1",
    voiceChannelId: "vc-1",
    channelName: "General",
    selfMuted: true,
    visible: true,
  };
  busy = false;
  artifacts = new Map();
  host = {
    inspectOwnerVoiceState: vi.fn(async () => voiceState),
    runSession: vi.fn(async (opts) => {
      runOpts = opts;
      return new Promise<{ reason: string }>((resolve) => {
        resolveRun = resolve;
        opts.signal.addEventListener("abort", () => resolve({ reason: "cancelled" }), {
          once: true,
        });
      });
    }),
    speak: vi.fn(async () => {}),
    waitForPlaybackIdle: vi.fn(async () => {}),
    stopPlayback: vi.fn(async () => {}),
    notify: vi.fn(async () => {}),
  };
  dispatch = {
    isHomeThreadBusy: vi.fn(async () => busy),
    inspectArtifact: vi.fn(async (id) => artifacts.get(id) ?? "missing"),
    enqueue: vi.fn(async (request) => {
      artifacts.set(request.id, "pending");
    }),
  };
  manager = new ThreadVoiceManager({
    store,
    logger: silent,
    host,
    dispatch,
    leases,
    now: () => "2026-08-27T12:30:00.000Z",
  });
});

afterEach(async () => {
  manager.shutdown();
  await flush();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("ThreadVoiceManager lifecycle", () => {
  it("requires visible self-muted owner state before acquiring or running", async () => {
    voiceState = { ...voiceState, selfMuted: false } as OwnerVoiceState;
    const result = await manager.start(startRequest);
    expect(result).toEqual({
      ok: false,
      error: "Mute yourself in Discord before starting Thread Voice, then try again.",
    });
    expect(host.runSession).not.toHaveBeenCalled();
    expect(leases.list()).toEqual([]);
  });

  it("acquires before run, persists runtime/audio state, and releases on end", async () => {
    const started = await manager.start(startRequest);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(leases.get("guild-1")).toMatchObject({
      kind: "thread_voice",
      sessionId: started.session.id,
    });
    expect(host.runSession).toHaveBeenCalledOnce();

    runOpts?.onState("ready");
    runOpts?.onAudioSent(1250);
    expect(store.getThreadVoiceSession(started.session.id)).toMatchObject({
      status: "ready",
      transmittedAudioMs: 1250,
    });

    resolveRun?.({ reason: "owner left" });
    await flush();
    expect(store.getThreadVoiceSession(started.session.id)).toMatchObject({
      status: "ended",
      endReason: "owner left",
    });
    expect(leases.get("guild-1")).toBeUndefined();
  });

  it("reports a shared Live Help lease conflict without converting it to authorization", async () => {
    leases.acquire({
      kind: "live_help",
      sessionId: "lh_active",
      guildId: "guild-1",
      voiceChannelId: "vc-1",
    });
    const result = await manager.start(startRequest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("live_help");
      expect(result.error).toContain("lh_active");
      expect(result.error).not.toMatch(/parent|approval/i);
    }
  });

  it("stop with discard clears only finalized pending text and releases resources", async () => {
    busy = true;
    const started = await manager.start(startRequest);
    if (!started.ok) throw new Error(started.error);
    manager.commitFinalSegment(started.session.id, {
      sequence: 1,
      authorId: "user-1",
      transcript: "do not keep this",
      audioMs: 800,
      capturedStartedUtc: "start",
      capturedEndedUtc: "end",
    });
    await flush();
    const stopped = await manager.stop(started.session.id, { discardPending: true });
    expect(stopped).toEqual({ ok: true, discarded: 1 });
    await flush();
    expect(store.listThreadVoiceSegments(started.session.id)[0]).toMatchObject({
      state: "discarded",
      transcript: "",
    });
    expect(store.getThreadVoiceSession(started.session.id)?.status).toBe("ended");
    expect(leases.get("guild-1")).toBeUndefined();
  });

  it("discard also removes a claimed batch only while it has no dispatch artifact", async () => {
    busy = true;
    const started = await manager.start(startRequest);
    if (!started.ok) throw new Error(started.error);
    manager.commitFinalSegment(started.session.id, {
      sequence: 1,
      authorId: "user-1",
      transcript: "claimed but not enqueued",
      audioMs: 800,
      capturedStartedUtc: "start",
      capturedEndedUtc: "end",
    });
    store.claimPendingThreadVoiceBatch(started.session.id, "tvd_artifact_free");

    const stopped = await manager.stop(started.session.id, { discardPending: true });
    expect(stopped).toEqual({ ok: true, discarded: 1 });
    expect(store.getThreadVoiceBatch("tvd_artifact_free")?.segments[0]).toMatchObject({
      state: "discarded",
      transcript: "",
    });
    expect(store.listThreadVoiceSegments(started.session.id)[0]).toMatchObject({
      state: "discarded",
      transcript: "",
    });
  });

  it.each(["pending", "running", "done"] as const)(
    "preserves a claimed batch once its %s dispatch artifact exists",
    async (artifactState) => {
      busy = true;
      const started = await manager.start(startRequest);
      if (!started.ok) throw new Error(started.error);
      manager.commitFinalSegment(started.session.id, {
        sequence: 1,
        authorId: "user-1",
        transcript: "durably owned",
        audioMs: 800,
        capturedStartedUtc: "start",
        capturedEndedUtc: "end",
      });
      store.claimPendingThreadVoiceBatch(started.session.id, "tvd_owned");
      artifacts.set("tvd_owned", artifactState);

      const stopped = await manager.stop(started.session.id, { discardPending: true });
      expect(stopped).toEqual({ ok: true, discarded: 0 });
      expect(store.getThreadVoiceBatch("tvd_owned")?.segments[0]).toMatchObject({
        state: "batched",
        transcript: "durably owned",
      });
    }
  );
});

describe("ThreadVoiceManager durable release and recovery", () => {
  it("waits for an earlier reserved capture when API finals complete out of order", async () => {
    const started = await manager.start(startRequest);
    if (!started.ok) throw new Error(started.error);
    const first = runOpts!.nextSequence();
    const second = runOpts!.nextSequence();
    expect([first, second]).toEqual([1, 2]);

    runOpts!.onFinal({
      sequence: second,
      authorId: "user-1",
      transcript: "second final arrived first",
      audioMs: 500,
      capturedStartedUtc: "s2",
      capturedEndedUtc: "e2",
    });
    await flush();
    expect(dispatch.enqueue).not.toHaveBeenCalled();

    runOpts!.onFinal({
      sequence: first,
      authorId: "user-1",
      transcript: "first final arrived second",
      audioMs: 500,
      capturedStartedUtc: "s1",
      capturedEndedUtc: "e1",
    });
    await flush();
    expect(dispatch.enqueue).toHaveBeenCalledOnce();
    const prompt = vi.mocked(dispatch.enqueue).mock.calls[0]![0].prompt;
    expect(prompt.indexOf("Voice segment 1")).toBeLessThan(prompt.indexOf("Voice segment 2"));
  });

  it("lets an explicit noise/drop settlement unblock a later finalized capture", async () => {
    const started = await manager.start(startRequest);
    if (!started.ok) throw new Error(started.error);
    const dropped = runOpts!.nextSequence();
    const finalized = runOpts!.nextSequence();
    runOpts!.onFinal({
      sequence: finalized,
      authorId: "user-1",
      transcript: "usable second utterance",
      audioMs: 500,
      capturedStartedUtc: "s2",
      capturedEndedUtc: "e2",
    });
    await flush();
    expect(dispatch.enqueue).not.toHaveBeenCalled();
    runOpts!.onDropped({
      sequence: dropped,
      authorId: "user-1",
      state: "capture_dropped",
      audioMs: 100,
      capturedStartedUtc: "s1",
      capturedEndedUtc: "e1",
    });
    await flush();
    expect(dispatch.enqueue).toHaveBeenCalledOnce();
    expect(store.getThreadVoiceSegmentBySequence(started.session.id, dropped)).toMatchObject({
      state: "capture_dropped",
      transcript: "",
    });
  });

  it("accumulates out-of-order finals while busy into one ordered batch after playback drains", async () => {
    busy = true;
    const started = await manager.start(startRequest);
    if (!started.ok) throw new Error(started.error);
    manager.commitFinalSegment(started.session.id, {
      sequence: 2,
      authorId: "user-1",
      transcript: "second",
      audioMs: 500,
      capturedStartedUtc: "s2",
      capturedEndedUtc: "e2",
    });
    manager.commitFinalSegment(started.session.id, {
      sequence: 1,
      authorId: "user-1",
      transcript: "first",
      audioMs: 500,
      capturedStartedUtc: "s1",
      capturedEndedUtc: "e1",
    });
    await flush();
    expect(dispatch.enqueue).not.toHaveBeenCalled();

    busy = false;
    expect(await manager.releaseIfIdle(started.session.id)).toBe(true);
    expect(host.waitForPlaybackIdle).toHaveBeenCalledWith(started.session.id);
    expect(dispatch.enqueue).toHaveBeenCalledOnce();
    const request = vi.mocked(dispatch.enqueue).mock.calls[0]![0];
    expect(request.authorId).toBe("user-1");
    expect(request.threadVoiceSessionId).toBe(started.session.id);
    expect(request.prompt.indexOf("Voice segment 1:\nfirst")).toBeLessThan(
      request.prompt.indexOf("Voice segment 2:\nsecond")
    );

    manager.commitFinalSegment(started.session.id, {
      sequence: 3,
      authorId: "user-1",
      transcript: "third",
      audioMs: 500,
      capturedStartedUtc: "s3",
      capturedEndedUtc: "e3",
    });
    expect(await manager.releaseIfIdle(started.session.id)).toBe(false);
    await manager.markDispatchSettled(started.session.id, request.id);
    expect(dispatch.enqueue).toHaveBeenCalledTimes(2);
    expect(vi.mocked(dispatch.enqueue).mock.calls[1]![0].prompt).toContain(
      "Voice segment 3:\nthird"
    );
  });

  it("does not enqueue again when recovery finds an existing stable artifact", async () => {
    const row = durableSession();
    store.insertThreadVoiceSession(row);
    store.appendThreadVoiceSegment({
      id: "tvs_recover",
      sessionId: row.id,
      sequence: 1,
      authorId: row.ownerUserId,
      transcript: "recover this",
      state: "pending",
      audioMs: 500,
      dispatchId: null,
      capturedStartedUtc: "start",
      capturedEndedUtc: "end",
      createdUtc: "created",
      updatedUtc: "updated",
      error: null,
    });
    store.claimPendingThreadVoiceBatch(row.id, "tvd_existing");
    artifacts.set("tvd_existing", "pending");

    const first = await manager.recoverDispatches();
    expect(first).toMatchObject({ dispatchesEnqueued: 0 });
    expect(dispatch.enqueue).not.toHaveBeenCalled();
    expect(store.getThreadVoiceBatch("tvd_existing")?.segments[0]?.state).toBe("dispatched");

    await manager.recoverDispatches();
    expect(dispatch.enqueue).not.toHaveBeenCalled();
    expect(manager.getActiveDispatchId(row)).toBe("tvd_existing");
  });

  it("re-enqueues a missing batched artifact once under the persisted dispatch id", async () => {
    const row = durableSession();
    store.insertThreadVoiceSession(row);
    store.appendThreadVoiceSegment({
      id: "tvs_missing",
      sessionId: row.id,
      sequence: 1,
      authorId: row.ownerUserId,
      transcript: "recover missing",
      state: "pending",
      audioMs: 500,
      dispatchId: null,
      capturedStartedUtc: "start",
      capturedEndedUtc: "end",
      createdUtc: "created",
      updatedUtc: "updated",
      error: null,
    });
    store.claimPendingThreadVoiceBatch(row.id, "tvd_missing");

    expect((await manager.recoverDispatches()).dispatchesEnqueued).toBe(1);
    expect(vi.mocked(dispatch.enqueue).mock.calls[0]![0].id).toBe("tvd_missing");
    await manager.recoverDispatches();
    expect(dispatch.enqueue).toHaveBeenCalledOnce();
  });
});

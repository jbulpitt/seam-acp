import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type {
  VoiceConsoleCaptureCommit,
  VoiceConsoleCaptureDrop,
  VoiceConsoleCapturePersistencePort,
  VoiceConsoleCaptureSnapshotDraft,
} from "../packages/core/src/core/voice-console/capture-router.js";
import {
  DiscordVoiceConsoleCaptureHost,
  type VoiceConsoleTranscribePort,
  type VoiceConsoleTranscriberFactory,
} from "../packages/core/src/platforms/discord/voice-console-capture.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

type FakeVoiceState = {
  id: string;
  channelId: string | null;
  selfMute: boolean | null;
  sessionId: string | null;
  member?: {
    displayName: string;
    user: { globalName: string | null; username: string };
  };
};

function voiceState(
  id: string,
  channelId: string | null,
  selfMute: boolean,
  sessionId = `${id}-session`
): FakeVoiceState {
  return {
    id,
    channelId,
    selfMute,
    sessionId,
    member: {
      displayName: id.toUpperCase(),
      user: { globalName: null, username: id },
    },
  };
}

function fixture(opts: {
  inputActive?: boolean;
  maxCapturePartBytes?: number;
  finalizingThrows?: boolean;
} = {}) {
  const voiceChannelId = "voice-1";
  const allowed = new Set(["alice", "bob"]);
  const client = new EventEmitter() as EventEmitter & {
    on: (event: string, listener: (...args: any[]) => void) => typeof client;
    off: (event: string, listener: (...args: any[]) => void) => typeof client;
  };
  const speaking = new EventEmitter() as EventEmitter & { users: Map<string, number> };
  speaking.users = new Map();
  const subscriptions = new Map<string, PassThrough>();
  const streamsByUser = new Map<string, PassThrough[]>();
  const receiver = {
    speaking,
    subscriptions,
    subscribe: vi.fn((userId: string) => {
      const stream = new PassThrough({ objectMode: true });
      subscriptions.set(userId, stream);
      const streams = streamsByUser.get(userId) ?? [];
      streams.push(stream);
      streamsByUser.set(userId, streams);
      return stream;
    }),
  };
  const connection = { receiver, destroy: vi.fn() };

  let captureSerial = 0;
  let sequence = 0;
  const commits: Array<{ speakerId: string; transcript: string; forwardedBytes: number }> = [];
  const drops: Array<{ speakerId: string; reason: string }> = [];
  const terminalCommits: VoiceConsoleCaptureCommit[] = [];
  const terminalDrops: VoiceConsoleCaptureDrop[] = [];
  const persistence: VoiceConsoleCapturePersistencePort = {
    snapshotCapture: vi.fn(async ({ speakerId, speakerName, capturedStartedUtc }) => {
      captureSerial += 1;
      sequence += 1;
      const snapshot: VoiceConsoleCaptureSnapshotDraft = {
        consoleId: "console-1",
        captureId: `capture-${captureSerial}`,
        consoleRevision: 3,
        speakerId,
        speakerName,
        capturedStartedUtc,
        targets: [{ bindingId: "binding-a", sequence }],
      };
      return snapshot;
    }),
    commitCapture: vi.fn(async (input) => {
      terminalCommits.push(input);
      commits.push({
        speakerId: input.snapshot.speakerId,
        transcript: input.transcript,
        forwardedBytes: input.forwardedBytes,
      });
      return input.snapshot.targets.map((target) => ({
        bindingId: target.bindingId,
        sequence: target.sequence,
        status: "committed" as const,
      }));
    }),
    dropCapture: vi.fn(async (input) => {
      terminalDrops.push(input);
      drops.push({ speakerId: input.snapshot.speakerId, reason: input.reason });
    }),
  };

  const transcribers = new Map<
    string,
    {
      port: VoiceConsoleTranscribePort;
      sent: number[];
      handlers: Parameters<VoiceConsoleTranscriberFactory>[0]["handlers"];
    }
  >();
  const factory = vi.fn<VoiceConsoleTranscriberFactory>(async ({ speakerId, handlers }) => {
    const sent: number[] = [];
    const port: VoiceConsoleTranscribePort = {
      startUtterance: vi.fn(async () => {}),
      sendPcm16k: vi.fn((pcm) => {
        sent.push(Buffer.from(pcm).readInt16LE(0));
        handlers.onForwardedBytes(pcm.byteLength);
      }),
      finalizeUtterance: vi.fn(async () => ({
        ok: true as const,
        text: `${speakerId} transcript`,
        source: speakerId === "bob" ? "unary" as const : "live" as const,
      })),
      cancelUtterance: vi.fn(),
      close: vi.fn(),
    };
    transcribers.set(speakerId, { port, sent, handlers });
    return port;
  });
  const finalizing: string[] = [];
  const callbackErrors: string[] = [];

  const host = new DiscordVoiceConsoleCaptureHost({
    client: client as never,
    connection: connection as never,
    voiceChannelId,
    initialSpeakers: [
      { userId: "alice", speakerName: "ALICE", selfMuted: true, sessionId: "alice-session" },
      { userId: "bob", speakerName: "BOB", selfMuted: true, sessionId: "bob-session" },
      { userId: "mallory", speakerName: "MALLORY", selfMuted: true, sessionId: "mallory-session" },
    ],
    persistence,
    isAllowedUser: (userId) => allowed.has(userId),
    createTranscriber: factory,
    logger: silent,
    inputActive: opts.inputActive ?? true,
    callbacks: {
      onCaptureFinalizing: (capture) => {
        finalizing.push(capture.captureId);
        if (opts.finalizingThrows) throw new Error("host finalizing observer failure");
      },
      onError: (error) => callbackErrors.push(error.message),
    },
    minCaptureBytes: 2,
    maxCapturePartBytes: opts.maxCapturePartBytes ?? 32_000,
    now: (() => {
      let clock = 0;
      return () => `t-${++clock}`;
    })(),
    dependencies: {
      createDecoder: () => ({
        decode: (packet) => {
          const sample = packet[0] ?? 0;
          const pcm48k = Buffer.alloc(6);
          pcm48k.writeInt16LE(sample, 0);
          pcm48k.writeInt16LE(sample, 2);
          pcm48k.writeInt16LE(sample, 4);
          return { pcm48k, channels: 1 as const };
        },
      }),
    },
  });

  return {
    host,
    client,
    speaking,
    receiver,
    connection,
    subscriptions,
    streamsByUser,
    persistence,
    allowed,
    transcribers,
    factory,
    commits,
    drops,
    terminalCommits,
    terminalDrops,
    finalizing,
    callbackErrors,
    voiceChannelId,
  };
}

async function setMuted(
  f: ReturnType<typeof fixture>,
  userId: string,
  prior: boolean,
  next: boolean,
  sessionId = `${userId}-session`
): Promise<void> {
  f.client.emit(
    "voiceStateUpdate",
    voiceState(userId, f.voiceChannelId, prior, sessionId),
    voiceState(userId, f.voiceChannelId, next, sessionId)
  );
  await tick();
}

describe("DiscordVoiceConsoleCaptureHost", () => {
  it("isolates overlapping authorized speakers and never subscribes an unauthorized user", async () => {
    const f = fixture();
    await setMuted(f, "alice", true, false);
    await setMuted(f, "bob", true, false);
    await setMuted(f, "mallory", true, false);
    expect(f.factory).toHaveBeenCalledTimes(2);
    expect(f.transcribers.has("alice")).toBe(true);
    expect(f.transcribers.has("bob")).toBe(true);
    expect(f.transcribers.has("mallory")).toBe(false);

    for (const userId of ["alice", "bob", "mallory"]) {
      f.speaking.users.set(userId, 1);
      f.speaking.emit("start", userId);
    }
    expect(f.receiver.subscribe).toHaveBeenCalledTimes(2);
    expect(f.subscriptions.has("mallory")).toBe(false);

    f.subscriptions.get("alice")!.write(Buffer.from([11]));
    f.subscriptions.get("bob")!.write(Buffer.from([22]));
    await tick();
    await setMuted(f, "alice", false, true);
    await setMuted(f, "bob", false, true);
    await f.host.idle();

    expect(f.transcribers.get("alice")!.sent).toEqual([11]);
    expect(f.transcribers.get("bob")!.sent).toEqual([22]);
    expect(f.commits).toEqual([
      { speakerId: "alice", transcript: "alice transcript", forwardedBytes: 2 },
      { speakerId: "bob", transcript: "bob transcript", forwardedBytes: 2 },
    ]);
    expect(f.host.router.forwardedBytes).toBe(4);
    expect(f.finalizing).toEqual(["capture-1", "capture-2"]);
    expect(f.terminalCommits.map((input) => ({
      captureId: input.captureId,
      forwardedBytes: input.forwardedBytes,
      forwardedAudioMs: input.forwardedAudioMs,
      source: input.source,
      targetCount: input.snapshot.targets.length,
    }))).toEqual([
      {
        captureId: "capture-1",
        forwardedBytes: 2,
        forwardedAudioMs: 0,
        source: "live",
        targetCount: 1,
      },
      {
        captureId: "capture-2",
        forwardedBytes: 2,
        forwardedAudioMs: 0,
        source: "unary",
        targetCount: 1,
      },
    ]);
    await f.host.destroy();
  });

  it("marks one logical exact-boundary continuation finalizing once", async () => {
    const f = fixture({ maxCapturePartBytes: 2 });
    await setMuted(f, "alice", true, false);
    f.speaking.users.set("alice", 1);
    f.speaking.emit("start", "alice");
    f.subscriptions.get("alice")!.write(Buffer.from([13]));
    await tick();

    await setMuted(f, "alice", false, true);
    await setMuted(f, "alice", false, true);
    await f.host.idle();

    expect(f.finalizing).toEqual(["capture-1"]);
    // The transport may close the exact-boundary empty continuation through a
    // second Live activity, but both parts still settle one logical capture.
    expect(f.transcribers.get("alice")!.port.finalizeUtterance).toHaveBeenCalledTimes(2);
    expect(f.persistence.commitCapture).toHaveBeenCalledOnce();
    expect(f.terminalCommits[0]).toMatchObject({
      captureId: "capture-1",
      forwardedBytes: 2,
      forwardedAudioMs: 0,
      source: "live",
    });
    expect(f.terminalCommits[0]).not.toHaveProperty("pcm");
    await f.host.destroy();
  });

  it("isolates a finalizing observer failure without blocking STT or commit", async () => {
    const f = fixture({ finalizingThrows: true });
    await setMuted(f, "alice", true, false);
    f.speaking.users.set("alice", 1);
    f.speaking.emit("start", "alice");
    f.subscriptions.get("alice")!.write(Buffer.from([8]));
    await tick();

    await setMuted(f, "alice", false, true);
    await f.host.idle();

    expect(f.finalizing).toEqual(["capture-1"]);
    expect(f.callbackErrors).toContain("host finalizing observer failure");
    expect(f.transcribers.get("alice")!.port.finalizeUtterance).toHaveBeenCalledOnce();
    expect(f.persistence.commitCapture).toHaveBeenCalledOnce();
    await f.host.destroy();
  });

  it("fails safe on a same-user receiver discontinuity until a fresh mute cycle", async () => {
    const f = fixture();
    await setMuted(f, "alice", true, false);
    f.speaking.users.set("alice", 1);
    f.speaking.emit("start", "alice");
    f.speaking.emit("start", "alice");
    expect(f.receiver.subscribe).toHaveBeenCalledTimes(1);
    f.subscriptions.get("alice")!.write(Buffer.from([7]));
    await tick();
    const firstTranscriber = f.transcribers.get("alice")!;

    f.subscriptions.get("alice")!.emit("end");
    // A replacement speaking event can race ahead of the serialized durable
    // abort, but the runtime is locally unsafe as soon as the stream ends.
    f.speaking.emit("start", "alice");
    expect(f.receiver.subscribe).toHaveBeenCalledTimes(1);
    await tick();
    await f.host.idle();
    expect(f.host.router.listLanes().filter((lane) => lane.userId === "alice")).toHaveLength(1);
    expect(f.host.router.getLane("alice")).toMatchObject({ state: "awaiting_safe_mute" });
    expect(f.drops).toEqual([{ speakerId: "alice", reason: "unsafe_rebind" }]);
    expect(firstTranscriber.port.cancelUtterance).toHaveBeenCalledOnce();
    expect(firstTranscriber.port.close).toHaveBeenCalledOnce();

    // Discord may immediately advertise a replacement SSRC. It is ignored
    // until the real self-mute state proves a fresh safe edge.
    f.speaking.emit("start", "alice");
    expect(f.receiver.subscribe).toHaveBeenCalledTimes(1);
    await setMuted(f, "alice", false, true);
    await setMuted(f, "alice", true, false);
    expect(f.receiver.subscribe).toHaveBeenCalledTimes(2);
    f.subscriptions.get("alice")!.write(Buffer.from([9]));
    await tick();
    await setMuted(f, "alice", false, true);
    await f.host.idle();

    expect(f.host.router.listLanes().filter((lane) => lane.userId === "alice")).toHaveLength(1);
    expect(f.factory).toHaveBeenCalledTimes(2);
    expect(firstTranscriber.sent).toEqual([7]);
    expect(f.transcribers.get("alice")!.sent).toEqual([9]);
    expect(f.commits).toEqual([
      { speakerId: "alice", transcript: "alice transcript", forwardedBytes: 2 },
    ]);
    expect(f.persistence.commitCapture).toHaveBeenCalledOnce();
    await f.host.destroy();
  });

  it("Input off aborts every active STT lane without unary finalization or a late commit", async () => {
    const f = fixture();
    await setMuted(f, "alice", true, false);
    await setMuted(f, "bob", true, false);
    for (const userId of ["alice", "bob"]) {
      f.speaking.users.set(userId, 1);
      f.speaking.emit("start", userId);
      f.subscriptions.get(userId)!.write(Buffer.from([5]));
    }
    await tick();
    await f.host.setInputEnabled(false);
    await f.host.idle();

    expect(f.drops).toEqual([
      { speakerId: "alice", reason: "input_off" },
      { speakerId: "bob", reason: "input_off" },
    ]);
    expect(f.persistence.commitCapture).not.toHaveBeenCalled();
    expect(f.finalizing).toHaveLength(0);
    expect(f.subscriptions.size).toBe(0);
    expect(f.terminalDrops.map((input) => ({
      captureId: input.captureId,
      reason: input.reason,
      forwardedBytes: input.forwardedBytes,
      forwardedAudioMs: input.forwardedAudioMs,
      source: input.source,
    }))).toEqual([
      {
        captureId: "capture-1",
        reason: "input_off",
        forwardedBytes: 2,
        forwardedAudioMs: 0,
        source: undefined,
      },
      {
        captureId: "capture-2",
        reason: "input_off",
        forwardedBytes: 2,
        forwardedAudioMs: 0,
        source: undefined,
      },
    ]);
    for (const { port } of f.transcribers.values()) {
      expect(port.cancelUtterance).toHaveBeenCalledOnce();
      expect(port.close).toHaveBeenCalledOnce();
      expect(port.finalizeUtterance).not.toHaveBeenCalled();
    }

    await f.host.setInputEnabled(true);
    expect(f.host.router.getLane("alice")?.state).toBe("awaiting_safe_mute");
    await f.host.destroy();
  });

  it("Input off wins while a final transcription is still in flight", async () => {
    const f = fixture();
    await setMuted(f, "alice", true, false);
    f.speaking.users.set("alice", 1);
    f.speaking.emit("start", "alice");
    f.subscriptions.get("alice")!.write(Buffer.from([5]));
    await tick();

    let resolveFinal!: (result: {
      ok: true;
      text: string;
      source: "live";
    }) => void;
    const final = new Promise<{ ok: true; text: string; source: "live" }>((resolve) => {
      resolveFinal = resolve;
    });
    const port = f.transcribers.get("alice")!.port;
    vi.mocked(port.finalizeUtterance).mockReturnValue(final);

    await setMuted(f, "alice", false, true);
    expect(port.finalizeUtterance).toHaveBeenCalledOnce();
    expect(f.finalizing).toEqual(["capture-1"]);
    await f.host.setInputEnabled(false);
    expect(port.cancelUtterance).toHaveBeenCalledOnce();
    expect(port.close).toHaveBeenCalledOnce();
    expect(f.drops).toEqual([{ speakerId: "alice", reason: "input_off" }]);

    resolveFinal({ ok: true, text: "too late", source: "live" });
    await f.host.idle();
    expect(f.persistence.commitCapture).not.toHaveBeenCalled();
    await f.host.destroy();
  });

  it("revokes an active speaker and requires a safe cycle after an uncertain device session", async () => {
    const f = fixture();
    await setMuted(f, "alice", true, false);
    const firstCapture = f.host.router.getLane("alice")?.captureId;
    f.client.emit(
      "voiceStateUpdate",
      voiceState("alice", f.voiceChannelId, false, "session-1"),
      voiceState("alice", f.voiceChannelId, false, "session-2")
    );
    await tick();
    await f.host.idle();
    expect(f.host.router.listLanes().filter((lane) => lane.userId === "alice")).toHaveLength(1);
    expect(f.host.router.getLane("alice")).toMatchObject({ state: "awaiting_safe_mute" });
    expect(f.drops).toContainEqual({ speakerId: "alice", reason: "unsafe_rebind" });
    expect(f.finalizing).toHaveLength(0);
    await expect(
      f.host.router.settleCapture(firstCapture!, {
        ok: true,
        transcript: "late",
        audioMs: 1,
        capturedEndedUtc: "late",
        source: "live",
      })
    ).resolves.toMatchObject({ status: "ignored" });

    await setMuted(f, "alice", false, true, "session-2");
    await setMuted(f, "alice", true, false, "session-2");
    expect(f.host.router.getLane("alice")?.state).toBe("capturing");
    expect(f.factory).toHaveBeenCalledTimes(2);

    f.allowed.delete("alice");
    await f.host.refreshAllowedUsers();
    await f.host.idle();
    expect(f.host.router.getLane("alice")).toBeUndefined();
    expect(f.drops).toContainEqual({ speakerId: "alice", reason: "speaker_unauthorized" });
    await f.host.destroy();
  });

  it("keeps Input off at zero snapshots, subscriptions, STT clients, and bytes", async () => {
    const f = fixture({ inputActive: false });
    await setMuted(f, "alice", true, false);
    f.speaking.users.set("alice", 1);
    f.speaking.emit("start", "alice");
    await tick();
    expect(f.persistence.snapshotCapture).not.toHaveBeenCalled();
    expect(f.receiver.subscribe).not.toHaveBeenCalled();
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.host.router.forwardedBytes).toBe(0);
    await f.host.destroy();
  });

  it("borrows one shared voice connection for receive and playback ownership", async () => {
    const f = fixture();
    expect(f.host.sharedConnection).toBe(f.connection);

    await f.host.destroy();
    expect(f.connection.destroy).not.toHaveBeenCalled();
  });
});

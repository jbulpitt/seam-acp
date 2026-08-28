import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { OpusEncoder } from "@discordjs/opus";
import { AudioPlayerStatus } from "@discordjs/voice";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DiscordOpusDecoder,
  DiscordThreadVoiceCall,
  ThreadVoiceCaptureGate,
  ThreadVoicePlaybackQueue,
  pcm24kMonoTo48kStereo,
  pcm48kTo16kMono,
  type ThreadVoiceCaptureEnd,
  type ThreadVoiceCaptureRef,
} from "../packages/core/src/platforms/discord/thread-voice-call.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const silentLogger = {
  warn: vi.fn(),
} as unknown as Logger;

describe("ThreadVoiceCaptureGate", () => {
  it("uses owner self-mute edges and ignores non-owner or muted PCM", () => {
    const starts: ThreadVoiceCaptureRef[] = [];
    const pcmSequences: number[] = [];
    const ends: ThreadVoiceCaptureEnd[] = [];
    const sentMs: number[] = [];
    const gate = new ThreadVoiceCaptureGate({
      ownerUserId: "owner",
      minCaptureBytes: 640,
      maxCapturePartBytes: 6_400,
      callbacks: {
        onCaptureStart: (capture) => starts.push(capture),
        onPcm: (chunk) => pcmSequences.push(chunk.sequence),
        onCaptureEnd: (capture) => ends.push(capture),
        onForwardablePcm: (durationMs) => sentMs.push(durationMs),
      },
    });

    expect(gate.pushPcm("owner", Buffer.alloc(640, 1))).toBe(false);
    gate.setSelfMuted("intruder", false);
    expect(gate.capturing).toBe(false);

    gate.setSelfMuted("owner", false);
    expect(gate.capturing).toBe(true);
    expect(gate.pushPcm("intruder", Buffer.alloc(640, 1))).toBe(false);
    expect(gate.pushPcm("owner", Buffer.alloc(640, 1))).toBe(true);
    gate.setSelfMuted("intruder", true);
    expect(gate.capturing).toBe(true);
    gate.setSelfMuted("owner", true);

    expect(starts).toEqual([{ sequence: 1, part: 0 }]);
    expect(pcmSequences).toEqual([1]);
    expect(sentMs).toEqual([20]);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({
      sequence: 1,
      part: 0,
      durationMs: 20,
      reason: "mute",
      continuation: false,
      usable: true,
    });
    expect(ends[0]!.pcm16kMono.byteLength).toBe(640);
  });

  it("assigns capture order at unmute and marks sub-250ms captures unusable", () => {
    const starts: ThreadVoiceCaptureRef[] = [];
    const ends: ThreadVoiceCaptureEnd[] = [];
    const gate = new ThreadVoiceCaptureGate({
      ownerUserId: "owner",
      callbacks: {
        onCaptureStart: (capture) => starts.push(capture),
        onPcm: () => {},
        onCaptureEnd: (capture) => ends.push(capture),
      },
    });

    gate.setSelfMuted("owner", false);
    gate.pushPcm("owner", Buffer.alloc(7_998, 1));
    gate.setSelfMuted("owner", true);
    gate.setSelfMuted("owner", false);
    gate.pushPcm("owner", Buffer.alloc(8_000, 1));
    gate.setSelfMuted("owner", true);

    expect(starts.map((capture) => capture.sequence)).toEqual([1, 2]);
    expect(ends.map((capture) => capture.usable)).toEqual([false, true]);
  });

  it("bounds memory by rolling five-minute-style parts under one sequence", () => {
    const starts: ThreadVoiceCaptureRef[] = [];
    const ends: ThreadVoiceCaptureEnd[] = [];
    const gate = new ThreadVoiceCaptureGate({
      ownerUserId: "owner",
      allocateSequence: vi.fn(() => 4_207),
      minCaptureBytes: 2,
      maxCapturePartBytes: 1_280,
      callbacks: {
        onCaptureStart: (capture) => starts.push(capture),
        onPcm: () => {},
        onCaptureEnd: (capture) => ends.push(capture),
      },
    });

    gate.setSelfMuted("owner", false);
    gate.pushPcm("owner", Buffer.alloc(3_200, 1));
    gate.setSelfMuted("owner", true);

    expect(starts).toEqual([
      { sequence: 4_207, part: 0 },
      { sequence: 4_207, part: 1 },
      { sequence: 4_207, part: 2 },
    ]);
    expect(ends.map((capture) => capture.reason)).toEqual(["limit", "limit", "mute"]);
    expect(ends.map((capture) => capture.continuation)).toEqual([true, true, false]);
    expect(ends.map((capture) => capture.pcm16kMono.byteLength)).toEqual([
      1_280,
      1_280,
      640,
    ]);
  });

  it("allocates exactly once per unmute and retains that value across continuations", () => {
    const allocateSequence = vi
      .fn<() => number>()
      .mockReturnValueOnce(9_001)
      .mockReturnValueOnce(9_017);
    const starts: ThreadVoiceCaptureRef[] = [];
    const ends: ThreadVoiceCaptureEnd[] = [];
    const gate = new ThreadVoiceCaptureGate({
      ownerUserId: "owner",
      allocateSequence,
      minCaptureBytes: 2,
      maxCapturePartBytes: 640,
      callbacks: {
        onCaptureStart: (capture) => starts.push(capture),
        onPcm: () => {},
        onCaptureEnd: (capture) => ends.push(capture),
      },
    });

    gate.setSelfMuted("owner", false);
    gate.pushPcm("owner", Buffer.alloc(1_280, 1));
    gate.setSelfMuted("owner", true);
    gate.setSelfMuted("owner", false);
    gate.setSelfMuted("owner", true);

    expect(allocateSequence).toHaveBeenCalledTimes(2);
    expect(starts.map(({ sequence, part }) => ({ sequence, part }))).toEqual([
      { sequence: 9_001, part: 0 },
      { sequence: 9_001, part: 1 },
      { sequence: 9_001, part: 2 },
      { sequence: 9_017, part: 0 },
    ]);
    expect(ends.map(({ sequence, continuation }) => ({ sequence, continuation }))).toEqual([
      { sequence: 9_001, continuation: true },
      { sequence: 9_001, continuation: true },
      { sequence: 9_001, continuation: false },
      { sequence: 9_017, continuation: false },
    ]);
  });

  it("emits a terminal marker when mute follows an exact part boundary", () => {
    const ends: ThreadVoiceCaptureEnd[] = [];
    const gate = new ThreadVoiceCaptureGate({
      ownerUserId: "owner",
      allocateSequence: () => 73,
      minCaptureBytes: 2,
      maxCapturePartBytes: 640,
      callbacks: {
        onCaptureStart: () => {},
        onPcm: () => {},
        onCaptureEnd: (capture) => ends.push(capture),
      },
    });

    gate.setSelfMuted("owner", false);
    gate.pushPcm("owner", Buffer.alloc(640, 1));
    gate.setSelfMuted("owner", true);

    expect(ends).toHaveLength(2);
    expect(ends[0]).toMatchObject({
      sequence: 73,
      part: 0,
      reason: "limit",
      continuation: true,
      usable: true,
    });
    expect(ends[1]).toMatchObject({
      sequence: 73,
      part: 1,
      reason: "mute",
      continuation: false,
      usable: false,
    });
    expect(ends[1]!.pcm16kMono.byteLength).toBe(0);
  });

  it("deterministically drops an active capture on explicit stop", () => {
    const ends: ThreadVoiceCaptureEnd[] = [];
    const gate = new ThreadVoiceCaptureGate({
      ownerUserId: "owner",
      minCaptureBytes: 2,
      callbacks: {
        onCaptureStart: () => {},
        onPcm: () => {},
        onCaptureEnd: (capture) => ends.push(capture),
      },
    });
    gate.setSelfMuted("owner", false);
    gate.pushPcm("owner", Buffer.alloc(640, 1));
    gate.stop();
    gate.stop();
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ reason: "stop", usable: false });
    expect(gate.pushPcm("owner", Buffer.alloc(640, 1))).toBe(false);
  });
});

describe("Thread Voice codecs", () => {
  it("downmixes and decimates Discord 48k stereo PCM to 16k mono", () => {
    const pcm = Buffer.alloc(6 * 4);
    for (let frame = 0; frame < 6; frame++) {
      pcm.writeInt16LE(3_000, frame * 4);
      pcm.writeInt16LE(1_000, frame * 4 + 2);
    }
    const out = pcm48kTo16kMono(pcm, 2);
    expect(out.byteLength).toBe(4);
    expect(out.readInt16LE(0)).toBe(2_000);
    expect(out.readInt16LE(2)).toBe(2_000);
  });

  it("duplicates 24k mono samples into 48k stereo frames", () => {
    const pcm = Buffer.alloc(4);
    pcm.writeInt16LE(100, 0);
    pcm.writeInt16LE(-200, 2);
    const out = pcm24kMonoTo48kStereo(pcm);
    expect(out.byteLength).toBe(16);
    expect([...Array(4)].map((_, frame) => out.readInt16LE(frame * 4))).toEqual([
      100,
      100,
      -200,
      -200,
    ]);
    expect([...Array(4)].map((_, frame) => out.readInt16LE(frame * 4 + 2))).toEqual([
      100,
      100,
      -200,
      -200,
    ]);
  });

  it("decodes a real Discord Opus packet and converts it to 16k mono", () => {
    const encoder = new OpusEncoder(48_000, 2);
    const pcm48 = Buffer.alloc(960 * 4);
    for (let frame = 0; frame < 960; frame++) {
      const sample = Math.round(8_000 * Math.sin((2 * Math.PI * frame) / 96));
      pcm48.writeInt16LE(sample, frame * 4);
      pcm48.writeInt16LE(sample, frame * 4 + 2);
    }
    const decoded = new DiscordOpusDecoder().decode(encoder.encode(pcm48));
    expect(decoded).not.toBeNull();
    const pcm16 = pcm48kTo16kMono(decoded!.pcm48k, decoded!.channels);
    expect(pcm16.byteLength).toBe(640);
    expect(pcm16.some((byte) => byte !== 0)).toBe(true);
  });
});

describe("ThreadVoicePlaybackQueue", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reuses one player, preserves packet order, and resolves only after player idle", async () => {
    vi.useFakeTimers();
    const player = new EventEmitter() as EventEmitter & {
      state: { status: string };
      play: (resource: unknown) => void;
      stop: () => boolean;
    };
    player.state = { status: AudioPlayerStatus.Idle };
    player.stop = () => true;
    player.play = (resource: unknown) => {
      const oldState = player.state;
      player.state = { status: AudioPlayerStatus.Playing };
      player.emit("stateChange", oldState, player.state);
      (resource as EventEmitter).once("finish", () => {
        const playing = player.state;
        player.state = { status: AudioPlayerStatus.Idle };
        player.emit("stateChange", playing, player.state);
      });
    };

    const encodedSamples: number[] = [];
    const createPlayer = vi.fn(() => player);
    const unsubscribe = vi.fn();
    const connection = { subscribe: vi.fn(() => ({ unsubscribe })) };
    const queue = new ThreadVoicePlaybackQueue({
      connection: connection as never,
      logger: silentLogger,
      dependencies: {
        createPlayer: createPlayer as never,
        createResource: ((stream: EventEmitter) => stream) as never,
        createEncoder: () => ({
          decode: () => Buffer.alloc(0),
          encode: (pcm: Buffer) => {
            encodedSamples.push(pcm.readInt16LE(0));
            return Buffer.from([encodedSamples.length]);
          },
        }),
      },
    });

    const first = Buffer.alloc(960 * 2);
    first.writeInt16LE(111, 0);
    first.writeInt16LE(222, 960);
    queue.enqueue({ pcm: first, sampleRate: 24_000, channels: 1 });
    let idle = false;
    const waiting = queue.waitForIdle().then(() => {
      idle = true;
    });
    expect(idle).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    await waiting;
    expect(encodedSamples).toEqual([111, 222]);
    expect(createPlayer).toHaveBeenCalledTimes(1);
    expect(connection.subscribe).toHaveBeenCalledTimes(1);

    const second = Buffer.alloc(960);
    second.writeInt16LE(333, 0);
    queue.enqueue({ pcm: second, sampleRate: 24_000, channels: 1 });
    const waitingAgain = queue.waitForIdle();
    await vi.advanceTimersByTimeAsync(30);
    await waitingAgain;
    expect(encodedSamples).toEqual([111, 222, 333]);
    expect(createPlayer).toHaveBeenCalledTimes(1);
    queue.destroy();
    queue.destroy();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("pads a final sub-frame tail before reporting idle", async () => {
    vi.useFakeTimers();
    const player = new EventEmitter() as any;
    player.state = { status: AudioPlayerStatus.Idle };
    player.stop = () => true;
    player.play = (resource: EventEmitter) => {
      player.state = { status: AudioPlayerStatus.Playing };
      resource.once("finish", () => {
        const old = player.state;
        player.state = { status: AudioPlayerStatus.Idle };
        player.emit("stateChange", old, player.state);
      });
    };
    const encodedLengths: number[] = [];
    const queue = new ThreadVoicePlaybackQueue({
      connection: { subscribe: () => ({}) } as never,
      logger: silentLogger,
      dependencies: {
        createPlayer: (() => player) as never,
        createResource: ((stream: EventEmitter) => stream) as never,
        createEncoder: () => ({
          decode: () => Buffer.alloc(0),
          encode: (pcm: Buffer) => {
            encodedLengths.push(pcm.byteLength);
            return Buffer.from([1]);
          },
        }),
      },
    });
    queue.enqueue({ pcm: Buffer.alloc(100), sampleRate: 24_000, channels: 1 });
    const waiting = queue.waitForIdle();
    await vi.advanceTimersByTimeAsync(30);
    await waiting;
    expect(encodedLengths).toEqual([3_840]);
    queue.destroy();
  });

  it("force-stops current and queued PCM, settles waiters, and remains reusable", async () => {
    vi.useFakeTimers();
    const player = new EventEmitter() as any;
    player.state = { status: AudioPlayerStatus.Idle };
    player.play = (resource: EventEmitter) => {
      const old = player.state;
      player.state = { status: AudioPlayerStatus.Playing };
      player.emit("stateChange", old, player.state);
      resource.once("finish", () => {
        const playing = player.state;
        player.state = { status: AudioPlayerStatus.Idle };
        player.emit("stateChange", playing, player.state);
      });
    };
    player.stop = vi.fn(() => {
      const old = player.state;
      player.state = { status: AudioPlayerStatus.Idle };
      player.emit("stateChange", old, player.state);
      return true;
    });
    const encodedSamples: number[] = [];
    const queue = new ThreadVoicePlaybackQueue({
      connection: { subscribe: () => ({}) } as never,
      logger: silentLogger,
      dependencies: {
        createPlayer: (() => player) as never,
        createResource: ((stream: EventEmitter) => stream) as never,
        createEncoder: () => ({
          decode: () => Buffer.alloc(0),
          encode: (pcm: Buffer) => {
            encodedSamples.push(pcm.readInt16LE(0));
            return Buffer.from([encodedSamples.length]);
          },
        }),
      },
    });

    const interrupted = Buffer.alloc(960 * 2);
    interrupted.writeInt16LE(101, 0);
    interrupted.writeInt16LE(202, 960);
    queue.enqueue({ pcm: interrupted, sampleRate: 24_000, channels: 1 });
    const waiting = queue.waitForIdle();
    await vi.advanceTimersByTimeAsync(1);
    queue.stopAndClear();
    await expect(waiting).resolves.toBeUndefined();
    const countAfterStop = encodedSamples.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(encodedSamples).toHaveLength(countAfterStop);

    const later = Buffer.alloc(960);
    later.writeInt16LE(303, 0);
    queue.enqueue({ pcm: later, sampleRate: 24_000, channels: 1 });
    const reused = queue.waitForIdle();
    await vi.advanceTimersByTimeAsync(30);
    await reused;
    expect(encodedSamples.at(-1)).toBe(303);
    expect(player.stop).toHaveBeenCalled();
    queue.destroy();
  });
});

describe("DiscordThreadVoiceCall lifecycle", () => {
  it("removes listeners, destroys media once, and settles done on abort", async () => {
    const ownerUserId = "owner";
    const voiceChannelId = "voice";
    const guildId = "guild";
    const speaking = new EventEmitter() as EventEmitter & { users: Map<string, number> };
    speaking.users = new Map();
    const subscriptions = new Map<string, PassThrough>();
    const receiver = {
      speaking,
      subscriptions,
      subscribe: vi.fn((userId: string) => {
        const stream = new PassThrough({ objectMode: true });
        subscriptions.set(userId, stream);
        return stream;
      }),
    };
    const connection = new EventEmitter() as any;
    connection.receiver = receiver;
    const unsubscribe = vi.fn();
    connection.subscribe = vi.fn(() => ({ unsubscribe }));
    connection.destroy = vi.fn();

    const ownerState = { channelId: voiceChannelId, selfMute: true };
    const channel = {
      id: voiceChannelId,
      isVoiceBased: () => true,
      guild: {
        id: guildId,
        voiceAdapterCreator: {},
        voiceStates: { cache: new Map([[ownerUserId, ownerState]]) },
      },
    };
    const client = new EventEmitter() as any;
    client.channels = { fetch: vi.fn(async () => channel) };
    client.user = { id: "bot" };

    const player = new EventEmitter() as any;
    player.state = { status: AudioPlayerStatus.Idle };
    player.play = vi.fn();
    player.stop = vi.fn(() => true);
    const controller = new AbortController();
    const states: string[] = [];
    const captureStarts = vi.fn();
    const capturePcm = vi.fn();
    const captureEnds = vi.fn();
    const call = await DiscordThreadVoiceCall.connect({
      client,
      guildId,
      voiceChannelId,
      ownerUserId,
      signal: controller.signal,
      logger: silentLogger,
      callbacks: {
        onCaptureStart: captureStarts,
        onPcm: capturePcm,
        onCaptureEnd: captureEnds,
        onState: (state) => states.push(state),
      },
      dependencies: {
        getExistingVoiceConnection: () => undefined,
        join: () => connection,
        waitUntilReady: async () => {},
        playback: {
          createPlayer: (() => player) as never,
          createResource: ((stream: EventEmitter) => stream) as never,
          createEncoder: () => ({
            decode: () => Buffer.alloc(0),
            encode: () => Buffer.from([1]),
          }),
        },
      },
    });

    expect(states).toEqual(["ready"]);
    expect(client.listenerCount("voiceStateUpdate")).toBe(1);
    expect(speaking.listenerCount("start")).toBe(1);

    const mutedState = { id: ownerUserId, channelId: voiceChannelId, selfMute: true };
    const unmutedState = { id: ownerUserId, channelId: voiceChannelId, selfMute: false };
    client.emit("voiceStateUpdate", mutedState, unmutedState);
    speaking.emit("start", "intruder");
    expect(receiver.subscribe).not.toHaveBeenCalled();
    speaking.emit("start", ownerUserId);
    expect(receiver.subscribe).toHaveBeenCalledTimes(1);
    expect(receiver.subscribe).toHaveBeenCalledWith(ownerUserId, expect.anything());

    const encoder = new OpusEncoder(48_000, 2);
    const pcm48 = Buffer.alloc(960 * 4, 1);
    subscriptions.get(ownerUserId)!.write(encoder.encode(pcm48));
    client.emit("voiceStateUpdate", unmutedState, mutedState);
    expect(captureStarts).toHaveBeenCalledWith({ sequence: 1, part: 0 });
    expect(capturePcm).toHaveBeenCalledTimes(1);
    expect(captureEnds).toHaveBeenCalledWith(
      expect.objectContaining({ sequence: 1, part: 0, reason: "mute", usable: false })
    );

    controller.abort();
    await expect(call.done).resolves.toEqual({ reason: "cancelled" });
    await call.destroy("second-cleanup");

    expect(states).toEqual(["ready", "capturing", "ready", "ended"]);
    expect(client.listenerCount("voiceStateUpdate")).toBe(0);
    expect(speaking.listenerCount("start")).toBe(0);
    expect(speaking.listenerCount("end")).toBe(0);
    expect(connection.destroy).toHaveBeenCalledTimes(1);
    expect(player.stop).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

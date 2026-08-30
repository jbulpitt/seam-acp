import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { VoiceConsolePcmQueue } from "../packages/core/src/platforms/discord/voice-console-playback.js";
import { DiscordVoiceConsolePlayback } from "../packages/core/src/platforms/discord/voice-console-playback.js";
import type { VoiceConsoleSpeechChunk } from "../packages/core/src/core/voice-console/speech-types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function chunk(bindingId: string, ordinal: number): VoiceConsoleSpeechChunk {
  return {
    consoleId: "console-1",
    bindingId,
    turnId: `turn-${bindingId}`,
    ordinal,
    generation: 0,
    text: `${bindingId}-${ordinal}`,
  };
}

function audio20ms() {
  return {
    pcm: new Uint8Array(960),
    sampleRate: 24_000,
    channels: 1,
  };
}

function controlledQueue(): {
  queue: VoiceConsolePcmQueue;
  releaseIdle(): void;
} {
  let idle = deferred<void>();
  const queue: VoiceConsolePcmQueue = {
    enqueue: vi.fn(),
    waitForIdle: vi.fn(() => idle.promise),
    stopAndClear: vi.fn(() => {
      idle.resolve();
      idle = deferred<void>();
    }),
    destroy: vi.fn(() => idle.resolve()),
  };
  return {
    queue,
    releaseIdle: () => {
      idle.resolve();
      idle = deferred<void>();
    },
  };
}

describe("DiscordVoiceConsolePlayback", () => {
  it("keeps one producer open, preserves delta order, and drains only after EOF", async () => {
    const idle = deferred<void>();
    const calls: string[] = [];
    const queue: VoiceConsolePcmQueue = {
      beginStreaming: vi.fn(() => { calls.push("begin"); }),
      enqueue: vi.fn((pcm) => { calls.push(`pcm:${pcm.pcm[0]}`); }),
      endStreaming: vi.fn(() => { calls.push("end"); }),
      waitForIdle: vi.fn(() => idle.promise),
      stopAndClear: vi.fn(() => idle.resolve()),
      destroy: vi.fn(() => idle.resolve()),
    };
    const playback = new DiscordVoiceConsolePlayback({ queue });
    const stream = playback.beginStream({
      chunk: chunk("A", 1),
      signal: new AbortController().signal,
    });
    await stream.enqueue({ ...audio20ms(), pcm: new Uint8Array([1, 0]) });
    await stream.enqueue({ ...audio20ms(), pcm: new Uint8Array([2, 0]) });
    expect(calls).toEqual(["begin", "pcm:1", "pcm:2"]);

    const finished = stream.finish();
    expect(calls).toEqual(["begin", "pcm:1", "pcm:2", "end"]);
    let settled = false;
    void finished.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    idle.resolve();
    await expect(finished).resolves.toEqual({
      status: "played",
      durationMs: 1 / 12,
    });
    expect(playback.currentSource()).toBeNull();
  });

  it("backpressures a streaming producer above the bounded audio high-water mark", async () => {
    const capacity = deferred<void>();
    const queue: VoiceConsolePcmQueue = {
      beginStreaming: vi.fn(),
      enqueue: vi.fn(),
      endStreaming: vi.fn(),
      bufferedAudioMs: vi.fn(() => 2_500),
      waitForBufferedAudioBelow: vi.fn(() => capacity.promise),
      waitForIdle: vi.fn(async () => {}),
      stopAndClear: vi.fn(() => capacity.resolve()),
      destroy: vi.fn(() => capacity.resolve()),
    };
    const playback = new DiscordVoiceConsolePlayback({ queue });
    const stream = playback.beginStream({
      chunk: chunk("A", 1),
      signal: new AbortController().signal,
    });
    let accepted = false;
    const enqueue = stream.enqueue(audio20ms()).then(() => { accepted = true; });
    await vi.waitFor(() => expect(queue.waitForBufferedAudioBelow).toHaveBeenCalledWith(1_000));
    expect(accepted).toBe(false);
    capacity.resolve();
    await enqueue;
    await stream.finish();
  });

  it("slices a large provider delta before enqueue so backpressure stays bounded", async () => {
    let bufferedMs = 0;
    const waits: number[] = [];
    const queue: VoiceConsolePcmQueue = {
      beginStreaming: vi.fn(),
      enqueue: vi.fn((audio) => {
        bufferedMs += (audio.pcm.byteLength / (audio.sampleRate * audio.channels * 2)) * 1_000;
      }),
      endStreaming: vi.fn(),
      bufferedAudioMs: vi.fn(() => bufferedMs),
      waitForBufferedAudioBelow: vi.fn(async (limit) => {
        waits.push(limit);
        bufferedMs = 0;
      }),
      waitForIdle: vi.fn(async () => {}),
      stopAndClear: vi.fn(),
      destroy: vi.fn(),
    };
    const playback = new DiscordVoiceConsolePlayback({ queue });
    const stream = playback.beginStream({
      chunk: chunk("A", 1),
      signal: new AbortController().signal,
    });
    await stream.enqueue({
      pcm: new Uint8Array(24_000 * 2 * 5),
      sampleRate: 24_000,
      channels: 1,
    });
    const enqueued = vi.mocked(queue.enqueue).mock.calls.map(([audio]) => audio.pcm.byteLength);
    expect(enqueued).toHaveLength(25);
    expect(Math.max(...enqueued)).toBe(9_600);
    expect(waits).toEqual([1_000, 1_000]);
    await expect(stream.finish()).resolves.toEqual({ status: "played", durationMs: 5_000 });
  });

  it("cancels promptly while a streaming enqueue is blocked on backpressure", async () => {
    const capacity = deferred<void>();
    let consumedMs = 0;
    const queue: VoiceConsolePcmQueue = {
      beginStreaming: vi.fn(),
      enqueue: vi.fn(() => { consumedMs = 20; }),
      endStreaming: vi.fn(),
      bufferedAudioMs: vi.fn(() => 2_500),
      consumedAudioMs: vi.fn(() => consumedMs),
      waitForBufferedAudioBelow: vi.fn(() => capacity.promise),
      waitForIdle: vi.fn(async () => {}),
      stopAndClear: vi.fn(() => capacity.resolve()),
      destroy: vi.fn(() => capacity.resolve()),
    };
    const playback = new DiscordVoiceConsolePlayback({ queue });
    const controller = new AbortController();
    const stream = playback.beginStream({ chunk: chunk("A", 1), signal: controller.signal });
    const enqueue = stream.enqueue(audio20ms());
    await vi.waitFor(() => expect(queue.waitForBufferedAudioBelow).toHaveBeenCalledOnce());
    controller.abort();
    await expect(enqueue).rejects.toMatchObject({ name: "AbortError" });
    await expect(stream.finish()).resolves.toEqual({ status: "cancelled", durationMs: 20 });
    expect(queue.stopAndClear).toHaveBeenCalledOnce();
  });

  it("cancels incremental playback and clears accepted deltas exactly once", async () => {
    const { queue } = controlledQueue();
    queue.beginStreaming = vi.fn();
    queue.endStreaming = vi.fn();
    const playback = new DiscordVoiceConsolePlayback({ queue });
    const controller = new AbortController();
    const stream = playback.beginStream({ chunk: chunk("A", 1), signal: controller.signal });
    await stream.enqueue(audio20ms());
    controller.abort();
    controller.abort();
    await expect(stream.finish()).resolves.toEqual({ status: "cancelled", durationMs: 0 });
    expect(queue.stopAndClear).toHaveBeenCalledTimes(1);
    expect(playback.currentSource()).toBeNull();
  });

  it("builds its reusable player on an injected already-joined connection", () => {
    const player = new EventEmitter() as EventEmitter & {
      state: { status: string };
      stop: ReturnType<typeof vi.fn>;
    };
    player.state = { status: "idle" };
    player.stop = vi.fn(() => true);
    const unsubscribe = vi.fn();
    const connection = { subscribe: vi.fn(() => ({ unsubscribe })) };
    const playback = new DiscordVoiceConsolePlayback({
      connection,
      logger: { warn: vi.fn() } as never,
      dependencies: {
        createPlayer: (() => player) as never,
        createResource: ((stream: EventEmitter) => stream) as never,
        createEncoder: () => ({
          decode: () => Buffer.alloc(0),
          encode: () => Buffer.from([1]),
        }),
      },
    });

    expect(connection.subscribe).toHaveBeenCalledTimes(1);
    playback.destroy();
    playback.destroy();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("reports an injected Discord player error instead of marking audio played", async () => {
    const player = new EventEmitter() as EventEmitter & {
      state: { status: string };
      play: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
    };
    player.state = { status: "idle" };
    player.stop = vi.fn(() => true);
    player.play = vi.fn(() => {
      queueMicrotask(() => player.emit("error", new Error("discord player failed")));
    });
    const playback = new DiscordVoiceConsolePlayback({
      connection: { subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })) },
      logger: { warn: vi.fn() } as never,
      dependencies: {
        createPlayer: (() => player) as never,
        createResource: ((stream: EventEmitter) => stream) as never,
        createEncoder: () => ({
          decode: () => Buffer.alloc(0),
          encode: () => Buffer.from([1]),
        }),
      },
    });

    await expect(playback.play({
      chunk: chunk("A", 1),
      audio: audio20ms(),
      signal: new AbortController().signal,
    })).resolves.toEqual({
      status: "failed",
      durationMs: 20,
      error: "discord player failed",
    });
    playback.destroy();
  });

  it("stops the current source promptly when playback is cancelled", async () => {
    const { queue } = controlledQueue();
    const playback = new DiscordVoiceConsolePlayback({ queue });
    const controller = new AbortController();
    const playing = playback.play({
      chunk: chunk("A", 1),
      audio: audio20ms(),
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(queue.waitForIdle).toHaveBeenCalledTimes(1));
    expect(playback.currentSource()).toEqual({
      consoleId: "console-1",
      bindingId: "A",
      turnId: "turn-A",
    });

    controller.abort();

    await expect(playing).resolves.toEqual({ status: "cancelled", durationMs: 0 });
    expect(queue.stopAndClear).toHaveBeenCalledTimes(1);
    expect(playback.currentSource()).toBeNull();
  });

  it("reuses one persistent queue across sources and reports PCM duration", async () => {
    const { queue, releaseIdle } = controlledQueue();
    const playback = new DiscordVoiceConsolePlayback({ queue });
    const firstController = new AbortController();
    const first = playback.play({
      chunk: chunk("A", 1),
      audio: audio20ms(),
      signal: firstController.signal,
    });
    await vi.waitFor(() => expect(queue.enqueue).toHaveBeenCalledTimes(1));
    releaseIdle();
    await expect(first).resolves.toEqual({ status: "played", durationMs: 20 });

    const second = playback.play({
      chunk: chunk("B", 1),
      audio: audio20ms(),
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(queue.enqueue).toHaveBeenCalledTimes(2));
    releaseIdle();
    await expect(second).resolves.toEqual({ status: "played", durationMs: 20 });

    expect(queue.enqueue).toHaveBeenNthCalledWith(1, audio20ms());
    expect(queue.enqueue).toHaveBeenNthCalledWith(2, audio20ms());
    expect(queue.stopAndClear).not.toHaveBeenCalled();
  });

  it("rejects concurrent callers because the scheduler owns serialization", async () => {
    const { queue, releaseIdle } = controlledQueue();
    const playback = new DiscordVoiceConsolePlayback({ queue });
    const first = playback.play({
      chunk: chunk("A", 1),
      audio: audio20ms(),
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(queue.waitForIdle).toHaveBeenCalledTimes(1));

    await expect(playback.play({
      chunk: chunk("B", 1),
      audio: audio20ms(),
      signal: new AbortController().signal,
    })).rejects.toThrow("already has an active chunk");

    releaseIdle();
    await first;
  });

  it("destroys the reusable queue once and settles active playback as cancelled", async () => {
    const { queue } = controlledQueue();
    const playback = new DiscordVoiceConsolePlayback({ queue });
    const playing = playback.play({
      chunk: chunk("A", 1),
      audio: audio20ms(),
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(queue.waitForIdle).toHaveBeenCalledTimes(1));

    playback.destroy();
    playback.destroy();

    await expect(playing).resolves.toEqual({ status: "cancelled", durationMs: 0 });
    expect(queue.destroy).toHaveBeenCalledTimes(1);
    expect(playback.currentSource()).toBeNull();
    await expect(playback.play({
      chunk: chunk("B", 1),
      audio: audio20ms(),
      signal: new AbortController().signal,
    })).resolves.toEqual({ status: "cancelled", durationMs: 0 });
  });
});

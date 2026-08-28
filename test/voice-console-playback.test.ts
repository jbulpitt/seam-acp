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
      durationMs: 0,
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

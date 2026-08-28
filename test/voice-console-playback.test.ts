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

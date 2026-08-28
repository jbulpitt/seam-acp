import { describe, expect, it, vi } from "vitest";
import {
  ThreadVoiceSpeechPipeline,
  shouldAttachCompletedTurnVoice,
} from "../packages/core/src/platforms/discord/thread-voice-speech.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("ThreadVoiceSpeechPipeline", () => {
  it("suppresses the completed-turn voice attachment whenever live VC speech owns output", () => {
    expect(shouldAttachCompletedTurnVoice(true)).toBe(false);
    expect(shouldAttachCompletedTurnVoice(false)).toBe(true);
  });
  it("synthesizes/enqueues progressively in order and gates completion on playback drain", async () => {
    const playback = deferred<void>();
    const spoken: number[] = [];
    const synthesize = vi.fn(async (text: string) => ({
      ok: true as const,
      audio: { pcm: new Uint8Array([text.includes("first") ? 1 : 2]), sampleRate: 24_000, channels: 1 },
    }));
    const pipeline = new ThreadVoiceSpeechPipeline({
      synthesize,
      speak: vi.fn(async (pcm) => { spoken.push(pcm.pcm[0]!); }),
      waitForPlaybackIdle: () => playback.promise,
    });
    pipeline.feed("This first sentence is deliberately long enough to cross the minimum speech segment size and play now. ");
    await vi.waitFor(() => expect(spoken).toEqual([1]));
    pipeline.feed("This second sentence is also deliberately long enough to become another ordered speech chunk. ");
    const drained = pipeline.flushAndDrain();
    await vi.waitFor(() => expect(spoken).toEqual([1, 2]));
    let settled = false;
    void drained.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    playback.resolve();
    await expect(drained).resolves.toEqual({ chunks: 2, played: 2 });
  });

  it("keeps later chunks and text success when one synthesis request fails", async () => {
    const failures: string[] = [];
    const spoken: number[] = [];
    let attempt = 0;
    const pipeline = new ThreadVoiceSpeechPipeline({
      synthesize: vi.fn(async () => {
        attempt += 1;
        return attempt === 1
          ? { ok: false as const, error: "quota blip" }
          : { ok: true as const, audio: { pcm: new Uint8Array([2]), sampleRate: 24_000, channels: 1 } };
      }),
      speak: vi.fn(async (pcm) => { spoken.push(pcm.pcm[0]!); }),
      waitForPlaybackIdle: vi.fn(async () => {}),
      onFailure: (error) => failures.push(error),
    });
    pipeline.feed("This first sentence is deliberately long enough to cross the minimum and fail synthesis once. ");
    pipeline.feed("This second sentence is deliberately long enough to synthesize successfully after that failure. ");
    await expect(pipeline.flushAndDrain()).resolves.toEqual({ chunks: 2, played: 1 });
    expect(failures).toEqual(["quota blip"]);
    expect(spoken).toEqual([2]);
  });

  it("cancels in-flight synthesis and suppresses every queued playback chunk", async () => {
    const firstSynthesis = deferred<{
      ok: true;
      audio: { pcm: Uint8Array; sampleRate: number; channels: number };
    }>();
    const synthesize = vi.fn(() => firstSynthesis.promise);
    const speak = vi.fn(async () => {});
    const waitForPlaybackIdle = vi.fn(async () => {});
    const pipeline = new ThreadVoiceSpeechPipeline({
      synthesize,
      speak,
      waitForPlaybackIdle,
    });
    pipeline.feed("This first sentence is deliberately long enough to begin synthesis before force cancellation. ");
    pipeline.feed("This second sentence is deliberately long enough to be queued behind the first one. ");
    await vi.waitFor(() => expect(synthesize).toHaveBeenCalledOnce());

    pipeline.cancel();
    firstSynthesis.resolve({
      ok: true,
      audio: { pcm: new Uint8Array([1]), sampleRate: 24_000, channels: 1 },
    });

    await expect(pipeline.flushAndDrain()).resolves.toEqual({ chunks: 2, played: 0 });
    expect(synthesize).toHaveBeenCalledOnce();
    expect(speak).not.toHaveBeenCalled();
    expect(waitForPlaybackIdle).toHaveBeenCalledOnce();
  });

  it("shares one terminal settlement across success, catch, and finally callers", async () => {
    const playback = deferred<void>();
    const waitForPlaybackIdle = vi.fn(() => playback.promise);
    const pipeline = new ThreadVoiceSpeechPipeline({
      synthesize: vi.fn(async () => ({
        ok: true as const,
        audio: { pcm: new Uint8Array([1]), sampleRate: 24_000, channels: 1 },
      })),
      speak: vi.fn(async () => {}),
      waitForPlaybackIdle,
    });
    pipeline.feed("This sentence is deliberately long enough to become a complete progressive speech chunk. ");

    const fromSuccess = pipeline.flushAndDrain();
    const fromCatch = pipeline.flushAndDrain();
    const fromFinally = pipeline.flushAndDrain();
    playback.resolve();

    await expect(Promise.all([fromSuccess, fromCatch, fromFinally])).resolves.toEqual([
      { chunks: 1, played: 1 },
      { chunks: 1, played: 1 },
      { chunks: 1, played: 1 },
    ]);
    expect(waitForPlaybackIdle).toHaveBeenCalledOnce();
  });
});

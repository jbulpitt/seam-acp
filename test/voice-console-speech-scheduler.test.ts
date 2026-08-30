import { describe, expect, it, vi } from "vitest";
import { VoiceConsoleSpeechScheduler } from "../packages/core/src/core/voice-console/speech-scheduler.js";
import type {
  VoiceConsolePlaybackRequest,
  VoiceConsoleSpeechChunk,
  VoiceConsoleSpeechPlayback,
  VoiceConsoleSpeechProfile,
  VoiceConsoleSpeechStateChange,
  VoiceConsoleSpeechSourceRef,
  VoiceConsoleSynthesisRequest,
  VoiceConsoleSynthesisResult,
} from "../packages/core/src/core/voice-console/speech-types.js";

const consoleId = "console-1";
const profileA: VoiceConsoleSpeechProfile = {
  voice: "Kore",
  pace: "natural",
  style: "clear",
};
const profileB: VoiceConsoleSpeechProfile = {
  voice: "Puck",
  pace: "fast",
  style: "warm",
};

function source(bindingId: string, turnId = `turn-${bindingId}`): VoiceConsoleSpeechSourceRef {
  return { consoleId, bindingId, turnId };
}

function chunk(
  ref: VoiceConsoleSpeechSourceRef,
  ordinal: number,
  generation = 0,
  text = `${ref.bindingId}-${ordinal}`
): VoiceConsoleSpeechChunk {
  return { ...ref, ordinal, generation, text };
}

function audio(marker = 1): { pcm: Uint8Array; sampleRate: number; channels: number } {
  return { pcm: new Uint8Array([marker, 0]), sampleRate: 24_000, channels: 1 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index++) await Promise.resolve();
}

function setup(opts: {
  synthesize?: (request: VoiceConsoleSynthesisRequest) => Promise<VoiceConsoleSynthesisResult>;
  playback?: VoiceConsoleSpeechPlayback;
} = {}) {
  const played: string[] = [];
  const playback = opts.playback ?? {
    play: vi.fn(async ({ chunk: item }: VoiceConsolePlaybackRequest) => {
      played.push(item.text);
      return { status: "played" as const, durationMs: 1_000 };
    }),
    destroy: vi.fn(),
  };
  const synthesize = opts.synthesize ?? vi.fn(async ({ chunk: item }) => ({
    ok: true as const,
    audio: audio(item.ordinal),
  }));
  const failures: unknown[] = [];
  const scheduler = new VoiceConsoleSpeechScheduler({
    consoleId,
    synthesize,
    playback,
    onFailure: (failure) => failures.push(failure),
  });
  scheduler.registerBinding({ bindingId: "A", profile: profileA, outputEnabled: true });
  scheduler.registerBinding({ bindingId: "B", profile: profileB, outputEnabled: true });
  return { scheduler, synthesize, playback, played, failures };
}

describe("VoiceConsoleSpeechScheduler fairness", () => {
  it("starts incremental PCM playback before the synthesis response reaches EOF", async () => {
    const eof = deferred<VoiceConsoleSynthesisResult>();
    const pcmOrder: number[] = [];
    let finishCalled = false;
    const playback: VoiceConsoleSpeechPlayback = {
      play: vi.fn(async () => ({ status: "played", durationMs: 1_000 })),
      beginStream: vi.fn(() => ({
        enqueue: vi.fn(async (pcm) => { pcmOrder.push(pcm.pcm[0]!); }),
        finish: vi.fn(async () => {
          finishCalled = true;
          return { status: "played" as const, durationMs: 40 };
        }),
        cancel: vi.fn(),
      })),
      destroy: vi.fn(),
    };
    const synthesize = vi.fn(async (request: VoiceConsoleSynthesisRequest) => {
      await request.onAudioDelta(audio(1));
      await request.onAudioDelta(audio(2));
      return eof.promise;
    });
    const { scheduler } = setup({ synthesize, playback });
    const a = source("A", "turn-streaming-eof");
    scheduler.registerSource(a);
    scheduler.enqueueChunk(chunk(a, 1));
    const drained = scheduler.finishSource(a);

    await vi.waitFor(() => expect(pcmOrder).toEqual([1, 2]));
    expect(finishCalled).toBe(false);
    expect(playback.play).not.toHaveBeenCalled();
    eof.resolve({ ok: true, streamed: true, audioDeltas: 2 });
    await expect(drained).resolves.toMatchObject({ played: 1, failed: 0, dropped: 0 });
    expect(finishCalled).toBe(true);
  });

  it("uses one synthesis slot, preserves source order, and rotates after two chunks", async () => {
    let activeSynthesis = 0;
    let maxActiveSynthesis = 0;
    const profiles: string[] = [];
    const { scheduler, played } = setup({
      synthesize: vi.fn(async (request) => {
        activeSynthesis += 1;
        maxActiveSynthesis = Math.max(maxActiveSynthesis, activeSynthesis);
        profiles.push(`${request.chunk.bindingId}:${request.profile.voice}:${request.profile.pace}:${request.profile.style}`);
        await Promise.resolve();
        activeSynthesis -= 1;
        return { ok: true, audio: audio(request.chunk.ordinal) };
      }),
    });
    const a = source("A");
    const b = source("B");
    scheduler.registerSource(a);
    scheduler.registerSource(b);
    for (let ordinal = 1; ordinal <= 3; ordinal++) {
      expect(scheduler.enqueueChunk(chunk(a, ordinal))).toBe("accepted");
      expect(scheduler.enqueueChunk(chunk(b, ordinal))).toBe("accepted");
    }

    const drainedA = scheduler.finishSource(a);
    const drainedB = scheduler.finishSource(b);
    await Promise.all([drainedA, drainedB]);

    expect(played).toEqual(["A-1", "A-2", "B-1", "B-2", "A-3", "B-3"]);
    expect(maxActiveSynthesis).toBe(1);
    expect(profiles).toEqual([
      "A:Kore:natural:clear",
      "A:Kore:natural:clear",
      "B:Puck:fast:warm",
      "B:Puck:fast:warm",
      "A:Kore:natural:clear",
      "B:Puck:fast:warm",
    ]);
  });

  it("rotates after one chunk whose completed audio exceeds 25 seconds", async () => {
    const played: string[] = [];
    const playback: VoiceConsoleSpeechPlayback = {
      play: vi.fn(async ({ chunk: item }) => {
        played.push(item.text);
        return {
          status: "played",
          durationMs: item.text === "A-1" ? 26_000 : 1_000,
        };
      }),
      destroy: vi.fn(),
    };
    const { scheduler } = setup({ playback });
    const a = source("A");
    const b = source("B");
    scheduler.registerSource(a);
    scheduler.registerSource(b);
    scheduler.enqueueChunk(chunk(a, 1));
    scheduler.enqueueChunk(chunk(a, 2));
    scheduler.enqueueChunk(chunk(b, 1));
    await Promise.all([scheduler.finishSource(a), scheduler.finishSource(b)]);
    expect(played).toEqual(["A-1", "B-1", "A-2"]);
  });

  it.each(["failed", "cancelled"] as const)(
    "charges midstream %s airtime to the current fairness slice",
    async (terminalStatus) => {
      const attempted: string[] = [];
      const playback: VoiceConsoleSpeechPlayback = {
        play: vi.fn(async ({ chunk: item }) => {
          attempted.push(item.text);
          if (item.text === "A-1") {
            return terminalStatus === "failed"
              ? { status: "failed" as const, durationMs: 26_000, error: "midstream player error" }
              : { status: "cancelled" as const, durationMs: 26_000 };
          }
          return { status: "played" as const, durationMs: 1_000 };
        }),
        destroy: vi.fn(),
      };
      const { scheduler } = setup({ playback });
      const a = source("A", `turn-fair-${terminalStatus}`);
      const b = source("B", `turn-fair-peer-${terminalStatus}`);
      scheduler.registerSource(a);
      scheduler.registerSource(b);
      scheduler.enqueueChunk(chunk(a, 1));
      scheduler.enqueueChunk(chunk(a, 2));
      scheduler.enqueueChunk(chunk(b, 1));

      await Promise.all([scheduler.finishSource(a), scheduler.finishSource(b)]);
      expect(attempted).toEqual(["A-1", "B-1", "A-2"]);
    }
  );

  it("does not rotate away when no competing source is ready", async () => {
    const { scheduler, played } = setup();
    const a = source("A");
    scheduler.registerSource(a);
    for (let ordinal = 1; ordinal <= 4; ordinal++) {
      scheduler.enqueueChunk(chunk(a, ordinal));
    }
    await scheduler.finishSource(a);
    expect(played).toEqual(["A-1", "A-2", "A-3", "A-4"]);
  });
});

describe("VoiceConsoleSpeechScheduler cancellation and generations", () => {
  it("fences late streaming deltas when output generation is cancelled", async () => {
    let synthesisSignal: AbortSignal | undefined;
    const streamCancel = vi.fn();
    const streamedPcm: number[] = [];
    const playback: VoiceConsoleSpeechPlayback = {
      play: vi.fn(async () => ({ status: "played", durationMs: 1_000 })),
      beginStream: vi.fn(({ signal }) => ({
        enqueue: vi.fn(async (pcm) => { streamedPcm.push(pcm.pcm[0]!); }),
        finish: vi.fn(async () => ({
          status: signal.aborted ? "cancelled" as const : "played" as const,
          durationMs: 0,
        })),
        cancel: streamCancel,
      })),
      destroy: vi.fn(),
    };
    const synthesize = vi.fn(async (request: VoiceConsoleSynthesisRequest) => {
      synthesisSignal = request.signal;
      await request.onAudioDelta(audio(7));
      return new Promise<VoiceConsoleSynthesisResult>((resolve) => {
        request.signal.addEventListener(
          "abort",
          () => resolve({ ok: false, error: "TTS cancelled" }),
          { once: true }
        );
      });
    });
    const { scheduler, failures } = setup({ synthesize, playback });
    const a = source("A", "turn-stream-cancel");
    scheduler.registerSource(a);
    scheduler.enqueueChunk(chunk(a, 1));
    const drained = scheduler.finishSource(a);
    await vi.waitFor(() => expect(streamedPcm).toEqual([7]));

    expect(scheduler.setOutputEnabled("A", false)).toBe(1);
    expect(synthesisSignal?.aborted).toBe(true);
    await expect(drained).resolves.toMatchObject({ played: 0, failed: 0, dropped: 1 });
    expect(streamCancel).toHaveBeenCalledOnce();
    expect(streamedPcm).toEqual([7]);
    expect(failures).toEqual([]);
  });

  it("drops a late synthesis result while retaining the one-request provider slot", async () => {
    const first = deferred<VoiceConsoleSynthesisResult>();
    let firstSignal: AbortSignal | undefined;
    let activeSynthesis = 0;
    let maxActiveSynthesis = 0;
    const played: string[] = [];
    const synthesize = vi.fn(async (request: VoiceConsoleSynthesisRequest) => {
      activeSynthesis += 1;
      maxActiveSynthesis = Math.max(maxActiveSynthesis, activeSynthesis);
      try {
        if (request.chunk.bindingId === "A") {
          firstSignal = request.signal;
          return await first.promise;
        }
        return { ok: true as const, audio: audio(2) };
      } finally {
        activeSynthesis -= 1;
      }
    });
    const playback: VoiceConsoleSpeechPlayback = {
      play: vi.fn(async ({ chunk: item }) => {
        played.push(item.text);
        return { status: "played", durationMs: 1_000 };
      }),
      destroy: vi.fn(),
    };
    const { scheduler } = setup({ synthesize, playback });
    const a = source("A");
    const b = source("B");
    scheduler.registerSource(a);
    scheduler.registerSource(b);
    scheduler.enqueueChunk(chunk(a, 1));
    scheduler.enqueueChunk(chunk(b, 1));
    const drainedA = scheduler.finishSource(a);
    const drainedB = scheduler.finishSource(b);
    await vi.waitFor(() => expect(firstSignal).toBeDefined());

    expect(scheduler.setOutputEnabled("A", false)).toBe(1);
    expect(firstSignal!.aborted).toBe(true);
    let bSettled = false;
    void drainedB.then(() => { bSettled = true; });
    await Promise.resolve();
    expect(bSettled).toBe(false);
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(maxActiveSynthesis).toBe(1);
    expect(played).toEqual([]);

    first.resolve({ ok: true, audio: audio(1) });
    await Promise.all([drainedA, drainedB]);
    expect(played).toEqual(["B-1"]);
    expect(maxActiveSynthesis).toBe(1);
  });

  it("stops current playback on output-off without disturbing the next binding", async () => {
    let activeA:
      | { signal: AbortSignal; resolve: (value: { status: "cancelled"; durationMs: number }) => void }
      | undefined;
    const played: string[] = [];
    const playback: VoiceConsoleSpeechPlayback = {
      play: vi.fn(async (request) => {
        if (request.chunk.bindingId === "A") {
          return new Promise((resolve) => {
            activeA = { signal: request.signal, resolve };
            request.signal.addEventListener(
              "abort",
              () => resolve({ status: "cancelled", durationMs: 0 }),
              { once: true }
            );
          });
        }
        played.push(request.chunk.text);
        return { status: "played", durationMs: 1_000 };
      }),
      destroy: vi.fn(),
    };
    const { scheduler } = setup({ playback });
    const a = source("A");
    const b = source("B");
    scheduler.registerSource(a);
    scheduler.registerSource(b);
    scheduler.enqueueChunk(chunk(a, 1));
    scheduler.enqueueChunk(chunk(b, 1));
    const drainedA = scheduler.finishSource(a);
    const drainedB = scheduler.finishSource(b);
    await vi.waitFor(() => expect(activeA).toBeDefined());

    scheduler.setOutputEnabled("A", false);
    expect(activeA!.signal.aborted).toBe(true);
    await Promise.all([drainedA, drainedB]);
    expect(played).toEqual(["B-1"]);
  });

  it("handles rapid toggles by dropping stale generations and disabled prose", async () => {
    const requests: VoiceConsoleSynthesisRequest[] = [];
    const { scheduler, played } = setup({
      synthesize: vi.fn(async (request) => {
        requests.push(request);
        return { ok: true, audio: audio(request.chunk.ordinal) };
      }),
    });
    const a = source("A", "turn-toggle");
    scheduler.registerSource(a);

    scheduler.feedSourceText(a, "This partial sentence belongs to output that is about to be disabled");
    expect(scheduler.setOutputEnabled("A", false)).toBe(1);
    scheduler.feedSourceText(a, "This entire disabled sentence must never be spoken. ");
    expect(scheduler.setOutputEnabled("A", true)).toBe(1);
    expect(scheduler.enqueueChunk(chunk(a, 1, 0, "stale-zero"))).toBe("dropped");
    expect(scheduler.enqueueChunk(chunk(a, 2, 1, "queued-before-second-off"))).toBe("accepted");
    expect(scheduler.setOutputEnabled("A", false)).toBe(2);
    expect(scheduler.setOutputEnabled("A", false)).toBe(2);
    expect(scheduler.setOutputEnabled("A", true)).toBe(2);
    expect(scheduler.enqueueChunk(chunk(a, 3, 1, "stale-one"))).toBe("dropped");
    expect(scheduler.enqueueChunk(chunk(a, 4, 2, "future-clean"))).toBe("accepted");

    const stats = await scheduler.finishSource(a);
    expect(played).toEqual(["future-clean"]);
    expect(requests.map((request) => request.chunk.text)).toEqual(["future-clean"]);
    expect(stats).toMatchObject({ accepted: 2, played: 1, dropped: 3 });
  });

  it("cancels one source during synthesis and leaves sibling sources runnable", async () => {
    const first = deferred<VoiceConsoleSynthesisResult>();
    let signal: AbortSignal | undefined;
    const { scheduler, played } = setup({
      synthesize: vi.fn(async (request) => {
        if (request.chunk.bindingId === "A") {
          signal = request.signal;
          return first.promise;
        }
        return { ok: true, audio: audio(2) };
      }),
    });
    const a = source("A", "turn-cancel");
    const b = source("B", "turn-stays");
    scheduler.registerSource(a);
    scheduler.registerSource(b);
    scheduler.enqueueChunk(chunk(a, 1));
    scheduler.enqueueChunk(chunk(b, 1));
    const drainedA = scheduler.finishSource(a);
    const drainedB = scheduler.finishSource(b);
    await vi.waitFor(() => expect(signal).toBeDefined());
    scheduler.cancelSource(a);
    expect(signal!.aborted).toBe(true);
    expect(played).toEqual([]);
    first.resolve({ ok: true, audio: audio(1) });
    await Promise.all([drainedA, drainedB]);
    expect(played).toEqual(["B-1"]);
  });
});

describe("VoiceConsoleSpeechScheduler authoritative durable state", () => {
  it("restores and snapshots the exact durable generation across restart", () => {
    const playback: VoiceConsoleSpeechPlayback = {
      play: vi.fn(async () => ({ status: "played", durationMs: 1_000 })),
      destroy: vi.fn(),
    };
    const create = () => new VoiceConsoleSpeechScheduler({
      consoleId,
      synthesize: async () => ({ ok: true, audio: audio() }),
      playback,
    });

    const beforeRestart = create();
    beforeRestart.registerBinding({
      bindingId: "A",
      profile: profileA,
      outputEnabled: false,
      generation: 73,
    });
    expect(beforeRestart.snapshot().bindings[0]).toMatchObject({
      outputEnabled: false,
      generation: 73,
    });
    beforeRestart.destroy();

    const recovered = create();
    recovered.registerBinding({
      bindingId: "A",
      profile: profileA,
      outputEnabled: false,
      generation: 73,
    });
    expect(recovered.syncBindingState("A", { outputEnabled: false, generation: 73 }))
      .toBe("unchanged");
    expect(recovered.syncBindingState("A", { outputEnabled: true, generation: 74 }))
      .toBe("applied");
    expect(recovered.snapshot().bindings[0]).toMatchObject({
      outputEnabled: true,
      generation: 74,
    });
  });

  it("applies disable, re-enable, duplicate, stale, and same-enabled invalidation without inventing generations", async () => {
    const late = deferred<VoiceConsoleSynthesisResult>();
    let oldSignal: AbortSignal | undefined;
    const requests: VoiceConsoleSynthesisRequest[] = [];
    const played: string[] = [];
    const scheduler = new VoiceConsoleSpeechScheduler({
      consoleId,
      synthesize: vi.fn(async (request) => {
        requests.push(request);
        if (request.chunk.text === "old-current") {
          oldSignal = request.signal;
          return late.promise;
        }
        return { ok: true, audio: audio(request.chunk.ordinal) };
      }),
      playback: {
        play: vi.fn(async ({ chunk: item }) => {
          played.push(item.text);
          return { status: "played", durationMs: 1_000 };
        }),
        destroy: vi.fn(),
      },
    });
    scheduler.registerBinding({
      bindingId: "A",
      profile: profileA,
      outputEnabled: true,
      generation: 10,
    });
    scheduler.registerBinding({
      bindingId: "B",
      profile: profileB,
      outputEnabled: true,
      generation: 4,
    });
    const a = source("A", "turn-authoritative");
    const b = source("B", "turn-sibling");
    scheduler.registerSource(a);
    scheduler.registerSource(b);
    scheduler.feedSourceText(a, "Old partial prose that must never cross an authoritative generation boundary");
    scheduler.enqueueChunk(chunk(a, 1, 10, "old-current"));
    scheduler.enqueueChunk(chunk(b, 1, 4, "sibling"));
    const siblingDrain = scheduler.finishSource(b);
    await vi.waitFor(() => expect(oldSignal).toBeDefined());

    expect(scheduler.syncBindingState("A", { outputEnabled: false, generation: 20 }))
      .toBe("applied");
    expect(oldSignal!.aborted).toBe(true);
    expect(scheduler.syncBindingState("A", { outputEnabled: false, generation: 20 }))
      .toBe("unchanged");
    expect(scheduler.syncBindingState("A", { outputEnabled: true, generation: 19 }))
      .toBe("stale");
    expect(() => scheduler.syncBindingState("A", { outputEnabled: true, generation: 20 }))
      .toThrow(/conflicts at generation 20/);

    expect(scheduler.syncBindingState("A", { outputEnabled: true, generation: 21 }))
      .toBe("applied");
    scheduler.feedSourceText(a, "Another partial sentence that must be reset by a newer enabled generation");
    expect(scheduler.enqueueChunk(chunk(a, 2, 21, "enabled-but-stale"))).toBe("accepted");
    expect(scheduler.syncBindingState("A", { outputEnabled: true, generation: 22 }))
      .toBe("applied");
    expect(scheduler.feedSourceText(
      a,
      "Only this future clean sentence is allowed to play after the authoritative re-enable boundary. "
    )).toBe(1);
    const bindingDrain = scheduler.waitForBindingDrain("A");
    const sourceDrain = scheduler.finishSource(a);

    late.resolve({ ok: true, audio: audio(1) });
    await Promise.all([sourceDrain, siblingDrain, bindingDrain]);
    expect(requests.map((request) => request.chunk.text)).toEqual([
      "old-current",
      "Only this future clean sentence is allowed to play after the authoritative re-enable boundary.",
      "sibling",
    ]);
    expect(played).toEqual([
      "Only this future clean sentence is allowed to play after the authoritative re-enable boundary.",
      "sibling",
    ]);
    expect(scheduler.snapshot().bindings).toEqual([
      expect.objectContaining({ bindingId: "A", outputEnabled: true, generation: 22 }),
      expect.objectContaining({ bindingId: "B", outputEnabled: true, generation: 4 }),
    ]);
  });

  it("rejects invalid generations and keeps unregister/re-register authoritative", () => {
    const { scheduler } = setup();
    expect(() => scheduler.syncBindingState("A", { outputEnabled: false, generation: -1 }))
      .toThrow(/non-negative safe integer/);
    expect(() => scheduler.syncBindingState("A", { outputEnabled: false, generation: 1.5 }))
      .toThrow(/non-negative safe integer/);
    expect(scheduler.unregisterBinding("A")).toBe(true);
    scheduler.registerBinding({
      bindingId: "A",
      profile: profileA,
      outputEnabled: false,
      generation: 900,
    });
    expect(scheduler.snapshot().bindings.find((binding) => binding.bindingId === "A"))
      .toMatchObject({ outputEnabled: false, generation: 900 });
  });

  it("fails closed on an enabled-to-disabled equal-generation conflict during synthesis", async () => {
    const lateSynthesis = deferred<VoiceConsoleSynthesisResult>();
    let oldSignal: AbortSignal | undefined;
    const requests: VoiceConsoleSynthesisRequest[] = [];
    const played: string[] = [];
    const scheduler = new VoiceConsoleSpeechScheduler({
      consoleId,
      synthesize: vi.fn(async (request) => {
        requests.push(request);
        if (request.chunk.text === "old-current") {
          oldSignal = request.signal;
          return lateSynthesis.promise;
        }
        return { ok: true, audio: audio(request.chunk.ordinal) };
      }),
      playback: {
        play: vi.fn(async ({ chunk: item }) => {
          played.push(item.text);
          return { status: "played", durationMs: 1_000 };
        }),
        destroy: vi.fn(),
      },
    });
    scheduler.registerBinding({
      bindingId: "A",
      profile: profileA,
      outputEnabled: true,
      generation: 5,
    });
    const a = source("A", "turn-conflict-synthesis");
    scheduler.registerSource(a);
    scheduler.feedSourceText(a, "This old partial prose must be discarded when durable state conflicts");
    scheduler.enqueueChunk(chunk(a, 1, 5, "old-current"));
    scheduler.enqueueChunk(chunk(a, 2, 5, "old-queued"));
    const bindingDrain = scheduler.waitForBindingDrain("A");
    await vi.waitFor(() => expect(oldSignal).toBeDefined());

    expect(() => scheduler.syncBindingState("A", { outputEnabled: false, generation: 5 }))
      .toThrow(/strictly newer authoritative generation/);
    expect(oldSignal!.aborted).toBe(true);
    expect(scheduler.snapshot().bindings[0]).toMatchObject({
      outputEnabled: false,
      generation: 5,
      queuedChunks: 0,
      stateConflict: {
        generation: 5,
        localOutputEnabled: true,
        receivedOutputEnabled: false,
      },
    });
    expect(() => scheduler.syncBindingState("A", { outputEnabled: false, generation: 5 }))
      .toThrow(/strictly newer authoritative generation/);
    expect(() => scheduler.syncBindingState("A", { outputEnabled: true, generation: 5 }))
      .toThrow(/strictly newer authoritative generation/);
    expect(() => scheduler.setOutputEnabled("A", true))
      .toThrow(/strictly newer authoritative generation/);
    expect(scheduler.feedSourceText(a, "Blocked prose must not accumulate or play. ")).toBe(0);
    expect(scheduler.enqueueChunk(chunk(a, 3, 5, "blocked"))).toBe("dropped");

    expect(scheduler.syncBindingState("A", { outputEnabled: true, generation: 6 }))
      .toBe("applied");
    expect(scheduler.snapshot().bindings[0]).toMatchObject({
      outputEnabled: true,
      generation: 6,
      stateConflict: null,
    });
    expect(scheduler.feedSourceText(
      a,
      "Only this future clean sentence may play after a strictly newer authoritative generation. "
    )).toBe(1);
    const sourceDrain = scheduler.finishSource(a);
    lateSynthesis.resolve({ ok: true, audio: audio(1) });

    const [sourceStats, bindingStats] = await Promise.all([sourceDrain, bindingDrain]);
    expect(requests.map((request) => request.chunk.text)).toEqual([
      "old-current",
      "Only this future clean sentence may play after a strictly newer authoritative generation.",
    ]);
    expect(played).toEqual([
      "Only this future clean sentence may play after a strictly newer authoritative generation.",
    ]);
    expect(sourceStats).toMatchObject({ accepted: 3, played: 1, dropped: 3 });
    expect(bindingStats).toMatchObject({ accepted: 3, played: 1, dropped: 3 });
  });

  it("fails closed on an equal-generation conflict during playback and keeps siblings reusable", async () => {
    const latePlayback = deferred<{ status: "played"; durationMs: number }>();
    let playbackSignal: AbortSignal | undefined;
    const played: string[] = [];
    const playback: VoiceConsoleSpeechPlayback = {
      play: vi.fn(async (request) => {
        if (request.chunk.text === "old-playing") {
          playbackSignal = request.signal;
          return latePlayback.promise;
        }
        played.push(request.chunk.text);
        return { status: "played", durationMs: 1_000 };
      }),
      destroy: vi.fn(),
    };
    const scheduler = new VoiceConsoleSpeechScheduler({
      consoleId,
      synthesize: async ({ chunk: item }) => ({ ok: true, audio: audio(item.ordinal) }),
      playback,
    });
    scheduler.registerBinding({
      bindingId: "A",
      profile: profileA,
      outputEnabled: true,
      generation: 5,
    });
    scheduler.registerBinding({
      bindingId: "B",
      profile: profileB,
      outputEnabled: true,
      generation: 9,
    });
    const a = source("A", "turn-conflict-playback");
    const b = source("B", "turn-conflict-sibling");
    scheduler.registerSource(a);
    scheduler.registerSource(b);
    scheduler.enqueueChunk(chunk(a, 1, 5, "old-playing"));
    scheduler.enqueueChunk(chunk(a, 2, 5, "old-queued"));
    scheduler.enqueueChunk(chunk(b, 1, 9, "sibling"));
    const drainA = scheduler.finishSource(a);
    const drainB = scheduler.finishSource(b);
    await vi.waitFor(() => expect(playbackSignal).toBeDefined());

    expect(() => scheduler.syncBindingState("A", { outputEnabled: false, generation: 5 }))
      .toThrow(/strictly newer authoritative generation/);
    expect(playbackSignal!.aborted).toBe(true);
    await expect(drainA).resolves.toMatchObject({ accepted: 2, dropped: 2 });
    await expect(drainB).resolves.toMatchObject({ played: 1 });
    expect(played).toEqual(["sibling"]);
    expect(playback.destroy).not.toHaveBeenCalled();

    latePlayback.resolve({ status: "played", durationMs: 99_000 });
    await flushMicrotasks();
    expect(played).toEqual(["sibling"]);

    expect(scheduler.syncBindingState("A", { outputEnabled: true, generation: 6 }))
      .toBe("applied");
    const recovered = source("A", "turn-after-playback-conflict");
    scheduler.registerSource(recovered);
    scheduler.enqueueChunk(chunk(recovered, 1, 6, "A-recovered"));
    await scheduler.finishSource(recovered);
    expect(played).toEqual(["sibling", "A-recovered"]);
  });

  it("blocks a disabled-to-enabled equal-generation conflict until a newer generation", async () => {
    const { scheduler, played } = setup();
    scheduler.unregisterBinding("A");
    scheduler.registerBinding({
      bindingId: "A",
      profile: profileA,
      outputEnabled: false,
      generation: 5,
    });
    const a = source("A", "turn-disabled-conflict");
    scheduler.registerSource(a);
    expect(scheduler.feedSourceText(a, "Disabled partial prose must not be retained. ")).toBe(0);

    expect(() => scheduler.syncBindingState("A", { outputEnabled: true, generation: 5 }))
      .toThrow(/strictly newer authoritative generation/);
    expect(() => scheduler.syncBindingState("A", { outputEnabled: true, generation: 5 }))
      .toThrow(/strictly newer authoritative generation/);
    expect(() => scheduler.syncBindingState("A", { outputEnabled: false, generation: 5 }))
      .toThrow(/strictly newer authoritative generation/);
    expect(scheduler.snapshot().bindings.find((binding) => binding.bindingId === "A"))
      .toMatchObject({
        outputEnabled: false,
        generation: 5,
        stateConflict: {
          localOutputEnabled: false,
          receivedOutputEnabled: true,
        },
      });
    expect(scheduler.enqueueChunk(chunk(a, 1, 5, "blocked"))).toBe("dropped");
    expect(scheduler.feedSourceText(a, "Still blocked prose must remain silent. ")).toBe(0);

    expect(scheduler.syncBindingState("A", { outputEnabled: true, generation: 6 }))
      .toBe("applied");
    expect(scheduler.feedSourceText(
      a,
      "A strictly newer generation allows only this future clean sentence to reach playback. "
    )).toBe(1);
    await scheduler.finishSource(a);
    expect(played).toEqual([
      "A strictly newer generation allows only this future clean sentence to reach playback.",
    ]);
  });
});

describe("VoiceConsoleSpeechScheduler state changes", () => {
  it("keeps async callbacks single-flight and coalesces a burst to the latest snapshot", async () => {
    const gates: Array<ReturnType<typeof deferred<void>>> = [];
    const delivered: number[] = [];
    const snapshots: VoiceConsoleSpeechStateChange[] = [];
    let active = 0;
    let maxActive = 0;
    const scheduler = new VoiceConsoleSpeechScheduler({
      consoleId,
      synthesize: async () => ({ ok: true, audio: audio() }),
      playback: {
        play: async () => ({ status: "played", durationMs: 1_000 }),
        destroy: vi.fn(),
      },
      onStateChange: async (change) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        snapshots.push(change);
        const gate = deferred<void>();
        gates.push(gate);
        await gate.promise;
        delivered.push(change.snapshot.bindings[0]?.generation ?? -1);
        active -= 1;
      },
    });
    scheduler.registerBinding({
      bindingId: "A",
      profile: profileA,
      outputEnabled: true,
      generation: 0,
    });
    await vi.waitFor(() => expect(gates).toHaveLength(1));

    for (let generation = 1; generation <= 5; generation++) {
      expect(scheduler.syncBindingState("A", {
        outputEnabled: generation % 2 === 0,
        generation,
      })).toBe("applied");
    }
    await flushMicrotasks();
    expect(gates).toHaveLength(1);
    expect(snapshots).toHaveLength(1);
    expect(maxActive).toBe(1);

    gates[0]!.resolve();
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    expect(snapshots[1]?.snapshot.bindings[0]).toMatchObject({
      generation: 5,
      outputEnabled: false,
    });
    expect(snapshots[1]?.reasons).toEqual(["queue-changed", "binding-synced"]);
    expect(maxActive).toBe(1);

    gates[1]!.resolve();
    await vi.waitFor(() => expect(delivered).toEqual([0, 5]));
    expect(maxActive).toBe(1);
    expect(delivered.at(-1)).toBe(5);
  });

  it("serializes reentrant mutation and isolates callback throw/rejection", async () => {
    const seen: number[] = [];
    let active = 0;
    let maxActive = 0;
    let call = 0;
    let scheduler!: VoiceConsoleSpeechScheduler;
    scheduler = new VoiceConsoleSpeechScheduler({
      consoleId,
      synthesize: async () => ({ ok: true, audio: audio() }),
      playback: {
        play: async () => ({ status: "played", durationMs: 1_000 }),
        destroy: vi.fn(),
      },
      onStateChange: async (change) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        call += 1;
        seen.push(change.snapshot.bindings[0]?.generation ?? -1);
        if (call === 1) {
          scheduler.syncBindingState("A", { outputEnabled: false, generation: 1 });
          active -= 1;
          throw new Error("synchronous callback failure");
        }
        active -= 1;
        if (call === 2) return Promise.reject(new Error("async callback failure"));
      },
    });
    scheduler.registerBinding({
      bindingId: "A",
      profile: profileA,
      outputEnabled: true,
      generation: 0,
    });
    await vi.waitFor(() => expect(seen).toEqual([0, 1]));
    await flushMicrotasks();
    expect(maxActive).toBe(1);
    expect(scheduler.snapshot().bindings[0]).toMatchObject({
      generation: 1,
      outputEnabled: false,
    });

    const a = source("A", "turn-callback-drain");
    scheduler.registerSource(a);
    scheduler.cancelSource(a);
    await expect(scheduler.waitForSourceDrain(a)).resolves.toMatchObject({ accepted: 0 });
  });

  it("delivers unregister/destroy as the latest state after a pending callback", async () => {
    const first = deferred<void>();
    const snapshots: VoiceConsoleSpeechStateChange[] = [];
    const scheduler = new VoiceConsoleSpeechScheduler({
      consoleId,
      synthesize: async () => ({ ok: true, audio: audio() }),
      playback: {
        play: async () => ({ status: "played", durationMs: 1_000 }),
        destroy: vi.fn(),
      },
      onStateChange: async (change) => {
        snapshots.push(change);
        if (snapshots.length === 1) await first.promise;
      },
    });
    scheduler.registerBinding({ bindingId: "A", profile: profileA, outputEnabled: true });
    await vi.waitFor(() => expect(snapshots).toHaveLength(1));
    scheduler.unregisterBinding("A");
    scheduler.destroy();
    scheduler.destroy();
    await flushMicrotasks();
    expect(snapshots).toHaveLength(1);

    first.resolve();
    await vi.waitFor(() => expect(snapshots).toHaveLength(2));
    expect(snapshots[1]?.reasons).toEqual(["binding-unregistered", "destroyed"]);
    expect(snapshots[1]?.snapshot).toMatchObject({ destroyed: true, bindings: [] });
  });

  it("reports authoritative sync and lifecycle changes without replay churn", async () => {
    const changes: VoiceConsoleSpeechStateChange[] = [];
    const scheduler = new VoiceConsoleSpeechScheduler({
      consoleId,
      synthesize: async () => ({ ok: true, audio: audio() }),
      playback: {
        play: async () => ({ status: "played", durationMs: 1_000 }),
        destroy: vi.fn(),
      },
      onStateChange: (change) => changes.push(change),
    });
    scheduler.registerBinding({
      bindingId: "A",
      profile: profileA,
      outputEnabled: true,
      generation: 5,
    });
    await vi.waitFor(() => expect(changes).toHaveLength(1));
    changes.length = 0;

    expect(scheduler.syncBindingState("A", { outputEnabled: false, generation: 6 }))
      .toBe("applied");
    expect(scheduler.syncBindingState("A", { outputEnabled: false, generation: 6 }))
      .toBe("unchanged");
    expect(scheduler.syncBindingState("A", { outputEnabled: true, generation: 5 }))
      .toBe("stale");
    await vi.waitFor(() => expect(changes).toHaveLength(1));
    expect(changes[0]?.reasons).toEqual(["queue-changed", "binding-synced"]);
    expect(changes[0]?.snapshot.bindings[0]).toMatchObject({
      outputEnabled: false,
      generation: 6,
    });

    const a = source("A", "turn-state-cancel");
    const beforeCancel = changes.length;
    scheduler.registerSource(a);
    scheduler.cancelSource(a);
    await scheduler.waitForSourceDrain(a);
    await vi.waitFor(() => expect(changes.length).toBeGreaterThan(beforeCancel));
    expect(changes.some((change) => change.reasons.includes("source-cancelled"))).toBe(true);

    expect(scheduler.unregisterBinding("A")).toBe(true);
    scheduler.destroy();
    scheduler.destroy();
    await vi.waitFor(() => expect(changes.at(-1)?.snapshot.destroyed).toBe(true));
    const terminal = changes.at(-1);
    expect(terminal?.reasons).toEqual(["binding-unregistered", "destroyed"]);
    expect(terminal?.snapshot).toMatchObject({ destroyed: true, bindings: [] });
  });

  it("coalesces synchronous mutations and reports exact queue/work transitions", async () => {
    const changes: VoiceConsoleSpeechStateChange[] = [];
    const scheduler = new VoiceConsoleSpeechScheduler({
      consoleId,
      synthesize: async ({ chunk: item }) => ({ ok: true, audio: audio(item.ordinal) }),
      playback: {
        play: async () => ({ status: "played", durationMs: 1_000 }),
        destroy: vi.fn(),
      },
      onStateChange: (change) => changes.push(change),
    });
    scheduler.registerBinding({ bindingId: "A", profile: profileA, outputEnabled: true });
    const a = source("A", "turn-state-coalesce");
    scheduler.registerSource(a);
    scheduler.enqueueChunk(chunk(a, 1));
    const drained = scheduler.finishSource(a);

    await vi.waitFor(() => expect(changes).not.toHaveLength(0));
    expect(changes[0]?.reasons).toEqual([
      "binding-registered",
      "source-registered",
      "queue-changed",
    ]);
    expect(changes[0]?.snapshot).toMatchObject({
      queueDepth: 1,
      currentSource: null,
      currentPhase: null,
    });

    await drained;
    await vi.waitFor(() => expect(changes.at(-1)?.snapshot.currentSource).toBeNull());
    const reasons = changes.flatMap((change) => change.reasons);
    expect(reasons).toContain("work-started");
    expect(reasons).toContain("work-phase-changed");
    expect(reasons).toContain("work-settled");
    expect(changes.at(-1)?.snapshot).toMatchObject({
      queueDepth: 0,
      currentSource: null,
      currentPhase: null,
    });
  });

  it("isolates throwing and rejecting callbacks while drains and destroy settle", async () => {
    const observed: VoiceConsoleSpeechStateChange[] = [];
    let calls = 0;
    const scheduler = new VoiceConsoleSpeechScheduler({
      consoleId,
      synthesize: async () => ({ ok: true, audio: audio() }),
      playback: {
        play: async () => ({ status: "played", durationMs: 1_000 }),
        destroy: vi.fn(),
      },
      onStateChange: (change) => {
        observed.push(change);
        calls += 1;
        if (calls % 2 === 1) throw new Error("card refresh threw");
        return Promise.reject(new Error("card refresh rejected"));
      },
    });
    scheduler.registerBinding({ bindingId: "A", profile: profileA, outputEnabled: true });
    const a = source("A", "turn-state-throws");
    scheduler.registerSource(a);
    scheduler.enqueueChunk(chunk(a, 1));
    await expect(scheduler.finishSource(a)).resolves.toMatchObject({ played: 1 });
    scheduler.destroy();
    scheduler.destroy();
    await vi.waitFor(() =>
      expect(observed.filter((change) => change.reasons.includes("destroyed"))).toHaveLength(1)
    );

    expect(observed.length).toBeGreaterThan(1);
    expect(observed.filter((change) => change.reasons.includes("destroyed"))).toHaveLength(1);
    expect(observed.at(-1)?.snapshot.destroyed).toBe(true);
  });

  it("exposes one bounded recent failure and clears it on recovery", async () => {
    const changes: VoiceConsoleSpeechStateChange[] = [];
    const scheduler = new VoiceConsoleSpeechScheduler({
      consoleId,
      synthesize: async ({ chunk: item }) => item.turnId === "turn-fails"
        ? { ok: false, error: "quota" }
        : { ok: true, audio: audio(item.ordinal) },
      playback: {
        play: async () => ({ status: "played", durationMs: 1_000 }),
        destroy: vi.fn(),
      },
      onStateChange: (change) => changes.push(change),
    });
    scheduler.registerBinding({ bindingId: "A", profile: profileA, outputEnabled: true });
    const failed = source("A", "turn-fails");
    scheduler.registerSource(failed);
    scheduler.enqueueChunk(chunk(failed, 1));
    await scheduler.finishSource(failed);
    expect(scheduler.snapshot().bindings[0]?.recentFailure).toMatchObject({
      ordinal: 1,
      phase: "synthesis",
      error: "quota",
    });

    const recovered = source("A", "turn-recovers");
    scheduler.registerSource(recovered);
    scheduler.enqueueChunk(chunk(recovered, 1));
    await scheduler.finishSource(recovered);
    await Promise.resolve();
    expect(scheduler.snapshot().bindings[0]?.recentFailure).toBeNull();
    expect(changes.some((change) => change.reasons.includes("failure"))).toBe(true);
    expect(changes.some((change) => change.reasons.includes("recovered"))).toBe(true);
  });
});

describe("VoiceConsoleSpeechScheduler failures, drains, and cleanup", () => {
  it("still speaks the final flushed sentence after a middle synthesis failure", async () => {
    const attempted: string[] = [];
    const played: string[] = [];
    const { scheduler, failures } = setup({
      synthesize: vi.fn(async ({ chunk: item }) => {
        attempted.push(item.text);
        return item.ordinal === 2
          ? { ok: false as const, error: "transient provider response" }
          : { ok: true as const, audio: audio(item.ordinal) };
      }),
      playback: {
        play: vi.fn(async ({ chunk: item }) => {
          played.push(item.text);
          return { status: "played" as const, durationMs: 1_000 };
        }),
        destroy: vi.fn(),
      },
    });
    const a = source("A", "turn-with-final-tail");
    scheduler.registerSource(a);
    scheduler.feedSourceText(
      a,
      "Opening sentence. This middle sentence is deliberately long enough to become a separate speech chunk and fail. Final bullet stays buffered"
    );

    await expect(scheduler.finishSource(a)).resolves.toMatchObject({
      failed: 1,
      played: 2,
    });
    expect(attempted.at(-1)).toBe("Final bullet stays buffered");
    expect(played.at(-1)).toBe("Final bullet stays buffered");
    expect(failures).toHaveLength(1);
  });

  it("warns once per source turn, continues after synthesis/playback failures, and cannot stall", async () => {
    const failures: unknown[] = [];
    const played: string[] = [];
    const synthesize = vi.fn(async (request: VoiceConsoleSynthesisRequest) => {
      if (request.chunk.text === "A-1") return { ok: false as const, error: "quota" };
      return { ok: true as const, audio: audio(request.chunk.ordinal) };
    });
    const playback: VoiceConsoleSpeechPlayback = {
      play: vi.fn(async ({ chunk: item }) => {
        if (item.text === "A-2") throw new Error("player failed");
        played.push(item.text);
        return { status: "played", durationMs: 1_000 };
      }),
      destroy: vi.fn(),
    };
    const scheduler = new VoiceConsoleSpeechScheduler({
      consoleId,
      synthesize,
      playback,
      onFailure: (failure) => failures.push(failure),
    });
    scheduler.registerBinding({ bindingId: "A", profile: profileA, outputEnabled: true });
    scheduler.registerBinding({ bindingId: "B", profile: profileB, outputEnabled: true });
    const a = source("A", "turn-fail");
    const b = source("B", "turn-good");
    scheduler.registerSource(a);
    scheduler.registerSource(b);
    scheduler.enqueueChunk(chunk(a, 1));
    scheduler.enqueueChunk(chunk(a, 2));
    scheduler.enqueueChunk(chunk(a, 3));
    scheduler.enqueueChunk(chunk(b, 1));
    const [statsA, statsB] = await Promise.all([
      scheduler.finishSource(a),
      scheduler.finishSource(b),
    ]);

    expect(played).toEqual(["B-1", "A-3"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ ordinal: 1, phase: "synthesis", error: "quota" });
    expect(statsA).toMatchObject({ failed: 2, played: 1 });
    expect(statsB).toMatchObject({ failed: 0, played: 1 });
  });

  it("resolves one binding drain while another binding is still playing", async () => {
    const bPlayback = deferred<{ status: "played"; durationMs: number }>();
    const playback: VoiceConsoleSpeechPlayback = {
      play: vi.fn(async ({ chunk: item }) => {
        if (item.bindingId === "B") return bPlayback.promise;
        return { status: "played", durationMs: 1_000 };
      }),
      destroy: vi.fn(),
    };
    const { scheduler } = setup({ playback });
    const a = source("A", "turn-drain-a");
    const b = source("B", "turn-drain-b");
    scheduler.registerSource(a);
    scheduler.registerSource(b);
    scheduler.enqueueChunk(chunk(a, 1));
    scheduler.enqueueChunk(chunk(b, 1));
    scheduler.finishSource(a);
    scheduler.finishSource(b);
    const drainedA = scheduler.waitForBindingDrain("A");
    const drainedB = scheduler.waitForBindingDrain("B");

    await expect(drainedA).resolves.toMatchObject({ played: 1 });
    let bSettled = false;
    void drainedB.then(() => { bSettled = true; });
    await Promise.resolve();
    expect(bSettled).toBe(false);
    bPlayback.resolve({ status: "played", durationMs: 1_000 });
    await expect(drainedB).resolves.toMatchObject({ played: 1 });
  });

  it("aborts work, drops accepted chunks, settles drains, and destroys playback once", async () => {
    const synthesis = deferred<VoiceConsoleSynthesisResult>();
    let signal: AbortSignal | undefined;
    const playback: VoiceConsoleSpeechPlayback = {
      play: vi.fn(async () => ({ status: "played", durationMs: 1_000 })),
      destroy: vi.fn(),
    };
    const { scheduler } = setup({
      playback,
      synthesize: vi.fn(async (request) => {
        signal = request.signal;
        return synthesis.promise;
      }),
    });
    const a = source("A", "turn-destroy");
    scheduler.registerSource(a);
    scheduler.enqueueChunk(chunk(a, 1));
    scheduler.finishSource(a);
    const drained = scheduler.waitForBindingDrain("A");
    await vi.waitFor(() => expect(signal).toBeDefined());

    scheduler.destroy();
    scheduler.destroy();
    expect(signal!.aborted).toBe(true);
    await expect(drained).resolves.toMatchObject({ accepted: 1, dropped: 1 });
    expect(playback.destroy).toHaveBeenCalledTimes(1);
    expect(scheduler.snapshot().destroyed).toBe(true);
    synthesis.resolve({ ok: true, audio: audio(1) });
  });
});

describe("VoiceConsoleSpeechScheduler binding and source lifecycle", () => {
  it("unregisters during synthesis, settles drains, and keeps sibling playback reusable", async () => {
    const lateSynthesis = deferred<VoiceConsoleSynthesisResult>();
    let synthesisSignal: AbortSignal | undefined;
    const { scheduler, playback, played } = setup({
      synthesize: vi.fn(async (request) => {
        if (request.chunk.turnId === "turn-unregister-synthesis") {
          synthesisSignal = request.signal;
          return lateSynthesis.promise;
        }
        return { ok: true, audio: audio(2) };
      }),
    });
    const a = source("A", "turn-unregister-synthesis");
    const b = source("B", "turn-survives-synthesis");
    scheduler.registerSource(a);
    scheduler.registerSource(b);
    scheduler.enqueueChunk(chunk(a, 1));
    scheduler.enqueueChunk(chunk(b, 1));
    const sourceDrainA = scheduler.finishSource(a);
    const bindingDrainA = scheduler.waitForBindingDrain("A");
    const sourceDrainB = scheduler.finishSource(b);
    await vi.waitFor(() => expect(synthesisSignal).toBeDefined());

    expect(scheduler.unregisterBinding("A")).toBe(true);
    expect(scheduler.unregisterBinding("A")).toBe(false);
    expect(synthesisSignal!.aborted).toBe(true);
    await expect(sourceDrainA).resolves.toMatchObject({ accepted: 1, dropped: 1 });
    await expect(bindingDrainA).resolves.toMatchObject({ accepted: 1, dropped: 1 });
    expect(played).toEqual([]);
    expect(scheduler.snapshot().bindings.map((binding) => binding.bindingId)).toEqual(["B"]);
    expect(playback.destroy).not.toHaveBeenCalled();

    scheduler.registerBinding({ bindingId: "A", profile: profileA, outputEnabled: true });
    const reboundA = source("A", "turn-rebound");
    scheduler.registerSource(reboundA);
    scheduler.enqueueChunk(chunk(reboundA, 1, 0, "A-rebound"));
    const reboundDrain = scheduler.finishSource(reboundA);

    lateSynthesis.resolve({ ok: true, audio: audio(1) });
    await expect(sourceDrainB).resolves.toMatchObject({ played: 1 });
    await expect(reboundDrain).resolves.toMatchObject({ played: 1 });
    expect(played).toEqual(["B-1", "A-rebound"]);
  });

  it("ignores late playback completion after unregister and advances immediately", async () => {
    const latePlayback = deferred<{ status: "played"; durationMs: number }>();
    let playbackSignal: AbortSignal | undefined;
    const played: string[] = [];
    const playback: VoiceConsoleSpeechPlayback = {
      play: vi.fn(async (request) => {
        if (request.chunk.bindingId === "A") {
          playbackSignal = request.signal;
          return latePlayback.promise;
        }
        played.push(request.chunk.text);
        return { status: "played", durationMs: 1_000 };
      }),
      destroy: vi.fn(),
    };
    const { scheduler } = setup({ playback });
    const a = source("A", "turn-unregister-playback");
    const b = source("B", "turn-survives-playback");
    scheduler.registerSource(a);
    scheduler.registerSource(b);
    scheduler.enqueueChunk(chunk(a, 1));
    scheduler.enqueueChunk(chunk(b, 1));
    const sourceDrainA = scheduler.finishSource(a);
    const bindingDrainA = scheduler.waitForBindingDrain("A");
    const sourceDrainB = scheduler.finishSource(b);
    await vi.waitFor(() => expect(playbackSignal).toBeDefined());

    expect(scheduler.unregisterBinding("A")).toBe(true);
    expect(playbackSignal!.aborted).toBe(true);
    await expect(sourceDrainA).resolves.toMatchObject({ accepted: 1, dropped: 1 });
    await expect(bindingDrainA).resolves.toMatchObject({ accepted: 1, dropped: 1 });
    await expect(sourceDrainB).resolves.toMatchObject({ played: 1 });
    expect(played).toEqual(["B-1"]);
    expect(playback.destroy).not.toHaveBeenCalled();

    latePlayback.resolve({ status: "played", durationMs: 99_000 });
    await Promise.resolve();
    expect(played).toEqual(["B-1"]);
    expect(scheduler.snapshot().bindings.map((binding) => binding.bindingId)).toEqual(["B"]);
  });

  it("forgets completed source retention explicitly and idempotently", async () => {
    const { scheduler } = setup();
    const a = source("A", "turn-forget");
    scheduler.registerSource(a);
    scheduler.enqueueChunk(chunk(a, 1));
    await scheduler.finishSource(a);

    expect(() => scheduler.registerSource(a)).toThrow("already registered");
    expect(scheduler.forgetSource(a)).toBe(true);
    expect(scheduler.forgetSource(a)).toBe(false);

    scheduler.registerSource(a);
    expect(scheduler.forgetSource(a)).toBe(false);
    scheduler.cancelSource(a);
    await expect(scheduler.waitForSourceDrain(a)).resolves.toMatchObject({ accepted: 0 });
    expect(scheduler.forgetSource(a)).toBe(true);
    expect(scheduler.forgetSource(a)).toBe(false);

    for (let index = 0; index < 128; index++) {
      const completed = source("A", `turn-long-lived-${index}`);
      scheduler.registerSource(completed);
      await scheduler.finishSource(completed);
      expect(scheduler.forgetSource(completed)).toBe(true);
    }
  });
});

describe("VoiceConsoleSpeechScheduler failure isolation", () => {
  it("records a typed playback failure, warns once, and continues later chunks", async () => {
    const failures: unknown[] = [];
    const played: string[] = [];
    const playback: VoiceConsoleSpeechPlayback = {
      play: vi.fn(async ({ chunk: item }) => {
        if (item.ordinal === 1) {
          return { status: "failed", durationMs: 0, error: "discord player failed" };
        }
        played.push(item.text);
        return { status: "played", durationMs: 1_000 };
      }),
      destroy: vi.fn(),
    };
    const scheduler = new VoiceConsoleSpeechScheduler({
      consoleId,
      synthesize: async ({ chunk: item }) => ({ ok: true, audio: audio(item.ordinal) }),
      playback,
      onFailure: (failure) => failures.push(failure),
    });
    scheduler.registerBinding({ bindingId: "A", profile: profileA, outputEnabled: true });
    const a = source("A", "turn-player-failure");
    scheduler.registerSource(a);
    scheduler.enqueueChunk(chunk(a, 1));
    scheduler.enqueueChunk(chunk(a, 2));

    await expect(scheduler.finishSource(a)).resolves.toMatchObject({ failed: 1, played: 1 });
    expect(played).toEqual(["A-2"]);
    expect(failures).toEqual([
      expect.objectContaining({ phase: "playback", error: "discord player failed" }),
    ]);
  });

  it("isolates a throwing warning callback so work and drains still settle", async () => {
    const warning = vi.fn(() => {
      throw new Error("warning channel unavailable");
    });
    const played: string[] = [];
    const scheduler = new VoiceConsoleSpeechScheduler({
      consoleId,
      synthesize: async ({ chunk: item }) => item.ordinal === 1
        ? { ok: false, error: "quota" }
        : { ok: true, audio: audio(item.ordinal) },
      playback: {
        play: async ({ chunk: item }) => {
          played.push(item.text);
          return { status: "played", durationMs: 1_000 };
        },
        destroy: vi.fn(),
      },
      onFailure: warning,
    });
    scheduler.registerBinding({ bindingId: "A", profile: profileA, outputEnabled: true });
    const a = source("A", "turn-warning-throws");
    scheduler.registerSource(a);
    scheduler.enqueueChunk(chunk(a, 1));
    scheduler.enqueueChunk(chunk(a, 2));
    const bindingDrain = scheduler.waitForBindingDrain("A");

    await expect(scheduler.finishSource(a)).resolves.toMatchObject({ failed: 1, played: 1 });
    await expect(bindingDrain).resolves.toMatchObject({ failed: 1, played: 1 });
    expect(warning).toHaveBeenCalledTimes(1);
    expect(played).toEqual(["A-2"]);
    expect(scheduler.snapshot().currentSource).toBeNull();
  });
});

import { describe, expect, it, vi } from "vitest";
import { VoiceConsoleSpeechScheduler } from "../packages/core/src/core/voice-console/speech-scheduler.js";
import type {
  VoiceConsolePlaybackRequest,
  VoiceConsoleSpeechChunk,
  VoiceConsoleSpeechPlayback,
  VoiceConsoleSpeechProfile,
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
  it("drops a late synthesis result on output-off and immediately advances another source", async () => {
    const first = deferred<VoiceConsoleSynthesisResult>();
    let firstSignal: AbortSignal | undefined;
    const played: string[] = [];
    const synthesize = vi.fn(async (request: VoiceConsoleSynthesisRequest) => {
      if (request.chunk.bindingId === "A") {
        firstSignal = request.signal;
        return first.promise;
      }
      return { ok: true as const, audio: audio(2) };
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
    await drainedB;
    await expect(drainedA).resolves.toMatchObject({ played: 0, dropped: 1 });
    expect(played).toEqual(["B-1"]);

    first.resolve({ ok: true, audio: audio(1) });
    await Promise.resolve();
    expect(played).toEqual(["B-1"]);
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
    await Promise.all([drainedA, drainedB]);
    expect(played).toEqual(["B-1"]);
    first.resolve({ ok: true, audio: audio(1) });
  });
});

describe("VoiceConsoleSpeechScheduler failures, drains, and cleanup", () => {
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

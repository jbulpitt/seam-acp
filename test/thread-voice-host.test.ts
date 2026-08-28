import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import type { Logger } from "../packages/core/src/lib/logger.js";
import {
  ThreadVoiceCaptureCoordinator,
  type ThreadVoiceTranscribePort,
} from "../packages/core/src/platforms/discord/thread-voice-host.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("ThreadVoiceCaptureCoordinator", () => {
  it("serializes immediate continuations and retains usable text across an empty terminal marker", async () => {
    const one = deferred<{ ok: true; text: string; source: "live" }>();
    const two = deferred<{ ok: true; text: string; source: "live" }>();
    const finals = [one, two];
    let active = false;
    const sent: number[] = [];
    const transcribe: ThreadVoiceTranscribePort = {
      startUtterance: vi.fn(async () => {
        expect(active).toBe(false);
        active = true;
      }),
      sendPcm16k: vi.fn((pcm) => sent.push(pcm[0] ?? -1)),
      finalizeUtterance: vi.fn(async () => {
        const next = finals.shift()!;
        const result = await next.promise;
        active = false;
        return result;
      }),
    };
    const onFinal = vi.fn();
    const onDropped = vi.fn();
    let clock = 0;
    const bridge = new ThreadVoiceCaptureCoordinator({
      ownerUserId: "owner",
      transcribe,
      logger: silent,
      now: () => `t${++clock}`,
      callbacks: {
        onInterim: vi.fn(),
        onFinal,
        onDropped,
        onAudioSent: vi.fn(),
      },
    });

    bridge.onCaptureStart({ sequence: 1, part: 0 });
    bridge.onPcm({ sequence: 1, part: 0, pcm16kMono: Buffer.from([1, 0]), durationMs: 1 });
    bridge.onCaptureEnd({
      sequence: 1, part: 0, pcm16kMono: Buffer.alloc(8_000), durationMs: 250,
      reason: "limit", continuation: true, usable: true,
    });
    bridge.onCaptureStart({ sequence: 1, part: 1 });
    bridge.onCaptureEnd({
      sequence: 1, part: 1, pcm16kMono: Buffer.alloc(0), durationMs: 0,
      reason: "mute", continuation: false, usable: false,
    });
    bridge.onCaptureStart({ sequence: 2, part: 0 });
    bridge.onPcm({ sequence: 2, part: 0, pcm16kMono: Buffer.from([2, 0]), durationMs: 1 });
    bridge.onCaptureEnd({
      sequence: 2, part: 0, pcm16kMono: Buffer.alloc(8_000), durationMs: 250,
      reason: "mute", continuation: false, usable: true,
    });

    await tick();
    expect(transcribe.startUtterance).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([1]);
    one.resolve({ ok: true, text: "first continuation", source: "live" });
    await tick();
    expect(transcribe.startUtterance).toHaveBeenCalledTimes(2);
    expect(sent).toEqual([1, 2]);
    two.resolve({ ok: true, text: "next utterance", source: "live" });
    await bridge.idle();

    expect(onDropped).not.toHaveBeenCalled();
    expect(onFinal.mock.calls.map(([segment]) => [segment.sequence, segment.transcript])).toEqual([
      [1, "first continuation"],
      [2, "next utterance"],
    ]);
    expect(transcribe.finalizeUtterance).toHaveBeenCalledTimes(2);
  });

  it("reports only actual forwarded-byte deltas, carrying fractional milliseconds", () => {
    const onAudioSent = vi.fn();
    const bridge = new ThreadVoiceCaptureCoordinator({
      ownerUserId: "owner",
      transcribe: {
        startUtterance: vi.fn(async () => {}),
        sendPcm16k: vi.fn(),
        finalizeUtterance: vi.fn(async () => ({ ok: false, error: "unused", source: "unary" })),
      },
      logger: silent,
      callbacks: {
        onInterim: vi.fn(), onFinal: vi.fn(), onDropped: vi.fn(), onAudioSent,
      },
    });
    bridge.onForwardedBytes(31);
    expect(onAudioSent).not.toHaveBeenCalled();
    bridge.onForwardedBytes(33);
    expect(onAudioSent).toHaveBeenCalledWith(2);
  });

  it("settles one failed continuation with an empty terminal exactly once", async () => {
    const onFinal = vi.fn();
    const onDropped = vi.fn();
    const transcribe: ThreadVoiceTranscribePort = {
      startUtterance: vi.fn(async () => {}),
      sendPcm16k: vi.fn(),
      finalizeUtterance: vi.fn(async () => ({
        ok: false as const,
        error: "live and unary unavailable",
        source: "unary" as const,
      })),
    };
    const bridge = new ThreadVoiceCaptureCoordinator({
      ownerUserId: "owner",
      transcribe,
      logger: silent,
      callbacks: {
        onInterim: vi.fn(),
        onFinal,
        onDropped,
        onAudioSent: vi.fn(),
      },
    });

    bridge.onCaptureStart({ sequence: 9, part: 0 });
    bridge.onPcm({
      sequence: 9,
      part: 0,
      pcm16kMono: Buffer.from([1, 0]),
      durationMs: 1,
    });
    bridge.onCaptureEnd({
      sequence: 9,
      part: 0,
      pcm16kMono: Buffer.alloc(8_000),
      durationMs: 250,
      reason: "limit",
      continuation: true,
      usable: true,
    });
    bridge.onCaptureStart({ sequence: 9, part: 1 });
    bridge.onCaptureEnd({
      sequence: 9,
      part: 1,
      pcm16kMono: Buffer.alloc(0),
      durationMs: 0,
      reason: "mute",
      continuation: false,
      usable: false,
    });

    await bridge.idle();
    await bridge.idle();
    expect(transcribe.startUtterance).toHaveBeenCalledOnce();
    expect(transcribe.finalizeUtterance).toHaveBeenCalledOnce();
    expect(onFinal).not.toHaveBeenCalled();
    expect(onDropped).toHaveBeenCalledOnce();
    expect(onDropped).toHaveBeenCalledWith(expect.objectContaining({
      sequence: 9,
      state: "transcribe_failed",
      error: expect.stringContaining("live and unary unavailable"),
    }));
  });
});

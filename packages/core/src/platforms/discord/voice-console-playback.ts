import type { VoiceConnection } from "@discordjs/voice";
import type { TtsPcm } from "../../core/audio/gemini-tts.js";
import type {
  VoiceConsolePlaybackRequest,
  VoiceConsolePlaybackResult,
  VoiceConsolePlaybackStream,
  VoiceConsoleSpeechPlayback,
  VoiceConsoleSpeechSourceRef,
} from "../../core/voice-console/speech-types.js";
import type { Logger } from "../../lib/logger.js";
import {
  ThreadVoicePlaybackQueue,
  type PlaybackDependencies,
} from "./thread-voice-call.js";

export interface VoiceConsolePcmQueue {
  enqueue(pcm: TtsPcm): void;
  beginStreaming?(): void;
  endStreaming?(): void;
  bufferedAudioMs?(): number;
  /** Monotonic PCM-equivalent airtime written to the Discord resource. */
  consumedAudioMs?(): number;
  waitForBufferedAudioBelow?(maxBufferedMs: number): Promise<void>;
  waitForIdle(): Promise<void>;
  takePlaybackError?(): string | undefined;
  stopAndClear(): void;
  destroy(): void;
}

export type VoiceConsolePlaybackConnection = Pick<VoiceConnection, "subscribe">;

/**
 * Package E may inject Package B's shared PCM queue directly, or provide its
 * already-joined Discord connection so this facade creates only the reusable
 * audio player/queue. This transport never joins a voice channel itself.
 */
export interface DiscordVoiceConsolePlaybackOptions {
  queue?: VoiceConsolePcmQueue;
  connection?: VoiceConsolePlaybackConnection;
  logger?: Logger;
  dependencies?: PlaybackDependencies;
}

type ActivePlayback = {
  source: VoiceConsoleSpeechSourceRef;
  cancelled: boolean;
  consumedAtStart: number;
};

const STREAM_HIGH_WATER_MS = 2_000;
const STREAM_LOW_WATER_MS = 1_000;
const STREAM_ENQUEUE_SLICE_MS = 200;
const TURN_END_TONE_SAMPLE_RATE = 24_000;
const TURN_END_TONE_DURATION_MS = 180;
// A pure tone is perceived more strongly than speech at the same peak. Eight
// percent full-scale keeps this marker around half the subjective speech level.
const TURN_END_TONE_GAIN = 0.08;

/** Short, soft descending chime generated locally; no TTS request is involved. */
export function createTurnEndIndicatorPcm(): TtsPcm {
  const samples = Math.round(TURN_END_TONE_SAMPLE_RATE * TURN_END_TONE_DURATION_MS / 1_000);
  const pcm = new Uint8Array(samples * 2);
  const view = new DataView(pcm.buffer);
  const fadeSamples = Math.round(TURN_END_TONE_SAMPLE_RATE * 0.02);
  const split = Math.round(samples * 0.48);
  for (let index = 0; index < samples; index++) {
    const frequency = index < split ? 880 : 660;
    const fadeIn = Math.min(1, index / fadeSamples);
    const fadeOut = Math.min(1, (samples - 1 - index) / fadeSamples);
    const envelope = Math.max(0, Math.min(fadeIn, fadeOut));
    const sample = Math.round(
      32_767 * TURN_END_TONE_GAIN * envelope *
      Math.sin((2 * Math.PI * frequency * index) / TURN_END_TONE_SAMPLE_RATE)
    );
    view.setInt16(index * 2, sample, true);
  }
  return { pcm, sampleRate: TURN_END_TONE_SAMPLE_RATE, channels: 1 };
}

/**
 * Source-aware facade over one reusable Discord PCM/Opus player.
 *
 * The core scheduler guarantees serial calls. The source identity here exists
 * so an AbortSignal can promptly stop only the currently selected chunk.
 */
export class DiscordVoiceConsolePlayback implements VoiceConsoleSpeechPlayback {
  private readonly queue: VoiceConsolePcmQueue;
  private active: ActivePlayback | undefined;
  private destroyed = false;

  constructor(opts: DiscordVoiceConsolePlaybackOptions) {
    if (opts.queue) {
      this.queue = opts.queue;
      return;
    }
    if (!opts.connection || !opts.logger) {
      throw new Error("Voice Console playback requires a queue or Discord connection/logger");
    }
    this.queue = new ThreadVoicePlaybackQueue({
      connection: opts.connection,
      logger: opts.logger,
      ...(opts.dependencies ? { dependencies: opts.dependencies } : {}),
    });
  }

  async play(request: VoiceConsolePlaybackRequest): Promise<VoiceConsolePlaybackResult> {
    if (this.destroyed) return { status: "cancelled", durationMs: 0 };
    if (this.active) throw new Error("Voice Console playback already has an active chunk");
    if (request.signal.aborted) return { status: "cancelled", durationMs: 0 };
    const durationMs = pcmDurationMs(request.audio);
    const consumedAtStart = this.queue.consumedAudioMs?.() ?? 0;
    const active: ActivePlayback = {
      source: {
        consoleId: request.chunk.consoleId,
        bindingId: request.chunk.bindingId,
        turnId: request.chunk.turnId,
      },
      cancelled: false,
      consumedAtStart,
    };
    this.active = active;
    const onAbort = (): void => {
      if (this.active !== active || active.cancelled) return;
      active.cancelled = true;
      this.queue.stopAndClear();
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (request.signal.aborted) onAbort();
      if (active.cancelled) return { status: "cancelled", durationMs: 0 };
      this.queue.enqueue(request.audio);
      await this.queue.waitForIdle();
      const consumedMs = consumedSince(this.queue, consumedAtStart);
      if (active.cancelled || this.destroyed) {
        return { status: "cancelled", durationMs: consumedMs };
      }
      const playbackError = this.queue.takePlaybackError?.();
      return playbackError
        ? { status: "failed", durationMs: consumedMs, error: playbackError }
        : { status: "played", durationMs: consumedMs || durationMs };
    } finally {
      request.signal.removeEventListener("abort", onAbort);
      if (this.active === active) this.active = undefined;
    }
  }

  playEndIndicator(
    request: Omit<VoiceConsolePlaybackRequest, "audio">
  ): Promise<VoiceConsolePlaybackResult> {
    return this.play({ ...request, audio: createTurnEndIndicatorPcm() });
  }

  beginStream(
    request: Omit<VoiceConsolePlaybackRequest, "audio">
  ): VoiceConsolePlaybackStream {
    if (this.destroyed) return cancelledStream();
    if (this.active) throw new Error("Voice Console playback already has an active chunk");
    const consumedAtStart = this.queue.consumedAudioMs?.() ?? 0;
    const active: ActivePlayback = {
      source: {
        consoleId: request.chunk.consoleId,
        bindingId: request.chunk.bindingId,
        turnId: request.chunk.turnId,
      },
      cancelled: request.signal.aborted,
      consumedAtStart,
    };
    this.active = active;
    let durationMs = 0;
    let finished: Promise<VoiceConsolePlaybackResult> | undefined;
    const onAbort = (): void => {
      if (this.active !== active || active.cancelled) return;
      active.cancelled = true;
      this.queue.stopAndClear();
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (active.cancelled) this.queue.stopAndClear();
      else this.queue.beginStreaming?.();
    } catch (error) {
      request.signal.removeEventListener("abort", onAbort);
      if (this.active === active) this.active = undefined;
      throw error;
    }

    const finish = (): Promise<VoiceConsolePlaybackResult> => {
      finished ??= (async () => {
        try {
          if (active.cancelled || this.destroyed) {
            return {
              status: "cancelled",
              durationMs: consumedSince(this.queue, consumedAtStart),
            };
          }
          this.queue.endStreaming?.();
          await this.queue.waitForIdle();
          if (active.cancelled || this.destroyed) {
            return {
              status: "cancelled",
              durationMs: consumedSince(this.queue, consumedAtStart),
            };
          }
          const playbackError = this.queue.takePlaybackError?.();
          const consumedMs = consumedSince(this.queue, consumedAtStart);
          return playbackError
            ? { status: "failed", durationMs: consumedMs, error: playbackError }
            : { status: "played", durationMs: consumedMs || durationMs };
        } finally {
          request.signal.removeEventListener("abort", onAbort);
          if (this.active === active) this.active = undefined;
        }
      })();
      return finished;
    };

    return {
      enqueue: async (audio) => {
        if (active.cancelled || this.destroyed || request.signal.aborted) {
          throw abortError();
        }
        const totalDurationMs = pcmDurationMs(audio);
        const sliceBytes = Math.max(
          2,
          Math.floor(audio.sampleRate * audio.channels * 2 * (STREAM_ENQUEUE_SLICE_MS / 1_000))
        );
        for (let offset = 0; offset < audio.pcm.byteLength; offset += sliceBytes) {
          if (active.cancelled || this.destroyed || request.signal.aborted) {
            throw abortError();
          }
          const pcm = audio.pcm.subarray(offset, Math.min(offset + sliceBytes, audio.pcm.byteLength));
          this.queue.enqueue({ pcm, sampleRate: audio.sampleRate, channels: audio.channels });
          if (
            this.queue.bufferedAudioMs &&
            this.queue.waitForBufferedAudioBelow &&
            this.queue.bufferedAudioMs() > STREAM_HIGH_WATER_MS
          ) {
            await this.queue.waitForBufferedAudioBelow(STREAM_LOW_WATER_MS);
          }
          if (active.cancelled || this.destroyed || request.signal.aborted) {
            throw abortError();
          }
        }
        durationMs += totalDurationMs;
      },
      finish,
      cancel: onAbort,
    };
  }

  currentSource(): VoiceConsoleSpeechSourceRef | null {
    return this.active ? { ...this.active.source } : null;
  }

  currentConsumedAudioMs(): number {
    return this.active ? consumedSince(this.queue, this.active.consumedAtStart) : 0;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.active) this.active.cancelled = true;
    this.queue.destroy();
    this.active = undefined;
  }
}

function cancelledStream(): VoiceConsolePlaybackStream {
  return {
    enqueue: async () => { throw abortError(); },
    finish: async () => ({ status: "cancelled", durationMs: 0 }),
    cancel: () => {},
  };
}

function abortError(): Error {
  const error = new Error("Voice Console streaming playback cancelled");
  error.name = "AbortError";
  return error;
}

function pcmDurationMs(pcm: TtsPcm): number {
  if (pcm.sampleRate <= 0 || pcm.channels <= 0 || pcm.pcm.byteLength % 2 !== 0) {
    throw new Error("Voice Console playback received invalid int16 PCM metadata");
  }
  return (pcm.pcm.byteLength / (pcm.sampleRate * pcm.channels * 2)) * 1_000;
}

function consumedSince(queue: VoiceConsolePcmQueue, baselineMs: number): number {
  const total = queue.consumedAudioMs?.();
  return typeof total === "number" && Number.isFinite(total) && total >= baselineMs
    ? total - baselineMs
    : 0;
}

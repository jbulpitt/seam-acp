import type { VoiceConnection } from "@discordjs/voice";
import type { TtsPcm } from "../../core/audio/gemini-tts.js";
import type {
  VoiceConsolePlaybackRequest,
  VoiceConsolePlaybackResult,
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
};

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
    const active: ActivePlayback = {
      source: {
        consoleId: request.chunk.consoleId,
        bindingId: request.chunk.bindingId,
        turnId: request.chunk.turnId,
      },
      cancelled: false,
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
      if (active.cancelled || this.destroyed) {
        return { status: "cancelled", durationMs: 0 };
      }
      const playbackError = this.queue.takePlaybackError?.();
      return playbackError
        ? { status: "failed", durationMs: 0, error: playbackError }
        : { status: "played", durationMs };
    } finally {
      request.signal.removeEventListener("abort", onAbort);
      if (this.active === active) this.active = undefined;
    }
  }

  currentSource(): VoiceConsoleSpeechSourceRef | null {
    return this.active ? { ...this.active.source } : null;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.active) this.active.cancelled = true;
    this.queue.destroy();
    this.active = undefined;
  }
}

function pcmDurationMs(pcm: TtsPcm): number {
  if (pcm.sampleRate <= 0 || pcm.channels <= 0 || pcm.pcm.byteLength % 2 !== 0) {
    throw new Error("Voice Console playback received invalid int16 PCM metadata");
  }
  return Math.round(
    (pcm.pcm.byteLength / (pcm.sampleRate * pcm.channels * 2)) * 1_000
  );
}

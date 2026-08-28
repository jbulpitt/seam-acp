import { StreamingSpeechSegmenter } from "../../core/audio/streaming-speech-segmenter.js";
import type { TtsPcm } from "../../core/thread-voice/types.js";

export type ThreadVoiceSynthesisResult =
  | { ok: true; audio: TtsPcm }
  | { ok: false; error: string };

/** Sequential sentence/chunk synthesis followed by ordered PCM enqueue. */
export class ThreadVoiceSpeechPipeline {
  private readonly segmenter = new StreamingSpeechSegmenter();
  private readonly synthesize: (text: string) => Promise<ThreadVoiceSynthesisResult>;
  private readonly speak: (pcm: TtsPcm) => Promise<void>;
  private readonly waitForPlaybackIdle: () => Promise<void>;
  private readonly onFailure: (error: string, text: string) => void;
  private tail = Promise.resolve();
  private flushed = false;
  private chunks = 0;
  private played = 0;
  private cancelled = false;
  private drainPromise?: Promise<{ chunks: number; played: number }>;

  constructor(opts: {
    synthesize: (text: string) => Promise<ThreadVoiceSynthesisResult>;
    speak: (pcm: TtsPcm) => Promise<void>;
    waitForPlaybackIdle: () => Promise<void>;
    onFailure?: (error: string, text: string) => void;
  }) {
    this.synthesize = opts.synthesize;
    this.speak = opts.speak;
    this.waitForPlaybackIdle = opts.waitForPlaybackIdle;
    this.onFailure = opts.onFailure ?? (() => {});
  }

  feed(text: string): void {
    if (this.flushed || this.cancelled) return;
    this.enqueue(this.segmenter.feed(text));
  }

  async flushAndDrain(): Promise<{ chunks: number; played: number }> {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.doFlushAndDrain();
    return this.drainPromise;
  }

  private async doFlushAndDrain(): Promise<{ chunks: number; played: number }> {
    if (!this.flushed) {
      this.flushed = true;
      this.enqueue(this.segmenter.flush());
    }
    await this.tail;
    try {
      await this.waitForPlaybackIdle();
    } catch (err) {
      this.onFailure(err instanceof Error ? err.message : String(err), "");
    }
    return { chunks: this.chunks, played: this.played };
  }

  cancel(): void {
    this.cancelled = true;
  }

  private enqueue(chunks: string[]): void {
    for (const text of chunks) {
      this.chunks += 1;
      this.tail = this.tail.then(async () => {
        if (this.cancelled) return;
        try {
          const result = await this.synthesize(text);
          if (this.cancelled) return;
          if (!result.ok) {
            this.onFailure(result.error, text);
            return;
          }
          await this.speak(result.audio);
          this.played += 1;
        } catch (err) {
          this.onFailure(err instanceof Error ? err.message : String(err), text);
        }
      });
    }
  }
}

export function shouldAttachCompletedTurnVoice(threadVoiceActive: boolean): boolean {
  return !threadVoiceActive;
}

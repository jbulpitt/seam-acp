import type { Logger } from "../../lib/logger.js";
import type {
  DroppedVoiceSegment,
  FinalVoiceSegment,
} from "../../core/thread-voice/types.js";
import type {
  GeminiLiveTranscribeResult,
} from "../../core/audio/gemini-live-transcribe.js";
import type {
  ThreadVoiceCaptureEnd,
  ThreadVoiceCaptureRef,
  ThreadVoicePcmChunk,
} from "./thread-voice-call.js";

export interface ThreadVoiceTranscribePort {
  startUtterance(): Promise<void>;
  sendPcm16k(pcm: Uint8Array): void;
  finalizeUtterance(pcm: Uint8Array): Promise<GeminiLiveTranscribeResult>;
  /** V2 safety hook; V1 ports may omit it and retain close/fallback behavior. */
  cancelUtterance?(): void;
}

export interface ThreadVoiceCaptureCoordinatorCallbacks {
  onInterim: (sequence: number, text: string) => void;
  onFinal: (segment: FinalVoiceSegment) => void;
  onDropped: (segment: DroppedVoiceSegment) => void;
  onAudioSent: (durationMs: number) => void;
  onTranscribing?: (sequence: number) => void;
  /** Additive V2 hook; unary wins if any continuation part required it. */
  onTranscriptionSource?: (sequence: number, source: "live" | "unary") => void;
}

type CapturePart = {
  ref: ThreadVoiceCaptureRef;
  startedUtc: string;
  endedUtc?: string;
  chunks: Buffer[];
  started: boolean;
  ended?: ThreadVoiceCaptureEnd;
  completion: Promise<PartResult>;
  resolveEnd: () => void;
  endPromise: Promise<void>;
};

type PartResult = {
  ref: ThreadVoiceCaptureRef;
  startedUtc: string;
  endedUtc: string;
  durationMs: number;
  continuation: boolean;
  usable: boolean;
  text: string;
  source?: "live" | "unary";
  error?: string;
};

type LogicalCapture = {
  sequence: number;
  startedUtc: string;
  parts: Map<number, Promise<PartResult>>;
  terminalPart?: number;
  finalized: boolean;
};

/**
 * Serializes Package C capture parts over Package B's one-live-utterance API.
 *
 * A continuation may open synchronously while the prior part is still waiting
 * for a Live final or unary fallback. Its PCM is retained in memory and flushed
 * in capture order once the prior part settles. Logical output is emitted once,
 * only after the terminal continuation marker has arrived. This deliberately
 * treats an empty exact-boundary terminal part as a marker rather than evidence
 * that the earlier usable continuation text should be discarded.
 */
export class ThreadVoiceCaptureCoordinator {
  private readonly ownerUserId: string;
  private readonly transcribe: ThreadVoiceTranscribePort;
  private readonly callbacks: ThreadVoiceCaptureCoordinatorCallbacks;
  private readonly logger: Logger;
  private readonly now: () => string;
  private readonly parts = new Map<string, CapturePart>();
  private readonly logical = new Map<number, LogicalCapture>();
  private readonly abortedSequences = new Set<number>();
  private serial = Promise.resolve();
  private activePart?: CapturePart;
  private forwardedByteRemainder = 0;

  constructor(opts: {
    ownerUserId: string;
    transcribe: ThreadVoiceTranscribePort;
    callbacks: ThreadVoiceCaptureCoordinatorCallbacks;
    logger: Logger;
    now?: () => string;
  }) {
    this.ownerUserId = opts.ownerUserId;
    this.transcribe = opts.transcribe;
    this.callbacks = opts.callbacks;
    this.logger = opts.logger;
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  onCaptureStart(ref: ThreadVoiceCaptureRef): void {
    const key = partKey(ref);
    if (this.parts.has(key)) return;
    let resolveEnd!: () => void;
    const endPromise = new Promise<void>((resolve) => {
      resolveEnd = resolve;
    });
    const part: CapturePart = {
      ref,
      startedUtc: this.now(),
      chunks: [],
      started: false,
      resolveEnd,
      endPromise,
      completion: undefined as unknown as Promise<PartResult>,
    };
    const prior = this.serial;
    part.completion = prior
      .then(() => this.processPart(part))
      .catch((err): PartResult => ({
        ref,
        startedUtc: part.startedUtc,
        endedUtc: part.endedUtc ?? this.now(),
        durationMs: part.ended?.durationMs ?? 0,
        continuation: part.ended?.continuation ?? false,
        usable: false,
        text: "",
        error: errorMessage(err),
      }));
    this.serial = part.completion.then(() => undefined, () => undefined);
    this.parts.set(key, part);

    let logical = this.logical.get(ref.sequence);
    if (!logical) {
      logical = {
        sequence: ref.sequence,
        startedUtc: part.startedUtc,
        parts: new Map(),
        finalized: false,
      };
      this.logical.set(ref.sequence, logical);
    }
    logical.parts.set(ref.part, part.completion);
  }

  onPcm(chunk: ThreadVoicePcmChunk): void {
    const part = this.parts.get(partKey(chunk));
    if (!part || part.ended) return;
    const pcm = Buffer.from(chunk.pcm16kMono);
    if (part.started && this.activePart === part) {
      this.transcribe.sendPcm16k(pcm);
    } else {
      part.chunks.push(pcm);
    }
  }

  onCaptureEnd(end: ThreadVoiceCaptureEnd): void {
    const part = this.parts.get(partKey(end));
    if (!part || part.ended) return;
    part.ended = end;
    part.endedUtc = this.now();
    part.resolveEnd();
    const logical = this.logical.get(end.sequence);
    if (!logical) return;
    if (!end.continuation) {
      logical.terminalPart = end.part;
      void this.finalizeLogical(logical);
    }
  }

  onInterim(text: string): void {
    const sequence = this.activePart?.ref.sequence;
    if (sequence !== undefined && text.trim()) this.callbacks.onInterim(sequence, text);
  }

  /**
   * Additive V2 reuse hook: discard one logical sequence without starting a
   * queued Google activity or invoking unary fallback after its capture gate
   * supplies the terminal end marker. Existing V1 callers never use this.
   */
  abortSequence(sequence: number): void {
    if (Number.isSafeInteger(sequence) && sequence > 0) {
      this.abortedSequences.add(sequence);
    }
  }

  /** Package B telemetry: bytes actually accepted by the open Google socket. */
  onForwardedBytes(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    this.forwardedByteRemainder += Math.trunc(bytes);
    const durationMs = Math.floor(this.forwardedByteRemainder / 32);
    if (durationMs <= 0) return;
    this.forwardedByteRemainder -= durationMs * 32;
    this.callbacks.onAudioSent(durationMs);
  }

  async idle(): Promise<void> {
    await this.serial;
    const finalizers = [...this.logical.values()].map((logical) =>
      logical.terminalPart === undefined ? Promise.resolve() : this.finalizeLogical(logical)
    );
    await Promise.all(finalizers);
  }

  private async processPart(part: CapturePart): Promise<PartResult> {
    if (part.ended && this.abortedSequences.has(part.ref.sequence)) {
      return this.abortedPartResult(part);
    }
    // A queued exact-boundary marker can finish empty before its predecessor's
    // final settles. Skip a Google activity for that marker entirely.
    if (part.ended && part.ended.pcm16kMono.byteLength === 0) {
      return this.noNetworkPartResult(part);
    }
    await this.transcribe.startUtterance();
    part.started = true;
    this.activePart = part;
    for (const pcm of part.chunks.splice(0)) this.transcribe.sendPcm16k(pcm);
    await part.endPromise;
    if (this.abortedSequences.has(part.ref.sequence)) {
      return this.abortedPartResult(part);
    }
    this.callbacks.onTranscribing?.(part.ref.sequence);
    const end = part.ended!;
    let result: GeminiLiveTranscribeResult;
    try {
      result = await this.transcribe.finalizeUtterance(end.pcm16kMono);
    } finally {
      if (this.activePart === part) this.activePart = undefined;
    }
    return this.partResult(part, result);
  }

  private partResult(part: CapturePart, result: GeminiLiveTranscribeResult): PartResult {
    const end = part.ended!;
    return {
      ref: part.ref,
      startedUtc: part.startedUtc,
      endedUtc: part.endedUtc ?? this.now(),
      durationMs: end.durationMs,
      continuation: end.continuation,
      usable: end.usable,
      text: result.ok && end.usable ? result.text.trim() : "",
      source: result.source,
      ...(!result.ok ? { error: result.error } : {}),
    };
  }

  private abortedPartResult(part: CapturePart): PartResult {
    const end = part.ended!;
    return {
      ref: part.ref,
      startedUtc: part.startedUtc,
      endedUtc: part.endedUtc ?? this.now(),
      durationMs: end.durationMs,
      continuation: end.continuation,
      usable: false,
      text: "",
      error: "capture aborted",
    };
  }

  private noNetworkPartResult(part: CapturePart): PartResult {
    const end = part.ended!;
    return {
      ref: part.ref,
      startedUtc: part.startedUtc,
      endedUtc: part.endedUtc ?? this.now(),
      durationMs: end.durationMs,
      continuation: end.continuation,
      usable: false,
      text: "",
      error: "empty capture marker",
    };
  }

  private async finalizeLogical(logical: LogicalCapture): Promise<void> {
    if (logical.finalized || logical.terminalPart === undefined) return;
    logical.finalized = true;
    const promises = [...logical.parts.entries()]
      .filter(([part]) => part <= logical.terminalPart!)
      .sort(([a], [b]) => a - b)
      .map(([, completion]) => completion);
    const parts = await Promise.all(promises);
    const transcript = parts.map((part) => part.text).filter(Boolean).join("\n").trim();
    const durationMs = parts.reduce((sum, part) => sum + part.durationMs, 0);
    const endedUtc = parts.at(-1)?.endedUtc ?? this.now();
    const source = parts.some((part) => part.source === "unary")
      ? "unary"
      : parts.some((part) => part.source === "live")
        ? "live"
        : undefined;
    if (source) this.callbacks.onTranscriptionSource?.(logical.sequence, source);
    if (transcript) {
      this.callbacks.onFinal({
        sequence: logical.sequence,
        authorId: this.ownerUserId,
        transcript,
        audioMs: durationMs,
        capturedStartedUtc: logical.startedUtc,
        capturedEndedUtc: endedUtc,
      });
    } else {
      const error = parts.map((part) => part.error).filter(Boolean).join("; ");
      this.callbacks.onDropped({
        sequence: logical.sequence,
        authorId: this.ownerUserId,
        state: error && parts.some((part) => part.usable)
          ? "transcribe_failed"
          : "capture_dropped",
        audioMs: durationMs,
        capturedStartedUtc: logical.startedUtc,
        capturedEndedUtc: endedUtc,
        ...(error ? { error } : {}),
      });
    }
    this.logger.info(
      {
        sequence: logical.sequence,
        parts: parts.length,
        audioMs: durationMs,
        chars: transcript.length,
      },
      "thread-voice logical capture settled"
    );
    this.logical.delete(logical.sequence);
    this.abortedSequences.delete(logical.sequence);
    for (const part of parts) this.parts.delete(partKey(part.ref));
  }
}

function partKey(ref: ThreadVoiceCaptureRef): string {
  return `${ref.sequence}:${ref.part}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

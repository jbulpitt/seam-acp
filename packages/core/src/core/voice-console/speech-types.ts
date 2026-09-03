import type { TtsPace, TtsPcm, TtsStyle } from "../audio/gemini-tts.js";

export interface VoiceConsoleSpeechProfile {
  voice: string;
  pace: TtsPace;
  style: TtsStyle;
}

export interface VoiceConsoleSpeechSourceRef {
  consoleId: string;
  bindingId: string;
  turnId: string;
}

/**
 * Delimiter for Voice Console composite `Map` keys (#171).
 *
 * These keys are process-local only — never persisted, logged, or rendered
 * (a read-only scan of the live DB found zero occurrences across 30 tables and
 * 365 columns), so the byte itself is an implementation detail and is
 * deliberately left as-is.
 *
 * It is nonetheless load-bearing. Without a delimiter, unregistering binding
 * `b1` prefix-matches `b10`, and the tuples `(12, 3)` and `(1, 23)` collide.
 *
 * Correctness needs exactly one property: the delimiter must not occur in the
 * FIRST component. Binding ids are authority ids
 * (`assertVoiceConsoleAuthorityId`, `^[A-Za-z0-9_-]{1,48}$`), which excludes it,
 * and the scheduler now enforces that at its registration boundary. Turn ids
 * are deliberately NOT constrained — they legitimately carry colons
 * (`dispatch:<id>`, `scheduled:<id>:<ts>`) — because the first delimiter
 * occurrence already terminates the binding id, leaving the rest unambiguous.
 */
export const VOICE_CONSOLE_KEY_DELIMITER = "\u0000";

/**
 * The one source-key format, shared by the speech scheduler and the Discord
 * voice console controller. Previously duplicated in both.
 */
export function voiceConsoleSpeechSourceKey(ref: VoiceConsoleSpeechSourceRef): string {
  return `${ref.bindingId}${VOICE_CONSOLE_KEY_DELIMITER}${ref.turnId}`;
}

/**
 * Prefix matching exactly the source keys of one binding. Derived from the same
 * delimiter as the key itself, so a prefix scan can never drift from the format
 * it is scanning.
 */
export function voiceConsoleSpeechBindingKeyPrefix(bindingId: string): string {
  return `${bindingId}${VOICE_CONSOLE_KEY_DELIMITER}`;
}

export interface VoiceConsoleSpeechChunk extends VoiceConsoleSpeechSourceRef {
  ordinal: number;
  text: string;
  generation: number;
}

export interface VoiceConsoleSynthesisRequest {
  chunk: VoiceConsoleSpeechChunk;
  profile: VoiceConsoleSpeechProfile;
  signal: AbortSignal;
  /** Awaited per provider delta; playback applies bounded backpressure here. */
  onAudioDelta: (audio: TtsPcm) => Promise<void>;
}

export type VoiceConsoleSynthesisResult =
  | { ok: true; audio: TtsPcm }
  | { ok: true; streamed: true; audioDeltas: number }
  | { ok: false; error: string };

export interface VoiceConsolePlaybackRequest {
  chunk: VoiceConsoleSpeechChunk;
  audio: TtsPcm;
  signal: AbortSignal;
}

export type VoiceConsolePlaybackResult =
  | { status: "played"; durationMs: number }
  | { status: "cancelled"; durationMs: number }
  | { status: "failed"; durationMs: number; error: string };

export interface VoiceConsoleSpeechPlayback {
  play(request: VoiceConsolePlaybackRequest): Promise<VoiceConsolePlaybackResult>;
  /** Optional local, non-verbal marker played once after a completed source. */
  playEndIndicator?(
    request: Omit<VoiceConsolePlaybackRequest, "audio">
  ): Promise<VoiceConsolePlaybackResult>;
  /** Optional only for compatibility with unary test/legacy playback adapters. */
  beginStream?(request: Omit<VoiceConsolePlaybackRequest, "audio">): VoiceConsolePlaybackStream;
  /** Best-effort current airtime for cancellation races that settle before play(). */
  currentConsumedAudioMs?(): number;
  destroy(): void;
}

export interface VoiceConsolePlaybackStream {
  enqueue(audio: TtsPcm): Promise<void>;
  finish(): Promise<VoiceConsolePlaybackResult>;
  cancel(): void;
}

export type VoiceConsoleSpeechFailurePhase = "synthesis" | "playback";

export interface VoiceConsoleSpeechFailure {
  source: VoiceConsoleSpeechSourceRef;
  ordinal: number;
  phase: VoiceConsoleSpeechFailurePhase;
  error: string;
}

export type VoiceConsoleSpeechWorkPhase = "synthesis" | "playback";

export interface VoiceConsoleBindingStateConflict {
  generation: number;
  localOutputEnabled: boolean;
  receivedOutputEnabled: boolean;
}

export interface VoiceConsoleSpeechStats {
  accepted: number;
  played: number;
  failed: number;
  dropped: number;
  playedAudioMs: number;
}

export interface VoiceConsoleSpeechBindingSnapshot {
  bindingId: string;
  outputEnabled: boolean;
  generation: number;
  profile: VoiceConsoleSpeechProfile;
  queuedChunks: number;
  activeSources: number;
  /** Runtime output is forced off until a strictly newer durable generation arrives. */
  stateConflict: VoiceConsoleBindingStateConflict | null;
  /** Cleared by the next source, successful playback, or authoritative state sync. */
  recentFailure: VoiceConsoleSpeechFailure | null;
  stats: VoiceConsoleSpeechStats;
}

export interface VoiceConsoleSpeechSchedulerSnapshot {
  consoleId: string;
  currentSource: VoiceConsoleSpeechSourceRef | null;
  currentPhase: VoiceConsoleSpeechWorkPhase | null;
  queueDepth: number;
  bindings: VoiceConsoleSpeechBindingSnapshot[];
  destroyed: boolean;
}

export type VoiceConsoleBindingStateSyncResult = "applied" | "unchanged" | "stale";

export type VoiceConsoleSpeechStateChangeReason =
  | "binding-registered"
  | "binding-synced"
  | "binding-conflict"
  | "binding-conflict-cleared"
  | "binding-invalidated"
  | "binding-unregistered"
  | "profile-updated"
  | "source-registered"
  | "source-cancelled"
  | "source-settled"
  | "queue-changed"
  | "work-started"
  | "work-phase-changed"
  | "work-settled"
  | "failure"
  | "recovered"
  | "destroyed";

export interface VoiceConsoleSpeechStateChange {
  /** Multiple synchronous mutations are coalesced into one callback. */
  reasons: VoiceConsoleSpeechStateChangeReason[];
  snapshot: VoiceConsoleSpeechSchedulerSnapshot;
}

export type VoiceConsoleChunkDisposition = "accepted" | "dropped";

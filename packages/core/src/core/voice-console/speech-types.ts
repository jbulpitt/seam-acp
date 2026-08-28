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

export interface VoiceConsoleSpeechChunk extends VoiceConsoleSpeechSourceRef {
  ordinal: number;
  text: string;
  generation: number;
}

export interface VoiceConsoleSynthesisRequest {
  chunk: VoiceConsoleSpeechChunk;
  profile: VoiceConsoleSpeechProfile;
  signal: AbortSignal;
}

export type VoiceConsoleSynthesisResult =
  | { ok: true; audio: TtsPcm }
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
  destroy(): void;
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

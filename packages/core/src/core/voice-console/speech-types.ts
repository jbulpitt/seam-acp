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
  | { status: "cancelled"; durationMs: number };

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
  stats: VoiceConsoleSpeechStats;
}

export interface VoiceConsoleSpeechSchedulerSnapshot {
  consoleId: string;
  currentSource: VoiceConsoleSpeechSourceRef | null;
  queueDepth: number;
  bindings: VoiceConsoleSpeechBindingSnapshot[];
  destroyed: boolean;
}

export type VoiceConsoleChunkDisposition = "accepted" | "dropped";

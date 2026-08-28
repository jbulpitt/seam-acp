import { randomBytes } from "node:crypto";

import type {
  ThreadVoiceDispatchArtifactState,
  ThreadVoiceSegmentState,
} from "../thread-voice/types.js";

export const VOICE_CONSOLE_ACTIVE_STATUSES = ["starting", "ready", "stopping"] as const;
export type VoiceConsoleStatus =
  | (typeof VOICE_CONSOLE_ACTIVE_STATUSES)[number]
  | "ended"
  | "failed";

export const VOICE_CONSOLE_BINDING_ACTIVE_STATUSES = ["adding", "active", "removing"] as const;
export type VoiceConsoleBindingStatus =
  | (typeof VOICE_CONSOLE_BINDING_ACTIVE_STATUSES)[number]
  | "ended"
  | "failed";

export interface VoiceConsoleSession {
  id: string;
  platform: string;
  guildId: string;
  voiceChannelId: string;
  ownerUserId: string;
  ownerName: string;
  status: VoiceConsoleStatus;
  cardChannelId: string;
  cardMessageId: string | null;
  cardPage: number;
  revision: number;
  fanoutArmed: boolean;
  forwardedAudioBytes: number;
  forwardedAudioMs: number;
  utteranceCount: number;
  liveFinalCount: number;
  unaryFallbackCount: number;
  droppedCount: number;
  sttFailureCount: number;
  createdUtc: string;
  updatedUtc: string;
  endedUtc: string | null;
  endReason: string | null;
}

/** Active V2 bindings live in the compatibility `thread_voice_sessions` table. */
export interface ThreadVoiceBinding {
  id: string;
  consoleId: string;
  platform: string;
  channelRef: string;
  parentRef: string | null;
  guildId: string;
  voiceChannelId: string;
  ownerUserId: string;
  ownerName: string;
  status: VoiceConsoleBindingStatus;
  noticeMessageId: string | null;
  alias: string;
  aliasNormalized: string;
  ttsVoice: string;
  ttsPace: string | null;
  ttsStyle: string | null;
  profileUpdatedUtc: string;
  outputEnabled: boolean;
  outputGeneration: number;
  createdUtc: string;
  updatedUtc: string;
  endedUtc: string | null;
  endReason: string | null;
}

export interface VoiceConsoleInputTarget {
  consoleId: string;
  bindingId: string;
  ordinal: number;
  selectedUtc: string;
}

export interface VoiceConsoleCaptureAssignment {
  bindingId: string;
  sequence: number;
  segmentId: string;
}

export interface VoiceConsoleCaptureSnapshot {
  captureId: string;
  fanoutGroupId: string | null;
  consoleId: string;
  consoleRevision: number;
  speakerId: string;
  speakerName: string;
  capturedStartedUtc: string;
  assignments: VoiceConsoleCaptureAssignment[];
}

export interface VoiceConsoleSegment {
  id: string;
  bindingId: string;
  sequence: number;
  captureId: string | null;
  fanoutGroupId: string | null;
  authorId: string;
  authorName: string;
  transcript: string;
  state: ThreadVoiceSegmentState;
  audioMs: number;
  dispatchId: string | null;
  capturedStartedUtc: string;
  capturedEndedUtc: string;
  createdUtc: string;
  updatedUtc: string;
  error: string | null;
}

export interface VoiceConsoleBatch {
  dispatchId: string;
  console: VoiceConsoleSession | null;
  binding: ThreadVoiceBinding;
  segments: VoiceConsoleSegment[];
  prompt: string;
  authorId: string;
  authorName: string;
}

export interface CreateVoiceConsoleInput {
  console: VoiceConsoleSession;
  binding: ThreadVoiceBinding;
  selectBinding?: boolean;
}

export interface AddVoiceConsoleBindingInput {
  binding: ThreadVoiceBinding;
  claim?: boolean;
  expectedRevision: number;
  interactionId?: string;
}

export interface VoiceConsoleMutationResult {
  applied: boolean;
  duplicate: boolean;
  console: VoiceConsoleSession;
  bindings: ThreadVoiceBinding[];
  targets: VoiceConsoleInputTarget[];
}

export type VoiceConsoleMutationFailure =
  | "not-found"
  | "inactive"
  | "stale-revision"
  | "invalid-targets"
  | "binding-limit"
  | "duplicate-thread"
  | "duplicate-alias"
  | "host-attach-failed"
  | "activation-failed"
  | "recovered-pending"
  | "interaction-pending"
  | "interaction-collision";

export type VoiceConsoleMutationOutcome =
  | { ok: true; value: VoiceConsoleMutationResult }
  | {
      ok: false;
      reason: VoiceConsoleMutationFailure;
      error: string;
      duplicate?: boolean;
      /** Failed external work originally surfaced as an exception. */
      replayAsException?: boolean;
    };

export type VoiceConsoleAddInteractionStatus = "pending" | "succeeded" | "failed";

export interface VoiceConsoleAddInteraction {
  consoleId: string;
  interactionId: string;
  bindingId: string;
  inputFingerprint: string;
  status: VoiceConsoleAddInteractionStatus;
  failureCode: VoiceConsoleMutationFailure | null;
  failureMessage: string | null;
  failureAsException: boolean;
  createdUtc: string;
  updatedUtc: string;
}

export function sanitizeVoiceConsoleFailureMessage(value: string): string {
  const sanitized = [...value]
    .map((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127 ? " " : char;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  return sanitized || "Voice Console binding add failed.";
}

export interface VoiceConsoleFinalCapture {
  captureId: string;
  speakerId: string;
  speakerName: string;
  transcript: string;
  /** STT/capture duration retained on each target segment. */
  audioMs: number;
  /** Cumulative 16 kHz mono PCM duration, counted once for this capture. */
  forwardedAudioMs?: number;
  capturedEndedUtc: string;
  /** Final capture authorization is supplied by the integration allowlist check. */
  speakerAuthorized: boolean;
  resultSource?: "live" | "unary";
  error?: string;
}

export type VoiceConsoleCaptureTerminalOutcome = "committed" | "dropped" | "failed";

/**
 * One durable winner for a logical capture. The row is keyed by captureId, so
 * fan-out targets share one accounting boundary and retries can only replay it.
 */
export interface VoiceConsoleCaptureTerminal {
  captureId: string;
  consoleId: string;
  outcome: VoiceConsoleCaptureTerminalOutcome;
  reason: string | null;
  resultSource: "live" | "unary" | null;
  /** STT/capture duration retained on target segments. */
  audioMs: number;
  /** Cumulative forwarded PCM duration counted once on the console. */
  forwardedAudioMs: number;
  capturedEndedUtc: string;
  createdUtc: string;
}

export interface VoiceConsoleDropCaptureInput {
  captureId: string;
  reason: string;
  capturedEndedUtc: string;
  audioMs: number;
  forwardedAudioMs: number;
  /** Distinguishes ordinary safety/noise drops from STT/host failures. */
  outcome?: "dropped" | "failed";
  resultSource?: "live" | "unary";
}

export interface VoiceConsoleCaptureCommitResult {
  captureId: string;
  terminal: VoiceConsoleCaptureTerminal | null;
  duplicate: boolean;
  committed: VoiceConsoleSegment[];
  dropped: VoiceConsoleSegment[];
  failures: Array<{ bindingId: string; error: string }>;
}

export interface VoiceConsoleDispatchRequest {
  id: string;
  target: string;
  prompt: string;
  authorId: string;
  authorName: string;
  consoleId: string;
  bindingId: string;
  createdUtc: string;
}

export interface VoiceConsoleDispatchHost {
  /**
   * True for any binding-local ACP/channel work, regardless of origin: typed,
   * wake, handoff, report-back, generic dispatch, or Thread Voice dispatch.
   */
  isBindingBusy(binding: ThreadVoiceBinding): boolean | Promise<boolean>;
  inspectArtifact(dispatchId: string): Promise<ThreadVoiceDispatchArtifactState>;
  enqueue(request: VoiceConsoleDispatchRequest): Promise<void>;
}

export interface VoiceConsoleRuntimeHost {
  startConsole(
    console: VoiceConsoleSession,
    bindings: readonly ThreadVoiceBinding[]
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  addBinding(
    console: VoiceConsoleSession,
    binding: ThreadVoiceBinding
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Package E installs capture/speech/card verification before returning. */
  reconcileConsole(
    console: VoiceConsoleSession,
    bindings: readonly ThreadVoiceBinding[]
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  stopConsole(consoleId: string, reason: string): Promise<void>;
  stopBinding(bindingId: string, reason: string): Promise<void>;
  /**
   * Drains every accepted speech source for this binding, including speech
   * created by visible generic dispatch/handoff/report-back turns.
   */
  waitForBindingSpeechIdle(bindingId: string): Promise<void>;
}

export type VoiceConsoleStartResult =
  | { ok: true; console: VoiceConsoleSession; binding: ThreadVoiceBinding }
  | { ok: false; error: string };

export type VoiceConsoleRemoveResult =
  | { ok: true; discarded: number; consoleEnded: boolean; duplicate?: true }
  | { ok: false; error: string };

export interface VoiceConsoleUpgradeDefaults {
  aliasFor(binding: { channelRef: string }): string;
  profileFor(binding: { channelRef: string }): {
    voice: string;
    pace: string | null;
    style: string | null;
  };
}

export interface VoiceConsoleBootResult {
  upgraded: number;
  reconciled: number;
  ended: number;
  dispatchesEnqueued: number;
  dispatchesFound: number;
  failures: number;
}

export function newVoiceConsoleId(): string {
  return `tvc_${randomBytes(9).toString("base64url")}`;
}

export function newVoiceConsoleBindingId(): string {
  return `tvb_${randomBytes(9).toString("base64url")}`;
}

export function newVoiceConsoleCaptureId(): string {
  return `tvcap_${randomBytes(9).toString("base64url")}`;
}

export function newVoiceConsoleFanoutGroupId(): string {
  return `tvfg_${randomBytes(9).toString("base64url")}`;
}

export function normalizeVoiceConsoleAlias(alias: string): string {
  return alias.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export function assertVoiceConsoleAuthorityId(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{1,48}$/.test(value)) {
    throw new Error(`${label} must be 1-48 colon-free characters using A-Z, a-z, 0-9, _ or -.`);
  }
}

export function sanitizeVoiceConsoleSpeakerName(value: string): string {
  const sanitized = value
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/@/g, "＠")
    .trim()
    .replace(/\s+/g, " ");
  return [...(sanitized || "Unknown speaker")].slice(0, 80).join("");
}

export function composeVoiceConsolePrompt(
  speakerId: string,
  segments: readonly Pick<VoiceConsoleSegment, "sequence" | "transcript">[]
): string {
  const body = segments
    .map((segment) => `Voice segment ${segment.sequence}:\n${segment.transcript}`)
    .join("\n\n");
  return `<thread-voice-input speaker-id="${speakerId}">\n${body}\n</thread-voice-input>`;
}

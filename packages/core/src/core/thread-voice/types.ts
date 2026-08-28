import { randomBytes } from "node:crypto";

export const THREAD_VOICE_ACTIVE_STATUSES = ["starting", "ready", "stopping"] as const;
export type ThreadVoiceSessionStatus =
  | (typeof THREAD_VOICE_ACTIVE_STATUSES)[number]
  | "ended"
  | "failed";

export type ThreadVoiceRuntimeState =
  | "starting"
  | "ready"
  | "capturing"
  | "transcribing"
  | "queued"
  | "agent_working"
  | "speaking"
  | "stopping"
  | "ended"
  | "failed";

export type ThreadVoiceSegmentState =
  | "capturing"
  | "finalizing"
  | "pending"
  | "batched"
  | "dispatched"
  | "capture_dropped"
  | "transcribe_failed"
  | "discarded";

export type ThreadVoiceDropState = "capture_dropped" | "transcribe_failed";

export interface ThreadVoiceSession {
  id: string;
  platform: string;
  channelRef: string;
  parentRef: string | null;
  guildId: string;
  voiceChannelId: string;
  ownerUserId: string;
  ownerName: string;
  status: ThreadVoiceSessionStatus;
  noticeMessageId: string | null;
  transmittedAudioMs: number;
  createdUtc: string;
  updatedUtc: string;
  endedUtc: string | null;
  endReason: string | null;
}

export interface ThreadVoiceSegment {
  id: string;
  sessionId: string;
  /** Assigned at the unmute edge. This, never completion time, defines order. */
  sequence: number;
  authorId: string;
  /** Finalized transcript text only. Raw/interim audio is never stored here. */
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

export interface FinalVoiceSegment {
  sequence: number;
  authorId: string;
  transcript: string;
  audioMs: number;
  capturedStartedUtc: string;
  capturedEndedUtc: string;
}

export interface DroppedVoiceSegment {
  sequence: number;
  authorId: string;
  state: ThreadVoiceDropState;
  audioMs: number;
  capturedStartedUtc: string;
  capturedEndedUtc: string;
  error?: string;
}

export type OwnerVoiceState =
  | {
      ok: true;
      guildId: string;
      voiceChannelId: string;
      channelName: string | null;
      selfMuted: boolean;
      visible: boolean;
    }
  | { ok: false; reason: string };

export interface ThreadVoiceStartRequest {
  platform: string;
  channelRef: string;
  parentRef: string | null;
  guildId: string;
  ownerUserId: string;
  ownerName: string;
}

export interface ThreadVoiceBatch {
  dispatchId: string;
  session: ThreadVoiceSession;
  segments: ThreadVoiceSegment[];
  prompt: string;
}

export type ThreadVoiceDispatchArtifactState =
  | "missing"
  | "pending"
  | "running"
  | "done";

export interface ThreadVoiceDispatchRequest {
  id: string;
  target: string;
  prompt: string;
  authorId: string;
  authorName: string;
  threadVoiceSessionId: string;
  createdUtc: string;
}

export interface TtsPcm {
  pcm: Uint8Array;
  sampleRate: number;
  channels: number;
}

export type ThreadVoiceNotification =
  | { kind: "state"; sessionId: string; state: ThreadVoiceRuntimeState }
  | { kind: "interim"; sessionId: string; sequence: number; text: string }
  | { kind: "final"; sessionId: string; segment: ThreadVoiceSegment }
  | { kind: "ended"; sessionId: string; reason: string }
  | { kind: "failed"; sessionId: string; error: string };

export interface ThreadVoicePendingStats {
  segmentCount: number;
  characterCount: number;
  activeDispatchId: string | null;
}

export function newThreadVoiceSessionId(): string {
  return `tv_${randomBytes(9).toString("base64url")}`;
}

export function newThreadVoiceSegmentId(): string {
  return `tvs_${randomBytes(9).toString("base64url")}`;
}

export function newThreadVoiceDispatchId(): string {
  return `tvd_${randomBytes(12).toString("base64url")}`;
}

export function composeThreadVoicePrompt(
  ownerId: string,
  segments: readonly Pick<ThreadVoiceSegment, "sequence" | "transcript">[]
): string {
  const body = segments
    .map((segment) => `Voice segment ${segment.sequence}:\n${segment.transcript}`)
    .join("\n\n");
  return `<thread-voice-input owner-id="${ownerId}">\n${body}\n</thread-voice-input>`;
}

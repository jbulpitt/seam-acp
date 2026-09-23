/**
 * Local control protocol for seam-sessiond (#573).
 *
 * The supervisor is deliberately ignorant of ACP and adapters. It receives an
 * opaque executable launch, moves bytes, and reports process facts. JSON is
 * newline-delimited and binary data is base64 so arbitrary stdio bytes cannot
 * corrupt framing.
 */

export const SESSIOND_PROTOCOL_VERSION = 1;

export type SessiondMethod =
  | "spawn"
  | "write"
  | "subscribe"
  | "kill"
  | "listSlots"
  | "replayOutput";

export interface SessiondSpawnParams {
  slot: number;
  /** Absolute executable. Shell evaluation is never used. */
  executable: string;
  args?: string[];
  cwd: string;
  /** Exact child environment. The daemon does not merge provider policy. */
  env: Record<string, string>;
}

export interface SessiondWriteParams {
  slot: number;
  dataBase64: string;
}

export interface SessiondSubscribeParams {
  slot: number;
  afterSeq: number;
}

export interface SessiondKillParams {
  slot: number;
  signal?: NodeJS.Signals;
}

export interface SessiondReplayOutputParams {
  slot: number;
  afterSeq: number;
}

export interface SessiondRequest {
  v: typeof SESSIOND_PROTOCOL_VERSION;
  id: string;
  method: SessiondMethod;
  params?: unknown;
}

export interface SessiondResponse {
  v: typeof SESSIOND_PROTOCOL_VERSION;
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code:
      | "invalid_request"
      | "slot_exists"
      | "slot_not_found"
      | "slot_not_alive"
      | "spawn_failed"
      | "write_failed"
      | "internal_error";
    /** Closed, non-secret diagnostic. Never a raw child/process error. */
    message: string;
  };
}

export type SessiondOutputStream = "stdout" | "stderr" | "exit";

export interface SessiondOutputFrame {
  seq: number;
  at: number;
  stream: SessiondOutputStream;
  /** Present for stdout/stderr, absent for exit. */
  dataBase64?: string;
  /** Present for exit. */
  code?: number | null;
  signal?: NodeJS.Signals | null;
}

export interface SessiondOutputGap {
  afterSeq: number;
  firstAvailableSeq: number;
  droppedFrames: number;
}

export type SessiondEvent =
  | {
      v: typeof SESSIOND_PROTOCOL_VERSION;
      type: "output";
      slot: number;
      frame: SessiondOutputFrame;
      replay: boolean;
    }
  | {
      v: typeof SESSIOND_PROTOCOL_VERSION;
      type: "output_gap";
      slot: number;
      gap: SessiondOutputGap;
    };

export interface SessiondSlotHealth {
  slot: number;
  /** Stronger than entry presence: whether the recorded child still exists. */
  alive: boolean;
  pid: number | null;
  lastStdoutMsAgo: number | null;
  lastStdinMsAgo: number | null;
  /** False for a persisted orphan whose descriptors died with sessiond. */
  attached: boolean;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  orphanReason?: "supervisor_restarted" | "identity_mismatch" | "identity_unverifiable";
}

export interface SessiondListSlotsResult {
  /** Entry existence, retained for compatibility with the bridge contract. */
  slots: number[];
  health: SessiondSlotHealth[];
}

export interface SessiondReplayOutputResult {
  slot: number;
  frames: SessiondOutputFrame[];
  gap?: SessiondOutputGap;
}

export type SessiondWireMessage = SessiondResponse | SessiondEvent;

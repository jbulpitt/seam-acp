import { ADAPTER_ERROR_KINDS, type AdapterErrorKind } from "./error-classification.js";

/**
 * Versioned policy Seam supplies before a remote slot accepts stdin (#467).
 *
 * This is deliberately only rung 1. A bridge may retry the same ACP session
 * in the same child; model/session/context/user decisions remain in Seam.
 */
export interface RemoteRung1Policy {
  version: 1;
  retryCount: number;
  backoffMs: number[];
  retryableErrorKinds: AdapterErrorKind[];
}

export interface RemoteRecoveryBinding {
  version: 1;
  location: string;
  slot: number;
  submissionId: string;
  acpSessionId: string;
  delegatedUtc: string;
  /** Seam's already-selected model notice, persisted with submission ownership.
   * The bridge neither chooses a model nor interprets this delivery metadata. */
  modelFallbackNotice?: string;
}

export type RemoteRecoveryPhase =
  | "armed"
  | "executing"
  | "backoff"
  | "retrying"
  | "succeeded"
  | "exhausted"
  | "awaiting_app";

/** Closed facts safe for listSlots/workProgress and durable telemetry. */
export interface RemoteRecoverySnapshot {
  version: 1;
  owner: "bridge";
  submissionId: string;
  acpSessionId: string;
  rung: 1;
  phase: RemoteRecoveryPhase;
  retry: number;
  budget: number;
  remaining: number;
  disposition: "continue_same_session" | "none";
  errorKind?: AdapterErrorKind;
  terminalReason?:
    | "completed"
    | "budget_exhausted"
    | "client_request_requires_app"
    | "child_exited"
    | "result_limit_exceeded"
    | "cancelled";
  updatedUtc: string;
}

/** User-visible result carried on the existing sequenced slot output log. */
export interface RemoteRecoveryResult {
  version: 1;
  submissionId: string;
  acpSessionId: string;
  status: "completed" | "failed";
  text: string;
  stopReason?: string;
  errorKind?: AdapterErrorKind;
  finishedUtc: string;
}

const OPAQUE_ID = /^[A-Za-z0-9_-]{1,200}$/;
const TERMINAL_REASONS = [
  "completed",
  "budget_exhausted",
  "client_request_requires_app",
  "child_exited",
  "result_limit_exceeded",
  "cancelled",
] as const;

function validSessionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1_024
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validErrorKind(value: unknown): value is AdapterErrorKind {
  return typeof value === "string" && (ADAPTER_ERROR_KINDS as readonly string[]).includes(value);
}

export function isRemoteRung1Policy(value: unknown): value is RemoteRung1Policy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as Partial<RemoteRung1Policy>;
  return policy.version === 1
    && Number.isSafeInteger(policy.retryCount)
    && (policy.retryCount ?? -1) >= 0
    && (policy.retryCount ?? 0) <= 10
    && Array.isArray(policy.backoffMs)
    && policy.backoffMs.length === policy.retryCount
    && policy.backoffMs.every((delay) => Number.isSafeInteger(delay) && delay >= 0 && delay <= 60_000)
    && Array.isArray(policy.retryableErrorKinds)
    && policy.retryableErrorKinds.length <= ADAPTER_ERROR_KINDS.length
    && policy.retryableErrorKinds.every((kind) => ADAPTER_ERROR_KINDS.includes(kind));
}

export function isRemoteRecoverySnapshot(value: unknown): value is RemoteRecoverySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Partial<RemoteRecoverySnapshot>;
  return snapshot.version === 1
    && snapshot.owner === "bridge"
    && typeof snapshot.submissionId === "string" && OPAQUE_ID.test(snapshot.submissionId)
    && validSessionId(snapshot.acpSessionId)
    && snapshot.rung === 1
    && ["armed", "executing", "backoff", "retrying", "succeeded", "exhausted", "awaiting_app"].includes(snapshot.phase ?? "")
    && Number.isSafeInteger(snapshot.retry)
    && Number.isSafeInteger(snapshot.budget)
    && Number.isSafeInteger(snapshot.remaining)
    && (snapshot.retry ?? -1) >= 0
    && (snapshot.budget ?? -1) >= 0
    && (snapshot.remaining ?? -1) >= 0
    && (snapshot.retry ?? 0) <= (snapshot.budget ?? -1)
    && (snapshot.remaining ?? 0) <= (snapshot.budget ?? -1)
    && (snapshot.disposition === "continue_same_session" || snapshot.disposition === "none")
    && (snapshot.errorKind === undefined || validErrorKind(snapshot.errorKind))
    && (snapshot.terminalReason === undefined
      || (TERMINAL_REASONS as readonly string[]).includes(snapshot.terminalReason))
    && validDate(snapshot.updatedUtc);
}

export function isRemoteRecoveryResult(value: unknown): value is RemoteRecoveryResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Partial<RemoteRecoveryResult>;
  return result.version === 1
    && typeof result.submissionId === "string" && OPAQUE_ID.test(result.submissionId)
    && validSessionId(result.acpSessionId)
    && (result.status === "completed" || result.status === "failed")
    && typeof result.text === "string" && result.text.length <= 2 * 1024 * 1024
    && (result.stopReason === undefined
      || (typeof result.stopReason === "string" && result.stopReason.length <= 1_024))
    && (result.errorKind === undefined || validErrorKind(result.errorKind))
    && validDate(result.finishedUtc);
}

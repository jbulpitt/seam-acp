/**
 * Provider re-authentication (#454).
 *
 * The attempt row is the record. A prompt that already started is suspended
 * with a `reauth-waiting:` reason instead of being completed failed. Boot
 * and operator continuation stay refused until `acceptReauthWait` swaps that
 * prefix. Resume text is the existing recovery story, so the original prompt
 * is not sent again.
 *
 * #450 publishes the card and calls `acceptReauthWait`. This module does not
 * post a card, arm a timer, or insert an elicitation row: creating one posts
 * a card, and boot settles an ordinary elicitation row as interrupted.
 */
import { DispatchSuspendedError } from "./dispatch/attempt-store.js";
import {
  REAUTH_COMPLETED_PREFIX,
  REAUTH_WAITING_PREFIX,
  recoveryFactsFromAttempt,
  recoveryStory,
  type RecoveryAttemptSource,
  type RecoveryRender,
} from "./dispatch/recovery-story.js";
import {
  classifyClaudeAuthFailure,
  type ClaudeCredentialFacts,
} from "./claude-oauth-contention.js";

const REASON_MAX = 500;
export const REAUTH_WAITING_TEXT = `${REAUTH_WAITING_PREFIX} provider authentication expired`;
export const REAUTH_COMPLETED_TEXT =
  `${REAUTH_COMPLETED_PREFIX} provider authentication was completed outside this turn`;

export type ReauthDecision =
  | { action: "retry"; reason: string }
  | { action: "park"; reason: string; park: ReauthPark }
  | { action: "inconclusive"; reason: string }
  | { action: "bridge_rejected"; reason: string }
  | { action: "not_reauth"; reason: string };

export interface ReauthPark {
  errorKind: "auth_expired" | "auth_required";
  /** HTTPS, no embedded credentials. Absent when the failure offered none. */
  url?: string;
  /** Short device code copied from the message. Never invented. */
  userCode?: string;
  /** The message offered a loopback callback. That URL is not `url`. */
  loopbackRejected?: boolean;
}

export interface NegotiateReauthInput {
  errorKind?: string | null;
  agentId?: string | null;
  message?: string | null;
  /** WebSocket close 4001. A rejected bridge token is not a provider credential. */
  bridgeCloseCode?: number | null;
  /**
   * Present only when this process read the Claude refresh-token expiry.
   * `refreshTokenExpiresAt: null` means the store was unreadable, which is
   * not the same as expired. Omit the field when the store was not consulted.
   */
  claudeCredentials?: ClaudeCredentialFacts;
  now?: number;
}

const AUTH_KINDS = new Set(["auth_expired", "auth_required", "auth_contention"]);

export function negotiateReauth(input: NegotiateReauthInput): ReauthDecision {
  if (input.bridgeCloseCode === 4001) {
    return {
      action: "bridge_rejected",
      reason: "bridge token was rejected (close 4001); this is not a provider credential",
    };
  }
  const message = input.message ?? "";
  const kind = input.errorKind || "unclassified";
  if (input.claudeCredentials && AUTH_KINDS.has(kind)) {
    return fromClaudeCredentials(kind, message, input.claudeCredentials, input.now ?? Date.now());
  }
  if (kind === "auth_contention") {
    return { action: "retry", reason: "refresh contention stays with the prompt owner's existing retry" };
  }
  if (kind === "auth_expired" || kind === "auth_required") {
    return park(kind, message, `provider authentication failed (${kind})`);
  }
  return { action: "inconclusive", reason: `error kind ${kind} is not a provider authentication failure` };
}

function fromClaudeCredentials(
  kind: string,
  message: string,
  credentials: ClaudeCredentialFacts,
  now: number,
): ReauthDecision {
  const classified = classifyClaudeAuthFailure(message, credentials, now);
  if (classified.retryable) return { action: "retry", reason: classified.reason };
  if (credentials.refreshTokenExpiresAt === null) {
    return { action: "inconclusive", reason: classified.reason };
  }
  if (!classified.requiresReauth) return { action: "not_reauth", reason: classified.reason };
  return park(kind === "auth_required" ? "auth_required" : "auth_expired", message, classified.reason);
}

function park(kind: string, message: string, reason: string): ReauthDecision {
  const errorKind = kind === "auth_required" ? "auth_required" : "auth_expired";
  return { action: "park", reason, park: { errorKind, ...parseOffer(message) } };
}

export class ReauthParked extends Error {
  readonly park: ReauthPark;
  constructor(decision: Extract<ReauthDecision, { action: "park" }>, cause: unknown) {
    // Keep the provider message and classification. The park is additional.
    const message = cause instanceof Error && cause.message ? cause.message : decision.reason;
    super(message, cause instanceof Error ? { cause } : undefined);
    this.name = "ReauthParked";
    this.park = decision.park;
    if (cause && typeof cause === "object" && "data" in cause) {
      (this as { data?: unknown }).data = (cause as { data?: unknown }).data;
    }
  }
}

export function isAwaitingReauth(reason: string | null | undefined): reason is string {
  return typeof reason === "string" && reason.startsWith(REAUTH_WAITING_PREFIX);
}

/** Facts #450 can read off the stalled reason. Null when this is not a wait. */
export function parseReauthWait(reason: string | null | undefined): {
  url?: string;
  userCode?: string;
  loopbackRejected: boolean;
} | null {
  if (!isAwaitingReauth(reason)) return null;
  const url = reason.match(/(?:^|\s)url=(\S+)/)?.[1];
  const userCode = reason.match(/(?:^|\s)code=([A-Z0-9-]{4,17})(?:\s|$)/)?.[1];
  return {
    ...(url ? { url } : {}),
    ...(userCode ? { userCode } : {}),
    loopbackRejected: /(?:^|\s)loopback=1(?:\s|$)/.test(reason),
  };
}

export function reauthStalledReason(park: ReauthPark): string {
  const extras: string[] = [];
  if (park.loopbackRejected) extras.push("loopback=1");
  if (park.url && !/\s/.test(park.url)) extras.push(`url=${park.url}`);
  if (park.userCode && /^[A-Z0-9-]{4,17}$/.test(park.userCode)) extras.push(`code=${park.userCode}`);
  let text = [REAUTH_WAITING_TEXT, ...extras].join(" ");
  while (text.length > REASON_MAX && extras.length > 0) {
    extras.pop();
    text = [REAUTH_WAITING_TEXT, ...extras].join(" ");
  }
  return text.length > REASON_MAX ? text.slice(0, REASON_MAX) : text;
}

/** Plain notice. Not a card, and not a second prompt. */
export function reauthWaitNotice(park: ReauthPark): string {
  const lines = [
    "Provider authentication expired while this turn was in flight. The turn is parked and its prompt will not be replayed.",
  ];
  if (park.url) lines.push(`Authenticate at ${park.url}`);
  if (park.userCode) lines.push(`Device code: ${park.userCode}`);
  if (park.loopbackRejected) {
    lines.push("The failure offered a loopback callback on the wrong host. That address is not the link to open.");
  }
  lines.push("The parked attempt continues only after authentication is accepted.");
  return lines.join("\n");
}

/**
 * Suspend the attempt with the waiting reason. Returns the defect whose
 * reason IS that string, so a later quarantine notice does not replace it.
 * Null when the row could not be suspended.
 */
export function parkReauthAttempt(
  store: { markStalled(id: string, reason: string): boolean },
  attemptId: string,
  park: ReauthPark,
): DispatchSuspendedError | null {
  const reason = reauthStalledReason(park);
  if (!store.markStalled(attemptId, reason)) return null;
  return DispatchSuspendedError.defect(attemptId, reason);
}

export interface ReauthAttemptStore {
  get(id: string): (RecoveryAttemptSource & { state?: string }) | null;
  markStalled(id: string, reason: string, now?: string): boolean;
}

/**
 * Record that authentication happened outside the turn and return the
 * continue story. Does not prompt. Null when the attempt is not waiting:
 * that is "could not tell", not a resume and not a failure.
 */
export function acceptReauthWait(
  store: ReauthAttemptStore,
  attemptId: string,
  now: Date = new Date(),
): RecoveryRender | null {
  const before = store.get(attemptId);
  if (!before || before.state !== "suspended" || !isAwaitingReauth(before.stalledReason)) return null;
  store.markStalled(attemptId, REAUTH_COMPLETED_TEXT);
  const after = store.get(attemptId);
  if (!after?.stalledReason?.startsWith(REAUTH_COMPLETED_PREFIX)) return null;
  const facts = recoveryFactsFromAttempt(after, now);
  if (facts.cause !== "reauthentication") return null;
  return recoveryStory(facts);
}

function parseOffer(message: string): Pick<ReauthPark, "url" | "userCode" | "loopbackRejected"> {
  let url: string | undefined;
  let loopbackRejected = false;
  for (const raw of message.match(/https?:\/\/[^\s<>"')]+/gi) ?? []) {
    let parsed: URL;
    try { parsed = new URL(raw.replace(/[.,);]+$/, "")); }
    catch { continue; }
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0") {
      loopbackRejected = true;
      continue;
    }
    if (!url && parsed.protocol === "https:" && !parsed.username && !parsed.password) url = parsed.toString();
  }
  const bare = message.replace(/https?:\/\/[^\s<>"')]+/gi, " ");
  const labeled = bare.match(/\b(?:user[_\s-]?code|device[_\s-]?code)\s*[:=]\s*([A-Za-z0-9]{4,8}(?:-[A-Za-z0-9]{4,8})?)\b/);
  const dashed = bare.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/);
  const userCode = (labeled?.[1] ?? dashed?.[1])?.toUpperCase();
  return {
    ...(url ? { url } : {}),
    ...(userCode ? { userCode } : {}),
    ...(loopbackRejected ? { loopbackRejected: true } : {}),
  };
}

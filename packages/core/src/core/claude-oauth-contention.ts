import os from "node:os";
import path from "node:path";

/**
 * Every Claude agent on this host runs as `ubuntu` and shares one credential
 * store, `~/.claude/.credentials.json`. Access tokens last exactly 8.0 hours.
 * When one expires, every concurrently-running Claude process races to refresh
 * it, one wins an internal file lock, and the losers fail their turn with
 *
 *   Failed to refresh OAuth token: another Claude Code process is refreshing it
 *   or exited mid-refresh. This is usually transient; retry in a minute, ...
 *
 * Seven concurrent processes were measured on 2026-09-13, so it fails in every
 * channel at once and reads as a system-wide outage rather than a token
 * refresh (#404).
 *
 * ## Why this retries instead of waiting
 *
 * Waiting on the winner's result would be strictly better — it removes the herd
 * rather than spreading it — and the lock already exists. It is not reachable
 * from here. The lock, and the decision to error rather than block, live inside
 * `claude.exe`, a 214 MB compiled ELF binary; the error text above is a string
 * constant in it. Nothing we can pass changes that behaviour.
 *
 * The deeper reason is that from outside that process, **waiting and retrying
 * are the same operation**. A true wait needs the lock holder to signal
 * completion. The only channel it publishes to is the credentials file itself,
 * so "wait for the winner" can only be implemented as "look again later" —
 * which is a retry with extra steps. Making the losers block is upstream work.
 *
 * ## Two axes, evidenced separately
 *
 * `retryable` and `requiresReauth` are deliberately NOT the same question, and
 * collapsing them is how this became a "somehow you signed me out" report while
 * the refresh token was valid for another sixteen days.
 *
 *   retryable      — only for the specific contention signature. Over-broad
 *                    matching here silently retries genuine auth failures,
 *                    which is the dangerous direction.
 *   requiresReauth — false whenever the refresh token is demonstrably still
 *                    valid, WHATEVER the message says. We may not know what an
 *                    unrecognised failure is, but we know what it is not, and
 *                    sending an operator to re-authenticate credentials that
 *                    are good for two more weeks fixes the wrong thing.
 */

/** How a Claude auth-shaped failure was classified. */
export type ClaudeAuthFailureKind =
  /** The measured #404 case: a lost refresh lock race. Transient. */
  | "refresh-contention"
  /** The refresh token itself is expired or absent. Re-authentication is real. */
  | "credentials-expired"
  /** Auth-shaped, but not a signature we recognise. Claim nothing. */
  | "unclassified";

export interface ClaudeAuthClassification {
  kind: ClaudeAuthFailureKind;
  /** May the turn be retried as-is? Only ever true for a recognised race. */
  retryable: boolean;
  /** May this be surfaced as "sign in again"? */
  requiresReauth: boolean;
  /** Human-readable justification, including the refresh-token evidence. */
  reason: string;
}

export interface ClaudeCredentialFacts {
  /** `claudeAiOauth.refreshTokenExpiresAt`, epoch ms. Null when unreadable. */
  refreshTokenExpiresAt: number | null;
}

/**
 * The distinctive contention phrase, and nothing broader.
 *
 * Both upstream wordings carry it verbatim — the SDK-facing
 * "Failed to refresh OAuth token: another Claude Code process is refreshing it
 * or exited mid-refresh" and the interactive "Could not refresh your login
 * because another Claude Code process is refreshing it (or exited
 * mid-refresh)". Matching "refresh" or "OAuth" alone would also catch a revoked
 * token or a network failure, and retrying those wastes the window and hides a
 * real fault.
 */
const CONTENTION = /another Claude Code process is refreshing it/i;

/**
 * Phrases that ask a human to re-authenticate. Recognised so the answer can be
 * *withheld* when the refresh token is still valid — never to assert one.
 */
const REAUTH_CLAIM = /sign in again|please run \/login|login expired|session expired/i;

export function classifyClaudeAuthFailure(
  message: string,
  credentials: ClaudeCredentialFacts,
  now: number = Date.now()
): ClaudeAuthClassification {
  const text = message ?? "";
  const { refreshTokenExpiresAt } = credentials;
  const refreshValid = typeof refreshTokenExpiresAt === "number" && refreshTokenExpiresAt > now;
  const validUntil = refreshValid
    ? `refresh token valid until ${new Date(refreshTokenExpiresAt as number).toISOString()}`
    : refreshTokenExpiresAt === null
      ? "refresh-token expiry unreadable"
      : `refresh token expired at ${new Date(refreshTokenExpiresAt).toISOString()}`;

  if (CONTENTION.test(text)) {
    // The contention message is only meaningful while a refresh could succeed.
    // If the refresh token is dead, the winner of the race fails too, and
    // retrying burns the window on a problem retrying cannot fix.
    if (!refreshValid) {
      return {
        kind: "credentials-expired",
        retryable: false,
        requiresReauth: refreshTokenExpiresAt !== null,
        reason: `refresh contention reported, but ${validUntil}`,
      };
    }
    return {
      kind: "refresh-contention",
      retryable: true,
      requiresReauth: false,
      reason: `lost the shared credential refresh race; ${validUntil}`,
    };
  }

  if (REAUTH_CLAIM.test(text) && refreshValid) {
    // This is the half that matters most. The message says to sign in; the
    // credentials say otherwise, and the credentials are checkable.
    return {
      kind: "unclassified",
      retryable: false,
      requiresReauth: false,
      reason: `message asks for re-authentication, but ${validUntil}, so this is not a sign-out`,
    };
  }

  return {
    kind: refreshValid || refreshTokenExpiresAt === null ? "unclassified" : "credentials-expired",
    retryable: false,
    requiresReauth: !refreshValid && refreshTokenExpiresAt !== null,
    reason: validUntil,
  };
}

/**
 * Full-jitter backoff. The caps grow exponentially; each delay is drawn
 * uniformly from `[0, cap]`.
 *
 * **The jitter is the fix, not a refinement of it.** A fixed delay makes all N
 * losers retry in lockstep and reproduces the herd one interval later — it
 * moves the failure rather than removing it. Drawing from the whole interval
 * (rather than jittering a little around a centre) is what actually
 * de-correlates processes that have no way to see each other.
 *
 * Caps are sized against upstream's own "retry in a minute": three attempts
 * reach ~65s worst case, covering a refresh that is normally sub-second but
 * may be a stale lock from a process that exited mid-refresh.
 */
export const CLAUDE_REFRESH_RETRY_CAPS_MS = Object.freeze([5_000, 15_000, 45_000]);

export function claudeRefreshRetryDelayMs(
  attempt: number,
  random: () => number = Math.random,
  caps: readonly number[] = CLAUDE_REFRESH_RETRY_CAPS_MS
): number {
  if (attempt < 1 || attempt > caps.length) {
    throw new Error(`attempt ${attempt} is outside 1..${caps.length}`);
  }
  return Math.floor(random() * (caps[attempt - 1] as number));
}

/** How many retries a recognised contention failure gets. */
export const CLAUDE_REFRESH_RETRY_ATTEMPTS = CLAUDE_REFRESH_RETRY_CAPS_MS.length;

/**
 * Read ONLY the refresh-token expiry out of the shared credential store.
 *
 * Deliberately narrow: it returns one number and never the tokens, so no caller
 * can log or forward a credential by accident. An unreadable or malformed store
 * yields `null`, which the classifier treats as "cannot tell" — distinct from
 * "expired", because refusing to claim is the honest answer and a wrong claim
 * here is what sends an operator to re-authenticate for no reason.
 */
export function readClaudeCredentialFacts(
  readFileSync: (p: string, enc: "utf8") => string,
  credentialsPath: string
): ClaudeCredentialFacts {
  try {
    const parsed = JSON.parse(readFileSync(credentialsPath, "utf8")) as {
      claudeAiOauth?: { refreshTokenExpiresAt?: unknown };
    };
    const raw = parsed?.claudeAiOauth?.refreshTokenExpiresAt;
    return { refreshTokenExpiresAt: typeof raw === "number" && Number.isFinite(raw) ? raw : null };
  } catch {
    return { refreshTokenExpiresAt: null };
  }
}

/**
 * The shared credential store this host's Claude agents all authenticate from.
 * `CLAUDE_CONFIG_DIR` is honoured because the store moves with it.
 */
export function claudeCredentialsPath(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir
): string {
  const dir = env.CLAUDE_CONFIG_DIR ?? path.join(env.HOME ?? homedir(), ".claude");
  return path.join(dir, ".credentials.json");
}

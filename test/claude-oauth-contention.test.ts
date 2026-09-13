/**
 * #404 — one credential store, seven concurrent Claude processes, an 8-hour
 * token, and a lock race whose losers fail their turn in every channel at once.
 *
 * Two properties are load-bearing and neither is "the option is set":
 *
 *   1. The classifier must be NARROW. Retrying a genuine auth failure hides it
 *      and burns the window, so the dangerous direction is over-broad matching.
 *      Most of this file pins things it must REFUSE to classify.
 *   2. The jitter must actually spread the herd. A fixed delay makes N losers
 *      retry in lockstep and reproduces the failure one interval later, so the
 *      test below measures the spread rather than asserting a flag.
 *
 * No real OAuth anywhere: the error text is injected and the credential facts
 * are supplied directly, because the whole point is deterministic
 * classification.
 */
import { describe, expect, it } from "vitest";
import {
  CLAUDE_REFRESH_RETRY_ATTEMPTS,
  CLAUDE_REFRESH_RETRY_CAPS_MS,
  claudeRefreshRetryDelayMs,
  classifyClaudeAuthFailure,
  readClaudeCredentialFacts,
} from "../packages/core/src/core/claude-oauth-contention.js";

/** The exact text observed on 2026-09-13, from the SDK-facing path. */
const CONTENTION_SDK =
  "Failed to refresh OAuth token: another Claude Code process is refreshing it or " +
  "exited mid-refresh. This is usually transient; retry in a minute, and if it " +
  "persists close other Claude Code processes or sign in again";

/** The interactive wording, read out of the same binary. */
const CONTENTION_INTERACTIVE =
  "Could not refresh your login because another Claude Code process is refreshing it " +
  "(or exited mid-refresh) Try again in a minute; if it keeps happening, close other " +
  "Claude Code windows or sign in again with /login";

const NOW = Date.parse("2026-09-13T16:39:00.000Z");
const VALID = { refreshTokenExpiresAt: Date.parse("2026-09-29T06:04:32.501Z") };
const EXPIRED = { refreshTokenExpiresAt: Date.parse("2026-09-01T00:00:00.000Z") };
const UNKNOWN = { refreshTokenExpiresAt: null };

describe("#404 the contention signature, and only it", () => {
  it.each([
    ["the SDK wording", CONTENTION_SDK],
    ["the interactive wording", CONTENTION_INTERACTIVE],
  ])("classifies %s as a retryable race", (_label, message) => {
    const result = classifyClaudeAuthFailure(message, VALID, NOW);
    expect(result).toMatchObject({
      kind: "refresh-contention", retryable: true, requiresReauth: false,
    });
    expect(result.reason).toContain("2026-09-29");
  });

  it.each([
    ["a revoked refresh token", "Failed to refresh OAuth token: invalid_grant"],
    ["a network failure during refresh", "Failed to refresh OAuth token: fetch failed (ECONNRESET)"],
    ["a bare refresh failure", "Failed to refresh OAuth token"],
    ["an unrelated OAuth error", "OAuth error: insufficient scope"],
    ["a rate limit", "Rate limit exceeded; please wait before retrying"],
    ["an overloaded upstream", "Internal error: overloaded_error"],
    ["a generic internal error", "Internal error: something went wrong"],
    ["an empty message", ""],
  ])("refuses to retry %s", (_label, message) => {
    // The dangerous direction. Every one of these is auth- or transient-shaped
    // enough that a looser matcher would swallow it, and swallowing a revoked
    // token means three silent retries and then the same failure a minute later.
    expect(classifyClaudeAuthFailure(message, VALID, NOW).retryable).toBe(false);
  });

  it.each([
    // Found by mutation: a matcher keyed on "mid-refresh" alone passed every
    // other test here, and "mid-refresh" is not a Claude-specific token.
    ["mid-refresh in an unrelated message", "Upload failed: the writer exited mid-refresh of its buffer"],
    ["mid-refresh from a different subsystem", "Catalog refresh aborted; source exited mid-refresh"],
    // Also found by mutation: dropping "Claude Code" from the phrase still
    // passed. Another agent's identically-shaped error must not be retried
    // against Claude's credential store, whose expiry says nothing about it.
    ["another agent's refresh race", "another codex process is refreshing it or exited mid-refresh"],
    ["an agy refresh race", "another agy process is refreshing it"],
  ])("refuses %s, which is not this failure", (_label, message) => {
    expect(classifyClaudeAuthFailure(message, VALID, NOW).retryable).toBe(false);
  });

  it("does not match on the word refresh, OAuth, or the advice clause alone", () => {
    // "sign in again" and "close other Claude Code processes" both appear in the
    // real message, so a matcher keyed on the ADVICE rather than the CAUSE would
    // look like it worked while catching unrelated failures.
    for (const near of [
      "close other Claude Code processes or sign in again",
      "This is usually transient; retry in a minute",
      "another Claude Code process is running",
      "a Claude Code process is refreshing it",
    ]) {
      expect(classifyClaudeAuthFailure(near, VALID, NOW).retryable).toBe(false);
    }
  });
});

describe("#404 a lock race must never present as a sign-out", () => {
  it("refuses re-authentication advice while the refresh token is valid", () => {
    // The measured case behind the "somehow you signed me out" report: the
    // message says to sign in, the credentials say there are sixteen days left,
    // and the credentials are checkable.
    for (const message of [
      "Login expired. Please run /login",
      "Your session expired and could not be refreshed",
      "Please sign in again",
    ]) {
      const result = classifyClaudeAuthFailure(message, VALID, NOW);
      expect(result.requiresReauth).toBe(false);
      expect(result.reason).toContain("not a sign-out");
    }
  });

  it("does not make an unrecognised failure retryable just because it is not a sign-out", () => {
    // Withholding a wrong claim is not the same as making a new one. We know
    // what it is not; we do not know what it is.
    const result = classifyClaudeAuthFailure("Login expired. Please run /login", VALID, NOW);
    expect(result.retryable).toBe(false);
    expect(result.kind).toBe("unclassified");
  });

  it("does ask for re-authentication once the refresh token really has expired", () => {
    const result = classifyClaudeAuthFailure("Login expired. Please run /login", EXPIRED, NOW);
    expect(result.requiresReauth).toBe(true);
    expect(result.kind).toBe("credentials-expired");
  });

  it("refuses to retry contention when the refresh token is dead, because the winner fails too", () => {
    const result = classifyClaudeAuthFailure(CONTENTION_SDK, EXPIRED, NOW);
    expect(result).toMatchObject({
      kind: "credentials-expired", retryable: false, requiresReauth: true,
    });
  });

  it("claims nothing either way when the expiry cannot be read", () => {
    // Unreadable is a third state. Asserting "signed out" from an unreadable
    // file would be the same wrong answer with less evidence behind it.
    const result = classifyClaudeAuthFailure(CONTENTION_SDK, UNKNOWN, NOW);
    expect(result.retryable).toBe(false);
    expect(result.requiresReauth).toBe(false);
    expect(result.reason).toContain("unreadable");
  });
});

describe("#404 the credential reader gives up one number and nothing else", () => {
  it("reads only the refresh-token expiry", () => {
    const store = JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-secret-access", refreshToken: "sk-secret-refresh",
        expiresAt: 1789338602501, refreshTokenExpiresAt: 1790661872501,
      },
    });
    const facts = readClaudeCredentialFacts(() => store, "/fake/.credentials.json");
    // The shape is the guarantee: one key, so no caller can log a token by
    // accident because no caller is ever handed one.
    expect(Object.keys(facts)).toEqual(["refreshTokenExpiresAt"]);
    expect(facts.refreshTokenExpiresAt).toBe(1790661872501);
    expect(JSON.stringify(facts)).not.toContain("sk-secret");
  });

  it.each([
    ["an unreadable file", () => { throw new Error("EACCES"); }],
    ["malformed JSON", () => "{not json"],
    ["a missing claudeAiOauth block", () => "{}"],
    ["a non-numeric expiry", () => JSON.stringify({ claudeAiOauth: { refreshTokenExpiresAt: "soon" } })],
  ])("returns null rather than throwing for %s", (_label, read) => {
    expect(readClaudeCredentialFacts(read as never, "/fake").refreshTokenExpiresAt).toBeNull();
  });
});

/** A seeded LCG, so "randomised" behaviour is reproducible in CI. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** What N losers of the same race would each wait before their first retry. */
function herdFirstRetryDelays(n: number, rng: () => number): number[] {
  return Array.from({ length: n }, () => claudeRefreshRetryDelayMs(1, rng));
}

describe("#404 the jitter demonstrably breaks the herd", () => {
  it("spreads seven simultaneous losers across the whole first interval", () => {
    // Seven concurrent processes is what was measured on the host.
    const delays = herdFirstRetryDelays(7, seeded(20260913));
    const cap = CLAUDE_REFRESH_RETRY_CAPS_MS[0];
    // Spread, not "the maximum reached the top quartile" — seven uniform draws
    // miss the top quartile about 13% of the time, so that would be a claim
    // about the seed rather than about the jitter. The range-coverage claim
    // belongs in the many-trials test below, where it is sound.
    expect(Math.max(...delays) - Math.min(...delays)).toBeGreaterThan(cap * 0.4);
    // And they are not merely different numbers: most land in a different
    // 250ms bucket, so they arrive as separate attempts rather than a herd.
    // Not all seven — two of seven uniform draws sharing a bucket is ordinary,
    // and demanding otherwise would again be a claim about the seed. The
    // aggregate behaviour is measured over many races below.
    const buckets = delays.map((d) => Math.floor(d / 250));
    expect(new Set(buckets).size).toBeGreaterThanOrEqual(5);
  });

  it("is the difference between one bucket and many — the contrast, not the flag", () => {
    // This is the whole argument. A fixed delay is what "add a retry" looks
    // like without jitter, and it moves the failure rather than fixing it.
    const fixedDelay = () => CLAUDE_REFRESH_RETRY_CAPS_MS[0] / 2;
    const lockstep = Array.from({ length: 7 }, () => fixedDelay());
    expect(new Set(lockstep).size).toBe(1);

    const jittered = herdFirstRetryDelays(7, seeded(7));
    expect(new Set(jittered).size).toBe(7);
  });

  it("keeps the herd broken across many independent races, not one lucky seed", () => {
    // 500 simulated herds; a seed-specific fluke would not survive the mean.
    const rng = seeded(1);
    let totalDistinctBuckets = 0;
    const trials = 500;
    for (let i = 0; i < trials; i += 1) {
      const buckets = herdFirstRetryDelays(7, rng).map((d) => Math.floor(d / 500));
      totalDistinctBuckets += new Set(buckets).size;
    }
    // Seven draws over ten 500ms buckets: collisions happen, but the mean must
    // sit near the top of the range rather than collapsing toward 1.
    expect(totalDistinctBuckets / trials).toBeGreaterThan(5);

    // And over many races the draws really do cover the whole interval — the
    // claim a single seven-draw herd cannot honestly make.
    const cap = CLAUDE_REFRESH_RETRY_CAPS_MS[0];
    const wide = seeded(99);
    const many = Array.from({ length: 2_000 }, () => claudeRefreshRetryDelayMs(1, wide));
    expect(Math.min(...many)).toBeLessThan(cap * 0.02);
    expect(Math.max(...many)).toBeGreaterThan(cap * 0.98);
  });

  it("grows the interval each attempt so a persistent lock is not hammered", () => {
    const always = () => 0.999_999;
    const delays = Array.from({ length: CLAUDE_REFRESH_RETRY_ATTEMPTS },
      (_, i) => claudeRefreshRetryDelayMs(i + 1, always));
    for (let i = 1; i < delays.length; i += 1) expect(delays[i]).toBeGreaterThan(delays[i - 1]);
    // Upstream's own advice is "retry in a minute"; the schedule must reach it.
    expect(delays.reduce((a, b) => a + b, 0)).toBeGreaterThan(60_000);
  });

  it("draws from the whole interval rather than jittering around a centre", () => {
    // Full jitter is what de-correlates processes that cannot see each other.
    // A centred jitter of ±10% would leave seven losers inside one narrow band.
    expect(claudeRefreshRetryDelayMs(1, () => 0)).toBe(0);
    expect(claudeRefreshRetryDelayMs(1, () => 0.999_999))
      .toBeGreaterThan(CLAUDE_REFRESH_RETRY_CAPS_MS[0] * 0.99);
  });

  it("refuses an attempt number outside the schedule instead of extrapolating", () => {
    expect(() => claudeRefreshRetryDelayMs(0, () => 0.5)).toThrow(/outside/);
    expect(() => claudeRefreshRetryDelayMs(CLAUDE_REFRESH_RETRY_ATTEMPTS + 1, () => 0.5))
      .toThrow(/outside/);
  });
});

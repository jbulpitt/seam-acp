/**
 * #404 — the retry where it actually runs, not just the classifier that decides it.
 *
 * `test/claude-oauth-contention.test.ts` pins the predicate and the jitter. This
 * file drives the real `AgentRuntime.prompt()` against a fake ACP connection
 * that rejects with the measured upstream text, because a classifier nothing
 * calls would classify nothing.
 *
 * The safety property is the one to watch: **a turn that has already produced
 * output is never retried.** The refresh race normally fires before the model
 * starts (the reported failure was 8s elapsed with the turn never running), but
 * if the token expires mid-turn, re-sending the prompt would duplicate the work
 * and the billing. That case must fall through and throw exactly as before.
 *
 * No real OAuth: the error is injected and the credential expiry is written into
 * a temp file the runtime is pointed at with `CLAUDE_CONFIG_DIR`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import type { AgentProfile } from "@seam/adapters";
import { logger } from "../packages/core/src/lib/logger.js";
import { CLAUDE_REFRESH_RETRY_ATTEMPTS } from "../packages/core/src/core/claude-oauth-contention.js";

const CONTENTION =
  "Failed to refresh OAuth token: another Claude Code process is refreshing it or " +
  "exited mid-refresh. This is usually transient; retry in a minute, and if it " +
  "persists close other Claude Code processes or sign in again";

const fakeProfile = { id: "fake" } as unknown as AgentProfile;
type Update = Record<string, unknown>;

/** A connection that rejects the first `failures` prompts, then succeeds. */
class FlakyConn {
  attempts = 0;
  failures = 0;
  error: Error = new Error(CONTENTION);
  /** Updates emitted BEFORE the rejection — models a turn that already ran. */
  updatesBeforeFailure: Update[] = [];
  private feed: (u: Update) => Promise<void>;

  constructor(rt: AgentRuntime) {
    this.feed = (u) =>
      (rt as unknown as { handleSessionUpdate(u: Update): Promise<void> }).handleSessionUpdate(u);
  }
  async prompt() {
    this.attempts += 1;
    for (const u of this.updatesBeforeFailure) await this.feed(u);
    if (this.attempts <= this.failures) throw this.error;
    return { stopReason: "end_turn" };
  }
  async cancel() {}
}

let configDir: string;
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;

/** Write a credential store carrying only an expiry. No tokens anywhere. */
function writeCredentials(refreshTokenExpiresAt: number | null): void {
  fs.writeFileSync(
    path.join(configDir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: refreshTokenExpiresAt === null ? {} : { refreshTokenExpiresAt } })
  );
}

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-404-"));
  process.env.CLAUDE_CONFIG_DIR = configDir;
  // Sixteen days out, as measured on 2026-09-13.
  writeCredentials(Date.now() + 16 * 24 * 60 * 60 * 1000);
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
  fs.rmSync(configDir, { recursive: true, force: true });
});

function makeRuntime() {
  const rt = new AgentRuntime({ profile: fakeProfile, logger });
  const conn = new FlakyConn(rt);
  (rt as unknown as { connection: unknown }).connection = conn;
  (rt as unknown as { promptCapabilities: unknown }).promptCapabilities = {};
  (rt as unknown as { sessionId: string }).sessionId = "s1";
  return { rt, conn };
}

/**
 * The real schedule's first cap is 5s, which would make this file take minutes.
 * Only the DELAY is shortened; the classifier, the attempt count and the
 * never-retry-after-output guard all run unmodified.
 */
function withFastDelays<T>(run: () => Promise<T>): Promise<T> {
  const realSetTimeout = globalThis.setTimeout;
  (globalThis as { setTimeout: unknown }).setTimeout =
    ((fn: () => void) => realSetTimeout(fn, 0)) as unknown as typeof setTimeout;
  return run().finally(() => { (globalThis as { setTimeout: unknown }).setTimeout = realSetTimeout; });
}

describe("#404 the retry runs where the turn does", () => {
  it("recovers a turn that lost the refresh race before the model started", async () => {
    const { rt, conn } = makeRuntime();
    conn.failures = 2;
    const outcome = await withFastDelays(() => rt.prompt("hello"));
    expect(outcome.stopReason).toBe("end_turn");
    expect(conn.attempts).toBe(3);
  });

  it("gives up after the configured attempts rather than retrying forever", async () => {
    const { rt, conn } = makeRuntime();
    conn.failures = 99;
    await expect(withFastDelays(() => rt.prompt("hello"))).rejects.toThrow(/another Claude Code process/);
    expect(conn.attempts).toBe(CLAUDE_REFRESH_RETRY_ATTEMPTS + 1);
  });

  it("NEVER retries a turn that already produced output", async () => {
    // The billing-safety property. A mid-turn token expiry must fail the turn
    // rather than silently run the model twice.
    const { rt, conn } = makeRuntime();
    conn.failures = 1;
    conn.updatesBeforeFailure = [
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial answer" } },
    ];
    await expect(withFastDelays(() => rt.prompt("hello"))).rejects.toThrow(/another Claude Code process/);
    expect(conn.attempts).toBe(1);
  });

  it("does not retry an error that is not the contention signature", async () => {
    const { rt, conn } = makeRuntime();
    conn.failures = 1;
    conn.error = new Error("Failed to refresh OAuth token: invalid_grant");
    await expect(withFastDelays(() => rt.prompt("hello"))).rejects.toThrow(/invalid_grant/);
    expect(conn.attempts).toBe(1);
  });

  it("does not retry contention once the refresh token has actually expired", async () => {
    writeCredentials(Date.now() - 60_000);
    const { rt, conn } = makeRuntime();
    conn.failures = 1;
    await expect(withFastDelays(() => rt.prompt("hello"))).rejects.toThrow(/another Claude Code process/);
    expect(conn.attempts).toBe(1);
  });

  it("does not retry when the credential store cannot be read", async () => {
    fs.rmSync(path.join(configDir, ".credentials.json"));
    const { rt, conn } = makeRuntime();
    conn.failures = 1;
    await expect(withFastDelays(() => rt.prompt("hello"))).rejects.toThrow(/another Claude Code process/);
    expect(conn.attempts).toBe(1);
  });

  it("resets the output guard between turns", async () => {
    // A turn that streamed must not poison the NEXT turn's ability to retry.
    const { rt, conn } = makeRuntime();
    conn.updatesBeforeFailure = [
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "first turn" } },
    ];
    await withFastDelays(() => rt.prompt("one"));
    conn.updatesBeforeFailure = [];
    conn.attempts = 0;
    conn.failures = 1;
    const outcome = await withFastDelays(() => rt.prompt("two"));
    expect(outcome.stopReason).toBe("end_turn");
    expect(conn.attempts).toBe(2);
  });
});

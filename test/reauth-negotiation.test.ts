/**
 * #454: a provider auth failure is a decision, not a dead turn.
 * Removing the park / retry / inconclusive split, or treating close 4001,
 * a still-valid token, or an unreadable store as re-auth, leaves these red.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { TurnAttemptStore } from "../packages/core/src/core/dispatch/attempt-store.js";
import { executionIdentity } from "../packages/core/src/core/dispatch/execution-identity.js";
import { recoveryFactsFromAttempt } from "../packages/core/src/core/dispatch/recovery-story.js";
import {
  acceptReauthWait,
  isAwaitingReauth,
  negotiateReauth,
  parseReauthWait,
  reauthStalledReason,
  REAUTH_COMPLETED_TEXT,
  REAUTH_WAITING_TEXT,
} from "../packages/core/src/core/reauth-negotiation.js";
import type { DispatchSpec } from "../packages/core/src/core/dispatch/types.js";

const EXPIRED = Date.parse("2026-01-01T00:00:00.000Z");
const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const VALID = NOW + 86_400_000;
const OAUTH = "Failed to authenticate: OAuth session expired and could not be refreshed";
const CONTENTION = "Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh";

describe("negotiateReauth", () => {
  it("retries contention and does not park it when the refresh token can still succeed", () => {
    expect(negotiateReauth({
      errorKind: "auth_contention",
      message: CONTENTION,
      claudeCredentials: { refreshTokenExpiresAt: VALID },
      now: NOW,
    }).action).toBe("retry");
    expect(negotiateReauth({ errorKind: "auth_contention", message: CONTENTION }).action).toBe("retry");
  });

  it("does not park when the message says sign in but the refresh token is still valid", () => {
    const decision = negotiateReauth({
      errorKind: "auth_expired",
      message: "Login expired. Please run /login",
      claudeCredentials: { refreshTokenExpiresAt: VALID },
      now: NOW,
    });
    expect(decision.action).toBe("not_reauth");
  });

  it("does not park when the credential store was unreadable", () => {
    const decision = negotiateReauth({
      errorKind: "auth_expired",
      message: OAUTH,
      claudeCredentials: { refreshTokenExpiresAt: null },
      now: NOW,
    });
    expect(decision.action).toBe("inconclusive");
  });

  it("does not park an unclassified failure that merely contains a URL", () => {
    const decision = negotiateReauth({
      errorKind: "unclassified",
      message: "something failed https://device.example.com/start code ABCD-EFGH",
    });
    expect(decision.action).toBe("inconclusive");
  });

  it("does not park bridge close 4001 even when the text looks like an expired session", () => {
    const decision = negotiateReauth({
      errorKind: "auth_expired",
      message: OAUTH,
      bridgeCloseCode: 4001,
      claudeCredentials: { refreshTokenExpiresAt: EXPIRED },
      now: NOW,
    });
    expect(decision.action).toBe("bridge_rejected");
  });

  it("parks an expired session, keeps an https device URL and code, and drops a loopback callback", () => {
    const decision = negotiateReauth({
      errorKind: "auth_expired",
      message: `${OAUTH} https://device.example.com/start?user_code=NOT-A-TOKEN code ABCD-EFGH http://127.0.0.1:9/callback`,
      claudeCredentials: { refreshTokenExpiresAt: EXPIRED },
      now: NOW,
    });
    expect(decision.action).toBe("park");
    if (decision.action !== "park") return;
    expect(decision.park.url).toBe("https://device.example.com/start?user_code=NOT-A-TOKEN");
    expect(decision.park.userCode).toBe("ABCD-EFGH");
    expect(decision.park.loopbackRejected).toBe(true);
    expect(decision.park.url).not.toContain("127.0.0.1");
    const stored = reauthStalledReason(decision.park);
    expect(isAwaitingReauth(stored)).toBe(true);
    expect(isAwaitingReauth(REAUTH_COMPLETED_TEXT)).toBe(false);
    expect(parseReauthWait(stored)).toMatchObject({
      url: "https://device.example.com/start?user_code=NOT-A-TOKEN",
      userCode: "ABCD-EFGH",
      loopbackRejected: true,
    });
  });

  it("parks auth_required with no invented URL when the message offered none", () => {
    const decision = negotiateReauth({
      errorKind: "auth_required",
      agentId: "agy",
      message: "unauthenticated",
    });
    expect(decision.action).toBe("park");
    if (decision.action !== "park") return;
    expect(decision.park.errorKind).toBe("auth_required");
    expect(decision.park.url).toBeUndefined();
    expect(decision.park.userCode).toBeUndefined();
  });

  it("does not treat a waiting reason as authentication already completed", () => {
    expect(recoveryFactsFromAttempt({
      stalledReason: REAUTH_WAITING_TEXT,
      promptStarted: true,
    }).cause).toBe("process_restart");
  });
});

describe("acceptReauthWait", () => {
  let dir: string;
  let db: Database.Database;
  let attempts: TurnAttemptStore;

  afterEach(() => {
    db?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  function started(id: string): void {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-454-"));
    db = new Database(path.join(dir, "seam.db"));
    attempts = new TurnAttemptStore(db);
    attempts.registerOwner("boot");
    const spec: DispatchSpec = {
      id,
      target: "thread",
      prompt: "ORIGINAL-BRIEF-DO-NOT-REPLAY",
      session: "live",
      kind: "handoff",
      createdUtc: "2026-09-22T00:00:00.000Z",
    };
    const row = attempts.claim(spec, executionIdentity({
      agent: "claude", location: "local", session: "live", model: "m", cwd: "/repo", config: {},
    }), "boot");
    attempts.bind(row, "acp-1");
    attempts.startPrompt(row);
  }

  it("returns a continue story and does not keep the device code or the original brief", () => {
    started("parked");
    const decision = negotiateReauth({
      errorKind: "auth_expired",
      message: `${OAUTH} https://device.example.com/start code ABCD-EFGH`,
    });
    expect(decision.action).toBe("park");
    if (decision.action !== "park") return;
    expect(attempts.markStalled("parked", reauthStalledReason(decision.park), "2026-09-22T01:00:00.000Z")).toBe(true);
    const story = acceptReauthWait(attempts, "parked", new Date("2026-09-22T03:00:00.000Z"));
    expect(story).not.toBeNull();
    expect(story!.prompt.startsWith("continue\n")).toBe(true);
    expect(story!.prompt).toContain("Authentication was completed outside this turn.");
    expect(story!.prompt).toContain("Do not repeat it.");
    expect(story!.prompt).toContain("The attempt was last recorded 2h ago.");
    expect(story!.prompt).not.toContain("ORIGINAL-BRIEF-DO-NOT-REPLAY");
    expect(story!.prompt).not.toContain("ABCD-EFGH");
    expect(story!.prompt).not.toContain("retries it as-is");
    expect(story!.prompt).not.toContain("reauth-waiting");
    expect(story!.prompt).not.toContain("reauth-completed");
    expect(story!.note.startsWith("Recovery:\n")).toBe(true);
    expect(story!.note).not.toContain("resuming after restart");
    const row = attempts.get("parked")!;
    expect(row.state).toBe("suspended");
    expect(row.promptStarted).toBe(true);
    expect(row.stalledReason).toBe(REAUTH_COMPLETED_TEXT);
    expect(row.outcome).toBeNull();
    expect(acceptReauthWait(attempts, "parked", new Date("2026-09-22T04:00:00.000Z"))).toBeNull();
    expect(attempts.get("parked")!.stalledReason).toBe(REAUTH_COMPLETED_TEXT);
  });

  it("returns null and leaves a non-waiting attempt unchanged", () => {
    started("other");
    expect(attempts.markStalled("other", "provider acquisition failed during execution: rpc timed out")).toBe(true);
    expect(acceptReauthWait(attempts, "other")).toBeNull();
    expect(attempts.get("other")!.stalledReason).toBe("provider acquisition failed during execution: rpc timed out");
    expect(acceptReauthWait(attempts, "missing")).toBeNull();
  });
});

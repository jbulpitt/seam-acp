/**
 * #302 — an interrupted turn must actually come back.
 *
 * Three defects sat on one path: the execution identity hashed rotating
 * credentials and provider env values, the continuation guard tested a vendor
 * name, and `claim()` never consulted `prompt_started`. Each of these alone
 * left an interrupted turn unable to resume.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { simulateRetiredOwnerProcess } from "./restart-process-fixture.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  TurnAttemptStore,
  DispatchSuspendedError,
} from "../packages/core/src/core/dispatch/attempt-store.js";
import {
  executionIdentity,
  compareExecutionIdentity,
} from "../packages/core/src/core/dispatch/execution-identity.js";
import type { DispatchSpec } from "../packages/core/src/core/dispatch/types.js";

let dir: string;
let db: Database.Database;
let attempts: TurnAttemptStore;

const spec = (over: Partial<DispatchSpec> = {}): DispatchSpec => ({
  id: "disp-302",
  target: "thread-worker",
  prompt: "keep going",
  session: "live",
  kind: "handoff",
  createdUtc: new Date().toISOString(),
  stream: false,
  ...over,
}) as DispatchSpec;

const selection = (over: Record<string, unknown> = {}) => executionIdentity({
  agent: "claude", location: "local", session: "live",
  model: "claude-opus-5", effort: "high", cwd: "/repo", config: { rider: null },
  ...over,
});

beforeEach(() => {
  vi.restoreAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-302-"));
  db = new Database(path.join(dir, "seam.db"));
  attempts = new TurnAttemptStore(db);
  simulateRetiredOwnerProcess();
  attempts.registerOwner("boot-1");
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Suspend a claimed attempt the way a process death does, using the real
 *  registration and the production liveness guard. */
function suspend(id: string): void {
  db.prepare("UPDATE turn_attempts SET state='suspended' WHERE id=?").run(id);
  // Stop simulating: the live process now reports its true start, so the
  // recorded owner is provably dead by the production guard.
  vi.restoreAllMocks();
}

describe("#302 execution identity", () => {
  it("ignores rotating credentials and provider environment values", () => {
    // The exact inputs the old digest folded in. None of them change which
    // session the work belongs to, and all of them drift on their own.
    const before = selection();
    process.env.CODEX_QA_302 = "before";
    process.env.ANTHROPIC_QA_302 = "before";
    const after = selection();
    process.env.CODEX_QA_302 = "after-rotation";
    process.env.ANTHROPIC_QA_302 = "after-rotation";
    const afterRotation = selection();
    delete process.env.CODEX_QA_302;
    delete process.env.ANTHROPIC_QA_302;

    expect(after).toBe(before);
    expect(afterRotation).toBe(before);
    expect(compareExecutionIdentity(before, afterRotation)).toEqual({ match: true, legacy: false });
    // And nothing credential-shaped is stored either.
    expect(before).not.toMatch(/auth\.json|config\.toml|CODEX_QA_302|before|after-rotation/);
  });

  it("names the field that differs instead of printing two digests", () => {
    const base = selection();
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ agent: "codex" }, /thread switched from claude to codex/],
      [{ location: "macbook-air" }, /thread moved from local to macbook-air/],
      [{ session: "isolated" }, /session kind changed from live to isolated/],
      [{ model: "claude-sonnet-5" }, /model changed from claude-opus-5 to claude-sonnet-5/],
      [{ effort: "low" }, /effort changed from high to low/],
      [{ cwd: "/other" }, /working directory changed from \/repo to \/other/],
      [{ config: { rider: "new rule" } }, /thread configuration changed/],
    ];
    for (const [over, expected] of cases) {
      const result = compareExecutionIdentity(base, selection(over));
      expect(result.match).toBe(false);
      if (!result.match) expect(result.reason).toMatch(expected);
    }
  });

  it("does not strand an attempt that stored a pre-#302 digest", () => {
    // Those rows are exactly the orphaned work this change exists to recover,
    // and a digest cannot say which field differs.
    const legacy = "a".repeat(64);
    expect(compareExecutionIdentity(legacy, selection())).toEqual({ match: true, legacy: true });
  });
});

describe("#302 claim()", () => {
  it("resumes in-flight work after a credential rotation", () => {
    const s = spec();
    attempts.claim(s, selection(), "boot-1");
    suspend(s.id);
    // A token refresh happens. Under the old digest this attempt could never
    // be claimed again, because a hash never returns to a previous value.
    process.env.OPENAI_QA_302 = "rotated";
    const resumed = attempts.claim(s, selection(), "boot-2");
    delete process.env.OPENAI_QA_302;
    expect(resumed.state).toBe("active");
    expect(resumed.generation).toBe(2);
  });

  it("refuses with a named reason when the selection really did change", () => {
    const s = spec();
    attempts.claim(s, selection(), "boot-1");
    suspend(s.id);
    try {
      attempts.claim(s, selection({ agent: "codex" }), "boot-2");
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchSuspendedError);
      expect((err as DispatchSuspendedError).reason).toMatch(/thread switched from claude to codex/);
    }
  });

  it("carries prompt_started through the claim so the caller reattaches instead of replaying", () => {
    const s = spec();
    const claimed = attempts.claim(s, selection(), "boot-1");
    attempts.bind(claimed, "acp-session-624a55a4");
    attempts.startPrompt(claimed);
    suspend(s.id);

    const resumed = attempts.claim(s, selection(), "boot-2");
    // This is what orchestrator.ts passes as `resume:` — reattach, not replay.
    expect(resumed.promptStarted).toBe(true);
    expect(resumed.acpSessionId).toBe("acp-session-624a55a4");
  });

  it("replays a turn interrupted before its prompt was sent", () => {
    const s = spec();
    attempts.claim(s, selection(), "boot-1");
    suspend(s.id);
    const resumed = attempts.claim(s, selection(), "boot-2");
    // Nothing reached the model, so the original spec is safe to re-send.
    expect(resumed.promptStarted).toBe(false);
    expect(JSON.parse(JSON.stringify(resumed.spec))).toMatchObject({ id: s.id, prompt: "keep going" });
  });

  it("refuses loudly if a started prompt has no session id", () => {
    const s = spec();
    attempts.claim(s, selection(), "boot-1");
    // startPrompt cannot produce this pairing; force it to prove the invariant
    // is asserted rather than silently replaying possibly-duplicated work.
    db.prepare("UPDATE turn_attempts SET prompt_started=1, acp_session_id=NULL WHERE id=?").run(s.id);
    suspend(s.id);
    try {
      attempts.claim(s, selection(), "boot-2");
      throw new Error("expected a refusal");
    } catch (err) {
      expect((err as DispatchSuspendedError).reason).toMatch(/started prompt with no session id/);
    }
  });
});

describe("#302 acp_session_id indexes", () => {
  it("indexes the column attempts are looked up by", () => {
    const named = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='turn_attempts'")
      .all() as Array<{ name: string }>;
    expect(named.map((r) => r.name)).toContain("idx_turn_attempt_acp_session");
    // And the planner actually uses it rather than scanning.
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM turn_attempts WHERE acp_session_id=?")
      .all("acp-session-624a55a4") as Array<{ detail: string }>;
    expect(plan.map((r) => r.detail).join(" ")).toMatch(/USING INDEX idx_turn_attempt_acp_session/);
  });
});

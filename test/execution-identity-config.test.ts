import { describe, expect, it } from "vitest";
import {
  compareExecutionIdentity,
  executionIdentity,
} from "../packages/core/src/core/dispatch/execution-identity.js";

/**
 * A configuration that did not change must compare equal.
 *
 * #302 replaced the identity digest with plain fields precisely so drift could
 * not strand suspended work, but `config` stayed an opaque blob compared byte
 * for byte, and the two call sites spelled it differently: admission recorded
 * the session's raw `configJson` (pretty printed, including `lastContextUsage`)
 * while the resume check recorded the parsed object with that key removed.
 *
 * The result was a refusal named "thread configuration changed" on a thread
 * whose configuration had never changed. It stranded the Pronoa #2068 carry
 * (dispatch 0a98091b) across the 2026-09-12 restart: every other identity
 * field matched, so only `config` could have produced the refusal, and the two
 * spellings could never be equal. #355 did not cause this — it exposed it, by
 * running the real safety checks instead of refusing everything outright.
 */

/** Exactly the shape the Pronoa carry's thread stores. */
const LIVE_CONFIG = {
  model: "gpt-5.6-sol",
  permissionPolicy: "always",
  reasoningEffort: "xhigh",
  role: "worker",
  lastContextUsage: { used: 200574, softLimit: 272000 },
};

/** What the session row holds verbatim: pretty printed, two-space indent. */
const RAW_CONFIG_JSON = JSON.stringify(LIVE_CONFIG, null, 2);

function identityWith(config: unknown): string {
  return executionIdentity({
    agent: "codex",
    location: "local",
    session: "live",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    cwd: "/home/operator/Projects/pronoa",
    config,
  });
}

describe("execution identity treats an unchanged configuration as unchanged", () => {
  it("matches the raw configJson recorded at admission against the parsed object used at resume", () => {
    // The production failure, reproduced from both real call-site spellings.
    const { lastContextUsage: _usage, ...parsed } = LIVE_CONFIG;
    const admitted = identityWith(RAW_CONFIG_JSON);
    const atResume = identityWith(parsed);

    const verdict = compareExecutionIdentity(admitted, atResume, {
      promptStarted: true,
      acpSessionId: "01a079c8-515c-7d43-97c7-962ef7f47394",
    });
    expect(verdict).toEqual({ match: true, legacy: false });
  });

  it("does not drift when lastContextUsage is rewritten by an ordinary turn", () => {
    // This key changes after EVERY turn, so including it would mean a thread
    // falls out of its own identity simply by being used.
    const before = identityWith(RAW_CONFIG_JSON);
    const after = identityWith(
      JSON.stringify({ ...LIVE_CONFIG, lastContextUsage: { used: 251_003, softLimit: 272_000 } }, null, 2)
    );
    expect(after).toBe(before);
  });

  it("does not drift when only the cwd provenance flag is set", () => {
    const before = identityWith(RAW_CONFIG_JSON);
    const after = identityWith(JSON.stringify({ ...LIVE_CONFIG, sessionCwdExplicit: true }, null, 2));
    expect(after).toBe(before);
  });

  it("ignores key order, which is not a configuration change", () => {
    const reordered = { role: "worker", reasoningEffort: "xhigh", permissionPolicy: "always", model: "gpt-5.6-sol" };
    const { lastContextUsage: _usage, ...parsed } = LIVE_CONFIG;
    expect(identityWith(reordered)).toBe(identityWith(parsed));
  });

  it("ignores runtime-advertised Codex mode observations", () => {
    expect(identityWith({ ...LIVE_CONFIG, codexModes: {
      sessionId: "s1", availableModes: [{ id: "agent-full-access", name: "Full access" }],
      currentModeId: "agent-full-access",
    } })).toBe(identityWith(LIVE_CONFIG));
  });

  it("permits a live permission policy edit without changing the saved conversation", () => {
    const admitted = identityWith(RAW_CONFIG_JSON);
    const escalated = identityWith({ ...LIVE_CONFIG, permissionPolicy: "never", lastContextUsage: undefined });

    const verdict = compareExecutionIdentity(admitted, escalated);
    expect(verdict).toEqual({ match: true, legacy: false });
  });

  it("still refuses a real routing change ahead of the configuration field", () => {
    const admitted = identityWith(RAW_CONFIG_JSON);
    const moved = executionIdentity({
      agent: "claude", location: "local", session: "live", model: "gpt-5.6-sol",
      effort: "xhigh", cwd: "/home/operator/Projects/pronoa", config: RAW_CONFIG_JSON,
    });
    expect(compareExecutionIdentity(admitted, moved)).toMatchObject({
      match: false, field: "agent", reason: "thread switched from codex to claude",
    });
  });

  it("preserves an opaque config snapshot without treating it as session identity", () => {
    expect(identityWith("opaque-marker")).toBe(identityWith("opaque-marker"));
    expect(compareExecutionIdentity(identityWith("opaque-marker"), identityWith("other-marker")))
      .toEqual({ match: true, legacy: false });
  });

  it("resumes an attempt stored before the spelling was settled, without a migration", () => {
    // Rows already suspended in SQL hold the old pretty-printed spelling. They
    // must continue on their own; rewriting stored history is not required.
    const legacyStored = JSON.stringify({
      version: 2, agent: "codex", location: "local", session: "live", model: "gpt-5.6-sol",
      effort: "xhigh", cwd: "/home/operator/Projects/pronoa", config: RAW_CONFIG_JSON,
    });
    const { lastContextUsage: _usage, ...parsed } = LIVE_CONFIG;
    expect(compareExecutionIdentity(legacyStored, identityWith(parsed))).toEqual({ match: true, legacy: false });
  });
});

/**
 * #602 — a hanging agent must report what it said.
 *
 * An abnormal exit already surfaces the child's stderr tail. A hang did not:
 * the child stays alive, nothing exits, the 45s timeout wins the race, and the
 * operator receives only "ACP initialize timed out after 45s (agent never
 * responded; check that '<id>' is installed and authenticated)".
 *
 * That sentence sent an entire afternoon into an authentication dead end while
 * the real cause — `flags provided but not defined: -log-file`, agy refusing a
 * flag seam passed — sat unread in the ring this runtime already maintains.
 */
import { describe, expect, it } from "vitest";
import { withRetainedStderr } from "../packages/core/src/agents/agent-runtime.js";

const TIMEOUT_MESSAGE =
  "ACP initialize timed out after 45s (agent never responded; check that 'agy' is installed and authenticated)";

describe("#602 retained stderr on a start failure", () => {
  it("attaches the tail the child actually produced", () => {
    const enriched = withRetainedStderr(new Error(TIMEOUT_MESSAGE), [
      "Usage: agy models [flags]",
      "Error: flags provided but not defined: -log-file /tmp/x.log",
    ]);
    expect(enriched).toBeInstanceOf(Error);
    // The real cause is now in front of whoever is reading.
    expect((enriched as Error).message).toContain("flags provided but not defined");
  });

  it("keeps the original sentence so callers matching on it still work", () => {
    const original = new Error(TIMEOUT_MESSAGE);
    const enriched = withRetainedStderr(original, ["some diagnostic"]) as Error;
    expect(enriched.message.startsWith(TIMEOUT_MESSAGE)).toBe(true);
    expect(enriched.cause).toBe(original);
  });

  it("returns the error untouched when the child said nothing", () => {
    // Silence is not a diagnosis. Inventing "(no output)" would read as though
    // the runtime had asked and been answered.
    const original = new Error(TIMEOUT_MESSAGE);
    expect(withRetainedStderr(original, [])).toBe(original);
    expect(withRetainedStderr(original, ["", "   ", "\n"])).toBe(original);
  });

  it("bounds the tail so a chatty child cannot flood the error", () => {
    const noisy = Array.from({ length: 500 }, (_, i) => `line-${i} ${"x".repeat(200)}`);
    const enriched = withRetainedStderr(new Error(TIMEOUT_MESSAGE), noisy) as Error;
    expect(enriched.message.length).toBeLessThan(TIMEOUT_MESSAGE.length + 4_200);
    // The LAST lines are kept — the cause of death is at the end, not the start.
    expect(enriched.message).toContain("line-499");
  });

  it("passes non-Error rejections through unchanged", () => {
    const thrown = { code: "not-an-error" };
    expect(withRetainedStderr(thrown, ["ignored"])).toBe(thrown);
  });
});

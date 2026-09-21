import { describe, expect, it, vi } from "vitest";
import { resolveError } from "@seam/adapters";
import { DEFAULT_ERROR_RULES } from "../packages/core/src/core/error-resolution-rules.js";
import { buildRecoveryDirective, runBoundedRecovery } from "../packages/core/src/core/recovery-directive.js";

describe("#448 wire directive and mechanical bounded owner", () => {
  it("round-trips the permitted ladder, counts, backoff and precomputed options as JSON", () => {
    const verdict = resolveError({ errorKind: "rate_limit", agentId: "claude", viableOptions: [
      { id: "model:precomputed-fallback", rung: 2 }, { id: "session:reattach", rung: 3 },
    ] }, DEFAULT_ERROR_RULES);
    const directive = buildRecoveryDirective(verdict, "conversation", [1, 2, 3, 4, 5]);
    expect(JSON.parse(JSON.stringify(directive))).toEqual(directive);
    expect(directive).toMatchObject({ version: 1, startRung: 1, surface: true, tier: verdict.tier, optionCount: 2 });
    expect(directive.steps).toEqual([
      { rung: 1, retryCount: 3, backoffMs: [2000, 5000, 10000], optionIds: [] },
      { rung: 2, retryCount: 1, backoffMs: [0], optionIds: ["model:precomputed-fallback"] },
      { rung: 3, retryCount: 1, backoffMs: [0], optionIds: ["session:reattach"] },
      { rung: 4, retryCount: 1, backoffMs: [0], optionIds: [] },
      { rung: 5, retryCount: 0, backoffMs: [], optionIds: [] },
    ]);
  });

  it("unknown remains recover-and-surface, not a silent stop", () => {
    const directive = buildRecoveryDirective(resolveError({ errorKind: "unclassified", agentId: "fixture" }, []), "conversation");
    expect(directive.steps.map(step => step.rung)).toEqual([1, 5]);
    expect(directive.surface).toBe(true);
  });

  it("ephemeral work and cancellation only surface, without provider retries", () => {
    const rate = resolveError({ errorKind: "rate_limit", agentId: "fixture" }, DEFAULT_ERROR_RULES);
    const cancelled = resolveError({ errorKind: "cancelled", agentId: "fixture" }, DEFAULT_ERROR_RULES);
    for (const directive of [buildRecoveryDirective(rate, "ephemeral"), buildRecoveryDirective(cancelled, "conversation")]) {
      expect(directive.steps).toEqual([{ rung: 5, retryCount: 0, backoffMs: [], optionIds: [] }]);
    }
  });

  it("a changed failure cannot replenish the first budget", async () => {
    const run = vi.fn().mockRejectedValue(new Error("still failed"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const delays = vi.fn().mockReturnValueOnce([1]).mockReturnValue([1, 2, 3]);
    await expect(runBoundedRecovery({ run, delays, sleep })).rejects.toThrow("still failed");
    expect(run).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("a changed failure can stop recovery immediately", async () => {
    const run = vi.fn().mockRejectedValue(new Error("changed"));
    const delays = vi.fn().mockReturnValueOnce([1, 2, 3]).mockReturnValue([]);
    await expect(runBoundedRecovery({ run, delays, sleep: async () => {} })).rejects.toThrow("changed");
    expect(run).toHaveBeenCalledTimes(2);
  });
});

import { describe, expect, it, vi } from "vitest";
import { resolveError, providerRetryBackoff, PROVIDER_RETRY_WINDOW_MS } from "@seam/adapters";
import { DEFAULT_ERROR_RULES } from "../packages/core/src/core/error-resolution-rules.js";
import { buildRecoveryDirective, runBoundedRecovery } from "../packages/core/src/core/recovery-directive.js";

describe("#448 wire directive and mechanical bounded owner", () => {
  it.each(["overloaded", "server_error"] as const)("extends only %s using the existing rung-1 directive", kind => {
    const directive = buildRecoveryDirective(resolveError({ errorKind: kind, agentId: "codex" }, DEFAULT_ERROR_RULES), "conversation");
    expect(directive.steps[0]).toMatchObject({ rung: 1, retryCount: 5, backoffMs: providerRetryBackoff(kind) });
  });

  it("does not retry again when provider time has consumed the horizon", async () => {
    let time = 0;
    let calls = 0;
    const cause = new Error("Overloaded");
    const run = vi.fn(async () => { if (++calls > 1) time += PROVIDER_RETRY_WINDOW_MS; throw cause; });
    const sleep = vi.fn(async (delay: number) => { time += delay; });
    await expect(runBoundedRecovery({ run, delays: () => providerRetryBackoff("overloaded")!, sleep,
      now: () => time, windowMs: () => PROVIDER_RETRY_WINDOW_MS })).rejects.toBe(cause);
    expect(run).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(10_000);
  });

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

  it("ephemeral work defaults to report-only and cancellation cannot be overridden", () => {
    const rate = resolveError({ errorKind: "rate_limit", agentId: "fixture" }, DEFAULT_ERROR_RULES);
    const cancelled = resolveError({ errorKind: "cancelled", agentId: "fixture" }, DEFAULT_ERROR_RULES);
    for (const directive of [buildRecoveryDirective(rate, "ephemeral"),
      buildRecoveryDirective(cancelled, "conversation"), buildRecoveryDirective(cancelled, "ephemeral", [1, 5])]) {
      expect(directive.steps).toEqual([{ rung: 5, retryCount: 0, backoffMs: [], optionIds: [] }]);
    }
  });

  it.each(["overloaded", "auth_contention"] as const)("uses the existing %s schedule when the ephemeral caller permits rung 1", kind => {
    const verdict = resolveError({ errorKind: kind, agentId: kind === "overloaded" ? "codex" : "claude" }, DEFAULT_ERROR_RULES);
    const directive = buildRecoveryDirective(verdict, "ephemeral", [1, 5]);
    expect(directive.scope).toBe("ephemeral");
    expect(directive.steps).toEqual(buildRecoveryDirective(verdict, "conversation").steps);
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

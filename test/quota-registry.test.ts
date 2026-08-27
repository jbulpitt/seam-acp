import { describe, expect, it } from "vitest";
import {
  AgentTurnWindow,
  QuotaRegistry,
  quotaPollIntervalMs,
} from "../packages/core/src/core/quota/quota-registry.js";
import { mapUnlimitedQuota } from "../packages/core/src/core/quota/agent-quota.js";

describe("quota polling cadence", () => {
  it("selects the exact per-agent cadence tiers", () => {
    expect(quotaPollIntervalMs(0)).toBe(3_600_000);
    expect(quotaPollIntervalMs(1)).toBe(1_800_000);
    expect(quotaPollIntervalMs(2)).toBe(1_800_000);
    expect(quotaPollIntervalMs(3)).toBe(900_000);
    expect(quotaPollIntervalMs(7)).toBe(900_000);
    expect(quotaPollIntervalMs(8)).toBe(300_000);
    expect(quotaPollIntervalMs(20)).toBe(300_000);
  });

  it("counts and cools down each agent independently over ten minutes", () => {
    const turns = new AgentTurnWindow();
    const now = 1_000_000;
    turns.record("claude", now - 9 * 60_000);
    turns.record("claude", now - 1_000);
    turns.record("codex", now - 11 * 60_000);
    expect(turns.turnsInLast10Min("claude", now)).toBe(2);
    expect(turns.turnsInLast10Min("codex", now)).toBe(0);
    expect(turns.turnsInLast10Min("claude", now + 11 * 60_000)).toBe(0);
  });
});

describe("QuotaRegistry", () => {
  it("stores, replaces, gets, and lists normalized snapshots", () => {
    const registry = new QuotaRegistry();
    registry.set(mapUnlimitedQuota({ agentId: "z", displayName: "Zed" }, 10));
    registry.set(mapUnlimitedQuota({ agentId: "a", displayName: "Alpha" }, 11));
    registry.set({
      ...mapUnlimitedQuota({ agentId: "z", displayName: "Zed" }, 12),
      plan: "updated",
    });
    expect(registry.get("z")?.fetchedAt).toBe(12);
    expect(registry.get("missing")).toBeUndefined();
    expect(registry.all().map((quota) => quota.agentId)).toEqual(["a", "z"]);
    expect(registry.all()).toHaveLength(2);
  });
});

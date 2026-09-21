import { describe, expect, it } from "vitest";
import { parseWarmSetHosts } from "../packages/core/src/core/warm-set/hosts.js";
import { agentFamily, holdingMb, loadCost } from "../packages/core/src/core/warm-set/footprint.js";
import { selectWarmSet, type WarmCandidate } from "../packages/core/src/core/warm-set/select.js";
import { BoundPool } from "../packages/core/src/core/warm-set/pool.js";

function c(over: Partial<WarmCandidate> & Pick<WarmCandidate, "sessionId" | "agentId">): WarmCandidate {
  return {
    updatedUtc: "2026-09-20T00:00:00.000Z",
    acpSessionId: "acp-1",
    hot: false,
    busy: false,
    ...over,
  };
}

describe("footprint measurements", () => {
  it("does not pretend copilot or agy cost what Claude costs", () => {
    expect(holdingMb("claude")).toBe(680);
    expect(holdingMb("codex")).toBe(380);
    expect(holdingMb("grok")).toBe(110);
    expect(holdingMb("copilot")).toBeNull();
    expect(holdingMb("agy")).toBeNull();
    expect(holdingMb("copilot-jbulpitt")).toBeNull();
    expect(agentFamily("ollama-cloud")).toBe("codex");
    expect(loadCost("codex")).toBe("high");
    expect(loadCost("claude")).toBe("low");
  });
});

describe("parseWarmSetHosts", () => {
  it("empty is opt-out", () => {
    expect(parseWarmSetHosts("")).toEqual([]);
    expect(parseWarmSetHosts("   ")).toEqual([]);
  });

  it("applies measured host defaults and explicit MB overrides", () => {
    expect(parseWarmSetHosts("fhr-server,rhc-server=8000")).toEqual([
      { id: "fhr-server", budgetMb: 2500 },
      { id: "rhc-server", budgetMb: 8000 },
    ]);
  });
});

describe("selectWarmSet", () => {
  it("keeps hot sessions that fit and loads recent measured cold ones up to slots", () => {
    const decisions = selectWarmSet({
      budgetMb: 1500,
      loadSlots: 2,
      highCostLoadSlots: 1,
      candidates: [
        c({ sessionId: "hot-claude", agentId: "claude", hot: true, updatedUtc: "2026-09-20T12:00:00.000Z" }),
        c({ sessionId: "cold-grok", agentId: "grok", updatedUtc: "2026-09-20T11:00:00.000Z" }),
        c({ sessionId: "cold-codex", agentId: "codex", updatedUtc: "2026-09-20T10:00:00.000Z" }),
        c({ sessionId: "older-grok", agentId: "grok", updatedUtc: "2026-09-19T00:00:00.000Z" }),
      ],
    });
    const byId = Object.fromEntries(decisions.map((d) => [d.sessionId, d.action]));
    expect(byId["hot-claude"]).toBe("keep");
    expect(byId["cold-grok"]).toBe("load");
    expect(byId["cold-codex"]).toBe("load");
    expect(byId["older-grok"]).toBe("ignore");
  });

  it("will not start an unmeasured agent, and will not evict a mid-turn hot session over budget", () => {
    const decisions = selectWarmSet({
      budgetMb: 100,
      loadSlots: 3,
      highCostLoadSlots: 1,
      candidates: [
        c({ sessionId: "busy-claude", agentId: "claude", hot: true, busy: true }),
        c({ sessionId: "cold-copilot", agentId: "copilot" }),
        c({ sessionId: "no-acp", agentId: "grok", acpSessionId: "" }),
      ],
    });
    const byId = Object.fromEntries(decisions.map((d) => [d.sessionId, d]));
    expect(byId["busy-claude"]?.action).toBe("keep");
    expect(byId["busy-claude"]?.reason).toBe("mid-turn");
    expect(byId["cold-copilot"]?.action).toBe("ignore");
    expect(byId["cold-copilot"]?.reason).toMatch(/unmeasured/);
    expect(byId["no-acp"]?.action).toBe("ignore");
  });

  it("evicts the least-recent idle hot session when the budget cannot hold it", () => {
    const decisions = selectWarmSet({
      budgetMb: 700,
      loadSlots: 0,
      highCostLoadSlots: 0,
      candidates: [
        c({ sessionId: "newer", agentId: "claude", hot: true, updatedUtc: "2026-09-20T12:00:00.000Z" }),
        c({ sessionId: "older", agentId: "claude", hot: true, updatedUtc: "2026-09-19T12:00:00.000Z" }),
      ],
    });
    const byId = Object.fromEntries(decisions.map((d) => [d.sessionId, d.action]));
    expect(byId["newer"]).toBe("keep");
    expect(byId["older"]).toBe("evict");
  });

  it("caps high-cost Codex loads even when loadSlots remain", () => {
    const decisions = selectWarmSet({
      budgetMb: 10_000,
      loadSlots: 3,
      highCostLoadSlots: 1,
      candidates: [
        c({ sessionId: "c1", agentId: "codex", updatedUtc: "2026-09-20T03:00:00.000Z" }),
        c({ sessionId: "c2", agentId: "codex", updatedUtc: "2026-09-20T02:00:00.000Z" }),
        c({ sessionId: "g1", agentId: "grok", updatedUtc: "2026-09-20T01:00:00.000Z" }),
      ],
    });
    const byId = Object.fromEntries(decisions.map((d) => [d.sessionId, d.action]));
    expect(byId["c1"]).toBe("load");
    expect(byId["c2"]).toBe("ignore");
    expect(byId["g1"]).toBe("load");
  });
});

describe("BoundPool", () => {
  it("never runs more than `limit` tasks at once, and a slow task does not stall others", async () => {
    const pool = new BoundPool(2);
    let max = 0;
    let current = 0;
    const order: string[] = [];
    const hold = async (name: string, ms: number) => {
      current += 1; max = Math.max(max, current);
      await new Promise((r) => setTimeout(r, ms));
      current -= 1;
      order.push(name);
    };
    const slow = pool.run(() => hold("slow", 80));
    const a = pool.run(() => hold("a", 30));
    const b = pool.run(() => hold("b", 30));
    await Promise.all([slow, a, b]);
    expect(max).toBe(2);
    expect(order).toContain("a");
    expect(order).toContain("b");
    expect(order).toContain("slow");
  });
});

import { describe, expect, it } from "vitest";
import {
  mapAgyQuota,
  mapClaudeQuota,
  mapCodexQuota,
  mapCopilotQuota,
  mapGrokQuota,
  mapUnlimitedQuota,
  normalizeQuotaWindows,
  ROLLING_WINDOW_SECONDS,
  WEEKLY_WINDOW_SECONDS,
} from "../packages/core/src/core/quota/agent-quota.js";

const identity = { agentId: "agent", displayName: "Agent" };
const now = 2_000_000_000;

describe("agent quota normalization", () => {
  it("always synthesizes missing rolling and weekly dimensions as full", () => {
    expect(normalizeQuotaWindows({}, now)).toEqual({
      rolling: { usedPercent: 0, resetsAt: now + ROLLING_WINDOW_SECONDS, label: "rolling" },
      weekly: { usedPercent: 0, resetsAt: now + WEEKLY_WINDOW_SECONDS, label: "weekly" },
    });
  });

  it("maps codex windows by duration regardless of primary/secondary order", () => {
    const quota = mapCodexQuota(identity, {
      ok: true,
      plan: "plus",
      primary: { usedPercent: 61, windowMinutes: 10_080, resetsAt: now + 500 },
      secondary: { usedPercent: 24, windowMinutes: 300, resetsAt: now + 100 },
      credits: { hasCredits: true, unlimited: false, balance: "12.50" },
    }, now);
    expect(quota.rolling.usedPercent).toBe(24);
    expect(quota.weekly.usedPercent).toBe(61);
    expect(quota.credits).toEqual({ balance: "12.50", unlimited: false });
  });

  it("maps Claude's 5-hour and 7-day buckets directly", () => {
    const quota = mapClaudeQuota(identity, {
      login: "a@example.com",
      subscriptionType: "max",
      rateLimitTier: null,
      fiveHour: { utilization: 12, resetsAt: "2033-05-18T03:34:00.000Z" },
      sevenDay: { utilization: 45, resetsAt: "2033-05-20T03:34:00.000Z" },
      sevenDaySonnet: null,
      sevenDayOpus: null,
      extraUsage: null,
    }, now);
    expect(quota.rolling.usedPercent).toBe(12);
    expect(quota.weekly.usedPercent).toBe(45);
    expect(quota.plan).toBe("max");
  });

  it("puts Copilot's monthly-ish premium quota in weekly and fills rolling", () => {
    const quota = mapCopilotQuota(identity, {
      login: "octocat",
      plan: "business",
      org: null,
      quotaResetAt: "2033-05-20T03:34:00.000Z",
      chat: null,
      completions: null,
      premiumInteractions: {
        unlimited: false,
        entitlement: 100,
        remaining: 35,
        percentRemaining: 35,
        overagePermitted: false,
        overageCount: 0,
      },
    }, now);
    expect(quota.weekly.usedPercent).toBe(65);
    expect(quota.rolling).toEqual({
      usedPercent: 0,
      resetsAt: now + ROLLING_WINDOW_SECONDS,
      label: "rolling",
    });
  });

  it("puts Grok's real limit in weekly and synthesizes rolling", () => {
    const quota = mapGrokQuota(identity, {
      subscriptionTier: "supergrok",
      creditUsagePercent: 72,
      periodType: "weekly",
      periodStart: null,
      periodEnd: "2033-05-20T03:34:00.000Z",
      isUnifiedBillingUser: true,
    }, now);
    expect(quota.weekly.usedPercent).toBe(72);
    expect(quota.rolling.resetsAt).toBe(now + ROLLING_WINDOW_SECONDS);
  });

  it("maps Antigravity credits to credits + weekly", () => {
    const quota = mapAgyQuota(identity, {
      planName: "pro",
      monthlyPromptCredits: 1_000,
      availablePromptCredits: 250,
      models: [{ label: "Gemini", remainingFraction: 0.2, resetTime: "2033-05-20T03:34:00.000Z" }],
    }, now);
    expect(quota.weekly.usedPercent).toBe(75);
    expect(quota.credits).toEqual({ balance: "250", unlimited: false });
    expect(quota.rolling.usedPercent).toBe(0);
  });

  it("represents fully unlimited local agents in both dimensions", () => {
    const quota = mapUnlimitedQuota(identity, now);
    expect(quota.rolling).toEqual({ usedPercent: 0, resetsAt: null, label: "unlimited" });
    expect(quota.weekly).toEqual({ usedPercent: 0, resetsAt: null, label: "unlimited" });
    expect(quota.credits?.unlimited).toBe(true);
  });
});

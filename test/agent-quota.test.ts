import { describe, expect, it } from "vitest";
import { parseAgyQuotaSummary } from "../packages/adapters/src/profiles/agy.js";
import { parseOllamaCloudUsage } from "../packages/adapters/src/profiles/ollama-cloud.js";
import type { AgentProfile } from "../packages/adapters/src/agent-profile.js";
import {
  mapAgyQuota,
  mapClaudeQuota,
  mapCodexQuota,
  mapCopilotQuota,
  mapGrokQuota,
  mapOllamaCloudQuota,
  mapUnlimitedQuota,
  normalizeQuotaWindows,
  ROLLING_WINDOW_SECONDS,
  WEEKLY_WINDOW_SECONDS,
} from "../packages/core/src/core/quota/agent-quota.js";
import { createAgentQuotaSources } from "../packages/core/src/core/quota/quota-poller.js";

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

  it("maps Antigravity's captured quota-summary envelope to rolling and weekly", () => {
    const data = parseAgyQuotaSummary({
      response: {
        groups: [
          {
            displayName: "Gemini Models",
            description: "Models within this group: Gemini Flash, Gemini Pro",
            buckets: [
              {
                bucketId: "gemini-weekly",
                displayName: "Weekly Limit Remaining",
                window: "weekly",
                remainingFraction: 0.98932266,
                resetTime: "2026-09-02T05:15:05Z",
              },
              {
                bucketId: "gemini-5h",
                displayName: "Five Hour Limit Remaining",
                window: "5h",
                remainingFraction: 0.9949275,
                resetTime: "2026-08-27T09:00:05Z",
              },
            ],
          },
          {
            displayName: "Claude and GPT models",
            buckets: [
              {
                bucketId: "3p-weekly",
                displayName: "Weekly Limit Remaining",
                window: "weekly",
                remainingFraction: 1,
                resetTime: "2026-09-02T20:23:47Z",
              },
              {
                bucketId: "3p-5h",
                displayName: "Five Hour Limit Remaining",
                window: "5h",
                remainingFraction: 1,
                resetTime: "2026-08-27T10:37:45Z",
              },
            ],
          },
        ],
        description: "Within each group, models share quota limits.",
      },
    });
    expect(data.groups).toHaveLength(2);

    const quota = mapAgyQuota(identity, data, now);
    expect(quota.ok).toBe(true);
    expect(quota.weekly.usedPercent).toBeCloseTo(1.067734);
    expect(quota.weekly.resetsAt).toBe(Date.parse("2026-09-02T05:15:05Z") / 1000);
    expect(quota.rolling.usedPercent).toBeCloseTo(0.50725);
    expect(quota.rolling.resetsAt).toBe(Date.parse("2026-08-27T09:00:05Z") / 1000);
    expect(quota.plan).toBeNull();
    expect(quota.credits).toBeNull();
  });

  it("collapses each Antigravity window to the group with the least remaining", () => {
    const quota = mapAgyQuota(identity, {
      groups: [
        {
          displayName: "Weekly constrained",
          buckets: [
            { displayName: "Weekly", window: "weekly", remainingFraction: 0.2 },
            { displayName: "Five hour", window: "5h", remainingFraction: 0.9 },
          ],
        },
        {
          displayName: "Rolling constrained",
          buckets: [
            { displayName: "Weekly", window: "weekly", remainingFraction: 0.8 },
            { displayName: "Five hour", window: "5h", remainingFraction: 0.1 },
          ],
        },
      ],
    }, now);
    expect(quota.weekly.usedPercent).toBe(80);
    expect(quota.rolling.usedPercent).toBe(90);
  });

  it("maps ollama-usage JSON without inverting its used percentages", () => {
    const data = parseOllamaCloudUsage({
      "5h": {
        identifier: "5h",
        pct_used: 0.0,
        reset_at: "2026-08-27T07:00:00+00:00",
        models: [],
      },
      weekly: {
        identifier: "weekly",
        pct_used: 43.6,
        reset_at: "2026-08-31T00:00:00+00:00",
        models: [
          { model: "kimi-k3", requests: 664 },
          { model: "glm-5.2", requests: 272 },
        ],
      },
    });
    const quota = mapOllamaCloudQuota(identity, data, now);
    expect(quota.ok).toBe(true);
    expect(quota.rolling.usedPercent).toBe(0);
    expect(quota.rolling.resetsAt).toBe(
      Date.parse("2026-08-27T07:00:00+00:00") / 1000
    );
    expect(quota.weekly.usedPercent).toBe(43.6);
    expect(quota.weekly.resetsAt).toBe(
      Date.parse("2026-08-31T00:00:00+00:00") / 1000
    );
    expect(data.weekly?.models).toEqual([
      { model: "kimi-k3", requests: 664 },
      { model: "glm-5.2", requests: 272 },
    ]);
  });

  it("wires ollama-cloud to a defensive CLI quota source", async () => {
    const profile = {
      id: "ollama-cloud",
      displayName: "Ollama Cloud",
    } as AgentProfile;
    const [source] = createAgentQuotaSources([profile], {
      ollamaUsageCliPath: "/definitely/missing/ollama-usage",
    });
    expect(source).toBeDefined();
    const quota = await source!.fetch();
    expect(quota.ok).toBe(false);
    expect(quota.error).toMatch(/ollama-usage spawn failed/);
    expect(quota.error).not.toMatch(/does not expose quota data/);
  });

  it("represents fully unlimited local agents in both dimensions", () => {
    const quota = mapUnlimitedQuota(identity, now);
    expect(quota.rolling).toEqual({ usedPercent: 0, resetsAt: null, label: "unlimited" });
    expect(quota.weekly).toEqual({ usedPercent: 0, resetsAt: null, label: "unlimited" });
    expect(quota.credits?.unlimited).toBe(true);
  });
});

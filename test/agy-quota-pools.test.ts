import { describe, expect, it } from "vitest";
import { parseAgyQuotaSummary } from "../packages/adapters/src/profiles/agy.js";
import { mapAgyQuota, mapUnavailableQuota } from "../packages/core/src/core/quota/agent-quota.js";
import { renderAgentQuotaLayout, renderAgentQuotaPanel } from "../packages/core/src/core/quota/agent-quota-card.js";
import { QuotaRegistry } from "../packages/core/src/core/quota/quota-registry.js";
import { quotaMcp } from "../packages/core/src/plugins/quota/mcp.js";
import { formatUsage } from "../packages/core/src/plugins/quota/format-usage.js";
import { renderGoogleChatLayout, renderGoogleChatPanel } from "../packages/core/src/platforms/google-chat/card-renderer.js";

const identity = { agentId: "agy", displayName: "Antigravity" };
const now = 1791777752;

// RetrieveUserQuotaSummary, seam-dev-server / agy 1.3.3, 2026-10-12T04:02Z.
function capturedUsage() {
  return parseAgyQuotaSummary({ response: { groups: [
    { displayName: "Gemini Models", description: "Models within this group: Gemini Flash, Gemini Pro", buckets: [
      { bucketId: "gemini-weekly", displayName: "Weekly Limit Remaining", window: "weekly", remainingFraction: 0.999346, resetTime: "2026-10-18T21:45:04Z" },
      { bucketId: "gemini-5h", displayName: "Five Hour Limit Remaining", window: "5h", remainingFraction: 0.9965602, resetTime: "2026-10-12T06:45:06Z" },
    ] },
    { displayName: "Claude and GPT models", description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS", buckets: [
      { bucketId: "3p-weekly", displayName: "Weekly Limit Remaining", window: "weekly", remainingFraction: 1, resetTime: "2026-10-19T04:02:31Z" },
      { bucketId: "3p-5h", displayName: "Five Hour Limit Remaining", window: "5h", remainingFraction: 1, resetTime: "2026-10-12T09:02:31Z" },
    ] },
  ] } });
}

describe("Antigravity's independent quota pools", () => {
  it("returns both native groups with their own windows through agent_quota", async () => {
    const registry = new QuotaRegistry();
    registry.set(mapAgyQuota(identity, capturedUsage(), now));
    const response = await quotaMcp(registry)[0]!.handle({ threadId: "quota", args: { agentId: "agy" } }, {} as never);
    const [quota] = JSON.parse(response.content[0]!.text);
    expect(quota.pools).toHaveLength(2);
    expect(quota.pools[0]).toMatchObject({ displayName: "Gemini Models", description: "Models within this group: Gemini Flash, Gemini Pro" });
    expect(quota.pools[0].rolling.usedPercent).toBeCloseTo(0.34398);
    expect(quota.pools[0].weekly.usedPercent).toBeCloseTo(0.0654);
    expect(quota.pools[1]).toMatchObject({ displayName: "Claude and GPT models", rolling: { usedPercent: 0, resetsAt: Date.parse("2026-10-12T09:02:31Z") / 1000 }, weekly: { usedPercent: 0, resetsAt: Date.parse("2026-10-19T04:02:31Z") / 1000 } });
    expect(quota.rolling.usedPercent).toBeCloseTo(0.34398);
    expect(quota.weekly.usedPercent).toBeCloseTo(0.0654);
  });

  it("does not mix two pools' percentages or resets when either is constrained", () => {
    const data = capturedUsage();
    data.groups[1]!.buckets[0]!.remainingFraction = 0.08;
    const quota = mapAgyQuota(identity, data, now);
    expect(quota.pools?.[0]?.weekly.usedPercent).toBeCloseTo(0.0654);
    expect(quota.pools?.[1]?.weekly.usedPercent).toBe(92);
    expect(quota.weekly).toEqual(quota.pools?.[1]?.weekly);
    const panel = renderAgentQuotaPanel([quota]);
    expect(panel.color).toBe(0xfaa61a);
    expect(panel.fields[0]!.value).toContain("Claude and GPT models");
    expect(panel.fields[0]!.value).toContain("92%");
  });

  it("shows both named pools in the shared card on Discord and Google Chat", () => {
    const quota = mapAgyQuota(identity, capturedUsage(), now);
    const layout = renderAgentQuotaLayout([quota]);
    const panel = renderAgentQuotaPanel([quota]);
    const outputs = [JSON.stringify(layout), panel.fields[0]!.value,
      JSON.stringify(renderGoogleChatLayout(layout, "quota")), JSON.stringify(renderGoogleChatPanel(panel, "quota"))];
    for (const text of outputs) {
      expect(text).toContain("Gemini Models");
      expect(text).toContain("Claude and GPT models");
      expect(text).toContain("5h");
      expect(text).toContain("weekly");
      expect(text).toContain("0%");
      expect(text).toContain("resets");
    }
    expect(panel.fields[0]!.value).toContain(String(Date.parse("2026-10-19T04:02:31Z") / 1000));
    expect(JSON.stringify(renderGoogleChatPanel(panel, "quota"))).toContain("2026-10-19 04:02:31 UTC");
    expect(formatUsage({ provider: "agy", data: capturedUsage() })).toContain("Claude and GPT models");
  });

  it("shows a missing pool as unknown without inventing a full quota or reset", () => {
    const data = capturedUsage();
    data.groups.pop();
    const quota = mapAgyQuota(identity, data, now);
    expect(quota.ok).toBe(true);
    expect(quota.pools?.[1]).toMatchObject({ displayName: "Claude and GPT models",
      rolling: { usedPercent: null, resetsAt: null, error: expect.stringMatching(/RetrieveUserQuotaSummary.*Claude and GPT models.*5h/) },
      weekly: { usedPercent: null, resetsAt: null, error: expect.stringMatching(/RetrieveUserQuotaSummary.*Claude and GPT models.*weekly/) } });
    for (const text of [renderAgentQuotaPanel([quota]).fields[0]!.value, formatUsage({ provider: "agy", data })]) {
      expect(text).toContain("Claude and GPT models");
      expect(text).toContain("unknown");
      expect(text).toContain("RetrieveUserQuotaSummary");
    }
  });

  it("keeps a missing window unknown while preserving the other reported window", () => {
    const data = capturedUsage();
    data.groups[1]!.buckets.pop();
    const quota = mapAgyQuota(identity, data, now);
    expect(quota.pools?.[1]?.rolling).toMatchObject({ usedPercent: null, resetsAt: null, error: expect.stringContaining("5h") });
    expect(quota.pools?.[1]?.weekly.usedPercent).toBe(0);
    expect(quota.pools?.[1]?.weekly.resetsAt).toBe(Date.parse("2026-10-19T04:02:31Z") / 1000);
  });

  it("does not silently report malformed or empty quota data as unused", () => {
    const data = parseAgyQuotaSummary({ response: { groups: [{ displayName: "Gemini Models", buckets: [
      { displayName: "Weekly", window: "weekly", remainingFraction: Number.NaN },
    ] }] } });
    const quota = mapAgyQuota(identity, data, now);
    expect(quota.ok).toBe(false);
    expect(quota.rolling).toMatchObject({ usedPercent: null, resetsAt: null });
    expect(quota.weekly).toMatchObject({ usedPercent: null, resetsAt: null });
    expect(quota.pools).toHaveLength(2);
    expect(quota.pools?.[0]?.weekly.error).toContain("RetrieveUserQuotaSummary");
  });

  it("reports the actual probe failure on both unknown pools", () => {
    const cause = "agy language server did not appear within 8000ms";
    const quota = mapUnavailableQuota(identity, cause, now);
    expect(quota.pools).toHaveLength(2);
    for (const pool of quota.pools ?? []) {
      expect(pool.rolling).toMatchObject({ usedPercent: null, resetsAt: null, error: cause });
      expect(pool.weekly).toMatchObject({ usedPercent: null, resetsAt: null, error: cause });
    }
    expect(renderAgentQuotaPanel([quota]).fields[0]!.value).toContain(cause);
  });
});

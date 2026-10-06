import { describe, expect, it } from "vitest";
import type { CodexUsageData } from "../packages/adapters/src/profiles/codex-session-manager.js";
import { mapCodexQuota } from "../packages/core/src/core/quota/agent-quota.js";
import { renderAgentQuotaRow } from "../packages/core/src/core/quota/agent-quota-card.js";
import { formatUsage } from "../packages/core/src/plugins/quota/format-usage.js";
import { quotaMcp } from "../packages/core/src/plugins/quota/mcp.js";
import { QuotaRegistry } from "../packages/core/src/core/quota/quota-registry.js";

function reading(kind: "live" | "rollout", observedAt: string | null): CodexUsageData {
  return {ok: true, plan: "pro", primary: {usedPercent: 7, windowMinutes: 10080, resetsAt: 1792000000}, secondary: null, credits: null,
    source: {kind, host: "controller", observedAt}};
}

describe("Codex quota observation source and age", () => {
  it("shows the local snapshot's host and original age, and leaves an absent rolling window unknown", async () => {
    const data = {...reading("rollout", "2026-10-06T00:05:00Z"), liveError: "provider: Authentication required"};
    const quota = mapCodexQuota({agentId: "codex", displayName: "Codex"}, data, 2000000000);
    expect(quota.fetchedAt).toBe(Date.parse(data.source!.observedAt!) / 1000);
    expect(quota.rolling).toEqual({usedPercent: null, resetsAt: null, label: "rolling"});
    expect(quota.weekly.usedPercent).toBe(7);
    expect(renderAgentQuotaRow(quota)).toContain("**rolling** not reported");
    expect(renderAgentQuotaRow(quota)).toContain("Rollout snapshot · controller");
    expect(formatUsage({provider: "codex", data})).toContain(`Rollout snapshot · controller · <t:${quota.fetchedAt}:R>`);
    expect(formatUsage({provider: "codex", data})).toContain("provider: Authentication required");
    const registry = new QuotaRegistry(); registry.set(quota);
    const result = await quotaMcp(registry)[0]!.handle({args: {agentId: "codex"}} as never);
    const rows = JSON.parse((result as {content: {text: string}[]}).content[0]!.text);
    expect(rows[0].source.host).toBe("controller");
    expect(rows[0].ageSeconds).toBeGreaterThan(0);
    expect(rows[0].fetchedAt).toBe(quota.fetchedAt);
  });

  it("identifies a live observation on the card and usage reply", () => {
    const data = reading("live", "2026-10-06T00:05:00Z");
    const quota = mapCodexQuota({agentId: "codex", displayName: "Codex"}, data);
    expect(renderAgentQuotaRow(quota)).toContain("Live read · controller");
    expect(formatUsage({provider: "codex", data})).toContain("Live read · controller");
  });

  it("shows unknown age for a snapshot without an event timestamp", () => {
    const quota = mapCodexQuota({agentId: "codex", displayName: "Codex"}, reading("rollout", null));
    expect(quota.fetchedAt).toBeNull();
    expect(renderAgentQuotaRow(quota)).toContain("age unknown");
  });
});

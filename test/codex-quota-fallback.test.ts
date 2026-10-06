import { describe, expect, it, vi } from "vitest";
import type { CodexUsageData } from "../packages/adapters/src/profiles/codex-session-manager.js";
import { readCodexAccountUsage } from "../packages/core/src/core/quota/codex-account-usage.js";
import { mapCodexQuota } from "../packages/core/src/core/quota/agent-quota.js";
import { renderAgentQuotaRow } from "../packages/core/src/core/quota/agent-quota-card.js";
import { formatUsage } from "../packages/core/src/plugins/quota/format-usage.js";
import { quotaMcp } from "../packages/core/src/plugins/quota/mcp.js";
import { QuotaRegistry } from "../packages/core/src/core/quota/quota-registry.js";

function snapshot(host: string, observedAt: string | null, usedPercent: number, credentialProfile = "account-shared"): CodexUsageData {
  return {ok: true, plan: "pro", primary: {usedPercent, windowMinutes: 10080, resetsAt: 1792000000}, secondary: null, credits: null,
    credentialProfile, source: {kind: "rollout", host, observedAt}};
}
const failed: CodexUsageData = {ok: false, plan: null, primary: null, secondary: null, credits: null,
  credentialProfile: "account-shared", error: "provider: Authentication required"};

describe("Codex account quota live-first fallback", () => {
  it("returns live quota without reading rollout snapshots", async () => {
    const live = {...snapshot("controller", "2026-10-06T01:00:00Z", 7), source: {kind: "live" as const, host: "controller", observedAt: "2026-10-06T01:00:00Z"}};
    const read = vi.fn(async () => live);
    expect(await readCodexAccountUsage({location: "local", locations: ["remote"], read})).toBe(live);
    expect(read).toHaveBeenCalledExactlyOnceWith("local", "live", undefined);
  });

  it("chooses a newer remote snapshot over stale local quota and ignores a different account", async () => {
    const read = vi.fn(async (location: string, mode: string) => mode === "live" ? failed :
      location === "local" ? snapshot("controller", "2026-10-05T23:04:00Z", 100) :
      location === "remote" ? snapshot("worker", "2026-10-06T00:05:00Z", 1) :
      snapshot("other", "2026-10-06T01:00:00Z", 90, "account-other"));
    const data = await readCodexAccountUsage({location: "local", locations: ["local", "remote", "other"], read});
    expect(data.primary?.usedPercent).toBe(1);
    expect(data.source).toEqual({kind: "rollout", host: "worker", observedAt: "2026-10-06T00:05:00Z"});
    expect(data.liveError).toBe("provider: Authentication required");
    expect(read.mock.calls[0]).toEqual(["local", "live", undefined]);
    expect(read.mock.calls.filter(([, mode]) => mode === "snapshot")).toHaveLength(3);
  });

  it("keeps unknown account identity host-local instead of combining unrelated default accounts", async () => {
    const read = async (location: string, mode: string) => mode === "live" ? {...failed, credentialProfile: "default"} :
      snapshot(location, location === "local" ? "2026-10-05T23:04:00Z" : "2026-10-06T00:05:00Z", location === "local" ? 100 : 1, "default");
    const data = await readCodexAccountUsage({location: "local", locations: ["remote"], read});
    expect(data.primary?.usedPercent).toBe(100);
  });

  it("propagates cancellation without falling back or refreshing an observation time", async () => {
    const controller = new AbortController();
    const read = vi.fn(async () => {controller.abort(new Error("owner cancelled")); throw controller.signal.reason;});
    await expect(readCodexAccountUsage({location: "remote", locations: ["local"], read, signal: controller.signal})).rejects.toThrow("owner cancelled");
    expect(read).toHaveBeenCalledOnce();
  });

  it("keeps live and snapshot failure causes when no source is available", async () => {
    const read = async (_location: string, mode: string) => {
      if (mode === "live") throw new Error("account/rateLimits/read: method not found");
      return {...failed, error: "no rate-limit data in recent codex sessions"};
    };
    const data = await readCodexAccountUsage({location: "local", locations: [], read});
    expect(data.ok).toBe(false);
    expect(data.error).toContain("method not found");
    expect(data.error).toContain("no rate-limit data");
  });

  it("shows snapshot host and original age, and leaves an absent rolling window unknown", async () => {
    const data = {...snapshot("worker", "2026-10-06T00:05:00Z", 1), liveError: failed.error};
    const quota = mapCodexQuota({agentId: "codex", displayName: "Codex"}, data, 2000000000);
    expect(quota.fetchedAt).toBe(Date.parse(data.source!.observedAt!) / 1000);
    expect(quota.rolling).toEqual({usedPercent: null, resetsAt: null, label: "rolling"});
    expect(renderAgentQuotaRow(quota)).toContain("**rolling** not reported");
    expect(renderAgentQuotaRow(quota)).toContain("Rollout snapshot · worker");
    expect(formatUsage({provider: "codex", data})).toContain(`Rollout snapshot · worker · <t:${quota.fetchedAt}:R>`);
    expect(formatUsage({provider: "codex", data})).toContain("provider: Authentication required");
    const registry = new QuotaRegistry(); registry.set(quota);
    const result = await quotaMcp(registry)[0]!.handle({args: {agentId: "codex"}} as never);
    const rows = JSON.parse((result as {content: {text: string}[]}).content[0]!.text);
    expect(rows[0].source.host).toBe("worker");
    expect(rows[0].ageSeconds).toBeGreaterThan(0);
    expect(rows[0].fetchedAt).toBe(quota.fetchedAt);
  });

  it("shows unknown age for a snapshot without an event timestamp", () => {
    const quota = mapCodexQuota({agentId: "codex", displayName: "Codex"}, snapshot("worker", null, 1));
    expect(quota.fetchedAt).toBeNull();
    expect(renderAgentQuotaRow(quota)).toContain("age unknown");
  });
});

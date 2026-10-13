import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseGrokBilling } from "@seam/adapters";
import { mapGrokQuota } from "../packages/core/src/core/quota/agent-quota.js";
import { renderAgentQuotaLayout, renderAgentQuotaPanel } from "../packages/core/src/core/quota/agent-quota-card.js";
import { PluginHost } from "../packages/core/src/plugins/host.js";
import { createQuotaPlugin } from "../packages/core/src/plugins/quota/index.js";
import { formatUsage } from "../packages/core/src/plugins/quota/format-usage.js";
import type { UsageBinding } from "../packages/core/src/core/quota/usage-provider.js";

const paidBilling = {
  subscription_tier: "SuperGrok Heavy",
  config: {
    currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-10-10T18:27:12Z", end: "2026-10-17T18:27:12Z" },
    onDemandCap: { val: 0 }, onDemandUsed: { val: 0 }, prepaidBalance: { val: 0 }, isUnifiedBillingUser: true,
  },
};
const identity = { agentId: "grok", displayName: "Grok" };
const now = 1_791_894_210;
const end = Math.floor(Date.parse(paidBilling.config.currentPeriod.end) / 1000);
const hosts: PluginHost[] = [], dirs: string[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Grok paid billing with an omitted zero usage scalar", () => {
  it("reports paid zero usage with the provider's actual period end", () => {
    const quota = mapGrokQuota(identity, parseGrokBilling(paidBilling), now);
    expect(quota).toMatchObject({ ok: true, plan: "SuperGrok Heavy", fetchedAt: now,
      weekly: { usedPercent: 0, resetsAt: end } });
    expect(quota.error).toBeUndefined();
    expect(quota.noSubscription).not.toBe(true);
  });

  it("preserves a reported nonzero meter", () => {
    const quota = mapGrokQuota(identity, parseGrokBilling({ ...paidBilling,
      config: { ...paidBilling.config, creditUsagePercent: 4.5 } }), now);
    expect(quota.weekly).toMatchObject({ usedPercent: 4.5, resetsAt: end });
  });

  it.each([
    { subscription_tier: "SuperGrok Heavy" },
    { ...paidBilling, subscription_tier: null },
  ])("does not invent a meter without both a paid tier and known period", raw => {
    expect(mapGrokQuota(identity, parseGrokBilling(raw), now)).toMatchObject({ ok: false, error: "Grok quota data unavailable" });
  });

  it("keeps the existing Free behavior, including credits", () => {
    const quota = mapGrokQuota(identity, parseGrokBilling({ ...paidBilling, subscription_tier: "Free" }), now);
    expect(quota).toMatchObject({ ok: true, noSubscription: true, plan: "Free", credits: null });
    expect(quota.weekly.resetsAt).toBe(now + 7 * 24 * 60 * 60);
    expect(formatUsage({ provider: "grok", data: parseGrokBilling({ ...paidBilling, subscription_tier: "Free" }) }))
      .toContain("No billing data available.");
  });

  it("carries explicit zero-valued prepaid and on-demand data through normalization", () => {
    const data = parseGrokBilling(paidBilling);
    expect(data).toMatchObject({ prepaidBalance: 0, onDemandCap: 0, onDemandUsed: 0 });
    expect(mapGrokQuota(identity, data, now).credits).toEqual({ balance: "0", unlimited: false,
      onDemand: { used: "0", cap: "0" } });
  });

  it("keeps the actual prepaid and on-demand amounts", () => {
    const data = parseGrokBilling({ ...paidBilling, config: { ...paidBilling.config,
      prepaidBalance: { val: 12.5 }, onDemandCap: { val: 50 }, onDemandUsed: { val: 7 } } });
    expect(mapGrokQuota(identity, data, now).credits).toEqual({ balance: "12.5", unlimited: false,
      onDemand: { used: "7", cap: "50" } });
  });

  it("renders the paid zero-usage card without a false warning", () => {
    const quota = mapGrokQuota(identity, parseGrokBilling(paidBilling), now);
    const layout = renderAgentQuotaLayout([quota]), panel = renderAgentQuotaPanel([quota]);
    for (const text of [JSON.stringify(layout), JSON.stringify(panel)]) {
      expect(text).toContain("SuperGrok Heavy"); expect(text).toContain("0%");
      expect(text).toContain(`resets <t:${end}:R>`);
      expect(text).toContain("credits 0"); expect(text).toContain("on-demand 0 / 0");
      expect(text).not.toMatch(/⚠️|No subscription|quota data unavailable/);
    }
    expect(layout.color).toBe(0x57f287); expect(panel.color).toBe(layout.color);
  });

  it("uses the same paid-zero interpretation in the live usage reply", () => {
    const text = formatUsage({ provider: "grok", data: parseGrokBilling(paidBilling) });
    expect(text).toContain("0%"); expect(text).toContain("Credits: 0");
    expect(text).toContain("On-demand: 0 / 0"); expect(text).not.toContain("No billing data");
  });

  it("the existing Refresh button replaces a cached Free plan without a Grok turn", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now * 1000);
    let paid = false;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-paid-quota-")); dirs.push(root);
    const file = path.join(root, "agent-quota-card.json");
    fs.writeFileSync(file, JSON.stringify({ threadId: "quota-thread", messageId: "legacy", lastBumpAt: Date.now() }));
    const binding: UsageBinding = { ...identity, location: "local", account: "grok", provider: "grok", quotaAvailable: true };
    const readUsage = vi.fn(async () => ({ provider: "grok" as const,
      data: parseGrokBilling(paid ? paidBilling : { subscription_tier: "Free" }) }));
    const card = { sendLayout: vi.fn(async channel => ({ channel, id: "new" })), editLayout: vi.fn(async () => {}),
      pinMessage: vi.fn(async () => {}) };
    const host = new PluginHost(pino({ level: "silent" }), { storageRoot: root,
      storageAliases: { quota: { "agent-quota-card.json": file } } }); hosts.push(host);
    await host.loadBuiltins([{ id: "quota", load: async () => createQuotaPlugin({ usage: { readUsage },
      bindings: () => [binding], resolve: () => binding, card }) }], { quota: {
      DISCORD_AGENT_QUOTA_THREAD_ID: "quota-thread", QUOTA_STALE_RETENTION_MS: 30 * 60_000, OLLAMA_CLOUD_ENABLED: false,
    } });
    await host.jobs.startAfterAdmission(Promise.resolve());
    const invocation = { threadId: "thread", parentId: "parent", args: { agentId: "grok" } };
    const get = async () => JSON.parse((await host.mcp.dispatch("agent_quota", invocation)).content[0]!.text)[0];
    expect((await get()).plan).toBe("Free");
    paid = true; await vi.advanceTimersByTimeAsync(1000);
    const followups: string[] = [];
    await host.components.dispatch({ kind: "button", customId: "seam-quota:refresh", channel: { platform: "discord", id: "quota-thread" },
      deferUpdate: async () => {}, followUpEphemeral: async text => { followups.push(text); } } as never);
    expect(readUsage).toHaveBeenCalledTimes(2);
    expect(await get()).toMatchObject({ ok: true, plan: "SuperGrok Heavy", fetchedAt: now + 1,
      weekly: { usedPercent: 0, resetsAt: end } });
    await vi.advanceTimersByTimeAsync(500);
    expect(JSON.stringify(card.editLayout.mock.calls.at(-1))).toContain("SuperGrok Heavy");
    expect(followups).toEqual(["Usage refreshed (1 agents)."]);
  });
});

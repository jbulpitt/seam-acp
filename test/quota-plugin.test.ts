import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginHost } from "../packages/core/src/plugins/host.js";
import { createQuotaPlugin } from "../packages/core/src/plugins/quota/index.js";
import type { ProviderUsage, UsageBinding } from "../packages/core/src/core/quota/usage-provider.js";
import { classifyDiscordInteraction } from "../packages/core/src/platforms/discord/adapter.js";

const logger = pino({ level: "silent" }); const hosts: PluginHost[] = []; const dirs: string[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.dispose(); vi.restoreAllMocks(); vi.useRealTimers(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const binding: UsageBinding = { agentId: "grok", displayName: "Grok", location: "local", account: "grok", provider: "grok", quotaAvailable: true };
const result = (): ProviderUsage => ({ provider: "grok", data: { subscriptionTier: "Free", creditUsagePercent: null, periodType: null, periodEnd: null } });
function fixture(read: (binding: Readonly<UsageBinding>, signal?: AbortSignal) => Promise<ProviderUsage> = async () => result()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quota-plugin-")); dirs.push(root);
  const file = path.join(root, "agent-quota-card.json"); fs.writeFileSync(file, JSON.stringify({ threadId: "quota-thread", messageId: "legacy", lastBumpAt: Date.now() }));
  const card = { sendLayout: vi.fn(async channel => ({ channel, id: "new" })), editLayout: vi.fn(async () => {}), pinMessage: vi.fn(async () => {}) };
  const usage = { readUsage: vi.fn(read) };
  const plugin = createQuotaPlugin({ usage, bindings: () => [binding], resolve: () => ({ ...binding, sessionId: "session" }), card });
  const host = new PluginHost(logger, { storageRoot: root, storageAliases: { quota: { "agent-quota-card.json": file } } }); hosts.push(host);
  const load = () => host.loadBuiltins([{ id: "quota", load: async () => plugin }], { quota: { DISCORD_AGENT_QUOTA_THREAD_ID: "quota-thread", QUOTA_STALE_RETENTION_MS: 0, OLLAMA_CLOUD_ENABLED: false } });
  return { host, plugin, card, usage, load };
}
const invocation = { threadId: "thread", parentId: "parent", args: {} };

describe("quota built-in", () => {
  it("keeps the pinned card, usage slash, MCP output and registered Refresh button", async () => {
    const f = fixture(); await f.load(); await f.host.jobs.startAfterAdmission(Promise.resolve());
    expect(f.card.sendLayout).not.toHaveBeenCalled();
    expect(f.card.editLayout.mock.calls[0]?.[0].id).toBe("legacy");
    const text = JSON.stringify(f.card.editLayout.mock.calls); expect(text).toContain("No subscription");
    const quota = await f.host.mcp.dispatch("agent_quota", invocation); expect(JSON.parse(quota.content[0]!.text)[0]).toMatchObject({ agentId: "grok", noSubscription: true });
    const edits: string[] = [];
    await f.host.slash.dispatch("seam", "info", "usage", { ...invocation, actor: { id: "user", name: "User" }, string: () => null, boolean: () => null, reply: async () => {}, defer: async () => {}, edit: async text => { edits.push(text); }, view: async () => {} });
    expect(edits[0]).toContain("**Grok usage**");
    const followups: string[] = [];
    await f.host.components.dispatch({ kind: "button", customId: "seam-quota:refresh", channel: { platform: "discord", id: "quota-thread" }, deferUpdate: async () => {}, followUpEphemeral: async text => { followups.push(text); } } as never);
    expect(followups).toEqual(["Usage refreshed (1 agents)."]);
    expect(classifyDiscordInteraction({ customId: "seam-quota:refresh", isChatInputCommand: () => false, isButton: () => true, isModalSubmit: () => false, isStringSelectMenu: () => false }, f.host.components)).toBe("plugin-component");
  });

  it("the maintenance job starts only after admission and preserves faster-active/slower-idle cadence", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_800_000);
    const f = fixture(); await f.load(); let admit!: () => void;
    const start = f.host.jobs.startAfterAdmission(new Promise(resolve => { admit = resolve; }));
    await Promise.resolve(); expect(f.usage.readUsage).not.toHaveBeenCalled(); admit(); await start;
    expect(f.usage.readUsage).toHaveBeenCalledOnce();
    for (let i = 0; i < 8; i++) f.host.turnActivity.emit({ type: "turn-started", turnId: `turn-${i}`, timestampMs: Date.now(), binding });
    await f.host.turnActivity.drain();
    await vi.advanceTimersByTimeAsync(5 * 60_000); expect(f.usage.readUsage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5 * 60_000); expect(f.usage.readUsage).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(5 * 60_000); expect(f.usage.readUsage).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(59 * 60_000); expect(f.usage.readUsage).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(60_000); expect(f.usage.readUsage).toHaveBeenCalledTimes(5);
  });

  it("a throwing provider exposes its real cause without affecting another row", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quota-failure-")); dirs.push(root);
    const host = new PluginHost(logger, { storageRoot: root }); hosts.push(host);
    const healthy = { ...binding, agentId: "grok-other", displayName: "Other" };
    const plugin = createQuotaPlugin({ usage: { readUsage: async target => { if (target.agentId === "grok") throw new Error("provider socket refused"); return result(); } }, bindings: () => [binding, healthy], resolve: () => binding, card: {} });
    await host.loadBuiltins([{ id: "quota", load: async () => plugin }], { quota: { QUOTA_STALE_RETENTION_MS: 0, OLLAMA_CLOUD_ENABLED: false } });
    await host.jobs.startAfterAdmission(Promise.resolve());
    const rows = JSON.parse((await host.mcp.dispatch("agent_quota", invocation)).content[0]!.text);
    expect(rows.find(row => row.agentId === "grok")).toMatchObject({ ok: false, error: "provider socket refused" });
    expect(rows.find(row => row.agentId === "grok-other")).toMatchObject({ ok: true, noSubscription: true });
  });

  it("aborts and drains owned provider work and card writes at shutdown", async () => {
    let calls = 0; let finish!: (value: ProviderUsage) => void; let signal!: AbortSignal;
    const f = fixture(async (_binding, currentSignal) => {
      if (++calls === 1) return result();
      signal = currentSignal!;
      return new Promise(resolve => { finish = resolve; });
    });
    await f.load(); await f.host.jobs.startAfterAdmission(Promise.resolve());
    const refresh = f.host.components.dispatch({ kind: "button", customId: "seam-quota:refresh", deferUpdate: async () => {}, followUpEphemeral: async () => {} } as never);
    await Promise.resolve(); await Promise.resolve();
    f.host.jobs.stop(); expect(signal.aborted).toBe(true);
    let drained = false; const drain = f.host.jobs.drain().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false);
    finish(result()); await refresh; await drain; expect(drained).toBe(true);
    await f.host.components.dispatch({ kind: "button", customId: "seam-quota:refresh", deferUpdate: async () => {}, followUpEphemeral: async () => {} } as never);
    expect(calls).toBe(2);
  });

  it("activation or job-start failure disables only quota and unpublishes its routes", async () => {
    const f = fixture();
    f.plugin.contributions.jobs![0]!.start = async () => { throw new Error("job fixture failed"); };
    await f.host.loadBuiltins([{ id: "healthy", load: async () => ({ id: "healthy", apiVersion: 1, builtin: true, contributions: { fences: [{ tag: "healthy", instruction: "healthy", handle: async () => {} }] } }) }]);
    await f.load(); await f.host.jobs.startAfterAdmission(Promise.resolve());
    expect(f.host.mcp.list(invocation)).toEqual([]);
    expect(f.host.slash.get("seam", "info", "usage")).toBeUndefined();
    expect(f.host.components.get("seam-quota:refresh", "button")).toBeUndefined();
    expect(f.host.fences.instructions).toEqual(["healthy"]);
  });
});

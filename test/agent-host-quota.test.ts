import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import * as adapters from "@seam/adapters";
import { createUsageProviderPort } from "../packages/core/src/core/quota/usage-provider.js";
import { QuotaRegistry } from "../packages/core/src/core/quota/quota-registry.js";
import { AgentQuotaPoller } from "../packages/core/src/core/quota/quota-poller.js";
import { quotaMcp } from "../packages/core/src/plugins/quota/mcp.js";
import { renderAgentQuotaLayout, renderAgentQuotaPanel } from "../packages/core/src/core/quota/agent-quota-card.js";
import { mapUnavailableQuota, type AgentQuota } from "../packages/core/src/core/quota/agent-quota.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

vi.mock("@seam/adapters", async original => ({ ...await original<typeof import("@seam/adapters")>(), fetchCodexUsage: vi.fn() }));
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });
const logger = pino({ level: "silent" }) as unknown as Logger;
const quota = (location?: string): AgentQuota => ({ agentId: "codex", displayName: "Codex", ...(location ? { location, host: location } : { host: "controller" }), ok: true,
  fetchedAt: 100, rolling: { label: "rolling", usedPercent: location ? 60 : 10, resetsAt: 500 }, weekly: { label: "weekly", usedPercent: 20, resetsAt: 1000 } } as AgentQuota);
function provider(support: boolean | undefined = true) {
  const read = vi.fn(async () => ({ provider: "codex", data: { ok: true, primary: null, secondary: null, credits: null, plan: "host" } }));
  const port = createUsageProviderPort({ profiles: [{ id: "codex", displayName: "Codex" }],
    separateBindings: () => [{ agentId: "codex", location: "worker" }], hostUsage: { supports: () => support, read }, controllerHost: "controller" } as never);
  return { port, read };
}

describe("explicit agent@host quotas", () => {
  it("reads an opted-in host through its RPC, without controller credentials", async () => {
    const { port, read } = provider();
    await port.readUsage(port.binding("codex", undefined, "worker"));
    expect(read).toHaveBeenCalledExactlyOnceWith("worker", "codex");
    expect(adapters.fetchCodexUsage).not.toHaveBeenCalled();
  });
  it("keeps other hosts global and old bridges global with an unavailable-setting notice", async () => {
    const { port, read } = provider(false);
    await port.readUsage(port.binding("codex", undefined, "worker"));
    expect(read).not.toHaveBeenCalled();
    expect(adapters.fetchCodexUsage).toHaveBeenCalledOnce();
    expect(port.bindings()).toHaveLength(1);
    expect(port.bindings()[0]).toMatchObject({ trackingUnavailable: expect.stringContaining("worker") });
  });
  it("does not substitute global usage when an opted-in host is offline", async () => {
    const { port, read } = provider(undefined);
    read.mockRejectedValueOnce(new Error('bridge "worker" is not connected'));
    await expect(port.readUsage(port.binding("codex", undefined, "worker"))).rejects.toThrow('bridge "worker" is not connected');
    expect(adapters.fetchCodexUsage).not.toHaveBeenCalled();
    expect(port.bindings()).toHaveLength(2);
  });
  it("keeps global and separate readings in independent cache rows", () => {
    const registry = new QuotaRegistry(); registry.set(quota()); registry.set(quota("worker"));
    expect(registry.all()).toHaveLength(2);
    expect(registry.get("codex")).toMatchObject({ rolling: { usedPercent: 10 } });
    expect((registry.get as Function)("codex", "worker")).toMatchObject({ rolling: { usedPercent: 60 } });
  });
  it("refreshes both rows independently and routes host turn activity to only its row", async () => {
    const registry = new QuotaRegistry(), global = vi.fn(async () => quota()), host = vi.fn(async () => quota("worker"));
    const poller = new AgentQuotaPoller({ logger, registry, sources: [
      { agentId: "codex", displayName: "Codex", eventDriven: true, fetch: global },
      { agentId: "codex", displayName: "Codex", location: "worker", eventDriven: true, fetch: host },
    ] as never });
    try {
      expect((await poller.refreshAll(true)).sources).toHaveLength(2);
      expect(global).toHaveBeenCalledOnce(); expect(host).toHaveBeenCalledOnce();
      (poller.recordTurnStart as Function)("codex", Date.now(), "worker");
      expect(poller.turnsInLast10Min("codex")).toBe(0);
      expect((poller.turnsInLast10Min as Function)("codex", Date.now(), "worker")).toBe(1);
    } finally { poller.stop(); await poller.drain(); }
  });
  it("shows retained host data as stale with the actual offline cause, never zero", async () => {
    const registry = new QuotaRegistry(), fetch = vi.fn(async () => quota("worker"));
    const poller = new AgentQuotaPoller({ logger, registry, sources: [{ agentId: "codex", displayName: "Codex", location: "worker", eventDriven: false, fetch }] as never });
    await poller.refreshAll(true);
    fetch.mockResolvedValueOnce(mapUnavailableQuota({ agentId: "codex", displayName: "Codex", location: "worker" } as never, 'bridge "worker" is not connected'));
    const result = await poller.refreshAll(true);
    expect(result.sources[0]?.quota).toMatchObject({ stale: true, liveError: 'bridge "worker" is not connected', rolling: { usedPercent: 60 }, fetchedAt: 100 });
    poller.stop(); await poller.drain();
  });
  it("MCP location picks its own row and a non-separated location picks global", async () => {
    const registry = new QuotaRegistry(); registry.set(quota()); registry.set(quota("worker"));
    const mcp = quotaMcp(registry)[0]!;
    const read = async (location: string) => JSON.parse((await mcp.handle({ args: { agentId: "codex", location } } as never)).content[0]!.text);
    expect((await read("worker"))[0]).toMatchObject({ location: "worker", rolling: { usedPercent: 60 }, ageSeconds: expect.any(Number) });
    expect((await read("other"))[0]).toMatchObject({ host: "controller", rolling: { usedPercent: 10 } });
  });
  it("both card renderers label global host, separate host and per-row age", () => {
    for (const card of [renderAgentQuotaLayout([quota(), quota("worker")]), renderAgentQuotaPanel([quota(), quota("worker")])]) {
      const text = JSON.stringify(card);
      expect(text).toContain("codex @ worker"); expect(text).toContain("global"); expect(text).toContain("controller"); expect(text).toContain("<t:100:R>");
    }
  });
  it("disabling separate tracking removes its row even if a host read finishes late", async () => {
    const registry = new QuotaRegistry();
    let finish!: (q: AgentQuota) => void;
    const global = { agentId: "codex", displayName: "Codex", eventDriven: false, fetch: async () => quota() };
    const poller = new AgentQuotaPoller({ logger, registry, sources: [global,
      { ...global, location: "worker", fetch: () => new Promise<AgentQuota>(resolve => { finish = resolve; }) }] as never });
    const work = poller.refreshAll(true);
    try {
      expect(typeof (poller as unknown as { updateSources: unknown }).updateSources).toBe("function");
      (poller as unknown as { updateSources: (sources: unknown[]) => void }).updateSources([global]);
    } finally { finish(quota("worker")); await work; poller.stop(); await poller.drain(); }
    expect(registry.all()).toHaveLength(1);
    expect(registry.get("codex")).toMatchObject({ rolling: { usedPercent: 10 } });
  });
});

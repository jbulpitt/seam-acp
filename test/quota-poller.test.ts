import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import {
  AgentQuotaPoller,
  type AgentQuotaSource,
} from "../packages/core/src/core/quota/quota-poller.js";
import { QuotaRegistry } from "../packages/core/src/core/quota/quota-registry.js";
import {
  mapUnavailableQuota,
  type AgentQuota,
} from "../packages/core/src/core/quota/agent-quota.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const silent = pino({ level: "silent" }) as unknown as Logger;
const identity = { agentId: "claude", displayName: "Claude" };

const okQuota: AgentQuota = {
  ...identity,
  ok: true,
  plan: "max",
  rolling: { usedPercent: 5, resetsAt: 100, label: "rolling" },
  weekly: { usedPercent: 10, resetsAt: 200, label: "weekly" },
  credits: null,
  fetchedAt: 1,
};
const badQuota: AgentQuota = mapUnavailableQuota(identity, "boom");

let queue: AgentQuota[] = [];
const source: AgentQuotaSource = {
  ...identity,
  eventDriven: false,
  fetch: async () => queue.shift() ?? badQuota,
};

function makePoller(staleRetentionMs: number, onUpdate?: (q: AgentQuota) => void) {
  const registry = new QuotaRegistry();
  const poller = new AgentQuotaPoller({
    logger: silent,
    registry,
    sources: [source],
    onUpdate,
    staleRetentionMs,
  });
  return { registry, poller };
}

describe("AgentQuotaPoller last-known-good retention", () => {
  afterEach(() => vi.useRealTimers());

  it("retains the last-known-good snapshot when a read is unavailable within the window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const updates: AgentQuota[] = [];
    const { registry, poller } = makePoller(60_000, (q) => updates.push(q));

    queue = [okQuota];
    await poller.refresh("claude", undefined, true);
    expect(registry.get("claude")?.ok).toBe(true);
    expect(updates).toHaveLength(1);

    // 30s later, still inside the 60s window: unavailable is suppressed.
    vi.setSystemTime(30_000);
    queue = [badQuota];
    const retained = await poller.refresh("claude", undefined, true);
    expect(retained?.ok).toBe(true);
    expect(retained?.plan).toBe("max");
    expect(registry.get("claude")?.ok).toBe(true);
    // A no-op retention does not fire another card update.
    expect(updates).toHaveLength(1);
  });

  it("surfaces the unavailable state once the retention window elapses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const updates: AgentQuota[] = [];
    const { registry, poller } = makePoller(60_000, (q) => updates.push(q));

    queue = [okQuota];
    await poller.refresh("claude", undefined, true);

    vi.setSystemTime(60_001);
    queue = [badQuota];
    const surfaced = await poller.refresh("claude", undefined, true);
    expect(surfaced?.ok).toBe(false);
    expect(registry.get("claude")?.ok).toBe(false);
    expect(updates).toHaveLength(2);
  });

  it("stores an unavailable result when there is no prior good value (cold start)", async () => {
    const { registry, poller } = makePoller(60_000);
    queue = [badQuota];
    const cold = await poller.refresh("claude", undefined, true);
    expect(cold?.ok).toBe(false);
    expect(registry.get("claude")?.ok).toBe(false);
  });

  it("disables retention when the window is zero", async () => {
    const { registry, poller } = makePoller(0);
    queue = [okQuota];
    await poller.refresh("claude", undefined, true);
    queue = [badQuota];
    const next = await poller.refresh("claude", undefined, true);
    expect(next?.ok).toBe(false);
    expect(registry.get("claude")?.ok).toBe(false);
  });
});

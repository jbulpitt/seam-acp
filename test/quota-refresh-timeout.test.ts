/**
 * #325: manual usage refresh owns a bounded fetch and reports partial failure.
 * These tests exercise the poller and the real Discord component handler, not
 * a test-only formatter.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgentQuotaPoller,
  createAgentQuotaSources,
  type AgentQuotaRefreshSummary,
  type AgentQuotaSource,
} from "../packages/core/src/core/quota/quota-poller.js";
import { QuotaRegistry } from "../packages/core/src/core/quota/quota-registry.js";
import type { AgentQuota } from "../packages/core/src/core/quota/agent-quota.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { ComponentEvent } from "../packages/core/src/platforms/chat-adapter.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import type { AgentProfile } from "@seam/adapters";

const silent = pino({ level: "silent" }) as unknown as Logger;

function quota(agentId: string, displayName: string): AgentQuota {
  return {
    agentId,
    displayName,
    ok: true,
    plan: "fixture",
    rolling: { usedPercent: 1, resetsAt: 2, label: "rolling" },
    weekly: { usedPercent: 3, resetsAt: 4, label: "weekly" },
    credits: null,
    fetchedAt: 5,
  };
}

describe("bounded quota refresh", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("times out only the stuck source, aborts its IO, and permits a later recovery", async () => {
    let stuckCalls = 0;
    let sawAbort = false;
    const stuck: AgentQuotaSource = {
      agentId: "copilot",
      displayName: "Copilot",
      eventDriven: false,
      fetch: async (signal) => {
        stuckCalls++;
        if (stuckCalls > 1) return quota("copilot", "Copilot");
        return await new Promise<AgentQuota>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            sawAbort = true;
            reject(signal.reason);
          }, { once: true });
        });
      },
    };
    const healthy: AgentQuotaSource = {
      agentId: "claude",
      displayName: "Claude",
      eventDriven: false,
      fetch: async () => quota("claude", "Claude"),
    };
    const registry = new QuotaRegistry();
    const poller = new AgentQuotaPoller({
      logger: silent,
      registry,
      sources: [stuck, healthy],
      sourceTimeoutMs: 25,
      staleRetentionMs: 0,
    });

    const startedAt = performance.now();
    const first = await poller.refreshAll(true);
    const elapsedMs = performance.now() - startedAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(15);
    expect(elapsedMs).toBeLessThan(200);
    expect(sawAbort).toBe(true);
    expect(first.outcome).toBe("mixed");
    expect(first.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: "copilot", outcome: "timed_out", error: "Quota refresh timed out after 0.025s" }),
      expect.objectContaining({ agentId: "claude", outcome: "refreshed", error: null }),
    ]));
    expect(registry.get("claude")?.ok).toBe(true);
    expect(registry.get("copilot")?.error).toBe("Quota refresh timed out after 0.025s");

    const second = await poller.refreshAll(true);
    expect(second.outcome).toBe("succeeded");
    expect(second.sources.find((source) => source.agentId === "copilot")?.outcome).toBe("refreshed");
    expect(stuckCalls).toBe(2);
  }, 500);

  it("keeps a normal source far inside its deadline", async () => {
    const poller = new AgentQuotaPoller({
      logger: silent,
      registry: new QuotaRegistry(),
      sources: [{
        agentId: "normal",
        displayName: "Normal",
        eventDriven: false,
        fetch: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return quota("normal", "Normal");
        },
      }],
      sourceTimeoutMs: 200,
    });
    const startedAt = performance.now();
    const result = await poller.refreshAll(true);
    const elapsedMs = performance.now() - startedAt;
    expect(result.outcome).toBe("succeeded");
    expect(elapsedMs).toBeLessThan(100);
  });

  it("prevents overlap and late publication when an aborted source has not settled", async () => {
    let calls = 0;
    let releaseFirst!: (value: AgentQuota) => void;
    const timedOutQuota = quota("slow", "Slow");
    const registry = new QuotaRegistry();
    const poller = new AgentQuotaPoller({
      logger: silent,
      registry,
      sources: [{
        agentId: "slow",
        displayName: "Slow",
        eventDriven: false,
        fetch: async () => {
          calls++;
          if (calls === 1) return await new Promise<AgentQuota>((resolve) => { releaseFirst = resolve; });
          return quota("slow", "Slow");
        },
      }],
      sourceTimeoutMs: 25,
      staleRetentionMs: 0,
    });
    const first = await poller.refreshAll(true);
    expect(first.sources[0]?.outcome).toBe("timed_out");
    const joined = await poller.refreshAll(true);
    expect(joined.sources[0]?.outcome).toBe("timed_out");
    expect(calls).toBe(1);

    releaseFirst(timedOutQuota);
    await new Promise((resolve) => setImmediate(resolve));
    expect(registry.get("slow")?.error).toBe("Quota refresh timed out after 0.025s");
    const recovered = await poller.refreshAll(true);
    expect(recovered.sources[0]?.outcome).toBe("refreshed");
    expect(calls).toBe(2);
  }, 500);

  it.each(["headers", "body"] as const)(
    "aborts the real Copilot source while response %s are stalled",
    async (stallAt) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-quota-copilot-"));
    try {
      fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
        lastLoggedInUser: { host: "github.com", login: "fixture" },
        copilotTokens: { "github.com:fixture": "credential-must-not-surface" },
      }));
      let fetchSignal: AbortSignal | undefined;
      vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
        fetchSignal = init?.signal ?? undefined;
        const stalled = async () => await new Promise<never>((_resolve, reject) => {
            fetchSignal?.addEventListener("abort", () => reject(fetchSignal?.reason), { once: true });
        });
        if (stallAt === "headers") return stalled();
        return Promise.resolve({ ok: true, json: stalled } as Response);
      }));
      const profile = { id: "copilot", displayName: "Copilot", configDir: dir } as AgentProfile;
      const [source] = createAgentQuotaSources([profile], {});
      const poller = new AgentQuotaPoller({
        logger: silent,
        registry: new QuotaRegistry(),
        sources: [source!],
        sourceTimeoutMs: 25,
        staleRetentionMs: 0,
      });
      const result = await poller.refreshAll(true);
      expect(fetchSignal?.aborted).toBe(true);
      expect(result.sources[0]).toMatchObject({
        agentId: "copilot",
        outcome: "timed_out",
        error: "Quota refresh timed out after 0.025s",
      });
      expect(JSON.stringify(result)).not.toContain("credential-must-not-surface");
      expect(JSON.stringify(result)).not.toContain(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    },
    500,
  );
});

describe("usage-card production interaction", () => {
  it("turns a partial timeout into a named ephemeral outcome", async () => {
    const followUps: string[] = [];
    const result: AgentQuotaRefreshSummary = {
      outcome: "mixed",
      durationMs: 30_000,
      timeoutMs: 30_000,
      sources: [
        { agentId: "copilot", displayName: "Copilot", outcome: "timed_out", durationMs: 30_000,
          quota: quota("copilot", "Copilot"), error: "Quota refresh timed out after 30s" },
        { agentId: "claude", displayName: "Claude", outcome: "refreshed", durationMs: 12,
          quota: quota("claude", "Claude"), error: null },
      ],
    };
    const host = Object.assign(Object.create(Orchestrator.prototype) as object, {
      quotaPoller: { refreshAll: vi.fn(async () => result) },
      lastQuotaRefreshClickAt: 0,
    }) as { handleQuotaCardComponent(evt: ComponentEvent): Promise<void> };
    await host.handleQuotaCardComponent({
      customId: "seam-quota:refresh",
      deferUpdate: async () => {},
      followUpEphemeral: async (text) => { followUps.push(text); },
    } as ComponentEvent);
    expect(followUps).toEqual([
      "Usage refresh timed out after 30s for Copilot. Other agents refreshed normally; any last-known-good values were retained.",
    ]);
  });
});

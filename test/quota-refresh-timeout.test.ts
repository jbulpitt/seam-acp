/**
 * #325: manual usage refresh owns a bounded fetch and reports partial failure.
 * These tests exercise the poller and the real Discord component handler, not
 * a test-only formatter.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentQuotaSources } from "./quota-source-fixture.js";
import pino from "pino";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgentQuotaPoller,
  type AgentQuotaRefreshSummary,
  type AgentQuotaSource,
} from "../packages/core/src/core/quota/quota-poller.js";
import { QuotaRegistry } from "../packages/core/src/core/quota/quota-registry.js";
import { renderAgentQuotaLayout, renderAgentQuotaPanel } from "../packages/core/src/core/quota/agent-quota-card.js";
import type { AgentQuota } from "../packages/core/src/core/quota/agent-quota.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { ComponentEvent } from "../packages/core/src/platforms/chat-adapter.js";
import { PluginHost } from "../packages/core/src/plugins/host.js";
import { createQuotaPlugin } from "../packages/core/src/plugins/quota/index.js";
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
    vi.useRealTimers();
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

  it("expires retained success when a completed timeout is reused without overlapping its reader", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T02:30:13Z"));
    const registry = new QuotaRegistry();
    const onUpdate = vi.fn();
    let release!: (value: AgentQuota) => void;
    const fetch = vi.fn<AgentQuotaSource["fetch"]>()
      .mockResolvedValueOnce(quota("claude", "Claude"))
      .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
      .mockResolvedValue(quota("claude", "Claude"));
    const poller = new AgentQuotaPoller({
      logger: silent, registry, onUpdate,
      sources: [{ agentId: "claude", displayName: "Claude", eventDriven: false, fetch }],
    });
    try {
      await poller.refreshAll(true);
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      const timedOut = poller.refreshAll(true);
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await timedOut).sources[0]).toMatchObject({ outcome: "timed_out", quota: { ok: true } });
      expect((await poller.refreshAll(true)).sources[0]?.quota.ok).toBe(true);
      expect(onUpdate).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
      const expired = await poller.refreshAll(true);
      expect(expired.sources[0]).toMatchObject({
        outcome: "timed_out", error: "Quota refresh timed out after 30s",
        quota: { ok: false, error: "Quota refresh timed out after 30s" },
      });
      expect(registry.get("claude")?.ok).toBe(false);
      const unavailable = registry.get("claude")!;
      expect(JSON.stringify(renderAgentQuotaLayout([unavailable]))).toContain("Quota refresh timed out after 30s");
      expect(JSON.stringify(renderAgentQuotaPanel([unavailable]))).toContain("Quota refresh timed out after 30s");
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(onUpdate).toHaveBeenCalledTimes(2);
      expect((await poller.refreshAll(true)).sources[0]?.quota).toBe(registry.get("claude"));
      expect(onUpdate).toHaveBeenCalledTimes(2);

      release(quota("claude", "Claude"));
      await poller.drain();
      expect(registry.get("claude")?.ok).toBe(false);
      expect((await poller.refreshAll(true)).sources[0]?.outcome).toBe("refreshed");
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally {
      release(quota("claude", "Claude"));
      poller.stop();
      await poller.drain();
    }
  });

  it.each(["headers", "body"] as const)(
    "aborts the real Copilot source while response %s are stalled",
    async (stallAt) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-quota-copilot-"));
    let poller: AgentQuotaPoller | undefined;
    try {
      fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
        lastLoggedInUser: { host: "github.com", login: "fixture" },
        copilotTokens: { "github.com:fixture": "credential-must-not-surface" },
      }));
      let entered!: () => void;
      const reading = new Promise<void>(resolve => { entered = resolve; });
      let fetchSignal: AbortSignal | undefined;
      vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
        fetchSignal = init?.signal ?? undefined;
        const stalled = async () => await new Promise<never>((_resolve, reject) => {
            if (fetchSignal?.aborted) reject(fetchSignal.reason);
            else fetchSignal?.addEventListener("abort", () => reject(fetchSignal?.reason), { once: true });
            entered();
        });
        if (stallAt === "headers") return stalled();
        return Promise.resolve({ ok: true, json: stalled } as Response);
      }));
      const profile = { id: "copilot", displayName: "Copilot", configDir: dir } as AgentProfile;
      const [source] = createAgentQuotaSources([profile], {});
      poller = new AgentQuotaPoller({
        logger: silent,
        registry: new QuotaRegistry(),
        sources: [source!],
        sourceTimeoutMs: 25,
        staleRetentionMs: 0,
      });
      const refresh = poller.refreshAll(true);
      // Reach the intended IO boundary before advancing the poller's deadline.
      await reading;
      await vi.advanceTimersByTimeAsync(24);
      expect(fetchSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await refresh;
      expect(fetchSignal?.aborted).toBe(true);
      expect(result.sources[0]).toMatchObject({
        agentId: "copilot",
        outcome: "timed_out",
        error: "Quota refresh timed out after 0.025s",
      });
      expect(JSON.stringify(result)).not.toContain("credential-must-not-surface");
      expect(JSON.stringify(result)).not.toContain(dir);
    } finally {
      poller?.stop();
      await poller?.drain();
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
    const spy = vi.spyOn(AgentQuotaPoller.prototype, "refreshAll").mockResolvedValue(result);
    const host = new PluginHost(silent);
    const plugin = createQuotaPlugin({ bindings: () => [], resolve: () => undefined, usage: { readUsage: async () => { throw new Error("not called"); } }, card: {} });
    await host.loadBuiltins([{ id: "quota", load: async () => plugin }], { quota: { QUOTA_STALE_RETENTION_MS: 0, OLLAMA_CLOUD_ENABLED: false } });
    await host.jobs.startAfterAdmission(Promise.resolve());
    await host.components.dispatch({
      kind: "button",
      customId: "seam-quota:refresh",
      deferUpdate: async () => {},
      followUpEphemeral: async (text) => { followUps.push(text); },
    } as ComponentEvent);
    expect(followUps).toEqual([
      "Usage refresh timed out after 30s for Copilot. Other agents refreshed normally; any last-known-good values were retained.",
    ]);
    await host.dispose(); spy.mockRestore();
  });
});

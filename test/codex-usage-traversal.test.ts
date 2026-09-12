/** #345 production-path cancellation and independent work ceiling. */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs, { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import {
  CODEX_USAGE_MAX_TRAVERSAL_ENTRIES,
  fetchCodexUsage,
} from "../packages/adapters/src/profiles/codex-session-manager.js";
import { AgentQuotaPoller } from "../packages/core/src/core/quota/quota-poller.js";
import { QuotaRegistry } from "../packages/core/src/core/quota/quota-registry.js";
import { mapCodexQuota, type AgentQuota } from "../packages/core/src/core/quota/agent-quota.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-codex-usage-walk-"));
  roots.push(root);
  return root;
}

function rateLimitLine(plan = "pro"): string {
  return JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        plan_type: plan,
        primary: { used_percent: 12, window_minutes: 300, resets_at: 123 },
        secondary: { used_percent: 34, window_minutes: 10_080, resets_at: 456 },
      },
    },
  });
}

describe("fetchCodexUsage bounded traversal", () => {
  it("stops the underlying real-directory walk when its owner aborts", async () => {
    const root = tempRoot();
    for (let i = 0; i < 80; i++) {
      const dir = path.join(root, `dir-${String(i).padStart(3, "0")}`, "nested");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${i}.jsonl`), "{}\n");
    }
    const original = fsp.opendir.bind(fsp);
    const controller = new AbortController();
    let opens = 0;
    vi.spyOn(fsp, "opendir").mockImplementation(async (...args) => {
      opens++;
      if (opens === 3) controller.abort(new Error("fixture cancellation"));
      await new Promise((resolve) => setImmediate(resolve));
      return original(...args);
    });

    await expect(fetchCodexUsage({ sessionsRoot: root, signal: controller.signal }))
      .rejects.toThrow("fixture cancellation");
    const stoppedAt = opens;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(opens).toBe(stoppedAt);
    expect(stoppedAt).toBeLessThan(81);
  });

  it("refuses an unbounded directory stream at the independent entry ceiling", async () => {
    let generated = 0;
    vi.spyOn(fsp, "opendir").mockImplementation(async () => ({
      close: async () => {},
      async *[Symbol.asyncIterator]() {
        await new Promise((resolve) => setImmediate(resolve));
        generated++;
        yield {
          name: `next-${generated}`,
          isDirectory: () => true,
          isFile: () => false,
        };
      },
    }) as unknown as Awaited<ReturnType<typeof fsp.opendir>>);

    const result = await fetchCodexUsage({
      sessionsRoot: "/fixture/infinite",
      maxTraversalEntries: 5,
    });
    expect(result).toMatchObject({
      ok: false,
      error: "Codex usage traversal exceeded the 5-entry ceiling",
    });
    expect(generated).toBe(6);
  }, 500);

  it("keeps a healthy sibling reporting when Codex exceeds its ceiling", async () => {
    const root = tempRoot();
    for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(root, `${i}.jsonl`), "{}\n");
    const identity = { agentId: "codex", displayName: "Codex" };
    const healthy: AgentQuota = {
      agentId: "healthy", displayName: "Healthy", ok: true, plan: "fixture",
      rolling: { usedPercent: 1, resetsAt: 2, label: "rolling" },
      weekly: { usedPercent: 3, resetsAt: 4, label: "weekly" },
      fetchedAt: 5,
    };
    const registry = new QuotaRegistry();
    const poller = new AgentQuotaPoller({
      logger: silent,
      registry,
      sourceTimeoutMs: 200,
      staleRetentionMs: 0,
      sources: [
        {
          ...identity,
          eventDriven: true,
          fetch: async (signal) => mapCodexQuota(identity, await fetchCodexUsage({
            sessionsRoot: root,
            signal,
            maxTraversalEntries: 5,
          })),
        },
        {
          agentId: "healthy",
          displayName: "Healthy",
          eventDriven: false,
          fetch: async () => healthy,
        },
      ],
    });
    const result = await poller.refreshAll(true);
    expect(result.outcome).toBe("mixed");
    expect(result.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentId: "codex",
        outcome: "unavailable",
        error: "Codex usage traversal exceeded the 5-entry ceiling",
      }),
      expect.objectContaining({ agentId: "healthy", outcome: "refreshed" }),
    ]));
    expect(registry.get("healthy")?.ok).toBe(true);
  });

  it("keeps a normal 100-rollout scan far below the production ceiling", async () => {
    const root = tempRoot();
    const dir = path.join(root, "2026", "09", "11");
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 100; i++) {
      fs.writeFileSync(
        path.join(dir, `rollout-${String(i).padStart(3, "0")}.jsonl`),
        `${rateLimitLine("normal-fixture")}\n`
      );
    }
    const startedAt = performance.now();
    const result = await fetchCodexUsage({ sessionsRoot: root });
    const elapsedMs = performance.now() - startedAt;
    expect(result).toMatchObject({ ok: true, plan: "normal-fixture" });
    expect(CODEX_USAGE_MAX_TRAVERSAL_ENTRIES / 103).toBeGreaterThan(97);
    expect(elapsedMs).toBeLessThan(2_000);
  });
});

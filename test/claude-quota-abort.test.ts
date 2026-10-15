import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import pino from "pino";
import { fetchClaudeUsage } from "../packages/adapters/src/profiles/claude.js";
import { createUsageProviderPort } from "../packages/core/src/core/quota/usage-provider.js";
import { createQuotaSources } from "../packages/core/src/plugins/quota/sources.js";
import { AgentQuotaPoller } from "../packages/core/src/core/quota/quota-poller.js";
import { QuotaRegistry } from "../packages/core/src/core/quota/quota-registry.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const silent = pino({ level: "silent" }) as unknown as Logger;
const usage = { five_hour: { utilization: 25 }, seven_day: { utilization: 93 } };

describe("Claude quota refresh cancellation", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-claude-quota-abort-"));
    fs.writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: "quota-abort-fixture-secret", email: "fixture@example.test" },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each(["headers", "success body", "error body"] as const)(
    "releases the real Claude source after a poller timeout during %s, then refreshes again",
    async (stallAt) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      // Own the reader's existing 8s deadline so even a RED run can abort its IO.
      const attempt = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(attempt.signal);
      let entered!: () => void;
      const reading = new Promise<void>(resolve => { entered = resolve; });
      let fetchSignal: AbortSignal | undefined;
      const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(async (_url, init) => {
        fetchSignal = init?.signal ?? undefined;
        const stalled = () => new Promise<never>((_resolve, reject) => {
          if (fetchSignal?.aborted) reject(fetchSignal.reason);
          else fetchSignal?.addEventListener("abort", () => reject(fetchSignal?.reason), { once: true });
          entered();
        });
        if (stallAt === "headers") return await stalled();
        return { ok: stallAt === "success body", status: 503, json: stalled, text: stalled } as unknown as Response;
      }).mockImplementation(async () => Response.json(usage));
      vi.stubGlobal("fetch", fetchMock);
      const port = createUsageProviderPort({ profiles: [{ id: "claude", displayName: "Claude", configDir: dir }] });
      const registry = new QuotaRegistry();
      const poller = new AgentQuotaPoller({
        logger: silent, registry, sources: createQuotaSources(port.bindings(), port), staleRetentionMs: 0,
      });
      try {
        const refresh = poller.refreshAll(true);
        await reading;
        await vi.advanceTimersByTimeAsync(30_000);
        expect((await refresh).sources[0]).toMatchObject({
          outcome: "timed_out", error: "Quota refresh timed out after 30s",
        });
        expect(fetchSignal?.aborted).toBe(true);
        // Settled source ownership, not merely a completed timeout race.
        await poller.drain();
        const recovered = await poller.refreshAll(true);
        expect(recovered.sources[0]).toMatchObject({ outcome: "refreshed", quota: { ok: true, weekly: { usedPercent: 93 } } });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(recovered)).not.toContain("quota-abort-fixture-secret");
      } finally {
        attempt.abort(new Error("fixture cleanup"));
        await vi.advanceTimersByTimeAsync(1_000);
        poller.stop();
        await poller.drain();
      }
    },
  );

  it("settles cancellation during an existing retry wait without another request", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let entered!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => ({
      ok: false, status: 503, text: async () => { entered(); return "{}"; },
    }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const reason = new Error("Quota refresh for 'Claude' timed out after 30s");
    // Keep RED type-correct against the old one-argument reader.
    const read: (dir: string, signal: AbortSignal) => ReturnType<typeof fetchClaudeUsage> = fetchClaudeUsage;
    let settled = false;
    const result = read(dir, controller.signal).then(
      value => { settled = true; return value; },
      error => { settled = true; return error; },
    );
    try {
      await reading;
      await setImmediate(); // The response body has completed and the retry wait is armed.
      controller.abort(reason);
      await setImmediate();
      expect(settled).toBe(true);
      expect(await result).toBe(reason);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      controller.abort(reason);
      await vi.advanceTimersByTimeAsync(1_000);
      await result;
    }
  });

  it("does not request usage when the quota refresh was already aborted", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(usage));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const reason = new Error("refresh stopped");
    controller.abort(reason);
    const read: (dir: string, signal: AbortSignal) => ReturnType<typeof fetchClaudeUsage> = fetchClaudeUsage;
    await expect(read(dir, controller.signal)).rejects.toBe(reason);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

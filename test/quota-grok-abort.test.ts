/**
 * #349 — Grok's quota RPC must consume the poller's abort signal.
 *
 * The cold path spawns `grok agent stdio` and bounds itself at 30s to
 * initialize plus 20s to bill: up to 50s, against the poller's 30s per-source
 * deadline (#344). The signal was never threaded in, so an aborted refresh
 * stopped the CALLER and left the spawned process running, holding stdio and
 * about to answer a question nobody would read.
 *
 * An accepted-but-unconsumed signal is worse than no timeout, because the
 * caller believes it has a bound it does not have. So these tests assert the
 * work stops, not that the wait stops — the child has to actually die.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import {
  AgentQuotaPoller,
  createAgentQuotaSources,
  type AgentQuotaSource,
} from "../packages/core/src/core/quota/quota-poller.js";
import { QuotaRegistry } from "../packages/core/src/core/quota/quota-registry.js";
import type { AgentQuota } from "../packages/core/src/core/quota/agent-quota.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { AgentProfile } from "@seam/adapters";

const silent = pino({ level: "silent" }) as unknown as Logger;
const fakeGrok = fileURLToPath(new URL("./fixtures/grok/fake-acp.mjs", import.meta.url));
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/**
 * A `grok` the poller can spawn that accepts `agent stdio` and never answers
 * `initialize` — the shape of a cold path that outlives its caller.
 */
function stageHangingGrok(): { cliPath: string; signalLog: string; methodLog: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-349-"));
  dirs.push(dir);
  const signalLog = path.join(dir, "signals");
  const methodLog = path.join(dir, "methods");
  const cliPath = path.join(dir, "grok");
  fs.writeFileSync(
    cliPath,
    `#!/bin/sh\n` +
      `GROK_FAKE_MODE=hang ` +
      `GROK_FAKE_SIGNAL_LOG=${signalLog} ` +
      `GROK_FAKE_LOG=${methodLog} ` +
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeGrok)} "$@"\n`,
    { mode: 0o755 }
  );
  return { cliPath, signalLog, methodLog };
}

/** The pid the fixture recorded when it received `initialize`. */
async function spawnedPid(methodLog: string, timeoutMs = 4_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fs.existsSync(methodLog)) {
      const lines = fs.readFileSync(methodLog, "utf8").trim().split("\n").filter(Boolean);
      const row = lines.map((line) => JSON.parse(line) as { pid: number; method: string })
        .find((entry) => entry.method === "initialize");
      if (row) return row.pid;
    }
    if (Date.now() >= deadline) throw new Error("fixture never recorded an initialize");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function quota(agentId: string, displayName: string): AgentQuota {
  return {
    agentId, displayName, ok: true, plan: "fixture",
    rolling: { usedPercent: 1, resetsAt: 2, label: "rolling" },
    weekly: { usedPercent: 3, resetsAt: 4, label: "weekly" },
    credits: null, fetchedAt: 5,
  };
}

describe("#349 an aborted Grok quota refresh cancels the work", () => {
  it("kills the spawned grok process instead of leaving it running", async () => {
    const { cliPath, signalLog, methodLog } = stageHangingGrok();
    const profile = { id: "grok", displayName: "Grok" } as AgentProfile;
    const [source] = createAgentQuotaSources([profile], { grokCliPath: cliPath });
    expect(source).toBeDefined();

    const poller = new AgentQuotaPoller({
      logger: silent,
      registry: new QuotaRegistry(),
      sources: [source!],
      sourceTimeoutMs: 300,
      staleRetentionMs: 0,
    });

    const refresh = poller.refreshAll(true);
    const pid = await spawnedPid(methodLog);
    expect(alive(pid)).toBe(true);

    const result = await refresh;
    expect(result.sources[0]).toMatchObject({ agentId: "grok", outcome: "timed_out" });

    // THE assertion. Reverting the fix leaves this process running for the
    // remaining ~29.7s of its own `initialize` bound, long after the poller
    // reported the refusal — the caller stopped, the work did not.
    await expect.poll(() => alive(pid), { timeout: 4_000, interval: 25 }).toBe(false);
    expect(fs.readFileSync(signalLog, "utf8")).toContain("SIGTERM");
  }, 20_000);

  it("refuses only Grok: every other source still reports in the same refresh", async () => {
    // The blast-radius claim, tested rather than asserted. Grok's quota being
    // unavailable must degrade to "we cannot currently tell you Grok's quota"
    // and nothing else — not the poller, not the other agents.
    const { cliPath, methodLog } = stageHangingGrok();
    const grokProfile = { id: "grok", displayName: "Grok" } as AgentProfile;
    const [grokSource] = createAgentQuotaSources([grokProfile], { grokCliPath: cliPath });
    let healthyCalls = 0;
    const healthy: AgentQuotaSource = {
      agentId: "claude",
      displayName: "Claude",
      eventDriven: false,
      fetch: async () => { healthyCalls++; return quota("claude", "Claude"); },
    };
    const registry = new QuotaRegistry();
    const poller = new AgentQuotaPoller({
      logger: silent,
      registry,
      sources: [grokSource!, healthy],
      sourceTimeoutMs: 300,
      staleRetentionMs: 0,
    });

    const refresh = poller.refreshAll(true);
    const pid = await spawnedPid(methodLog);
    const result = await refresh;
    await expect.poll(() => alive(pid), { timeout: 4_000, interval: 25 }).toBe(false);

    const byAgent = new Map(result.sources.map((row) => [row.agentId, row]));
    expect(byAgent.get("grok")).toMatchObject({ outcome: "timed_out" });
    // Claude ran, completed, and is readable from the registry — the poller
    // itself is intact and a second agent's answer was not collateral.
    expect(healthyCalls).toBe(1);
    expect(byAgent.get("claude")).toMatchObject({ outcome: "refreshed" });
    expect(registry.get("claude")?.ok).toBe(true);

    // And Grok remains a usable agent: the refusal carries a quota row that
    // says it cannot be told, not an exception that removes the source.
    expect(byAgent.get("grok")?.quota.ok).toBe(false);
    expect(registry.get("grok")?.agentId).toBe("grok");
  }, 20_000);

  it("does not spawn at all for a refresh that was already abandoned", async () => {
    const { cliPath, methodLog } = stageHangingGrok();
    const profile = { id: "grok", displayName: "Grok" } as AgentProfile;
    const [source] = createAgentQuotaSources([profile], { grokCliPath: cliPath });
    const controller = new AbortController();
    controller.abort(new Error("already abandoned"));

    await expect(source!.fetch(controller.signal)).rejects.toThrow(/already abandoned/);
    // The cheapest cancellation is the one that never starts a process.
    expect(fs.existsSync(methodLog)).toBe(false);
  }, 10_000);
});

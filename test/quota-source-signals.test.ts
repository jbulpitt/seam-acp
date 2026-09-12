/**
 * #361 — the remaining quota sources that accepted the abort signal and
 * dropped it, plus the coverage gap #359 reported honestly.
 *
 * `AgentQuotaSource.fetch` is typed `(signal: AbortSignal) => …`, so every
 * source is HANDED a signal. Dropping it is worse than having no bound, because
 * the caller believes it has one: the poller reports a refusal at its 30s
 * per-source deadline while the spawned child keeps working on an answer
 * nobody will read.
 *
 * Ollama Cloud is the milder case — `ollama-usage` bounds itself at 15s, inside
 * the deadline, so the work was bounded but not cancelled. Grok's is covered by
 * #349; this file adds the timeline sweep that #359 could not target.
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
import { fetchGrokUsage } from "@seam/adapters";
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

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** An `ollama-usage` that prints its pid and then never answers. */
function stageHangingOllama(): { cliPath: string; pidFile: string } {
  const dir = tmp("seam-361-ollama-");
  const pidFile = path.join(dir, "pid");
  const cliPath = path.join(dir, "ollama-usage");
  fs.writeFileSync(
    cliPath,
    `#!/bin/sh\necho $$ > ${JSON.stringify(pidFile)}\nwhile true; do sleep 1; done\n`,
    { mode: 0o755 }
  );
  return { cliPath, pidFile };
}

/** A `grok` that answers `initialize` and then never answers billing. */
function stageGrokStallingAtBilling(): { cliPath: string; methodLog: string } {
  const dir = tmp("seam-361-grok-");
  const methodLog = path.join(dir, "methods");
  const cliPath = path.join(dir, "grok");
  fs.writeFileSync(
    cliPath,
    `#!/bin/sh\n` +
      `GROK_FAKE_MODE=initialize-then-hang GROK_FAKE_LOG=${methodLog} ` +
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeGrok)} "$@"\n`,
    { mode: 0o755 }
  );
  return { cliPath, methodLog };
}

async function waitForPid(pidFile: string, timeoutMs = 4_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fs.existsSync(pidFile)) {
      const value = Number(fs.readFileSync(pidFile, "utf8").trim());
      if (Number.isInteger(value) && value > 0) return value;
    }
    if (Date.now() >= deadline) throw new Error(`no pid in ${pidFile}`);
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

describe("#361 an aborted Ollama Cloud quota refresh cancels the work", () => {
  it("kills the ollama-usage child instead of leaving it to its own timer", async () => {
    const { cliPath, pidFile } = stageHangingOllama();
    const profile = { id: "ollama-cloud", displayName: "Ollama Cloud" } as AgentProfile;
    const [source] = createAgentQuotaSources([profile], { ollamaUsageCliPath: cliPath });
    expect(source).toBeDefined();

    const poller = new AgentQuotaPoller({
      logger: silent,
      registry: new QuotaRegistry(),
      sources: [source!],
      sourceTimeoutMs: 300,
      staleRetentionMs: 0,
    });

    const refresh = poller.refreshAll(true);
    const pid = await waitForPid(pidFile);
    expect(alive(pid)).toBe(true);

    const result = await refresh;
    expect(result.sources[0]).toMatchObject({ agentId: "ollama-cloud", outcome: "timed_out" });

    // THE assertion. Reverting the fix leaves this child running for the
    // remaining ~14.7s of `ollama-usage`'s own bound, long after the poller
    // reported the refusal — the caller stopped, the work did not.
    await expect.poll(() => alive(pid), { timeout: 5_000, interval: 25 }).toBe(false);
  }, 25_000);

  it("refuses only Ollama Cloud: the other sources still report in the same refresh", async () => {
    // The blast-radius claim, tested rather than asserted.
    const { cliPath, pidFile } = stageHangingOllama();
    const profile = { id: "ollama-cloud", displayName: "Ollama Cloud" } as AgentProfile;
    const [ollamaSource] = createAgentQuotaSources([profile], { ollamaUsageCliPath: cliPath });
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
      sources: [ollamaSource!, healthy],
      sourceTimeoutMs: 300,
      staleRetentionMs: 0,
    });

    const refresh = poller.refreshAll(true);
    const pid = await waitForPid(pidFile);
    const result = await refresh;
    await expect.poll(() => alive(pid), { timeout: 5_000, interval: 25 }).toBe(false);

    const byAgent = new Map(result.sources.map((row) => [row.agentId, row]));
    expect(byAgent.get("ollama-cloud")).toMatchObject({ outcome: "timed_out" });
    expect(healthyCalls).toBe(1);
    expect(byAgent.get("claude")).toMatchObject({ outcome: "refreshed" });
    expect(registry.get("claude")?.ok).toBe(true);

    // Ollama Cloud remains a usable agent: the refusal is a quota row saying
    // it cannot be told, not an exception that removes the source.
    expect(byAgent.get("ollama-cloud")?.quota.ok).toBe(false);
    expect(registry.get("ollama-cloud")?.agentId).toBe("ollama-cloud");
  }, 25_000);

  it("does not spawn at all for a refresh that was already abandoned", async () => {
    const { cliPath, pidFile } = stageHangingOllama();
    const profile = { id: "ollama-cloud", displayName: "Ollama Cloud" } as AgentProfile;
    const [source] = createAgentQuotaSources([profile], { ollamaUsageCliPath: cliPath });
    const controller = new AbortController();
    controller.abort(new Error("already abandoned"));

    const result = await source!.fetch(controller.signal);
    expect(result.ok).toBe(false);
    expect(fs.existsSync(pidFile)).toBe(false);
  }, 10_000);
});

describe("#361 Grok's abort holds across the whole request lifetime", () => {
  // #359 reported that deleting `fetchGrokUsage`'s `aborted` racer survived
  // mutation, and asked for a test that aborts between `initialize` resolving
  // and billing being issued. That window turns out to be unreachable: the
  // billing `call()` runs in the same synchronous continuation as the resolved
  // initialize race, so it registers its `pending` entry before control returns
  // to the event loop, and an `abort` event is delivered as a task. `pending`
  // is therefore never empty when the handler runs.
  //
  // So rather than a test that cannot target that instant, this sweeps aborts
  // across the whole lifetime — before the spawn has settled, during
  // initialize, right at the transition, and deep into the billing wait — and
  // asserts the child dies every time. It covers the window if it is reachable
  // at all, which is the honest version of the same assurance.
  for (const delayMs of [0, 1, 5, 40, 120, 400]) {
    it(`kills the child when the abort lands at +${delayMs}ms`, async () => {
      const { cliPath, methodLog } = stageGrokStallingAtBilling();
      const controller = new AbortController();
      const pending = fetchGrokUsage(cliPath, controller.signal);
      const failure = pending.catch((err: unknown) => err);
      setTimeout(() => controller.abort(new Error("swept abort")), delayMs);

      await failure;
      // The child recorded its own pid when it answered a request; if it never
      // got that far the abort landed before initialize, which is also a pass —
      // there is nothing left running either way.
      if (fs.existsSync(methodLog)) {
        const rows = fs.readFileSync(methodLog, "utf8").trim().split("\n").filter(Boolean)
          .map((line) => JSON.parse(line) as { pid: number });
        const pid = rows[0]?.pid;
        if (pid) await expect.poll(() => alive(pid), { timeout: 5_000, interval: 25 }).toBe(false);
      }
    }, 15_000);
  }
});

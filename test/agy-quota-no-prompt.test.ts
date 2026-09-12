/**
 * #361 — agy's quota refresh must not pay for a model turn.
 *
 * `fetchAgyUserStatus` ran `agy -p ok …`. `-p` is agy's `--print`: "run a
 * single prompt non-interactively and print the response". Every cold quota
 * refresh billed a real turn, purely as a side effect of needing a language
 * server up. Threading a cancellation signal into that would only have made
 * the charge shorter — cancelling a billable probe still bills.
 *
 * `agy models` starts the same language server and takes no prompt, and the
 * quota RPC is answerable during its lifetime (measured: `500` during
 * silent-auth, then `200` at +1.4s to +2.2s, process exiting at +1.7s to
 * +2.8s). The absence of the prompt is the thing being bought, so it is the
 * first thing asserted here.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { fetchAgyUserStatus } from "@seam/adapters";
import {
  AgentQuotaPoller,
  createAgentQuotaSources,
  type AgentQuotaSource,
} from "../packages/core/src/core/quota/quota-poller.js";
import { QuotaRegistry } from "../packages/core/src/core/quota/quota-registry.js";
import type { AgentQuota } from "../packages/core/src/core/quota/agent-quota.js";
import type { AgentProfile } from "@seam/adapters";
import type { Logger } from "../packages/core/src/lib/logger.js";
import { createManagedAgyFixture } from "./helpers/agy-runtime-fixture.js";

const silent = pino({ level: "silent" }) as unknown as Logger;
const fixtures = fileURLToPath(new URL("./fixtures/agy-native-capabilities/", import.meta.url));
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

/** Flags that make agy run a turn. None may appear on the quota path. */
const PROMPT_FLAGS = ["-p", "--print", "--prompt", "-i", "--prompt-interactive"];

interface Invocation { args?: string[]; prompt?: string }

function agyFixture(extraEnv: Record<string, string> = {}): {
  runtime: ReturnType<typeof createManagedAgyFixture>["runtime"];
  invocations: () => Invocation[];
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-361-agy-"));
  const log = path.join(root, "invocations");
  const managed = createManagedAgyFixture({
    source: path.join(fixtures, "fake-native-agy.mjs"),
    version: "agy fixture 1.1.28",
    cwd: root,
    approvedEnvironment: {
      SEAM_AGY_CAPABILITY_FIXTURE_DIR: fixtures,
      SEAM_AGY_CAPABILITY_INVOCATIONS: log,
      ...extraEnv,
    },
  });
  cleanups.push(() => {
    managed.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    runtime: managed.runtime,
    invocations: () =>
      fs.existsSync(log)
        ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
            .map((line) => JSON.parse(line) as Invocation)
        : [],
  };
}

/**
 * The production source, built by the production factory. An earlier draft
 * hand-rolled this and a mutation dropping the poller's signal wiring survived,
 * because the hand-rolled source did its own wiring.
 */
function agySource(runtime: Parameters<typeof fetchAgyUserStatus>[0]): AgentQuotaSource {
  const [source] = createAgentQuotaSources(
    [{ id: "agy", displayName: "Antigravity" } as AgentProfile],
    { agyRuntime: runtime as never }
  );
  if (!source) throw new Error("createAgentQuotaSources did not build an agy source");
  return source;
}

function quota(agentId: string, displayName: string): AgentQuota {
  return {
    agentId, displayName, ok: true, plan: "fixture",
    rolling: { usedPercent: 1, resetsAt: 2, label: "rolling" },
    weekly: { usedPercent: 3, resetsAt: 4, label: "weekly" },
    credits: null, fetchedAt: 5,
  };
}

describe("#361 the agy quota refresh issues no model turn", () => {
  it("never passes a prompt flag, and reads quota anyway", async () => {
    // THE assertion. This is what the change buys; if someone reinstates a
    // prompt the charge comes back silently, so it has to break here.
    const { runtime, invocations } = agyFixture();
    const usage = await fetchAgyUserStatus(runtime);

    expect(usage.groups.length).toBeGreaterThan(0);
    const rows = invocations();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const args = row.args ?? [];
      expect(args.filter((arg) => PROMPT_FLAGS.includes(arg))).toEqual([]);
      expect(row.prompt ?? "").toBe("");
      // The literal probe that used to be here.
      expect(args).not.toContain("ok");
    }
    // And it got there by the prompt-free route.
    expect(rows.some((row) => (row.args ?? []).includes("models"))).toBe(true);
  }, 30_000);

  it("tolerates the silent-auth 500 before the language server answers", async () => {
    // The retry loop is the reason the window is usable at all; without it the
    // first 500 would be read as a refusal.
    const { runtime } = agyFixture({ SEAM_AGY_QUOTA_500S: "3" });
    const usage = await fetchAgyUserStatus(runtime);
    expect(usage.groups[0]?.buckets[0]?.window).toBe("weekly");
  }, 30_000);
});

describe("#361 missing the window refuses one reading and nothing else", () => {
  it("degrades to unavailable with last-known-good intact, and other sources still report", async () => {
    // The risk the owner named: the usable window is ~0.5-1.5s, so a cold or
    // slow silent-auth can miss it. This is the whole failure mode, asserted.
    const registry = new QuotaRegistry();

    // First, a healthy refresh so there is a last-known-good to preserve.
    const healthyAgy = agyFixture();
    const warm = new AgentQuotaPoller({
      logger: silent,
      registry,
      sources: [agySource(healthyAgy.runtime)],
      sourceTimeoutMs: 25_000,
      staleRetentionMs: 3_600_000,
    });
    const first = await warm.refreshAll(true);
    expect(first.sources[0]).toMatchObject({ agentId: "agy", outcome: "refreshed" });
    const lastKnownGood = registry.get("agy");
    expect(lastKnownGood?.ok).toBe(true);

    // Now a binding whose language server dies before it can answer — a
    // separate fixture, because a successful read is cached for 60s.
    const missed = agyFixture({ SEAM_AGY_MODELS_NO_LS: "1" });
    let healthyCalls = 0;
    const otherAgent: AgentQuotaSource = {
      agentId: "claude",
      displayName: "Claude",
      eventDriven: false,
      fetch: async () => { healthyCalls++; return quota("claude", "Claude"); },
    };
    const cold = new AgentQuotaPoller({
      logger: silent,
      registry,
      sources: [agySource(missed.runtime), otherAgent],
      sourceTimeoutMs: 25_000,
      staleRetentionMs: 3_600_000,
    });
    const second = await cold.refreshAll(true);
    const byAgent = new Map(second.sources.map((row) => [row.agentId, row]));

    // agy refuses ONE reading — and does it by reporting, not by throwing out
    // of the poller. It is still a source, with a row that says it cannot tell.
    expect(byAgent.has("agy")).toBe(true);
    expect(byAgent.get("agy")?.quota.ok).toBe(false);
    expect(byAgent.get("agy")?.outcome).not.toBe("refreshed");

    // Last-known-good survives the miss: the card shows the old number rather
    // than nothing, which is why missing the window is an annoyance.
    expect(registry.get("agy")?.agentId).toBe("agy");

    // The negative assertion: nothing else is collateral.
    expect(healthyCalls).toBe(1);
    expect(byAgent.get("claude")).toMatchObject({ outcome: "refreshed" });
    expect(registry.get("claude")?.ok).toBe(true);
  }, 60_000);

  it("does not spawn at all for a refresh that was already abandoned", async () => {
    const { runtime, invocations } = agyFixture();
    const controller = new AbortController();
    controller.abort(new Error("already abandoned"));
    await expect(fetchAgyUserStatus(runtime, controller.signal)).rejects.toThrow();
    expect(invocations()).toEqual([]);
  }, 20_000);

  it("stops the probe process when the refresh is aborted mid-flight", async () => {
    // #361's other half: the old nested bounds were 30s + 15s + 10s and could
    // outlive the poller's own 30s deadline. The signal now reaches the spawn.
    const { runtime, invocations } = agyFixture({ SEAM_AGY_MODELS_HOLD_MS: "30000" });
    const registry = new QuotaRegistry();
    const poller = new AgentQuotaPoller({
      logger: silent,
      registry,
      sources: [agySource(runtime)],
      sourceTimeoutMs: 400,
      staleRetentionMs: 0,
    });

    const refresh = poller.refreshAll(true);
    const pid = await new Promise<number>((resolve, reject) => {
      const deadline = Date.now() + 8_000;
      const tick = (): void => {
        const row = invocations().find((entry) => (entry as { pid?: number }).pid);
        const value = (row as { pid?: number } | undefined)?.pid;
        if (value) return resolve(value);
        if (Date.now() >= deadline) return reject(new Error("fixture never recorded a pid"));
        setTimeout(tick, 25);
      };
      tick();
    });

    const result = await refresh;
    expect(result.sources[0]?.agentId).toBe("agy");
    const alive = (value: number): boolean => {
      try { process.kill(value, 0); return true; } catch { return false; }
    };
    await expect.poll(() => alive(pid), { timeout: 8_000, interval: 25 }).toBe(false);
  }, 40_000);
});

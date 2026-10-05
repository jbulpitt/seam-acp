import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { BridgeUnreachableError } from "@seam/adapters";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { visualConfig } from "./plugin-card-visuals-fixture.js";

const start = Date.parse("2026-10-04T20:00:00Z");
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function setup(locations = ["remote"]) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(start);
  const dir = mkdtempSync(path.join(tmpdir(), "seam-reconcile-logs-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new SessionStore(path.join(dir, "test.db"));
  cleanups.push(() => store.close());
  const logger = pino({ level: "silent" });
  vi.spyOn(logger, "child").mockReturnValue(logger);
  const warn = vi.spyOn(logger, "warn");
  const info = vi.spyOn(logger, "info");
  const faults = new Map<string, { action: string; err: Error }>();
  const muxes = new Map(locations.map(location => {
    const attempt = store.turnAttempts.claim({ id: `held-${location}`, target: `thread-${location}`,
      prompt: "work", kind: "handoff", session: "live", createdUtc: new Date().toISOString() },
    "identity", "fixture");
    store.turnAttempts.bind(attempt, `acp-${location}`);
    store.turnAttempts.startPrompt(attempt);
    store.turnAttempts.recordRemoteRecovery(attempt, { version: 1, location, slot: 6,
      submissionId: `submission-${location}`, acpSessionId: `acp-${location}`, delegatedUtc: new Date().toISOString() });
    const recovery = { version: 1, owner: "bridge", submissionId: `submission-${location}`,
      acpSessionId: `acp-${location}`, rung: 1, phase: "armed", retry: 0, budget: 3, remaining: 3,
      disposition: "none", updatedUtc: new Date().toISOString() };
    return [location, { sendCmd: vi.fn(async (action: string) => {
      const fault = faults.get(location);
      if (fault?.action === action) throw fault.err;
      return action === "listSlots" ? { health: [{ slot: 6, alive: true, attached: true, recovery }] } : { state: "owned" };
    }) }] as const;
  }));
  store.turnAttempts.suspendBoot("fixture");
  const orch = new Orchestrator({ logger, store, router: {} as any, adapter: {} as any,
    modelCatalog: fixtureModelCatalog([]), renderer: discordRenderer,
    config: { ...visualConfig, DATA_DIR: dir, REPOS_ROOT: "/synthetic", REPO_EMOJIS: new Map(),
      channelPresets: new Map(), threadPresets: new Map() } as any });
  orch.setBridgeHub({ muxFor: (location: string) => muxes.get(location) } as any);
  for (const location of locations) (orch as any).remoteAdoptionFinishers.set(`held-${location}`, () => {});
  await orch.loadPlugins();
  warn.mockClear();
  info.mockClear();
  return { orch, store, warn, info, muxes, faults };
}

describe("recovery reconcile logging", () => {
  it("logs the first offline failure and minute reminders without skipping any of 900 ticks", async () => {
    const h = await setup();
    for (let second = 0; second < 900; second++) {
      vi.setSystemTime(start + second * 1000);
      h.faults.set("remote", { action: "listSlots",
        err: new BridgeUnreachableError("Remote bridge is offline. Make sure the bridge is running.", false) });
      await h.orch.reconcileRemoteRecoveries();
    }
    expect(h.warn).toHaveBeenCalledTimes(15);
    expect(h.warn.mock.calls[0]).toEqual([{ err: expect.any(BridgeUnreachableError), location: "remote" },
      "bridge recovery state unavailable; waiting for reconnect"]);
    expect(h.muxes.get("remote")!.sendCmd).toHaveBeenCalledTimes(900);
    expect(h.info).not.toHaveBeenCalled();
    expect(h.store.turnAttempts.get("held-remote")).toMatchObject({ state: "suspended", outcome: null });
  });

  it("logs changed causes immediately and reports total downtime and the last real error once", async () => {
    const h = await setup();
    const offline = new BridgeUnreachableError("Remote bridge is offline.", false);
    h.faults.set("remote", { action: "listSlots", err: offline });
    await h.orch.reconcileRemoteRecoveries();
    vi.setSystemTime(start + 1000);
    const unsupported = new Error("Unknown action: reconcileRung1Recovery");
    h.faults.set("remote", { action: "reconcileRung1Recovery", err: unsupported });
    await h.orch.reconcileRemoteRecoveries();
    expect(h.warn).toHaveBeenCalledTimes(2);
    expect(h.warn.mock.calls[1][0]).toEqual({ err: unsupported, location: "remote" });
    vi.setSystemTime(start + 10_000);
    const latest = new Error(unsupported.message);
    h.faults.set("remote", { action: "reconcileRung1Recovery", err: latest });
    await h.orch.reconcileRemoteRecoveries();
    expect(h.warn).toHaveBeenCalledTimes(2);
    h.faults.clear();
    vi.setSystemTime(start + 90_000);
    await h.orch.reconcileRemoteRecoveries();
    await h.orch.reconcileRemoteRecoveries();
    expect(h.info).toHaveBeenCalledExactlyOnceWith({ err: latest, location: "remote", unavailableMs: 90_000 },
      "bridge recovery reconciliation recovered");
    h.faults.set("remote", { action: "listSlots", err: offline });
    await h.orch.reconcileRemoteRecoveries();
    expect(h.warn).toHaveBeenCalledTimes(3);
  });

  it("does not report recovery when listSlots succeeds but the old bridge still rejects reconciliation", async () => {
    const h = await setup();
    const err = new Error("Unknown action: reconcileRung1Recovery");
    h.faults.set("remote", { action: "reconcileRung1Recovery", err });
    for (let second = 0; second < 300; second++) {
      vi.setSystemTime(start + second * 1000);
      await h.orch.reconcileRemoteRecoveries();
    }
    expect(h.warn).toHaveBeenCalledTimes(5);
    expect(h.warn.mock.calls.every(call => (call[0] as any).err === err)).toBe(true);
    expect(h.info).not.toHaveBeenCalled();
    expect(h.muxes.get("remote")!.sendCmd).toHaveBeenCalledTimes(600);
    expect(h.store.turnAttempts.get("held-remote")).toMatchObject({ state: "suspended", outcome: null });
    h.faults.clear();
    vi.setSystemTime(start + 300_000);
    await h.orch.reconcileRemoteRecoveries();
    expect(h.info).toHaveBeenCalledExactlyOnceWith({ err, location: "remote", unavailableMs: 300_000 },
      "bridge recovery reconciliation recovered");
  });

  it("tracks each bridge independently", async () => {
    const h = await setup(["alpha", "beta"]);
    const err = new BridgeUnreachableError("Remote bridge is offline.", false);
    h.faults.set("alpha", { action: "listSlots", err });
    await h.orch.reconcileRemoteRecoveries();
    vi.setSystemTime(start + 15_000);
    h.faults.set("beta", { action: "listSlots", err });
    await h.orch.reconcileRemoteRecoveries();
    expect(h.warn.mock.calls.map(call => (call[0] as any).location)).toEqual(["alpha", "beta"]);
    h.faults.delete("alpha");
    vi.setSystemTime(start + 30_000);
    await h.orch.reconcileRemoteRecoveries();
    expect(h.info).toHaveBeenCalledExactlyOnceWith({ err, location: "alpha", unavailableMs: 30_000 },
      "bridge recovery reconciliation recovered");
    vi.setSystemTime(start + 75_000);
    await h.orch.reconcileRemoteRecoveries();
    expect(h.warn.mock.calls.map(call => (call[0] as any).location)).toEqual(["alpha", "beta", "beta"]);
    expect(h.info).toHaveBeenCalledTimes(1);
  });

  it("keeps failure history when legacy inventory cannot establish recovery", async () => {
    const h = await setup();
    const err = new BridgeUnreachableError("Remote bridge is offline.", false);
    h.faults.set("remote", { action: "listSlots", err });
    await h.orch.reconcileRemoteRecoveries();
    h.faults.clear();
    h.muxes.get("remote")!.sendCmd.mockResolvedValueOnce({} as any);
    vi.setSystemTime(start + 30_000);
    await h.orch.reconcileRemoteRecoveries();
    expect(h.info).not.toHaveBeenCalled();
    await h.orch.reconcileRemoteRecoveries();
    expect(h.info).toHaveBeenCalledExactlyOnceWith({ err, location: "remote", unavailableMs: 30_000 },
      "bridge recovery reconciliation recovered");
  });
});

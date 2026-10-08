import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { DispatchWatcher } from "../packages/core/src/core/dispatch/watcher.js";
import { executionIdentity } from "../packages/core/src/core/dispatch/execution-identity.js";
import { ChoiceResultHub } from "../packages/core/src/core/choice/result.js";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import { planIsolatedBridgeSpawn } from "../packages/core/src/core/location-bind.js";
import { DEFAULT_REMOTE_RUNG1_POLICY } from "../packages/core/src/core/remote-spawn.js";
import type { AgentProfile } from "@seam/adapters";
import type { DispatchSpec } from "../packages/core/src/core/dispatch/types.js";

let dir: string;
let store: SessionStore;
let watcher: DispatchWatcher;
let orch: any;
const endpointId = "ie_boot_recovery";
const invalidTarget = Object.assign(new Error('Invalid Form Body: channel_id "ingest:ie_boot_recovery" is not snowflake'), {
  code: 50035,
});

function suspended(spec: DispatchSpec) {
  const attempt = store.turnAttempts.claim(spec,
    executionIdentity({ agent: "codex", location: "local", session: spec.session, model: "recorded-model", cwd: dir }), "old-boot");
  store.turnAttempts.bind(attempt, "recorded-acp");
  store.turnAttempts.startPrompt(attempt);
  store.turnAttempts.markStalled(spec.id, "ACP connection closed during controller restart");
  return store.turnAttempts.get(spec.id)!;
}

function ingestSpec(id = "a-ingest"): DispatchSpec {
  return { id, target: `ingest:${endpointId}`, kind: "ingest", session: "isolated",
    agentId: "codex", location: "local", prompt: "original HTTP request",
    correlationId: endpointId, createdUtc: new Date().toISOString() };
}

function pendingResult(spec: DispatchSpec) {
  store.insertChoiceResult({ dispatchId: spec.id, choiceId: endpointId, status: "pending",
    body: null, error: null, schema: null, createdUtc: spec.createdUtc, finishedUtc: null });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-ingest-boot-"));
  store = new SessionStore(path.join(dir, "seam.db"));
  store.turnAttempts.registerOwner("old-boot");
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), child() { return this; } };
  orch = Object.assign(Object.create(Orchestrator.prototype), {
    store, logger,
    config: { DATA_DIR: dir, REPOS_ROOT: dir, SEAM_TURN_RESUME_ENABLED: true,
      channelPresets: new Map(), threadPresets: new Map() },
    adapter: {
      getThreadLiveState: vi.fn(async ({ id }: { id: string }) => {
        if (id.startsWith("ingest:")) throw invalidTarget;
        return { locked: false, archived: false };
      }),
      sendMessage: vi.fn(async ({ id }: { id: string }) => {
        if (id.startsWith("ingest:")) throw invalidTarget;
        return { id: "notice" };
      }),
    },
  });
  watcher = new DispatchWatcher({ dataDir: dir, logger: logger as any,
    attempts: store.turnAttempts, onDispatch: async () => {} });
  orch.dispatchWatcher = watcher;
  orch.choiceResults = new ChoiceResultHub({ store, logger: logger as any });
});

afterEach(() => { watcher.stop(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe("ingest interrupted-dispatch recovery", () => {
  it.each(["local", "remote"])("binds an isolated %s holder before prompting, then adopts it instead of loading a second writer", async location => {
    const spec = { ...ingestSpec(), location };
    const attempt = store.turnAttempts.claim(spec,
      executionIdentity({ agent: "codex", location, session: "isolated", model: "recorded-model", cwd: dir }), "old-boot");
    store.turnAttempts.bind(attempt, "recorded-acp");
    store.turnAttempts.startPrompt(attempt);
    pendingResult(spec);
    const child = Object.assign(new EventEmitter(), {
      slot: 42, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    });
    const rpc = vi.fn(async (_method: string, params: any) => ({
      projectMcpInjection: true,
      ...(params.rung1Recovery ? { rung1RecoveryVersion: 1 } : {}),
    }));
    const sendCmd = vi.fn(async (action: string, params: any) => {
      if (action === "listSlots") return { health: [{ slot: 42, alive: true }] };
      if (action !== "armRung1Recovery") throw new Error(`unexpected command ${action}`);
      return { version: 1, owner: "bridge", rung: 1, phase: "armed", retry: 0, budget: 3,
        remaining: 3, disposition: "none", submissionId: params.submissionId,
        acpSessionId: params.acpSessionId, updatedUtc: spec.createdUtc };
    });
    const mux = { spawn: vi.fn(() => child), rpc, releaseStdin: vi.fn(), sendCmd,
      isBound: vi.fn(() => false), sendFrame: vi.fn() };
    orch.bridgeHub = { get: vi.fn(() => ({ mux })), muxFor: vi.fn(() => mux),
      markSessionBridge: vi.fn(), mcpServersForBridgeSpawn: vi.fn() };
    const plan = planIsolatedBridgeSpawn({ hub: orch.bridgeHub, sessionId: `dispatch:${spec.id}`,
      location, agentId: "codex", cwd: dir, model: "recorded-model" });
    const runtime = new AgentRuntime({ profile: { id: "codex" } as AgentProfile,
      logger: orch.logger, bridgeHealth: mux, spawnFn: plan.spawnFn });
    let started!: () => void;
    const prompted = new Promise<void>(resolve => { started = resolve; });
    let finish!: (value: { stopReason: string }) => void;
    const originalReply = new Promise<{ stopReason: string }>(resolve => { finish = resolve; });
    const prompt = vi.fn(() => { started(); return originalReply; });
    Object.assign(runtime, { child: await plan.spawnFn(), connection: { prompt },
      sessionId: "recorded-acp", promptCapabilities: {} });
    const original = runtime.prompt("original HTTP request", undefined, {
      recoveryScope: "ephemeral",
      onRemoteRecovery: binding => { store.turnAttempts.recordRemoteRecovery(attempt, { ...binding, location }); },
      onRemoteRecoveryReleased: binding => { store.turnAttempts.releaseRemoteRecovery(attempt, { ...binding, location }); },
    });
    try {
      await prompted;
      expect(store.turnAttempts.get(spec.id)?.remoteRecovery).toMatchObject({
        slot: 42, location, acpSessionId: "recorded-acp", generation: 1,
      });
      expect(rpc).toHaveBeenCalledWith("spawn", expect.objectContaining({
        rung1Recovery: DEFAULT_REMOTE_RUNG1_POLICY,
      }), { agentId: "codex" });
      store.turnAttempts.markStalled(spec.id, "controller restart");
      orch.adoptRemoteRecovery = vi.fn(async () => {});
      orch.requestDispatchContinuation = vi.fn();
      await orch.recoverInterruptedTurns();
      expect(orch.adoptRemoteRecovery).toHaveBeenCalledWith(expect.objectContaining({ id: spec.id }));
      expect(orch.requestDispatchContinuation).not.toHaveBeenCalled();
      expect(mux.spawn).toHaveBeenCalledTimes(1);
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(store.getChoiceResult(spec.id)?.status).toBe("pending");
      vi.useFakeTimers();
      orch.sweepUnownedSlots(location);
      await vi.advanceTimersByTimeAsync(90_001);
      expect(mux.sendFrame).not.toHaveBeenCalled();
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      finish({ stopReason: "end_turn" });
      await original;
    }
  });

  it("continues a recorded headless ingest without treating its endpoint ref as a Discord thread", async () => {
    const spec = ingestSpec();
    suspended(spec);
    await expect(orch.dispatchContinuationRefusal(spec)).resolves.toBeNull();
    expect(orch.adapter.getThreadLiveState).not.toHaveBeenCalled();
    expect(store.turnAttempts.get(spec.id)).toMatchObject({ state: "suspended", acpSessionId: "recorded-acp", generation: 1 });
  });

  it("still checks Discord availability for a live-thread ingest", async () => {
    const spec = { ...ingestSpec(), target: "1516907849349857421", session: "live" as const };
    suspended(spec);
    orch.adapter.getThreadLiveState.mockResolvedValue({ locked: true, archived: false });
    await expect(orch.dispatchContinuationRefusal(spec)).resolves.toContain("locked");
    expect(orch.adapter.getThreadLiveState).toHaveBeenCalledWith({ platform: "discord", id: spec.target });
  });

  it("does not make an optional notify thread an execution prerequisite for isolated ingest", async () => {
    const spec = { ...ingestSpec(), target: "1516907849349857421" };
    suspended(spec);
    orch.adapter.getThreadLiveState.mockRejectedValue(new Error("Discord temporarily unavailable"));
    await expect(orch.dispatchContinuationRefusal(spec)).resolves.toBeNull();
    expect(orch.adapter.getThreadLiveState).not.toHaveBeenCalled();
  });

  it("keeps a recoverable headless job parked in its HTTP result channel, without cancelling it or inventing a Discord destination", async () => {
    const spec = ingestSpec();
    const attempt = suspended(spec);
    pendingResult(spec);
    await expect(orch.postParkedTurnNotice(spec.target, attempt, attempt.stalledReason)).resolves.toBeUndefined();
    expect(store.turnAttempts.get(spec.id)).toMatchObject({ state: "suspended", generation: 1 });
    expect(store.getChoiceResult(spec.id)).toMatchObject({ status: "pending", finishedUtc: null });
    expect(store.turnAttempts.get(spec.id)?.stalledReason).toBe(attempt.stalledReason);
    expect(orch.adapter.sendMessage).not.toHaveBeenCalled();
  });

  it("sends an isolated ingest notice only to its recorded notify thread, not a report-back or authoring channel", async () => {
    const spec = { ...ingestSpec(), target: "1516907849349857421", returnTo: "1516907849349857422" };
    const attempt = suspended(spec);
    pendingResult(spec);
    await orch.observeRetainedDispatch(spec);
    expect(orch.adapter.sendMessage).toHaveBeenCalledWith({ platform: "discord", id: spec.target },
      expect.stringContaining(attempt.stalledReason!));
    expect(store.getChoiceResult(spec.id)?.status).toBe("pending");
    expect(store.turnAttempts.get(spec.id)?.state).toBe("suspended");
  });

  it("leaves a failed notice unacknowledged so the existing observation path can retry it", async () => {
    const spec = { ...ingestSpec(), target: "1516907849349857421" };
    suspended(spec);
    orch.adapter.sendMessage.mockRejectedValueOnce(invalidTarget);
    await expect(orch.observeRetainedDispatch(spec)).resolves.toBeUndefined();
    expect(store.turnAttempts.get(spec.id)).toMatchObject({ state: "suspended", stallNoticeUtc: null });
    await orch.observeRetainedDispatch(spec);
    expect(orch.adapter.sendMessage).toHaveBeenCalledTimes(2);
    expect(store.turnAttempts.get(spec.id)?.stallNoticeUtc).not.toBeNull();
    expect(orch.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ err: invalidTarget, id: spec.id }), expect.any(String));
  });

  it("settles a genuinely unresumable ingest through the existing HTTP completion path with its real cause", async () => {
    const spec = ingestSpec();
    store.turnAttempts.admit(spec);
    store.turnAttempts.markStalled(spec.id, "legacy execution has no recorded owner");
    const attempt = store.turnAttempts.get(spec.id)!;
    pendingResult(spec);
    store.recordDelegation({ id: spec.id, kind: "ingest", status: "interrupted", sourceRef: null,
      targetRef: null, correlationId: endpointId,
      promptPreview: spec.prompt, createdUtc: spec.createdUtc });
    await expect(orch.postParkedTurnNotice(spec.target, attempt, attempt.stalledReason)).resolves.toBeUndefined();
    expect(store.getChoiceResult(spec.id)).toMatchObject({ status: "missing",
      error: expect.stringContaining("no recorded execution") });
    expect(store.getDelegation(spec.id)?.status).toBe("failed");
    expect(orch.adapter.sendMessage).not.toHaveBeenCalled();
  });

  it("does not let one failed parked notice abort boot recovery of another suspended dispatch", async () => {
    const bad: DispatchSpec = { ...ingestSpec(), kind: "handoff", session: "live", target: "1516907849349857421" };
    store.turnAttempts.admit(bad);
    store.turnAttempts.markStalled(bad.id, "legacy execution has no recorded owner");
    orch.adapter.sendMessage.mockRejectedValue(invalidTarget);
    const laterSpec = { ...bad, id: "z-later", target: "1516907849349857422" };
    // The provider-owned adoption boundary stands in for an already-running holder.
    const recovery = { version: 1 as const, slot: 42, submissionId: "original-submission",
      acpSessionId: "recorded-acp", delegatedUtc: bad.createdUtc, location: "remote" };
    const active = store.turnAttempts.claim(laterSpec,
      executionIdentity({ agent: "codex", location: "remote", session: "live" }), "old-boot");
    store.turnAttempts.bind(active, "recorded-acp");
    store.turnAttempts.startPrompt(active);
    store.turnAttempts.recordRemoteRecovery(active, recovery);
    store.turnAttempts.markStalled(active.id, "controller restart");
    orch.adoptRemoteRecovery = vi.fn(async () => {});
    await expect(orch.recoverInterruptedTurns()).resolves.toBeUndefined();
    expect(orch.adoptRemoteRecovery).toHaveBeenCalledWith(expect.objectContaining({ id: active.id }));
    expect(orch.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ err: invalidTarget, id: bad.id }), expect.any(String));
  });
});

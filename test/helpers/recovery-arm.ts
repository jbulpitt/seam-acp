import { vi } from "vitest";
import type { AgentAdapter } from "@seam/adapters";
import { AgentRuntime, type AgentEvent } from "../../packages/core/src/agents/agent-runtime.js";
import { createRung1Recovery } from "../../packages/bridge/src/rung1-recovery.js";
import { DEFAULT_REMOTE_RUNG1_POLICY } from "../../packages/core/src/core/remote-spawn.js";
import type { Logger } from "../../packages/core/src/lib/logger.js";

export function recoveryArmFixture(options: {
  fail?: "timeout" | "invalid-ack";
  existingOwner?: "armed" | "executing";
  observedInput?: "partial" | "prompt";
  disarmUnavailable?: boolean;
} = {}) {
  const slot = 14, sid = "fixture-retained-session";
  const logger = { warn() {}, info() {}, error() {}, debug() {}, child() { return this; } } as unknown as Logger;
  const owner = createRung1Recovery({
    policyFor: () => DEFAULT_REMOTE_RUNG1_POLICY, classify: () => "unclassified",
    write: () => { throw new Error("fixture must not replay input"); },
    publishSnapshot() {}, publishResult() {},
  });
  if (options.existingOwner) {
    owner.arm(slot, { submissionId: "other-submission", acpSessionId: sid, continuation: "continue" });
    if (options.existingOwner === "executing") owner.observeInput(slot, JSON.stringify({
      id: "other-request", method: "session/prompt", params: { sessionId: sid, prompt: [] },
    }));
  }
  const timeout = Object.assign(new Error("armRung1Recovery timed out after 15000ms"), {
    code: "ETIMEDOUT", cause: new Error("synthetic lost controller reply"),
  });
  let faulted = false;
  let armWaiting!: () => void;
  const armPending = new Promise<void>(resolve => { armWaiting = resolve; });
  const sendCmd = vi.fn(async (action: string, payload: any) => {
    if (action === "listSlots") return { health: [{ slot, alive: true, attached: true }] };
    if (action === "disarmRung1Recovery") {
      if (options.disarmUnavailable) throw new Error("synthetic disarm reply unavailable");
      return { disarmed: owner.disarm(slot, payload.submissionId) };
    }
    if (action !== "armRung1Recovery") throw new Error(`unexpected control: ${action}`);
    const snapshot = owner.arm(slot, payload);
    if (!faulted && options.fail) {
      faulted = true;
      if (options.observedInput === "partial") owner.observeInputBytes(slot);
      if (options.observedInput === "prompt") owner.observeInput(slot, JSON.stringify({
        id: "unknown-request", method: "session/prompt", params: { sessionId: sid, prompt: [] },
      }));
      if (options.fail === "invalid-ack") return { ...snapshot, submissionId: "wrong-ack" };
      await new Promise((_, reject) => {
        setTimeout(() => reject(timeout), 15_000);
        armWaiting();
      });
    }
    return snapshot;
  });
  let nextRequest = 0;
  const prompt = vi.fn(async (params: any) => {
    const id = ++nextRequest;
    owner.observeInput(slot, JSON.stringify({ id, method: "session/prompt", params }));
    owner.observeOutput(slot, JSON.stringify({ id, result: { stopReason: "end_turn" } }));
    return { stopReason: "end_turn" };
  });
  const runtime = new AgentRuntime({
    profile: { id: "fixture" } as AgentAdapter, logger, bridgeHealth: { sendCmd },
    spawnFn: () => { throw new Error("fixture must retain its child"); },
  });
  const child = { slot, remoteRung1Recovery: true };
  Object.assign(runtime, { connection: { prompt }, sessionId: sid, promptCapabilities: {}, child });
  const evidence: AgentEvent[] = [];
  runtime.onEvent(async event => { evidence.push(event); });
  const bind = vi.fn(async () => {}), release = vi.fn(async () => {});
  return { runtime, child, owner, slot, sid, timeout, prompt, sendCmd, evidence, bind, release, armPending,
    opts: { onRemoteRecovery: bind, onRemoteRecoveryReleased: release } };
}

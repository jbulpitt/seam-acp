import { describe, expect, it, vi } from "vitest";
import type { AgentProfile } from "@seam/adapters";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const logger = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child() { return this; },
} as unknown as Logger;

function runtimeFixture(opts: {
  capability: boolean;
  armReply?: unknown;
  promptError?: Error;
  disarmed?: boolean;
}) {
  const order: string[] = [];
  const prompt = vi.fn(async () => {
    order.push("prompt");
    if (opts.promptError) throw opts.promptError;
    return { stopReason: "end_turn" };
  });
  const sendCmd = vi.fn(async (action: string, payload: any) => {
    order.push(action);
    if (action === "disarmRung1Recovery") return { disarmed: opts.disarmed ?? true };
    if (action !== "armRung1Recovery") throw new Error(`unexpected ${action}`);
    return opts.armReply ?? {
      version: 1,
      owner: "bridge",
      submissionId: payload.submissionId,
      acpSessionId: payload.acpSessionId,
      rung: 1,
      phase: "armed",
      retry: 0,
      budget: 3,
      remaining: 3,
      disposition: "none",
      updatedUtc: "2026-09-22T12:00:00.000Z",
    };
  });
  const profile = { id: "fixture" } as unknown as AgentProfile;
  const runtime = new AgentRuntime({ profile, logger, bridgeHealth: { sendCmd }, spawnFn: () => { throw new Error("unused"); } });
  Object.assign(runtime, {
    connection: { prompt },
    sessionId: "session-remote",
    promptCapabilities: {},
    child: { slot: 14, remoteRung1Recovery: opts.capability },
  });
  return { runtime, prompt, sendCmd, order };
}

describe("#467 controller-to-bridge recovery delegation", () => {
  it("durably binds an acknowledged bridge owner before the original prompt is written", async () => {
    const h = runtimeFixture({ capability: true });
    h.runtime.queueModelFallbackNotice("Model fallback: original → sibling; capability unknown; price unknown.");
    const bind = vi.fn(async (binding) => {
      h.order.push("durable-bind");
      expect(binding).toMatchObject({ slot: 14, acpSessionId: "session-remote" });
      expect(binding.modelFallbackNotice).toBe("Model fallback: original → sibling; capability unknown; price unknown.");
    });
    const release = vi.fn();
    await h.runtime.prompt("ORIGINAL PRIVATE BRIEF", undefined, {
      onRemoteRecovery: bind,
      onRemoteRecoveryReleased: release,
    });

    expect(h.order).toEqual(["armRung1Recovery", "durable-bind", "prompt"]);
    expect(h.sendCmd).toHaveBeenCalledTimes(1);
    const arm = h.sendCmd.mock.calls[0]![1];
    expect(arm).toMatchObject({ slot: 14, acpSessionId: "session-remote", continuation: "continue" });
    expect(JSON.stringify(arm)).not.toContain("ORIGINAL PRIVATE BRIEF");
    expect(bind).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    expect(h.prompt).toHaveBeenCalledTimes(1);
  });

  it("keeps the controller as sole owner when an old bridge omits capability acknowledgement", async () => {
    const h = runtimeFixture({ capability: false });
    const bind = vi.fn();
    const release = vi.fn();
    await h.runtime.prompt("ordinary prompt", undefined, {
      onRemoteRecovery: bind,
      onRemoteRecoveryReleased: release,
    });
    expect(h.sendCmd).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(h.prompt).toHaveBeenCalledTimes(1);
  });

  it("refuses this prompt when the bridge acknowledgement does not bind the exact submission", async () => {
    const h = runtimeFixture({ capability: true, armReply: { ok: true } });
    await expect(h.runtime.prompt("must not escape", undefined, {
      onRemoteRecovery: vi.fn(),
      onRemoteRecoveryReleased: vi.fn(),
    }))
      .rejects.toThrow("remote rung-1 recovery acknowledgement was invalid");
    expect(h.prompt).not.toHaveBeenCalled();
  });

  it("releases only a bridge-proven pre-write arm and never retries locally", async () => {
    const h = runtimeFixture({ capability: true, promptError: new Error("local write failed"), disarmed: true });
    const bind = vi.fn(async () => { h.order.push("durable-bind"); });
    const release = vi.fn(async () => { h.order.push("durable-release"); });

    await expect(h.runtime.prompt("one attempt", undefined, {
      onRemoteRecovery: bind,
      onRemoteRecoveryReleased: release,
    })).rejects.toThrow("local write failed");

    expect(h.order).toEqual([
      "armRung1Recovery", "durable-bind", "prompt", "disarmRung1Recovery", "durable-release",
    ]);
    expect(h.prompt).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("retains the sole bridge owner when prompt-write observation is ambiguous", async () => {
    const h = runtimeFixture({ capability: true, promptError: new Error("connection lost"), disarmed: false });
    const release = vi.fn();

    await expect(h.runtime.prompt("one attempt", undefined, {
      onRemoteRecovery: vi.fn(),
      onRemoteRecoveryReleased: release,
    })).rejects.toThrow("connection lost");

    expect(h.prompt).toHaveBeenCalledTimes(1);
    expect(h.sendCmd).toHaveBeenCalledWith("disarmRung1Recovery", expect.any(Object));
    expect(release).not.toHaveBeenCalled();
  });
});

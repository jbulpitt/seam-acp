import { describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import type { AgentProfile } from "@seam/adapters";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import type { PermissionPolicyMode } from "../packages/core/src/core/types.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import { CODEX_ACP_2_0_1_MODES as advertised } from "./fixtures/codex-acp-modes.js";

function harness(initial: PermissionPolicyMode = "always", agentId = "codex") {
  let policy = initial;
  const connection = {
    newSession: vi.fn(async () => ({ sessionId: "s1", modes: structuredClone(advertised) })),
    loadSession: vi.fn(async () => ({ modes: structuredClone(advertised) })),
    setSessionMode: vi.fn(async (_params: { sessionId: string; modeId: string }) => ({})),
    prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
    cancel: vi.fn(),
  };
  const observed = vi.fn();
  const runtime = new AgentRuntime({
    profile: { id: agentId } as AgentProfile,
    logger: pino({ level: "silent" }) as Logger,
    permissionMode: () => policy,
    onSessionModes: observed,
    spawnFn: () => { throw new Error("unexpected spawn"); },
  });
  Object.assign(runtime, { connection, promptCapabilities: {} });
  return { runtime, connection, observed, policy: (next: PermissionPolicyMode) => { policy = next; } };
}

describe("Codex permission policy selects an advertised ACP mode", () => {
  it("applies full access to a new session and again after load resets the mode", async () => {
    const { runtime, connection, observed } = harness();
    await runtime.newSession({ cwd: "/workspace" });
    await runtime.loadSession({ sessionId: "s1", cwd: "/workspace" });
    expect(connection.setSessionMode.mock.calls).toEqual([
      [{ sessionId: "s1", modeId: "agent-full-access" }],
      [{ sessionId: "s1", modeId: "agent-full-access" }],
    ]);
    expect(observed).toHaveBeenLastCalledWith(expect.objectContaining({ currentModeId: "agent-full-access" }));
  });

  it.each(["ask", "deny"] as const)("preserves the default sandbox for %s", async policy => {
    const { runtime, connection } = harness(policy);
    await runtime.newSession({ cwd: "/workspace" });
    await runtime.loadSession({ sessionId: "s1", cwd: "/workspace" });
    expect(connection.setSessionMode).not.toHaveBeenCalled();
  });

  it.each(["ask", "deny"] as const)("removes loaded full access for %s", async policy => {
    const { runtime, connection } = harness(policy);
    connection.loadSession.mockResolvedValueOnce({ modes: { ...advertised, currentModeId: "agent-full-access" } });
    await runtime.loadSession({ sessionId: "s1", cwd: "/workspace" });
    expect(connection.setSessionMode).toHaveBeenCalledWith({ sessionId: "s1", modeId: "agent" });
  });

  it("updates the warm session without replacing or cancelling it", async () => {
    const { runtime, connection, policy } = harness();
    await runtime.newSession({ cwd: "/workspace" });
    policy("ask");
    await runtime.applyPermissionMode();
    policy("deny");
    await runtime.applyPermissionMode();
    policy("always");
    await runtime.applyPermissionMode();
    expect(connection.setSessionMode.mock.calls.map(([params]) => params.modeId))
      .toEqual(["agent-full-access", "agent", "agent-full-access"]);
    expect(connection.newSession).toHaveBeenCalledTimes(1);
    expect(connection.cancel).not.toHaveBeenCalled();
  });

  it("rechecks the resolved policy before a warm prompt", async () => {
    const { runtime, connection, policy } = harness("ask");
    await runtime.newSession({ cwd: "/workspace" });
    policy("always");
    await runtime.prompt("hello");
    expect(connection.setSessionMode).toHaveBeenCalledWith({ sessionId: "s1", modeId: "agent-full-access" });
    expect(connection.prompt).toHaveBeenCalledTimes(1);
  });

  it("refuses a missing advertised full-access mode rather than silently sandboxing always", async () => {
    const { runtime, connection } = harness();
    connection.newSession.mockResolvedValueOnce({ sessionId: "s1", modes: {
      currentModeId: "agent", availableModes: advertised.availableModes.filter(mode => mode.id !== "agent-full-access"),
    } });
    await expect(runtime.newSession({ cwd: "/workspace" })).rejects.toThrow("session advertised no full-access mode");
    expect(connection.setSessionMode).not.toHaveBeenCalled();
    expect(connection.prompt).not.toHaveBeenCalled();
  });

  it("passes the mode RPC refusal through unchanged", async () => {
    const { runtime, connection, observed } = harness();
    const error = new Error("provider rejected session/set_mode: permission denied");
    connection.setSessionMode.mockRejectedValueOnce(error);
    await expect(runtime.newSession({ cwd: "/workspace" })).rejects.toBe(error);
    expect(observed).not.toHaveBeenCalled();
  });

  it("does not change another agent's modes", async () => {
    const { runtime, connection } = harness("always", "copilot");
    await runtime.newSession({ cwd: "/workspace" });
    expect(connection.setSessionMode).not.toHaveBeenCalled();
  });
});

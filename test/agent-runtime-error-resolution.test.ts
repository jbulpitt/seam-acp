import { describe, expect, it, vi } from "vitest";
import { RequestError } from "@agentclientprotocol/sdk";
import { classifyAgyError, classifyClaudeError, readErrorClassification, resolveError, type AgentProfile } from "@seam/adapters";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import { ReauthParked } from "../packages/core/src/core/reauth-negotiation.js";
import type { ClaudeCredentialFacts } from "../packages/core/src/core/claude-oauth-contention.js";
import { DEFAULT_ERROR_RULES } from "../packages/core/src/core/error-resolution-rules.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

function fixture(error: unknown, classifyError?: AgentProfile["classifyError"], agentId = "claude",
  bridgeHealth?: ConstructorParameters<typeof AgentRuntime>[0]["bridgeHealth"],
  claudeCredentialFacts?: () => ClaudeCredentialFacts | undefined) {
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), child() { return this; } };
  const profile = { id: agentId, classifyError, spawn: () => { throw error; } } as unknown as AgentProfile;
  const runtime = new AgentRuntime({ profile, logger: logger as unknown as Logger, bridgeHealth, claudeCredentialFacts });
  const prompt = vi.fn().mockRejectedValue(error);
  // This suite isolates classification; prompt recovery has its own behavioral
  // suite. Ephemeral work is the production one-attempt path, not a mock gate.
  Object.assign(runtime, { connection: { prompt, newSession: prompt, loadSession: prompt }, sessionId: "dispatch:fixture-session", promptCapabilities: {} });
  return { runtime, logger, prompt };
}

describe("#441 real runtime boundary to pure resolver (no providers)", () => {
  it("calls the adapter and makes rate_limit a field on the thrown ACP error", async () => {
    const original = new RequestError(-32603,
      "Internal error: Server is temporarily limiting requests (not your usage limit) · Rate limited", { trace: "retained" });
    const classify = vi.fn(classifyClaudeError);
    const { runtime, logger, prompt } = fixture(original, classify);
    const thrown = await runtime.prompt("fixture").catch((error: unknown) => error);
    expect(thrown).toBe(original);
    expect(classify).toHaveBeenCalledExactlyOnceWith(original);
    expect(original.data).toMatchObject({ trace: "retained", errorKind: "rate_limit", agentId: "claude" });
    expect(resolveError(readErrorClassification(thrown)!, DEFAULT_ERROR_RULES))
      .toMatchObject({ errorKind: "rate_limit", transience: "transient", startRung: 1 });
    expect(logger.warn).toHaveBeenCalledWith(
      { agentId: "claude", errorKind: "rate_limit", operation: "session/prompt" }, "adapter error classified");
    expect(prompt).toHaveBeenCalledTimes(1); // #426 ephemeral work does not retry.
  });

  it.each(["missing", "unrecognized", "throws"] as const)("%s classifier is attributable unclassified, not invisible", async (mode) => {
    const original = new Error("temporarily limiting requests · Rate limited");
    const classifier = mode === "missing" ? undefined : mode === "throws" ? () => { throw new Error("classifier bug"); }
      : () => ({ errorKind: "unclassified" as const, agentId: "fixture" });
    const { runtime, logger } = fixture(original, classifier, "fixture");
    const thrown = await runtime.prompt("fixture").catch((error: unknown) => error);
    expect(thrown).toBe(original);
    expect(readErrorClassification(thrown)).toMatchObject({ errorKind: "unclassified", agentId: "fixture" });
    expect(resolveError(readErrorClassification(thrown)!, DEFAULT_ERROR_RULES))
      .toMatchObject({ ruleId: null, startRung: 1, action: "recover", surface: true });
    expect(logger.warn).toHaveBeenCalledWith(
      { agentId: "fixture", errorKind: "unclassified", operation: "session/prompt" }, "adapter error classified");
  });

  it.each(["primitive", "frozen", "readonly-data"] as const)("preserves %s failures instead of throwing a classification assignment error", async (shape) => {
    const original = shape === "primitive" ? "provider failure" : shape === "frozen" ? Object.freeze(new Error("provider failure"))
      : Object.defineProperty(new Error("provider failure"), "data", { value: { trace: 1 }, writable: false, enumerable: true });
    const { runtime } = fixture(original);
    const thrown = await runtime.prompt("fixture").catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("provider failure");
    expect(readErrorClassification(thrown)).toMatchObject({ errorKind: "unclassified", agentId: "claude" });
  });

  it.each(["start", "session/new", "session/load"] as const)("classifies %s failures as well as prompts", async (operation) => {
    const original = new RequestError(-32603, "Internal error: Failed to authenticate: OAuth session expired and could not be refreshed",
      { errorKind: "authentication_failed" });
    const { runtime, logger } = fixture(original, classifyClaudeError);
    if (operation === "start") Object.assign(runtime, { connection: undefined });
    const call = operation === "start" ? runtime.start() : operation === "session/new"
      ? runtime.newSession({ cwd: "/fixture" }) : runtime.loadSession({ sessionId: "fixture-session", cwd: "/fixture" });
    await expect(call).rejects.toBe(original);
    expect(readErrorClassification(original)).toMatchObject({ errorKind: "auth_expired", agentId: "claude" });
    expect(logger.warn).toHaveBeenCalledWith({ agentId: "claude", errorKind: "auth_expired", operation }, "adapter error classified");
  });

  it("parks a prompt when the refresh token is dead and does not park when it is still valid or unreadable", async () => {
    const expired = new RequestError(-32603,
      "Failed to authenticate: OAuth session expired and could not be refreshed https://device.example.com/start code ABCD-EFGH",
      { errorKind: "authentication_failed" });
    const dead = fixture(expired, classifyClaudeError, "claude", undefined,
      () => ({ refreshTokenExpiresAt: 1 }));
    await expect(dead.runtime.prompt("fixture")).rejects.toBeInstanceOf(ReauthParked);
    expect(dead.prompt).toHaveBeenCalledTimes(1);

    const valid = fixture(expired, classifyClaudeError, "claude", undefined,
      () => ({ refreshTokenExpiresAt: Date.now() + 86_400_000 }));
    await expect(valid.runtime.prompt("fixture")).rejects.toBe(expired);
    expect(valid.prompt).toHaveBeenCalledTimes(1);

    const unreadable = fixture(expired, classifyClaudeError, "claude", undefined,
      () => ({ refreshTokenExpiresAt: null }));
    await expect(unreadable.runtime.prompt("fixture")).rejects.toBe(expired);

    const bridge = Object.assign(new RequestError(-32603, expired.message, { errorKind: "authentication_failed" }), { closeCode: 4001 });
    const rejected = fixture(bridge, classifyClaudeError, "claude", undefined,
      () => ({ refreshTokenExpiresAt: 1 }));
    await expect(rejected.runtime.prompt("fixture")).rejects.toBe(bridge);
  });

  it("leaves a successful prompt unchanged and emits no failure metric", async () => {
    const classify = vi.fn(classifyClaudeError);
    const { runtime, logger, prompt } = fixture(new Error("unused"), classify);
    prompt.mockResolvedValue({ stopReason: "end_turn" });
    await expect(runtime.prompt("fixture")).resolves.toMatchObject({ stopReason: "end_turn", cancelled: false });
    expect(classify).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("#487 child-owner health precedes the recovery verdict", () => {
  const nativeExit = () => new RequestError(-32603, "Internal error: native AGY exited_early", { code: "exited_early" });
  function remote(error = nativeExit(), reply: unknown = { health: [{ slot: 7, alive: true }] }) {
    const sendCmd = vi.fn(async () => reply);
    const h = fixture(error, classifyAgyError, "agy", { sendCmd });
    Object.assign(h.runtime, { child: { slot: 7 } });
    return { ...h, sendCmd, error };
  }

  it("does not classify a live adapter as agent_exit, preserving the failed native turn", async () => {
    const h = remote();
    const thrown = await h.runtime.prompt("fixture").catch(error => error);
    expect(thrown).toBe(h.error);
    expect(thrown.message).toBe("Internal error: native AGY exited_early");
    expect(thrown.data).toMatchObject({ code: "exited_early", errorKind: "protocol_error", agentId: "agy" });
    expect(thrown.data.details).toContain("bridge slot 7 is alive");
    expect(resolveError(readErrorClassification(thrown)!, DEFAULT_ERROR_RULES).errorKind).toBe("protocol_error");
    expect(h.sendCmd).toHaveBeenCalledExactlyOnceWith("listSlots", {});
    expect(h.prompt).toHaveBeenCalledTimes(1); // Ephemeral scope still never replays.
    expect(h.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ errorKind: "protocol_error", operation: "session/prompt" }), "adapter error classified");
    expect(h.logger.warn).not.toHaveBeenCalledWith(expect.objectContaining({ errorKind: "agent_exit" }), "adapter error classified");
  });

  it("retains an exit diagnosis when the owning bridge explicitly reports dead", async () => {
    const h = remote(nativeExit(), { health: [{ slot: 7, alive: false }] });
    const thrown = await h.runtime.prompt("fixture").catch(error => error);
    expect(readErrorClassification(thrown)?.errorKind).toBe("agent_exit");
    expect(h.sendCmd).toHaveBeenCalledOnce();
    expect(h.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ slot: 7, alive: false }), "bridge slot health consulted before exit classification");
  });

  it.each([
    ["old bridge", { slots: [7] }], ["missing slot", { health: [{ slot: 8, alive: true }] }],
    ["malformed health", { health: [{ slot: 7, alive: "true" }] }], ["null reply", null],
  ])("%s has no opinion, not evidence of death", async (_name, reply) => {
    const h = remote(nativeExit(), reply);
    const thrown = await h.runtime.prompt("fixture").catch(error => error);
    // Retain the adapter's original report, never derive an exit from absence.
    expect(readErrorClassification(thrown)?.errorKind).toBe("agent_exit");
    expect(h.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ alive: null }), "bridge slot health consulted before exit classification");
    expect(thrown.data.details ?? "").not.toContain("bridge slot");
  });

  it("failed / timed-out health probes do not mask the original failure", async () => {
    const h = remote(); h.sendCmd.mockRejectedValue(new Error("Command 'listSlots' timed out after 15s"));
    await expect(h.runtime.prompt("fixture")).rejects.toBe(h.error);
    expect(readErrorClassification(h.error)?.errorKind).toBe("agent_exit");
    expect(h.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ slot: 7 }), "bridge slot health unavailable; no process-liveness opinion");
  });

  it("never promotes another error to agent_exit, even with absent health", async () => {
    const error = new RequestError(-32603, "native AGY protocol_error", { code: "protocol_error" });
    const h = remote(error, { slots: [] });
    await expect(h.runtime.prompt("fixture")).rejects.toBe(error);
    expect(readErrorClassification(error)?.errorKind).toBe("protocol_error");
    expect(h.sendCmd).not.toHaveBeenCalled();
  });

  it("leaves local exit classification alone and skips health for successful turns", async () => {
    const local = fixture(nativeExit(), classifyAgyError, "agy");
    expect(readErrorClassification(await local.runtime.prompt("fixture").catch(error => error))?.errorKind).toBe("agent_exit");
    const h = remote(); h.prompt.mockResolvedValue({ stopReason: "end_turn" });
    await expect(h.runtime.prompt("fixture")).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(h.sendCmd).not.toHaveBeenCalled();
  });
});

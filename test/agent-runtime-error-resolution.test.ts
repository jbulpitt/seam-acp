import { describe, expect, it, vi } from "vitest";
import { RequestError } from "@agentclientprotocol/sdk";
import { classifyClaudeError, readErrorClassification, resolveError, type AgentProfile } from "@seam/adapters";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import { DEFAULT_ERROR_RULES } from "../packages/core/src/core/error-resolution-rules.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

function fixture(error: unknown, classifyError?: AgentProfile["classifyError"], agentId = "claude") {
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), child() { return this; } };
  const profile = { id: agentId, classifyError, spawn: () => { throw error; } } as unknown as AgentProfile;
  const runtime = new AgentRuntime({ profile, logger: logger as unknown as Logger });
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

  it("leaves a successful prompt unchanged and emits no failure metric", async () => {
    const classify = vi.fn(classifyClaudeError);
    const { runtime, logger, prompt } = fixture(new Error("unused"), classify);
    prompt.mockResolvedValue({ stopReason: "end_turn" });
    await expect(runtime.prompt("fixture")).resolves.toMatchObject({ stopReason: "end_turn", cancelled: false });
    expect(classify).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

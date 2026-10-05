import { describe, expect, it } from "vitest";
import {
  classifyCodexError, classifyClaudeError,
  sessionFailureError, readSessionFailure, codexReplyFailure, CodexReplyGate,
} from "@seam/adapters";

const rollout = JSON.stringify({ type: "error", error: {
  message: "model 'gpt-6.1-sol' is not enabled in rustponsesapi", type: "invalid_request_error", param: null, code: null,
}, status: 400 });

function terminal(title: string, category = "service", actions: string[] = ["retry"], severity = "error") {
  return { stopReason: "end_turn", _meta: { jetbrains: { air: { version: 1, sessionFailure: {
    id: "turn:error", revision: 1, category, severity, title, actions,
  } } } } };
}

describe("observed provider failures", () => {
  it("recognises the rollout 400 in the provider's terminal AIR metadata", () => {
    const error = sessionFailureError(terminal(rollout))!;
    expect(error.message).toBe(rollout);
    expect(error.data).toMatchObject({ status: 400, code: null, providerResponse: { error: { type: "invalid_request_error" } } });
    expect(classifyCodexError(error)).toMatchObject({ errorKind: "overloaded", sourceKind: "invalid_request_error" });
    expect(classifyCodexError(Object.assign(new Error("Internal error"), { data: JSON.parse(rollout) }))).toMatchObject({ errorKind: "overloaded" });
  });

  it("retains typed failure details when the title is only a summary", () => {
    const result = terminal("Provider rejected request");
    const frame = { ...result, _meta: { jetbrains: { air: { version: 1, sessionFailure: {
      ...result._meta.jetbrains.air.sessionFailure, details: rollout,
    } } } } };
    const error = sessionFailureError(frame)!;
    expect(error.message).toBe(`Provider rejected request\n${rollout}`);
    expect(error.data.status).toBe(400);
    expect(classifyCodexError(error).errorKind).toBe("overloaded");
  });

  it("recognises the exact September 27 capacity reply, not prose discussing it", () => {
    const text = "Selected model is at capacity. Please try a different model.";
    expect(classifyCodexError(codexReplyFailure(text)!)).toMatchObject({ errorKind: "overloaded" });
    expect(classifyCodexError(sessionFailureError(terminal(text))!)).toMatchObject({ errorKind: "overloaded" });
    expect(codexReplyFailure(`The agent said: ${text}`)).toBeUndefined();
    expect(codexReplyFailure(`\`\`\`json\n${rollout}\n\`\`\``)).toBeUndefined();
    expect(codexReplyFailure(`Here is the error:\n${rollout}`)).toBeUndefined();
  });

  it("does not turn an unknown model or another HTTP 400 into a rollout retry", () => {
    const unknown = JSON.stringify({ type: "error", error: { message: "The model 'not-a-model' does not exist",
      type: "invalid_request_error", code: "model_not_found" }, status: 400 });
    expect(classifyCodexError(sessionFailureError(terminal(unknown))!)).toMatchObject({ errorKind: "model_not_found" });
    const bad = JSON.stringify({ type: "error", error: { message: "Invalid input", type: "invalid_request_error", code: null }, status: 400 });
    expect(classifyCodexError(codexReplyFailure(bad)!)).toMatchObject({ errorKind: "invalid_request" });
  });

  it.each([
    ["server_error", undefined, "server_error"],
    ["server_error", 529, "overloaded"],
    ["overloaded", 529, "overloaded"],
  ])("preserves Claude ACP %s / %s as %s", (errorKind, status, expected) => {
    const error = Object.assign(new Error("Overloaded"), { data: { errorKind, status } });
    expect(classifyClaudeError(error).errorKind).toBe(expected);
  });

  it("uses AIR's agent-owned categories without treating warnings as terminal", () => {
    const metadata = terminal("temporary provider failure", "service", ["retry"]);
    expect(classifyClaudeError(sessionFailureError(metadata)!)).toMatchObject({ errorKind: "server_error" });
    expect(readSessionFailure(terminal("retrying internally", "service", ["retry"], "warning"))).toMatchObject({ severity: "warning" });
    expect(sessionFailureError(terminal("retrying internally", "service", ["retry"], "warning"))).toBeUndefined();
    expect(sessionFailureError({ stopReason: "end_turn" })).toBeUndefined();
  });

  it("splits a retryable throttle from exhausted quota and login", () => {
    expect(classifyCodexError(sessionFailureError(terminal("throttled", "limit", ["retry"]))!).errorKind).toBe("rate_limit");
    expect(classifyCodexError(sessionFailureError(terminal("You've hit your usage limit", "limit", []))!).errorKind).toBe("quota_exhausted");
    expect(classifyClaudeError(sessionFailureError(terminal("sign in", "access", ["login"]))!).errorKind).toBe("auth_required");
  });

  it("holds a split legacy error and flushes an ordinary answer intact", () => {
    const gate = new CodexReplyGate();
    for (const chunk of [rollout.slice(0, 9), rollout.slice(9, 70), rollout.slice(70)]) expect(gate.push(chunk)).toBe("");
    expect(gate.failure()?.message).toBe(rollout);
    const normal = new CodexReplyGate();
    expect(normal.push("Selected ")).toBe("");
    expect(normal.push("files updated.")).toBe("Selected files updated.");
    expect(normal.push(" Done.")).toBe(" Done.");
    expect(normal.failure()).toBeUndefined();
    const json = new CodexReplyGate();
    const reply = '{"answer":42}';
    expect(json.push(reply)).toBe(reply);
    expect(json.failure()).toBeUndefined();
    expect(json.flush()).toBe("");
  });
});

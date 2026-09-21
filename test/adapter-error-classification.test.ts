/**
 * #440 — adapters emit structured error classification.
 *
 * Fixtures are shapes captured from `journalctl -u seam-acp`, not invented
 * provider payloads. A test that still passes with its matcher deleted is
 * not covering that classification.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RequestError } from "@agentclientprotocol/sdk";
import {
  classifiedErrorData,
  classifyAgyError,
  classifyAndAttach,
  classifyClaudeError,
  classifyCodexError,
  classifyCopilotError,
  classifyGrokError,
  copilotNoModelConfigError,
  grokExitBeforeBillingError,
  makeClaudeProfile,
  makeCodexProfile,
  makeCopilotProfile,
  makeGrokProfile,
  parseExitCause,
  readErrorClassification,
  type AdapterErrorKind,
} from "@seam/adapters";

const adaptersRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../packages/adapters/src");

/** DispatchTurnError as logged: type/name/message/output/workerError, data absent. */
function dispatchTurn(message: string, extra: { output?: string; workerError?: string } = {}) {
  const err = new Error(message) as Error & {
    name: string;
    output: string;
    workerError?: string;
    data?: unknown;
  };
  err.name = "DispatchTurnError";
  err.output = extra.output ?? "";
  if (extra.workerError !== undefined) err.workerError = extra.workerError;
  return err;
}

function requestError(message: string, data: unknown, code = -32603) {
  return new RequestError(code, message, data);
}

function expectKind(
  classification: { errorKind: AdapterErrorKind; agentId: string },
  errorKind: AdapterErrorKind,
  agentId: string,
) {
  expect(classification).toMatchObject({ errorKind, agentId });
}

describe("#440 journal corpus — Claude", () => {
  it("classifies an expired OAuth session flattened into DispatchTurnError (data null)", () => {
    // journal 2026-09-13: err.type DispatchTurnError, data absent, reason in the message.
    const err = dispatchTurn(
      "Internal error: Failed to authenticate: OAuth session expired and could not be refreshed",
      {
        output: "Failed to authenticate: OAuth session expired and could not be refreshed",
        workerError: "Internal error: Failed to authenticate: OAuth session expired and could not be refreshed",
      },
    );
    expect(err).not.toHaveProperty("data");
    const result = classifyAndAttach(err, classifyClaudeError(err));
    expectKind(result, "auth_expired", "claude");
    expect(err.data).toMatchObject({ errorKind: "auth_expired", agentId: "claude" });
  });

  it("overrides Claude ACP server_error when the message is refresh contention", () => {
    // journal 2026-09-15: RequestError data.errorKind was `server_error` for the
    // #404 contention signature. Trusting the ACP kind would retry the wrong thing.
    const err = requestError(
      "Internal error: Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute, and if it persists close other Claude Code processes or sign in again",
      { errorKind: "server_error" },
    );
    const result = classifyClaudeError(err);
    expectKind(result, "auth_contention", "claude");
    expect(result.sourceKind).toBe("server_error");
    expect(result.errorKind).not.toBe("server_error");
  });

  it("maps ACP authentication_failed on the expired-OAuth RequestError", () => {
    const err = requestError(
      "Internal error: Failed to authenticate: OAuth session expired and could not be refreshed",
      { errorKind: "authentication_failed" },
    );
    expectKind(classifyClaudeError(err), "auth_expired", "claude");
  });

  it("produces rate_limit so the orchestrator's structured check is a live field", () => {
    const err = requestError(
      "Internal error: Server is temporarily limiting requests (not your usage limit) · Rate limited",
      { errorKind: "rate_limit" },
    );
    const result = classifyAndAttach(err, classifyClaudeError(err));
    expectKind(result, "rate_limit", "claude");
    expect((err as { data?: { errorKind?: string } }).data?.errorKind).toBe("rate_limit");
  });

  it("maps a 403 permission-denied payload with http_status, not the bare 'Internal error' message", () => {
    const err = requestError("Internal error", {
      type: "Object",
      message: "API error (status 403 Forbidden): permission-denied: I can't help with that request.",
      stack: "",
      http_status: 403,
    });
    expectKind(classifyClaudeError(err), "permission_denied", "claude");
  });

  it("does not classify a generic Internal error with null data — that is adapter under-reporting", () => {
    const err = requestError("Internal error", null);
    expectKind(classifyClaudeError(err), "unclassified", "claude");
  });
});

describe("#440 journal corpus — Codex", () => {
  it("reads the usage-limit reason off DispatchTurnError.output, not the collapsed message", () => {
    // journal 2026-09-19: message "Internal error", data null, output held the quota text.
    const err = dispatchTurn("Internal error", {
      output:
        "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 19th, 2026 6:00 AM.\n",
      workerError: "Internal error",
    });
    expectKind(classifyCodexError(err), "quota_exhausted", "codex");
    expectKind(classifyCodexError(dispatchTurn("Internal error")), "unclassified", "codex");
  });

  it("classifies Codex 'no rollout found' details as session_gone", () => {
    const err = requestError("Internal error", { details: "no rollout found for thread id 01a078e2-dead-beef-cafe-000000000000" });
    expectKind(classifyCodexError(err), "session_gone", "codex");
  });

  it("does not treat a Claude OAuth failure as a Codex quota error", () => {
    const err = dispatchTurn(
      "Internal error: Failed to authenticate: OAuth session expired and could not be refreshed",
    );
    expectKind(classifyCodexError(err), "unclassified", "codex");
  });
});

describe("#440 journal corpus — Grok", () => {
  it("attaches exitCode and signal on SIGILL so it is not a clean exit", () => {
    // journal: grok exited before billing (code=null, signal=SIGILL) × 16
    const err = grokExitBeforeBillingError(null, "SIGILL");
    expect(err.data).toMatchObject({
      errorKind: "agent_exit",
      agentId: "grok",
      exitCode: null,
      signal: "SIGILL",
    });
    const result = classifyGrokError(err);
    expectKind(result, "agent_exit", "grok");
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe("SIGILL");
    expect(Object.prototype.hasOwnProperty.call(result, "exitCode")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(result, "signal")).toBe(true);
  });

  it("classifies Grok ACP initialize connection-closed ProbeError", () => {
    const err = Object.assign(new Error("protocol_error: Grok ACP initialize: ACP connection closed"), {
      name: "ProbeError",
      code: "protocol_error",
      detail: "Grok ACP initialize: ACP connection closed",
    });
    expectKind(classifyGrokError(err), "connection_closed", "grok");
  });

  it("classifies Grok ACP initialize SIGILL ProbeError as agent_exit with both fields", () => {
    const err = Object.assign(
      new Error("exited_early: Grok ACP initialize exited (code=null, signal=SIGILL)"),
      { name: "ProbeError", code: "exited_early" },
    );
    const result = classifyGrokError(err);
    expectKind(result, "agent_exit", "grok");
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe("SIGILL");
  });

  it("does not classify Claude contention as a Grok failure", () => {
    const err = dispatchTurn(
      "Internal error: Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh",
    );
    expectKind(classifyGrokError(err), "unclassified", "grok");
  });
});

describe("#440 journal corpus — Copilot and capability absence", () => {
  it("produces capability_absent on the observed copilot catalog refusal", () => {
    const err = copilotNoModelConfigError();
    expect(err.data).toMatchObject({ errorKind: "capability_absent", agentId: "copilot" });
    expectKind(classifyCopilotError(err), "capability_absent", "copilot");
    expectKind(classifyCopilotError(new Error("copilot ACP advertised no model config options")), "capability_absent", "copilot");
  });

  it("classifies unknown rpc method: describeModelCatalog as capability_absent", () => {
    const err = new Error("unknown rpc method: describeModelCatalog");
    expectKind(classifyCopilotError(err), "capability_absent", "copilot");
    expectKind(classifyGrokError(err), "capability_absent", "grok");
  });
});

describe("#440 journal corpus — agy", () => {
  it("maps native AGY protocol_error data.code, not the Internal error prefix", () => {
    const err = requestError("Internal error: native AGY protocol_error", { code: "protocol_error" });
    expectKind(classifyAgyError(err), "protocol_error", "agy");
  });

  it("maps native AGY exited_early to agent_exit", () => {
    const err = requestError("Internal error: native AGY exited_early", { code: "exited_early" });
    expectKind(classifyAgyError(err), "agent_exit", "agy");
  });

  it("maps unknown session details to session_gone", () => {
    const err = RequestError.invalidParams(
      classifiedErrorData("agy", "session_gone", { details: "unknown session sess-1" }),
      "unknown session sess-1",
    );
    expect(err.data).toMatchObject({ errorKind: "session_gone", agentId: "agy", details: "unknown session sess-1" });
    expectKind(classifyAgyError(err), "session_gone", "agy");
  });

  it("agy RequestError throws go through agyData so errorKind is produced, not inferred", () => {
    const src = readFileSync(path.join(adaptersRoot, "profiles/agy.ts"), "utf8");
    const naked = src.match(/RequestError\.(invalidParams|internalError)\(\s*\{/g);
    expect(naked).toBeNull();
    expect(src.includes("agyData(")).toBe(true);
    expect(src.includes("classifiedErrorData")).toBe(true);
  });
});

describe("#440 shared runtime exits", () => {
  it("parses mid-turn exit code/signal out of the runtime message and always emits both fields", () => {
    const err = new Error("agent process exited mid-turn (code=1, signal=null)");
    const result = classifyClaudeError(err);
    expectKind(result, "agent_exit", "claude");
    expect(result.exitCode).toBe(1);
    expect(result.signal).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(result, "exitCode")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(result, "signal")).toBe(true);
  });

  it("does not treat JSON-RPC RequestError.code as a process exit code", () => {
    const err = requestError("Internal error", null, -32603);
    expect(parseExitCause(err)).toBeNull();
    expectKind(classifyClaudeError(err), "unclassified", "claude");
  });

  it("reads pino agent-exit records that have code/signal fields but a bare message", () => {
    const record = { msg: "agent process exited abnormally", code: null, signal: "SIGTERM" };
    const result = classifyGrokError(record);
    expectKind(result, "agent_exit", "grok");
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe("SIGTERM");
  });

  it("classifies session/load timeout by name/code, not by grepping 'timed out' alone", () => {
    const err = Object.assign(
      new Error("ACP session/load timed out after 60s for agent 'codex'; the session was not resumed and can be retried"),
      { name: "SessionLoadTimeoutError", code: "session_load_timeout" },
    );
    expectKind(classifyCodexError(err), "timeout", "codex");
    expectKind(classifyCodexError(new Error("the catalog refresh timed out waiting for lock")), "unclassified", "codex");
  });

  it("does not attribute unattributed HTTP 500 prose to an adapter", () => {
    expectKind(classifyClaudeError(new Error("Internal Server Error")), "unclassified", "claude");
    expectKind(classifyCodexError(new Error("Service Unavailable")), "unclassified", "codex");
  });
});

describe("#440 profile.classifyError is the producer on every factory", () => {
  it("attaches errorKind onto the error object for claude, zai, vertex, copilot, grok, codex, ollama-cloud", () => {
    const claude = makeClaudeProfile({ defaultModel: "default" });
    const zai = makeClaudeProfile({ id: "zai", defaultModel: "glm-5", effort: { mechanism: "none", levels: [] } });
    const vertex = makeClaudeProfile({ id: "claude-vertex", defaultModel: "default", brand: "vertex" });
    const copilot = makeCopilotProfile({ defaultModel: "gpt-5.2" });
    const grok = makeGrokProfile({ defaultModel: "grok-4.6" });
    const codex = makeCodexProfile({ defaultModel: "gpt-5.4" });
    const ollama = makeCodexProfile({ id: "ollama-cloud", defaultModel: "kimi-k2.5:cloud" });

    const oauth = dispatchTurn(
      "Internal error: Failed to authenticate: OAuth session expired and could not be refreshed",
    );
    expect(claude.classifyError?.(oauth)).toMatchObject({ errorKind: "auth_expired", agentId: "claude" });
    expect(oauth.data).toMatchObject({ errorKind: "auth_expired", agentId: "claude" });

    const zaiErr = dispatchTurn(
      "Internal error: Failed to authenticate: OAuth session expired and could not be refreshed",
    );
    expect(zai.classifyError?.(zaiErr)).toMatchObject({ errorKind: "auth_expired", agentId: "zai" });

    const vertexErr = new Error("agent process exited mid-turn (code=1, signal=null)");
    expect(vertex.classifyError?.(vertexErr)).toMatchObject({
      errorKind: "agent_exit", agentId: "claude-vertex", exitCode: 1, signal: null,
    });

    const copilotErr = new Error("copilot ACP advertised no model config options") as Error & { data?: unknown };
    expect(copilot.classifyError?.(copilotErr)).toMatchObject({
      errorKind: "capability_absent", agentId: "copilot",
    });
    expect(copilotErr.data).toMatchObject({ errorKind: "capability_absent" });

    const grokErr = grokExitBeforeBillingError(null, "SIGILL");
    expect(grok.classifyError?.(grokErr)).toMatchObject({
      errorKind: "agent_exit", agentId: "grok", signal: "SIGILL",
    });

    const quota = dispatchTurn("Internal error", {
      output: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 19th, 2026 6:00 AM.",
    });
    expect(codex.classifyError?.(quota)).toMatchObject({ errorKind: "quota_exhausted", agentId: "codex" });

    const ollamaErr = new Error("unknown rpc method: describeModelCatalog");
    expect(ollama.classifyError?.(ollamaErr)).toMatchObject({
      errorKind: "capability_absent", agentId: "ollama-cloud",
    });
  });

  it("readErrorClassification ignores ACP errorKind that has no agentId — that is not yet produced here", () => {
    const err = requestError("Internal error", { errorKind: "authentication_failed" });
    expect(readErrorClassification(err)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { RequestError } from "@agentclientprotocol/sdk";
import {
  ADAPTER_ERROR_KINDS, classifyClaudeError, classifyCodexError, classifyGrokError,
  resolveError, type ErrorRule, type ResolutionError,
} from "@seam/adapters";
import { DEFAULT_ERROR_RULES } from "../packages/core/src/core/error-resolution-rules.js";

const options = [
  { id: "human", rung: 5 }, { id: "fresh", rung: 4 }, { id: "reattach", rung: 3 },
  { id: "fallback-preferred", rung: 2 }, { id: "fallback-second", rung: 2 }, { id: "retry", rung: 1 },
] as const;

describe("#441 frozen resolver and variable data", () => {
  it.each([
    ["rate_limit", "transient", 1], ["quota_exhausted", "terminal", 2],
    ["auth_expired", "terminal", 2], ["auth_contention", "transient", 1],
    ["auth_required", "terminal", 2], ["permission_denied", "terminal", 2],
    ["session_gone", "terminal", 4], ["connection_closed", "transient", 3],
    ["protocol_error", "unknown", 1], ["agent_exit", "unknown", 3],
    ["overloaded", "transient", 1], ["invalid_request", "terminal", 4],
    ["context_length", "terminal", 4], ["model_not_found", "terminal", 2],
    ["capability_absent", "terminal", 2], ["server_error", "transient", 1],
    ["timeout", "transient", 1], ["cancelled", "terminal", 5], ["unclassified", "unknown", 1],
  ] as const)("covers %s without assuming billing or side effects", (errorKind, transience, startRung) => {
    expect(resolveError({ errorKind, agentId: "fixture" }, DEFAULT_ERROR_RULES)).toMatchObject({
      errorKind, agentId: "fixture", transience, startRung, charged: "unknown", sideEffects: "unknown",
      surface: true, action: errorKind === "cancelled" ? "stop" : "recover",
    });
  });

  it("has a policy row for every classified kind, but no data-owned unknown default", () => {
    expect(DEFAULT_ERROR_RULES.map((r) => r.when.errorKind).sort())
      .toEqual(ADAPTER_ERROR_KINDS.filter((k) => k !== "unclassified").sort());
  });

  it("uses exact fields and first-row precedence, including null versus absent exit cause", () => {
    const custom: ErrorRule = {
      id: "sigill", when: { errorKind: "agent_exit", agentId: "grok", exitCode: null, signal: "SIGILL" },
      then: { transience: "terminal", charged: "no", sideEffects: "unknown", sessionUsable: "unknown",
        needsHuman: "yes", startRung: 2, action: "recover" },
    };
    const rules = JSON.parse(JSON.stringify([custom, ...DEFAULT_ERROR_RULES]));
    const error: ResolutionError = { errorKind: "agent_exit", agentId: "grok", exitCode: null, signal: "SIGILL" };
    expect(resolveError(error, rules)).toMatchObject({ ruleId: "sigill", charged: "no", startRung: 2 });
    expect(resolveError({ ...error, exitCode: undefined }, rules).ruleId).toBe("agent_exit");
    expect(resolveError({ ...error, signal: "SIGTERM" }, rules).ruleId).toBe("agent_exit");
    expect(resolveError({ ...error, agentId: "codex" }, rules).ruleId).toBe("agent_exit");
    expect(resolveError(error, [...DEFAULT_ERROR_RULES, custom]).ruleId).toBe("agent_exit");
  });

  it("applies a new source-code row without a new function or English matcher", () => {
    const rule: ErrorRule = { ...DEFAULT_ERROR_RULES[0]!, id: "new-provider-code",
      when: { errorKind: "server_error", sourceKind: "new-code" },
      then: { ...DEFAULT_ERROR_RULES[0]!.then, startRung: 2 } };
    expect(resolveError({ agentId: "fixture", errorKind: "server_error", sourceKind: "new-code" }, [rule])
      .startRung).toBe(2);
    expect(resolveError({ agentId: "fixture", errorKind: "server_error", details: "new-code" }, [rule])
      .ruleId).toBeNull();
  });

  it("unknown and unmatched failures continue visibly from rung one even with hostile fallback data", () => {
    const stopUnknown: ErrorRule = { ...DEFAULT_ERROR_RULES[0]!, id: "stop-unknown",
      when: { errorKind: "unclassified" }, then: { ...DEFAULT_ERROR_RULES[0]!.then, action: "stop", startRung: 5 } };
    for (const errorKind of ["unclassified", "server_error"] as const) {
      expect(resolveError({ agentId: "codex", errorKind, details: "temporarily limiting requests · Rate limited",
        viableOptions: options }, [stopUnknown])).toMatchObject({
        errorKind, agentId: "codex", ruleId: null, transience: "unknown", startRung: 1, action: "recover", surface: true,
        optionCount: 6,
      });
    }
  });

  it("does not silently promise a recovery option when none is available", () => {
    const error = { errorKind: "model_not_found", agentId: "agy" } as const;
    expect(resolveError(error, DEFAULT_ERROR_RULES)).toMatchObject({ tier: 3, optionCount: 0, surface: true, action: "recover" });
    expect(resolveError({ ...error, viableOptions: [{ id: "fallback", rung: 2 }] }, DEFAULT_ERROR_RULES))
      .toMatchObject({ tier: 1, optionCount: 1 });
    expect(resolveError({ ...error, viableOptions: options }, DEFAULT_ERROR_RULES)).toMatchObject({ tier: 2, optionCount: 5 });
  });

  it("orders real options by rung, preserves fallback rank, and counts distinct actions", () => {
    const verdict = resolveError({ agentId: "codex", errorKind: "unclassified",
      viableOptions: [...options, { id: "retry", rung: 1 }] }, DEFAULT_ERROR_RULES);
    expect(verdict.options.map((o) => o.id)).toEqual([
      "retry", "fallback-preferred", "fallback-second", "reattach", "fresh", "human",
    ]);
    expect(verdict.optionCount).toBe(6);
    expect(resolveError({ agentId: "codex", errorKind: "unclassified", viableOptions: [options[5], options[5]] }, [])
      .tier).toBe(1);
  });

  it("observed axes override policy defaults without becoming retry guards", () => {
    expect(resolveError({ agentId: "claude", errorKind: "rate_limit",
      facts: { charged: "yes", sideEffects: "yes", sessionUsable: "yes", needsHuman: "unknown" },
      viableOptions: options }, DEFAULT_ERROR_RULES)).toMatchObject({
      charged: "yes", sideEffects: "yes", sessionUsable: "yes", needsHuman: "unknown", startRung: 1, action: "recover",
    });
  });

  it("is deterministic, accepts frozen inputs and returns independent data", () => {
    const error = Object.freeze({ agentId: "agy", errorKind: "connection_closed" as const,
      viableOptions: Object.freeze(options.map((o) => Object.freeze({ ...o }))) });
    const before = JSON.stringify([error, DEFAULT_ERROR_RULES]);
    const first = resolveError(error, DEFAULT_ERROR_RULES);
    expect(resolveError(error, DEFAULT_ERROR_RULES)).toEqual(first);
    first.options[0]!.id = "changed-result";
    expect(JSON.stringify([error, DEFAULT_ERROR_RULES])).toBe(before);
    expect(resolveError(error, DEFAULT_ERROR_RULES).options[0]!.id).toBe("reattach");
  });

  it("honors explicit cancellation, unlike unexpected failure", () => {
    expect(resolveError({ agentId: "codex", errorKind: "cancelled", viableOptions: options }, DEFAULT_ERROR_RULES))
      .toMatchObject({ action: "stop", options: [], surface: true, needsHuman: "no" });
  });
});

describe("#441 sanitized journal corpus through adapter then resolver", () => {
  // Re-observed 2026-09-20 in a bounded 40,000-record journal window since
  // 2026-09-13. No prompts, credentials, transcript content, or live calls.
  it.each([
    ["expired OAuth", "Internal error: Failed to authenticate: OAuth session expired and could not be refreshed",
      { errorKind: "authentication_failed" }, "auth_expired", "terminal", 2, "yes"],
    ["refresh race", "Internal error: Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh",
      { errorKind: "server_error" }, "auth_contention", "transient", 1, "no"],
    ["opaque internal", "Internal error", null, "unclassified", "unknown", 1, "unknown"],
    ["403", "Internal error", { http_status: 403 }, "permission_denied", "terminal", 2, "unknown"],
  ] as const)("%s", (_name, message, data, errorKind, transience, startRung, needsHuman) => {
    const classification = classifyClaudeError(new RequestError(-32603, message, data));
    expect(resolveError(classification, DEFAULT_ERROR_RULES)).toMatchObject({
      errorKind, agentId: "claude", transience, startRung, needsHuman, charged: "unknown", sideEffects: "unknown", surface: true,
    });
  });

  it("keeps Grok's observed closed-connection failure distinct from a dead session", () => {
    const error = new Error("protocol_error: Grok ACP initialize: ACP connection closed");
    expect(resolveError(classifyGrokError(error), DEFAULT_ERROR_RULES))
      .toMatchObject({ errorKind: "connection_closed", startRung: 3, sessionUsable: "unknown" });
  });

  it("uses #440's journal-backed Codex output shape rather than an Internal error guess", () => {
    const error = Object.assign(new Error("Internal error"), { name: "DispatchTurnError",
      output: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 19th, 2026 6:00 AM.\n" });
    expect(resolveError(classifyCodexError(error), DEFAULT_ERROR_RULES))
      .toMatchObject({ errorKind: "quota_exhausted", transience: "terminal", startRung: 2, action: "recover" });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AdapterErrorKind,
  RemoteRecoveryResult,
  RemoteRecoverySnapshot,
  RemoteRung1Policy,
} from "@seam/adapters";
import { isRemoteRung1Policy, classifyCodexError, providerRetryBackoff, PROVIDER_RETRY_WINDOW_MS } from "@seam/adapters";
import { createRung1Recovery } from "../packages/bridge/src/rung1-recovery.js";
import { DEFAULT_REMOTE_RUNG1_POLICY } from "../packages/core/src/core/remote-spawn.js";

const policy: RemoteRung1Policy = {
  version: 1,
  retryCount: 1,
  backoffMs: [25],
  retryableErrorKinds: ["timeout", "server_error"],
};

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function harness(opts: { connected?: boolean; kind?: AdapterErrorKind; policy?: RemoteRung1Policy; codex?: boolean; clock?: () => number } = {}) {
  const writes: string[] = [];
  const snapshots: RemoteRecoverySnapshot[] = [];
  const results: RemoteRecoveryResult[] = [];
  const output: string[] = [];
  const recovery = createRung1Recovery({
    policyFor: () => opts.policy ?? policy,
    agentId: opts.codex ? "codex" : undefined,
    classify: (_slot, error) => opts.codex ? classifyCodexError(error).errorKind : opts.kind ?? "timeout",
    write: (_slot, value) => { writes.push(value); return true; },
    publishSnapshot: (_slot, value) => snapshots.push(value),
    publishResult: (_slot, value) => results.push(value),
    publishOutput: (_slot, value) => output.push(value),
    controllerConnected: () => opts.connected ?? false,
    now: opts.clock ?? (() => Date.parse("2026-09-22T12:00:00.000Z")),
  });
  return { recovery, writes, snapshots, results, output };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("#467 bridge-owned rung 1", () => {
  it.each([false, true])("honours the adapter's bound AGY continuation result: bound=%s", async bound => {
    vi.useFakeTimers();
    const h = harness({ kind: "unclassified", policy: { ...policy, retryableErrorKinds: ["unclassified"] } });
    const reason = "AGY never bound a native conversation for this prompt, so it can't be continued.";
    const message = `native AGY exited_early${bound ? "" : `\n${reason}`}`;
    h.recovery.arm(4, { submissionId: "agy-submission", acpSessionId: "agy-session", continuation: "continue" });
    h.recovery.observeInput(4, line({ id: 17, method: "session/prompt", params: {
      sessionId: "agy-session", prompt: [{ type: "text", text: "original isolated brief" }],
    } }));
    const error = line({ id: 17, error: { code: -32603, message, data: {
      errorKind: "unclassified", agentId: "agy", code: "exited_early",
      ...(!bound ? { continuationUnavailable: reason } : {}),
    } } });
    const decision = h.recovery.observeOutput(4, error);
    await vi.advanceTimersByTimeAsync(25);
    if (!bound) {
      expect(decision.forward).toBe(error);
      expect(h.writes).toEqual([]);
      expect(h.results).toEqual([expect.objectContaining({ status: "failed", error: message, errorKind: "unclassified" })]);
      expect(h.recovery.snapshot(4)?.retry).toBe(0);
    } else {
      expect(decision.forward).toBeNull();
      expect(h.writes).toHaveLength(1);
      const retry = JSON.parse(h.writes[0]!);
      expect(retry.params).toEqual({ sessionId: "agy-session", prompt: [{ type: "text", text: "continue" }] });
      h.recovery.observeOutput(4, line({ id: retry.id, result: { stopReason: "end_turn" } }));
      expect(h.results).toEqual([expect.objectContaining({ status: "completed" })]);
    }
  });

  const rollout = JSON.stringify({ type: "error", error: { message: "model 'gpt-6.1-sol' is not enabled in rustponsesapi",
    type: "invalid_request_error", param: null, code: null }, status: 400 });
  function typedFailure(id: string | number, title = rollout) {
    return line({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", _meta: { jetbrains: { air: { version: 1,
      sessionFailure: { id: "turn:error", revision: 1, category: "service", severity: "error", title, actions: ["retry"] },
    } } } } });
  }
  function sendCodex(h: ReturnType<typeof harness>) {
    h.recovery.arm(4, { submissionId: "provider-submission", acpSessionId: "provider-session", continuation: "continue" });
    h.recovery.observeInput(4, line({ jsonrpc: "2.0", id: 17, method: "session/prompt", params: {
      sessionId: "provider-session", prompt: [{ type: "text", text: "real brief" }],
    } }));
  }

  it("retries a typed end_turn failure through the real adapter classifier, keeping its session", async () => {
    vi.useFakeTimers();
    const h = harness({ codex: true, policy: DEFAULT_REMOTE_RUNG1_POLICY });
    sendCodex(h);
    expect(h.recovery.observeOutput(4, typedFailure(17))).toEqual({ forward: null });
    expect(h.results).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    const retry = JSON.parse(h.writes[0]!);
    expect(retry.params).toEqual({ sessionId: "provider-session", prompt: [{ type: "text", text: "continue" }] });
    expect(h.recovery.observeOutput(4, line({ method: "session/update", params: { sessionId: "provider-session",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } } } })).forward).toContain("answer");
    expect(JSON.parse(h.recovery.observeOutput(4, line({ id: retry.id, result: { stopReason: "end_turn" } })).forward!)).toMatchObject({ id: 17 });
    expect(h.results).toEqual([expect.objectContaining({ status: "completed", text: "answer" })]);
    expect(h.results[0]).not.toHaveProperty("error");
  });

  it("retains the raw provider cause and fails after the bounded overload schedule", async () => {
    vi.useFakeTimers();
    const h = harness({ codex: true, policy: DEFAULT_REMOTE_RUNG1_POLICY, clock: Date.now });
    sendCodex(h);
    let id: string | number = 17;
    for (const delay of providerRetryBackoff("overloaded")!) {
      expect(h.recovery.observeOutput(4, typedFailure(id))).toEqual({ forward: null });
      await vi.advanceTimersByTimeAsync(delay);
      id = JSON.parse(h.writes.at(-1)!).id;
    }
    const forwarded = JSON.parse(h.recovery.observeOutput(4, typedFailure(id)).forward!);
    expect(forwarded).toMatchObject({ id: 17, error: { message: rollout, data: { status: 400 } } });
    expect(h.results).toEqual([expect.objectContaining({ status: "failed", error: rollout, errorKind: "overloaded", text: "" })]);
    expect(h.recovery.terminalResult(4)).toEqual(h.results[0]);
    expect(h.recovery.snapshot(4)).toMatchObject({ phase: "exhausted", retry: 5, budget: 5, remaining: 0 });
    await vi.advanceTimersByTimeAsync(PROVIDER_RETRY_WINDOW_MS);
    expect(h.writes).toHaveLength(5);
  });

  it("counts time spent failing, not just sleeps, against the provider horizon", async () => {
    vi.useFakeTimers();
    const h = harness({ codex: true, policy: DEFAULT_REMOTE_RUNG1_POLICY, clock: Date.now });
    sendCodex(h);
    h.recovery.observeOutput(4, typedFailure(17));
    await vi.advanceTimersByTimeAsync(PROVIDER_RETRY_WINDOW_MS);
    const id = JSON.parse(h.writes[0]!).id;
    expect(JSON.parse(h.recovery.observeOutput(4, typedFailure(id)).forward!).error.message).toBe(rollout);
    expect(h.results[0]).toMatchObject({ status: "failed", error: rollout });
    expect(h.writes).toHaveLength(1);
  });

  it("does not send a paid retry if a backoff callback runs after its horizon", async () => {
    vi.useFakeTimers();
    let time = 0;
    const h = harness({ codex: true, policy: DEFAULT_REMOTE_RUNG1_POLICY, clock: () => time });
    sendCodex(h);
    h.recovery.observeOutput(4, typedFailure(17));
    time = PROVIDER_RETRY_WINDOW_MS;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.writes).toEqual([]);
    expect(h.results[0]).toMatchObject({ status: "failed", error: rollout });
    expect(JSON.parse(h.output.at(-1)!)).toMatchObject({ id: 17, error: { message: rollout } });
  });

  it("consumes a split legacy failure without posting it as the answer", async () => {
    vi.useFakeTimers();
    const h = harness({ codex: true, policy: DEFAULT_REMOTE_RUNG1_POLICY });
    sendCodex(h);
    for (const text of ["Selected model is at ", "capacity. Please try a different model."]) {
      expect(h.recovery.observeOutput(4, line({ method: "session/update", params: { sessionId: "provider-session",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } }))).toEqual({ forward: null });
    }
    expect(h.recovery.observeOutput(4, line({ id: 17, result: { stopReason: "end_turn" } }))).toEqual({ forward: null });
    expect(h.results).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.writes).toHaveLength(1);
  });

  it.each(["initialize-before-arm", "initialize-during-resume"])("does not inspect replies with negotiated AIR support: %s", order => {
    const h = harness({ codex: true, policy: DEFAULT_REMOTE_RUNG1_POLICY });
    const initialize = () => h.recovery.observeOutput(4, line({ id: "initialize", result: { protocolVersion: 1,
      _meta: { jetbrains: { air: { version: 1, capabilities: ["sessionFailure"] } } } } }));
    if (order === "initialize-before-arm") initialize();
    sendCodex(h);
    if (order === "initialize-during-resume") initialize();
    const text = "Selected model is at capacity. Please try a different model.";
    expect(h.recovery.observeOutput(4, line({ method: "session/update", params: { sessionId: "provider-session",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } })).forward).toContain(text);
    h.recovery.observeOutput(4, line({ id: 17, result: { stopReason: "end_turn" } }));
    expect(h.results[0]).toMatchObject({ status: "completed", text });
    expect(h.writes).toEqual([]);
  });

  it.each([
    ["quota_exhausted", "limit", [], "You've hit your usage limit"],
    ["auth_required", "access", ["login"], "provider authentication expired"],
  ] as const)("does not retry typed %s", (kind, category, actions, title) => {
    const h = harness({ codex: true, policy: DEFAULT_REMOTE_RUNG1_POLICY });
    sendCodex(h);
    h.recovery.observeOutput(4, line({ id: 17, result: { stopReason: "end_turn", _meta: { jetbrains: { air: {
      version: 1, sessionFailure: { id: "failure", category, severity: "error", title, actions },
    } } } } }));
    expect(h.results[0]).toMatchObject({ status: "failed", errorKind: kind, error: title });
    expect(h.writes).toEqual([]);
  });

  it("settles a rebound arm that never received a prompt with its actual cause", () => {
    const h = harness();
    const input = { submissionId: "submission-missing", acpSessionId: "session-missing", continuation: "continue" };
    h.recovery.arm(6, input);
    expect(h.recovery.reconcile(6, input, false)).toEqual({ state: "owned" });
    expect(h.results).toEqual([expect.objectContaining({ status: "failed", stopReason: "prompt_not_received",
      error: expect.stringContaining("never received a complete session/prompt") })]);
    expect(h.writes).toEqual([]);
    expect(h.recovery.snapshot(6)).toMatchObject({ phase: "exhausted", terminalReason: "prompt_not_received" });
  });

  it("does not settle restoration, executing input, or another submission", () => {
    const h = harness();
    const input = { submissionId: "submission-live", acpSessionId: "session-live", continuation: "continue" };
    h.recovery.arm(6, input);
    expect(h.recovery.reconcile(6, input, true)).toEqual({ state: "owned" });
    expect(h.recovery.reconcile(6, { ...input, submissionId: "other" }, false)).toMatchObject({ state: "missing" });
    expect(h.results).toEqual([]);
    h.recovery.observeInput(6, line({ id: 7, method: "session/prompt", params: { sessionId: input.acpSessionId, prompt: [] } }));
    expect(h.recovery.reconcile(6, input, false)).toEqual({ state: "owned" });
    expect(h.recovery.snapshot(6)).toMatchObject({ phase: "executing" });
    expect(h.results).toEqual([]);
    expect(h.writes).toEqual([]);
  });

  it("names incomplete input without pretending it was submitted", () => {
    const h = harness();
    const input = { submissionId: "submission-partial", acpSessionId: "session-partial", continuation: "continue" };
    h.recovery.arm(6, input);
    h.recovery.observeInputBytes(6);
    expect(h.recovery.disarm(6, input.submissionId)).toBe(false);
    h.recovery.reconcile(6, input, false);
    expect(h.results[0]).toMatchObject({ status: "failed", error: expect.stringContaining("never received a complete") });
  });

  it("disarms only the exact terminal auth-required rejection after prompt bytes", () => {
    const h = harness({ codex: true, policy: DEFAULT_REMOTE_RUNG1_POLICY });
    sendCodex(h);
    expect(h.recovery.disarm(4, "provider-submission")).toBe(false);
    h.recovery.observeOutput(4, line({ id: 17, error: { code: -32000, message: "Authentication required" } }));
    expect(h.recovery.terminalResult(4)).toMatchObject({ status: "failed", errorKind: "auth_required" });
    expect(h.recovery.disarm(4, "wrong-submission")).toBe(false);
    expect(h.recovery.disarm(4, "provider-submission")).toBe(true);
    expect(h.recovery.snapshot(4)).toBeUndefined();
    expect(h.recovery.terminalResult(4)).toBeUndefined();
    expect(h.writes).toEqual([]);
  });

  it.each(["auth_expired", "quota_exhausted", "protocol_error"] as const)("does not disarm another terminal failure: %s", kind => {
    const h = harness({ kind });
    sendCodex(h);
    h.recovery.observeOutput(4, line({ id: 17, error: { code: -32000, message: "fixture failure" } }));
    expect(h.recovery.terminalResult(4)).toMatchObject({ status: "failed", errorKind: kind });
    expect(h.recovery.disarm(4, "provider-submission")).toBe(false);
  });

  it("does not disarm a backoff or a completed submission", () => {
    vi.useFakeTimers();
    const h = harness();
    sendCodex(h);
    h.recovery.observeOutput(4, line({ id: 17, error: { message: "fixture timeout" } }));
    expect(h.recovery.snapshot(4)).toMatchObject({ phase: "backoff" });
    expect(h.recovery.disarm(4, "provider-submission")).toBe(false);
    const done = harness();
    sendCodex(done);
    done.recovery.observeOutput(4, line({ id: 17, result: { stopReason: "end_turn" } }));
    expect(done.recovery.disarm(4, "provider-submission")).toBe(false);
  });

  it("continues the same session without retaining or resending the original prompt", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.recovery.arm(4, {
      submissionId: "submission-1",
      acpSessionId: "session-1",
      continuation: "continue",
    });
    const original = "ORIGINAL PRIVATE BRIEF";
    h.recovery.observeInput(4, line({ jsonrpc: "2.0", id: 17, method: "session/prompt",
      params: { sessionId: "session-1", prompt: [{ type: "text", text: original }] } }));

    const secret = "sk-live-token-that-must-not-survive";
    expect(h.recovery.observeOutput(4, line({ jsonrpc: "2.0", id: 17,
      error: { code: -32_000, message: `timed out: ${secret} /private/path` } }))).toEqual({ forward: null });
    await vi.advanceTimersByTimeAsync(25);

    expect(h.writes).toHaveLength(1);
    const retry = JSON.parse(h.writes[0]!) as any;
    expect(retry).toMatchObject({ method: "session/prompt", params: {
      sessionId: "session-1", prompt: [{ type: "text", text: "continue" }],
    } });
    expect(h.writes[0]).not.toContain(original);
    expect(h.writes[0]).not.toContain(secret);

    h.recovery.observeOutput(4, line({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "recovered answer" } },
    } }));
    const forwarded = h.recovery.observeOutput(4, line({ jsonrpc: "2.0", id: retry.id,
      result: { stopReason: "end_turn" } }));
    expect(JSON.parse(forwarded.forward!)).toMatchObject({ id: 17, result: { stopReason: "end_turn" } });
    expect(h.results).toEqual([expect.objectContaining({
      submissionId: "submission-1",
      acpSessionId: "session-1",
      status: "completed",
      text: "recovered answer",
    })]);

    // A fresh controller can still prove and adopt this exact terminal result
    // after live socket delivery or an output-log acknowledgement.
    expect(h.recovery.snapshot(4)).toMatchObject({ phase: "succeeded", retry: 1 });
    expect(h.recovery.terminalResult(4)).toEqual(h.results[0]);
    const publicRecord = JSON.stringify({ snapshots: h.snapshots, results: h.results, writes: h.writes });
    expect(publicRecord).not.toContain(secret);
    expect(publicRecord).not.toContain("/private/path");
    expect(publicRecord).not.toContain(original);
  });

  it("reports a child death as a closed terminal fact instead of stranding ownership", () => {
    const h = harness();
    h.recovery.arm(2, { submissionId: "submission-death", acpSessionId: "session-death",
      continuation: "continue" });
    h.recovery.observeInput(2, line({ id: 3, method: "session/prompt",
      params: { sessionId: "session-death", prompt: [] } }));
    h.recovery.childExited(2);
    expect(h.recovery.snapshot(2)).toMatchObject({
      phase: "exhausted",
      errorKind: "connection_closed",
      terminalReason: "child_exited",
    });
    expect(h.results).toEqual([expect.objectContaining({ status: "failed",
      errorKind: "connection_closed" })]);
  });

  it("never hands ownership back after any prompt bytes reached the child", () => {
    const h = harness();
    h.recovery.arm(6, { submissionId: "submission-partial", acpSessionId: "session-partial",
      continuation: "continue" });
    // This models a request split before the newline/JSON boundary. The bridge
    // cannot yet name its id, but it positively knows bytes crossed the wire.
    h.recovery.observeInputBytes(6);
    expect(h.recovery.disarm(6, "submission-partial")).toBe(false);
    expect(h.recovery.snapshot(6)).toMatchObject({ phase: "armed" });
  });

  it("refuses app-owned requests while disconnected instead of becoming a permission proxy", () => {
    const h = harness({ connected: false });
    h.recovery.arm(1, { submissionId: "submission-app", acpSessionId: "session-app",
      continuation: "continue" });
    h.recovery.observeInput(1, line({ id: 9, method: "session/prompt",
      params: { sessionId: "session-app", prompt: [] } }));
    const request = line({ id: 81, method: "session/request_permission", params: {} });
    expect(h.recovery.observeOutput(1, request)).toEqual({ forward: request });
    expect(h.recovery.snapshot(1)).toMatchObject({
      phase: "awaiting_app",
      terminalReason: "client_request_requires_app",
      disposition: "none",
    });
    expect(h.writes).toEqual([]);
  });

  it.each(["permission_denied", "model_not_found"] as const)(
    "leaves %s and every model/session decision with Seam",
    (kind) => {
      const h = harness({ kind });
      h.recovery.arm(7, { submissionId: "submission-refused", acpSessionId: "session-refused",
        continuation: "continue" });
      h.recovery.observeInput(7, line({ id: "original", method: "session/prompt",
        params: { sessionId: "session-refused", prompt: [] } }));
      expect(h.recovery.observeOutput(7, line({ id: "original", error: { message: "denied" } })).forward)
        .toContain("denied");
      expect(h.writes).toEqual([]);
      expect(h.results).toEqual([expect.objectContaining({ status: "failed",
        errorKind: kind })]);
    });

  it("cancels a pending bridge retry when the app cancels that session", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.recovery.arm(8, { submissionId: "submission-cancel", acpSessionId: "session-cancel",
      continuation: "continue" });
    h.recovery.observeInput(8, line({ id: 1, method: "session/prompt",
      params: { sessionId: "session-cancel", prompt: [] } }));
    h.recovery.observeOutput(8, line({ id: 1, error: { message: "retryable" } }));
    h.recovery.observeInput(8, line({ method: "session/cancel",
      params: { sessionId: "session-cancel" } }));
    await vi.advanceTimersByTimeAsync(100);
    expect(h.writes).toEqual([]);
    expect(h.results).toEqual([expect.objectContaining({ status: "failed", errorKind: "cancelled" })]);
  });
});

describe("#626 auth_contention waits out Claude's stale refresh lock", () => {
  const CONTENTION = "Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh.";

  function failPrompt(h: ReturnType<typeof harness>, slot: number, id: string | number): { forward: string | null } {
    return h.recovery.observeOutput(slot, line({ jsonrpc: "2.0", id, error: { code: -32_603, message: CONTENTION } }));
  }

  function armAndSend(h: ReturnType<typeof harness>, slot: number): void {
    h.recovery.arm(slot, { submissionId: `submission-${slot}`, acpSessionId: `session-${slot}`, continuation: "continue" });
    h.recovery.observeInput(slot, line({ jsonrpc: "2.0", id: 17, method: "session/prompt",
      params: { sessionId: `session-${slot}`, prompt: [{ type: "text", text: "wake prompt" }] } }));
  }

  it("retries once, only after the 60s stale window, under the production policy", async () => {
    vi.useFakeTimers();
    const h = harness({ kind: "auth_contention", policy: DEFAULT_REMOTE_RUNG1_POLICY });
    armAndSend(h, 5);

    expect(failPrompt(h, 5, 17)).toEqual({ forward: null });
    // The v1 schedule would have retried at 2s, 5s and 10s — all inside the
    // window in which a dead holder's lock cannot be taken over.
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.writes).toHaveLength(1);
    const retry = JSON.parse(h.writes[0]!) as { id: string };

    // Once: a second contention is surfaced, not retried again.
    expect(JSON.parse(failPrompt(h, 5, retry.id).forward!)).toMatchObject({ id: 17 });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.writes).toHaveLength(1);
    expect(h.recovery.snapshot(5)).toMatchObject({ phase: "exhausted", errorKind: "auth_contention", retry: 1 });
  });

  it("leaves unrelated kinds on the existing 2s/5s/10s schedule", async () => {
    vi.useFakeTimers();
    const h = harness({ kind: "protocol_error", policy: DEFAULT_REMOTE_RUNG1_POLICY });
    armAndSend(h, 6);
    expect(failPrompt(h, 6, 17)).toEqual({ forward: null });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.writes).toHaveLength(1);
  });

  it("stays valid for a bridge that predates the per-kind field", () => {
    // Old bridges run the v1 validator and FAIL THE SPAWN on an invalid
    // policy, so the new field must never make the policy invalid.
    expect(isRemoteRung1Policy(JSON.parse(JSON.stringify(DEFAULT_REMOTE_RUNG1_POLICY)))).toBe(true);
    const { backoffMsByKind: _dropped, ...v1Shape } = DEFAULT_REMOTE_RUNG1_POLICY;
    expect(v1Shape.backoffMs).toEqual([2_000, 5_000, 10_000]);
  });

  it("a malformed per-kind entry refuses only that override, not the retry", async () => {
    vi.useFakeTimers();
    const h = harness({ kind: "auth_contention", policy: {
      ...DEFAULT_REMOTE_RUNG1_POLICY,
      backoffMsByKind: { auth_contention: [PROVIDER_RETRY_WINDOW_MS + 1] },
    } });
    armAndSend(h, 7);
    expect(failPrompt(h, 7, 17)).toEqual({ forward: null });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.writes).toHaveLength(1);
  });
});

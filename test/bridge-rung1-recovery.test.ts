import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AdapterErrorKind,
  RemoteRecoveryResult,
  RemoteRecoverySnapshot,
  RemoteRung1Policy,
} from "@seam/adapters";
import { isRemoteRung1Policy } from "@seam/adapters";
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

function harness(opts: { connected?: boolean; kind?: AdapterErrorKind; policy?: RemoteRung1Policy } = {}) {
  const writes: string[] = [];
  const snapshots: RemoteRecoverySnapshot[] = [];
  const results: RemoteRecoveryResult[] = [];
  const recovery = createRung1Recovery({
    policyFor: () => opts.policy ?? policy,
    classify: () => opts.kind ?? "timeout",
    write: (_slot, value) => { writes.push(value); return true; },
    publishSnapshot: (_slot, value) => snapshots.push(value),
    publishResult: (_slot, value) => results.push(value),
    controllerConnected: () => opts.connected ?? false,
    now: () => Date.parse("2026-09-22T12:00:00.000Z"),
  });
  return { recovery, writes, snapshots, results };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("#467 bridge-owned rung 1", () => {
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

  it("leaves every other kind on the existing 2s/5s/10s schedule", async () => {
    vi.useFakeTimers();
    const h = harness({ kind: "server_error", policy: DEFAULT_REMOTE_RUNG1_POLICY });
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
      backoffMsByKind: { auth_contention: [120_000] },
    } });
    armAndSend(h, 7);
    expect(failPrompt(h, 7, 17)).toEqual({ forward: null });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.writes).toHaveLength(1);
  });
});

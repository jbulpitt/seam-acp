import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestError } from "@agentclientprotocol/sdk";
import { classifyCodexError, readErrorClassification, PROVIDER_RETRY_WINDOW_MS,
  remoteRung1KindBackoff, isRemoteRung1Policy, type AgentProfile, type AdapterErrorKind } from "@seam/adapters";
import { createRung1Recovery } from "../packages/bridge/src/rung1-recovery.js";
import { DEFAULT_REMOTE_RUNG1_POLICY } from "../packages/core/src/core/remote-spawn.js";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import { logger } from "../packages/core/src/lib/logger.js";

const capacity = "Selected model is at capacity. Please try a different model.";
const compactCapacity = `Error running remote compact task: ${capacity}`;
const frame = (value: unknown) => `${JSON.stringify(value)}\n`;
const windowMs = 30 * 60_000;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function bridge() {
  const writes: any[] = [], results: any[] = [], notices: any[] = [];
  const recovery = createRung1Recovery({ agentId: "codex", policyFor: () => DEFAULT_REMOTE_RUNG1_POLICY,
    classify: (_slot, error) => readErrorClassification(error)?.errorKind ?? classifyCodexError(error).errorKind,
    write: (_slot, line) => { writes.push(JSON.parse(line)); return true; },
    publishSnapshot: () => {}, publishResult: (_slot, result) => results.push(result),
    publishOutput: (_slot, line) => notices.push(JSON.parse(line)), now: Date.now });
  recovery.observeOutput(4, frame({ id: "initialize", result: { protocolVersion: 1,
    _meta: { jetbrains: { air: { version: 1, capabilities: ["sessionFailure"] } } } } }));
  recovery.arm(4, { submissionId: "submission", acpSessionId: "saved-session", continuation: "continue" });
  recovery.observeInput(4, frame({ id: 17, method: "session/prompt", params: {
    sessionId: "saved-session", prompt: [{ type: "text", text: "ORIGINAL_SIDE_EFFECT" }] } }));
  const error = (id: string | number, kind: AdapterErrorKind = "overloaded", message = capacity) =>
    recovery.observeOutput(4, frame({ id, error: { code: -32603, message, data: { agentId: "codex", errorKind: kind } } }));
  const progress = (sessionId = "saved-session") => recovery.observeOutput(4, frame({ method: "session/update", params: {
    sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "already-sent", status: "completed" } } }));
  const capacityFailure = (id: string | number, message = capacity) => recovery.observeOutput(4,
    frame(message === compactCapacity
      ? { id, result: { stopReason: "end_turn", _meta: { jetbrains: { air: { version: 1, sessionFailure: {
        id: "turn:error", category: "service", severity: "error", title: message, actions: ["retry"],
      } } } } } }
      : { id, error: { code: -32603, message } }));
  return { recovery, writes, results, notices, error, progress, capacityFailure };
}

describe("#988 productive continuations get a new failure episode", () => {
  // First warning -> terminal receipt, from the four production attempts.
  it.each([
    ["9e9238df", 2_652_416, capacity],
    ["eb19c768", 1_594_505, compactCapacity],
    ["90d9c7e5", 1_579_271, capacity],
    ["wake-051c212c", 3_901_027, capacity],
  ])("continues %s after progress and a later capacity error, without replay", async (_id, gap, firstCause) => {
    vi.useFakeTimers();
    const h = bridge();
    expect(h.capacityFailure(17, firstCause as string).forward).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    const retry = h.writes[0];
    h.progress();
    await vi.advanceTimersByTimeAsync(Number(gap) - 10_000);
    expect(h.capacityFailure(retry.id).forward).toBeNull();
    expect(h.results).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.writes).toHaveLength(2);
    expect(h.writes.map(p => p.params)).toEqual(Array(2).fill({ sessionId: "saved-session", prompt: [{ type: "text", text: "continue" }] }));
    h.recovery.observeOutput(4, frame({ method: "session/update", params: { sessionId: "saved-session",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "FINAL" } } } }));
    const terminal = JSON.parse(h.recovery.observeOutput(4, frame({ id: h.writes[1].id, result: { stopReason: "end_turn" } })).forward!);
    expect(terminal).toMatchObject({ id: 17, result: { stopReason: "end_turn" } });
    expect(h.results).toEqual([expect.objectContaining({ status: "completed", text: "FINAL" })]);
    expect(JSON.stringify(h.writes)).not.toContain("ORIGINAL_SIDE_EFFECT");
  });

  it("resets the controller prompt owner on productive continuation, too", async () => {
    vi.useFakeTimers();
    const runtime = new AgentRuntime({ profile: { id: "codex", classifyError: classifyCodexError } as AgentProfile,
      logger, spawnFn: () => { throw new Error("unused"); } });
    const requests: any[] = [];
    const prompt = vi.fn(async request => {
      requests.push(request);
      if (requests.length === 2) {
        await (runtime as any).handleSessionUpdate({ sessionUpdate: "tool_call_update", toolCallId: "sent", status: "completed" });
        await new Promise(resolve => setTimeout(resolve, 2_652_416));
      }
      if (requests.length < 3) throw new RequestError(-32603, capacity);
      return { stopReason: "end_turn" };
    });
    Object.assign(runtime, { connection: { prompt, cancel: vi.fn() }, sessionId: "saved-session", promptCapabilities: {} });
    const outcome = runtime.prompt("ORIGINAL_SIDE_EFFECT").then(result => ({ result, error: undefined }), error => ({ result: undefined, error }));
    await vi.advanceTimersByTimeAsync(10_000 + 2_652_416 + 10_000);
    const settled = await outcome;
    expect(settled.error).toBeUndefined();
    expect(settled.result).toMatchObject({ stopReason: "end_turn" });
    expect(requests).toHaveLength(3);
    expect(requests.every(p => p.sessionId === "saved-session")).toBe(true);
    expect(requests.slice(1).every(p => p.prompt[0].text.startsWith("continue"))).toBe(true);
    expect(JSON.stringify(requests.slice(1))).not.toContain("ORIGINAL_SIDE_EFFECT");
  });
});

describe("#988 approved per-kind schedules", () => {
  it("uses a 30-minute provider episode, not a turn-lifetime deadline", () => {
    expect(PROVIDER_RETRY_WINDOW_MS).toBe(windowMs);
  });

  it.each(["overloaded", "server_error", "rate_limit", "timeout", "protocol_error", "unclassified"] as const)(
    "covers the 30-minute %s window with the repeated 7-minute tail", async kind => {
      vi.useFakeTimers();
      const h = bridge();
      let id: string | number = 17;
      for (const delay of [10_000, 30_000, 120_000, 300_000, 420_000, 420_000, 420_000]) {
        expect(h.error(id, kind).forward).toBeNull();
        await vi.advanceTimersByTimeAsync(delay);
        id = h.writes.at(-1).id;
        expect(h.results).toEqual([]);
      }
      expect(h.writes).toHaveLength(7);
      expect(h.error(id, kind).forward).toBeNull();
      await vi.advanceTimersByTimeAsync(80_000);
      expect(h.writes).toHaveLength(7);
      expect(h.results).toEqual([expect.objectContaining({ status: "failed", error: capacity, errorKind: kind })]);
    });

  it("does not let retries of one kind shorten another kind's planned schedule", async () => {
    vi.useFakeTimers();
    const h = bridge(); let id: string | number = 17;
    for (const kind of ["protocol_error", "overloaded"] as const) {
      for (const delay of [10_000, 30_000, 120_000, 300_000]) {
        expect(h.error(id, kind).forward).toBeNull();
        await vi.advanceTimersByTimeAsync(delay);
        id = h.writes.at(-1).id;
      }
    }
    expect(h.error(id, "overloaded").forward).toBeNull();
    await vi.advanceTimersByTimeAsync(420_000);
    expect(h.writes).toHaveLength(9);
    expect(h.results).toEqual([]);
  });

  it.each(["auth_contention", "quota_exhausted"] as const)("executes the full finite %s plan before stopping", async kind => {
    vi.useFakeTimers();
    const h = bridge(); let id: string | number = 17;
    const delays = kind === "auth_contention" ? [60_000, 60_000, 60_000] : [300_000];
    for (const delay of delays) {
      expect(h.error(id, kind, "real provider cause").forward).toBeNull();
      await vi.advanceTimersByTimeAsync(delay);
      id = h.writes.at(-1).id;
    }
    expect(h.error(id, kind, "real provider cause").forward).not.toBeNull();
    expect(h.writes).toHaveLength(delays.length);
    expect(h.results[0]).toMatchObject({ status: "failed", errorKind: kind, error: "real provider cause" });
    if (kind === "quota_exhausted") expect(h.notices.at(-1).params.update).toMatchObject({
      title: "Paused — quota or balance exhausted", description: expect.stringContaining("real provider cause") });
    expect(remoteRung1KindBackoff(DEFAULT_REMOTE_RUNG1_POLICY, kind)).toEqual(delays);
  });

  it("accepts native backoff steps above the historical 60-second wire ceiling", () => {
    expect(isRemoteRung1Policy({ version: 1, retryCount: 1, backoffMs: [420_000],
      retryableErrorKinds: ["overloaded"] })).toBe(true);
  });

  it.each(["notice", "usage_update", "user_message_chunk"])("does not renew an episode on %s telemetry", async sessionUpdate => {
    vi.useFakeTimers();
    const h = bridge(); h.error(17);
    await vi.advanceTimersByTimeAsync(10_000);
    h.recovery.observeOutput(4, frame({ method: "session/update", params: { sessionId: "saved-session", update: {
      sessionUpdate, content: { type: "text", text: "continue" }, used: 500, size: 475000, title: "capacity diagnostic" } } }));
    h.progress("another-session");
    await vi.advanceTimersByTimeAsync(windowMs);
    expect(h.error(h.writes[0].id).forward).not.toBeNull();
    expect(h.results[0]).toMatchObject({ status: "failed" });
    expect(h.writes).toHaveLength(1);
  });
});

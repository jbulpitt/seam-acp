import { afterEach, expect, it, vi } from "vitest";
import { RequestError } from "@agentclientprotocol/sdk";
import {
  classifyAgyError, classifyAndAttach, providerRetryBackoff, providerRetryWindow,
  PROVIDER_RETRY_WINDOW_MS, resolveError,
} from "@seam/adapters";
import { ProbeError } from "../packages/adapters/src/probe-process.js";
import { DEFAULT_ERROR_RULES } from "../packages/core/src/core/error-resolution-rules.js";
import { DEFAULT_REMOTE_RUNG1_POLICY } from "../packages/core/src/core/remote-spawn.js";
import { buildRecoveryDirective, runBoundedRecovery } from "../packages/core/src/core/recovery-directive.js";
import { createRung1Recovery } from "../packages/bridge/src/rung1-recovery.js";
import { isRetryableBootAcquisitionError } from "../packages/core/src/core/dispatch/acquisition-phase.js";

const overflow = { limit: "StreamAgentStateUpdates frame" as const, limitBytes: 67_108_864, observedBytes: 67_108_865 };
const detail = `${overflow.limit} exceeded ${overflow.limitBytes} bytes (observed ${overflow.observedBytes} bytes)`;
const message = `Internal error: native AGY output_overflow: ${detail}`;
const wire = (value: unknown) => `${JSON.stringify(value)}\n`;
afterEach(() => vi.useRealTimers());

it.each([
  ["ACP", () => new RequestError(-32603, message, { code: "output_overflow", overflow })],
  ["flattened native message", () => new Error(message)],
  ["native probe", () => new ProbeError("output_overflow", detail, overflow)],
] as const)("%s overflow stops controller recovery immediately with its real size", async (_shape, cause) => {
  const error = cause();
  const classification = classifyAndAttach(error, classifyAgyError(error));
  expect(classification).toMatchObject({ agentId: "agy", errorKind: "output_overflow" });
  expect(error.message).toContain(detail);
  expect(providerRetryBackoff(classification.errorKind)).toBeUndefined();
  expect(providerRetryWindow(classification.errorKind)).toBeUndefined();
  expect(DEFAULT_REMOTE_RUNG1_POLICY.retryableErrorKinds).not.toContain(classification.errorKind);
  for (const scope of ["conversation", "ephemeral"] as const) {
    const verdict = resolveError(classification, DEFAULT_ERROR_RULES);
    expect(verdict).toMatchObject({ action: "stop", transience: "terminal", startRung: 5 });
    const directive = buildRecoveryDirective(verdict, scope);
    expect(directive.steps).toEqual([{ rung: 5, retryCount: 0, backoffMs: [], optionIds: [] }]);
    const run = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn();
    const onRetry = vi.fn();
    await expect(runBoundedRecovery({ run, sleep, onRetry,
      windowMs: () => providerRetryWindow(classification.errorKind),
      delays: () => directive.steps.find(step => step.rung === 1)?.backoffMs ?? [],
    })).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
  }
});

function bridge() {
  const writes: string[] = [];
  const results: unknown[] = [];
  const output: string[] = [];
  const recovery = createRung1Recovery({
    policyFor: () => DEFAULT_REMOTE_RUNG1_POLICY, agentId: "agy",
    classify: (_slot, error) => classifyAgyError(error).errorKind,
    write: (_slot, value) => { writes.push(value); return true; },
    publishSnapshot: () => {}, publishResult: (_slot, value) => results.push(value),
    publishOutput: (_slot, value) => output.push(value), now: Date.now,
  });
  recovery.arm(4, { submissionId: "overflow-proof", acpSessionId: "retained-session", continuation: "continue" });
  recovery.observeInput(4, wire({ id: 17, method: "session/prompt", params: {
    sessionId: "retained-session", prompt: [{ type: "text", text: "original brief" }],
  } }));
  return { recovery, writes, results, output };
}

it("does not replenish overflow retries during acquisition, including wrapped causes", () => {
  const error = new RequestError(-32603, message, { code: "output_overflow", overflow });
  classifyAndAttach(error, classifyAgyError(error));
  expect(isRetryableBootAcquisitionError(error)).toBe(false);
  expect(isRetryableBootAcquisitionError(new Error("acquisition failed", { cause: error }))).toBe(false);
});

it("forwards native overflow once without a bridge retry or a 30-minute wait", async () => {
  vi.useFakeTimers();
  const h = bridge();
  const response = wire({ id: 17, error: { code: -32603, message, data: { code: "output_overflow", overflow } } });
  expect(h.recovery.observeOutput(4, response).forward).toBe(response);
  expect(h.results).toEqual([expect.objectContaining({ status: "failed", errorKind: "output_overflow", error: message })]);
  expect(h.recovery.snapshot(4)?.retry).toBe(0);
  await vi.advanceTimersByTimeAsync(PROVIDER_RETRY_WINDOW_MS);
  expect(h.writes).toEqual([]);
  expect(h.output).toEqual([]);
  expect(h.results).toHaveLength(1);
});

it("keeps ordinary native protocol_error on the existing same-session provider schedule", async () => {
  vi.useFakeTimers();
  const error = new RequestError(-32603, "Internal error: native AGY protocol_error", { code: "protocol_error" });
  const kind = classifyAgyError(error).errorKind;
  expect(kind).toBe("protocol_error");
  expect(providerRetryWindow(kind)).toBe(PROVIDER_RETRY_WINDOW_MS);
  expect(providerRetryBackoff(kind)).toEqual([10_000, 30_000, 120_000, 300_000, 420_000]);
  expect(buildRecoveryDirective(resolveError({ errorKind: kind, agentId: "agy" }, DEFAULT_ERROR_RULES), "conversation")
    .steps[0]).toMatchObject({ rung: 1, retryCount: 5, backoffMs: providerRetryBackoff(kind) });
  const h = bridge();
  expect(h.recovery.observeOutput(4, wire({ id: 17, error: { code: -32603, message: error.message, data: error.data } }))
    .forward).toBeNull();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(h.writes).toHaveLength(1);
  const retry = JSON.parse(h.writes[0]!);
  expect(retry.params).toEqual({ sessionId: "retained-session", prompt: [{ type: "text", text: "continue" }] });
  h.recovery.observeOutput(4, wire({ id: retry.id, result: { stopReason: "end_turn" } }));
  expect(h.results).toEqual([expect.objectContaining({ status: "completed" })]);
});

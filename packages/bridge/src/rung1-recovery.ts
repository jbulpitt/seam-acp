import { randomUUID } from "node:crypto";
import {
  remoteRung1KindBackoff,
  type AdapterErrorKind,
  type RemoteRecoveryResult,
  type RemoteRecoverySnapshot,
  type RemoteRung1Policy,
} from "@seam/adapters";

const MAX_RESULT_CHARS = 2 * 1024 * 1024;

interface JsonRpcRecord extends Record<string, unknown> {
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface ArmedRecovery {
  submissionId: string;
  acpSessionId: string;
  continuation: string;
  policy: RemoteRung1Policy;
  originalRequestId?: string | number;
  activeRequestId?: string | number;
  retry: number;
  /** Retries already spent per kind; indexes `backoffMsByKind` (#626). */
  kindRetries: Map<AdapterErrorKind, number>;
  text: string;
  result?: RemoteRecoveryResult;
  terminal: boolean;
  resultLimitExceeded: boolean;
  inputObserved: boolean;
  snapshot: RemoteRecoverySnapshot;
  timer?: ReturnType<typeof setTimeout>;
}

export interface Rung1RecoveryHooks {
  policyFor(slot: number): RemoteRung1Policy | undefined;
  classify(slot: number, error: unknown): AdapterErrorKind;
  write(slot: number, line: string): boolean;
  publishSnapshot(slot: number, snapshot: RemoteRecoverySnapshot): void;
  publishResult(slot: number, result: RemoteRecoveryResult): void;
  controllerConnected(): boolean;
  now?: () => number;
}

export interface Rung1OutputDecision {
  /** Null means this terminal frame was consumed while bridge recovery continues. */
  forward: string | null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseLine(line: string): JsonRpcRecord | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return record(value) as JsonRpcRecord | undefined;
  } catch {
    return undefined;
  }
}

function textChunk(message: JsonRpcRecord, sessionId: string): string | undefined {
  if (message.method !== "session/update") return undefined;
  const params = record(message.params);
  if (params?.sessionId !== sessionId) return undefined;
  const update = record(params.update);
  if (update?.sessionUpdate !== "agent_message_chunk") return undefined;
  const content = record(update.content);
  return content?.type === "text" && typeof content.text === "string"
    ? content.text
    : undefined;
}

function terminalFor(message: JsonRpcRecord, id: string | number | undefined): boolean {
  return id !== undefined && message.id === id && ("result" in message || "error" in message);
}

function stopReason(message: JsonRpcRecord): string | undefined {
  const result = record(message.result);
  return typeof result?.stopReason === "string" ? result.stopReason : undefined;
}

function errorForClassification(message: JsonRpcRecord): Error {
  const raw = record(message.error);
  const err = Object.assign(new Error(typeof raw?.message === "string" ? raw.message : "ACP request failed"), {
    ...(raw && "code" in raw ? { code: raw.code } : {}),
    ...(raw && "data" in raw ? { data: raw.data } : {}),
  });
  return err;
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
}

/**
 * Narrow bridge-side rung-1 owner (#467).
 *
 * It observes only the armed `session/prompt`, retries only the same child and
 * session with caller-supplied continuation text, and rewrites its own terminal
 * response back to the original request id. It never persists or replays the
 * original prompt and never handles permissions, elicitation, cancellation,
 * model selection, or session replacement.
 */
export function createRung1Recovery(hooks: Rung1RecoveryHooks) {
  const armed = new Map<number, ArmedRecovery>();
  const now = hooks.now ?? Date.now;

  const publish = (slot: number, state: ArmedRecovery, patch: Partial<RemoteRecoverySnapshot>): void => {
    state.snapshot = {
      ...state.snapshot,
      ...patch,
      retry: state.retry,
      remaining: Math.max(0, state.policy.retryCount - state.retry),
      updatedUtc: new Date(now()).toISOString(),
    };
    hooks.publishSnapshot(slot, { ...state.snapshot });
  };

  const finish = (
    slot: number,
    state: ArmedRecovery,
    status: RemoteRecoveryResult["status"],
    patch: Pick<RemoteRecoverySnapshot, "phase" | "terminalReason"> &
      Partial<Pick<RemoteRecoverySnapshot, "errorKind">>,
    reason?: string,
  ): void => {
    if (state.timer) clearTimeout(state.timer);
    publish(slot, state, { ...patch, disposition: "none" });
    state.result = {
      version: 1,
      submissionId: state.submissionId,
      acpSessionId: state.acpSessionId,
      status,
      text: state.text,
      ...(reason ? { stopReason: reason } : {}),
      ...(patch.errorKind ? { errorKind: patch.errorKind } : {}),
      finishedUtc: new Date(now()).toISOString(),
    };
    state.terminal = true;
    hooks.publishResult(slot, { ...state.result });
  };

  /** False when no retry is left for this kind; the caller then finishes the
   * recovery AND forwards the error. A per-kind schedule can end before the
   * overall budget (#626), and swallowing that error would hang the turn. */
  const scheduleContinuation = (
    slot: number,
    state: ArmedRecovery,
    kind: AdapterErrorKind,
  ): boolean => {
    const kindSchedule = remoteRung1KindBackoff(state.policy, kind);
    const kindRetry = state.kindRetries.get(kind) ?? 0;
    const delay = kindSchedule ? kindSchedule[kindRetry] : state.policy.backoffMs[state.retry];
    if (delay === undefined || !state.policy.retryableErrorKinds.includes(kind)) return false;
    state.retry += 1;
    state.kindRetries.set(kind, kindRetry + 1);
    publish(slot, state, {
      phase: "backoff",
      disposition: "continue_same_session",
      errorKind: kind,
    });
    state.timer = setTimeout(() => {
      state.timer = undefined;
      const requestId = `seam-r1-${randomUUID()}`;
      state.activeRequestId = requestId;
      publish(slot, state, {
        phase: "retrying",
        disposition: "continue_same_session",
        errorKind: kind,
      });
      const line = `${JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method: "session/prompt",
        params: {
          sessionId: state.acpSessionId,
          prompt: [{ type: "text", text: state.continuation }],
        },
      })}\n`;
      if (!hooks.write(slot, line)) {
        finish(slot, state, "failed", {
          phase: "awaiting_app",
          terminalReason: "client_request_requires_app",
          errorKind: "connection_closed",
        });
      }
    }, delay);
    state.timer.unref?.();
    return true;
  };

  return {
    arm(slot: number, input: {
      submissionId: unknown;
      acpSessionId: unknown;
      continuation: unknown;
    }): RemoteRecoverySnapshot {
      const policy = hooks.policyFor(slot);
      if (!policy) throw new Error("rung-1 recovery is not configured for this slot");
      if (!validOpaqueId(input.submissionId)) throw new Error("rung-1 recovery requires an opaque submission id");
      if (typeof input.acpSessionId !== "string" || !input.acpSessionId) {
        throw new Error("rung-1 recovery requires an ACP session id");
      }
      if (typeof input.continuation !== "string" || !input.continuation.trim() || input.continuation.length > 8_192) {
        throw new Error("rung-1 recovery requires bounded continuation text");
      }
      const previous = armed.get(slot);
      if (previous && !previous.terminal) {
        throw new Error("rung-1 recovery already owns this slot submission");
      }
      const snapshot: RemoteRecoverySnapshot = {
        version: 1,
        owner: "bridge",
        submissionId: input.submissionId,
        acpSessionId: input.acpSessionId,
        rung: 1,
        phase: "armed",
        retry: 0,
        budget: policy.retryCount,
        remaining: policy.retryCount,
        disposition: "none",
        updatedUtc: new Date(now()).toISOString(),
      };
      const state: ArmedRecovery = {
        submissionId: input.submissionId,
        acpSessionId: input.acpSessionId,
        continuation: input.continuation,
        policy,
        retry: 0,
        kindRetries: new Map(),
        text: "",
        terminal: false,
        resultLimitExceeded: false,
        inputObserved: false,
        snapshot,
      };
      armed.set(slot, state);
      hooks.publishSnapshot(slot, { ...snapshot });
      return snapshot;
    },

    observeInputBytes(slot: number): void {
      const state = armed.get(slot);
      if (state && !state.terminal) state.inputObserved = true;
    },

    observeInput(slot: number, line: string): void {
      const state = armed.get(slot);
      if (!state || state.terminal) return;
      state.inputObserved = true;
      const message = parseLine(line);
      const params = message && record(message.params);
      if (message?.method === "session/cancel" && params?.sessionId === state.acpSessionId) {
        finish(slot, state, "failed", {
          phase: "exhausted",
          terminalReason: "cancelled",
          errorKind: "cancelled",
        });
        return;
      }
      if (state.originalRequestId !== undefined) return;
      if (message?.method !== "session/prompt" || params?.sessionId !== state.acpSessionId
        || (typeof message.id !== "string" && typeof message.id !== "number")) return;
      state.originalRequestId = message.id;
      state.activeRequestId = message.id;
      publish(slot, state, { phase: "executing", disposition: "none" });
    },

    observeOutput(slot: number, line: string): Rung1OutputDecision {
      const state = armed.get(slot);
      if (!state || state.terminal) return { forward: line };
      const message = parseLine(line);
      if (!message) return { forward: line };

      const chunk = textChunk(message, state.acpSessionId);
      if (chunk !== undefined) {
        if (state.text.length + chunk.length <= MAX_RESULT_CHARS) state.text += chunk;
        else state.resultLimitExceeded = true;
        return { forward: line };
      }

      // A child-to-client request while the controller is absent requires app
      // policy. Refuse this recovery only; the child and every other slot stay
      // alive, and the request remains in the output log for inspection.
      if (message.method && message.id !== undefined && !hooks.controllerConnected()) {
        publish(slot, state, {
          phase: "awaiting_app",
          disposition: "none",
          terminalReason: "client_request_requires_app",
        });
        return { forward: line };
      }

      if (!terminalFor(message, state.activeRequestId)) return { forward: line };
      const wasRetry = state.activeRequestId !== state.originalRequestId;
      if ("result" in message) {
        if (state.resultLimitExceeded) {
          finish(slot, state, "failed", {
            phase: "exhausted",
            terminalReason: "result_limit_exceeded",
            errorKind: "protocol_error",
          });
        } else {
          finish(slot, state, "completed", {
            phase: "succeeded",
            terminalReason: "completed",
          }, stopReason(message));
        }
        return {
          forward: wasRetry
            ? `${JSON.stringify({ ...message, id: state.originalRequestId })}\n`
            : line,
        };
      }

      const kind = hooks.classify(slot, errorForClassification(message));
      const shouldRetry = state.retry < state.policy.retryCount
        && state.policy.retryableErrorKinds.includes(kind);
      if (shouldRetry && scheduleContinuation(slot, state, kind)) return { forward: null };
      finish(slot, state, "failed", {
        phase: "exhausted",
        terminalReason: "budget_exhausted",
        errorKind: kind,
      });
      return {
        forward: wasRetry
          ? `${JSON.stringify({ ...message, id: state.originalRequestId })}\n`
          : line,
      };
    },

    snapshot(slot: number): RemoteRecoverySnapshot | undefined {
      const value = armed.get(slot)?.snapshot;
      return value ? { ...value } : undefined;
    },

    terminalResult(slot: number): RemoteRecoveryResult | undefined {
      const value = armed.get(slot)?.result;
      return value ? { ...value } : undefined;
    },

    snapshots(): Array<{ slot: number; recovery: RemoteRecoverySnapshot }> {
      return [...armed.entries()].map(([slot, state]) => ({
        slot,
        recovery: { ...state.snapshot },
      }));
    },

    childExited(slot: number): void {
      const state = armed.get(slot);
      if (!state || state.terminal) return;
      finish(slot, state, "failed", {
        phase: "exhausted",
        terminalReason: "child_exited",
        errorKind: "connection_closed",
      });
    },

    disarm(slot: number, submissionId: unknown): boolean {
      const state = armed.get(slot);
      // Once bytes were observed this bridge is the sole owner. A controller
      // may undo only an arm whose durable ledger write failed before send.
      if (!state || state.terminal || state.submissionId !== submissionId
        || state.inputObserved) return false;
      if (state.timer) clearTimeout(state.timer);
      armed.delete(slot);
      return true;
    },

    drop(slot: number): void {
      const state = armed.get(slot);
      if (state?.timer) clearTimeout(state.timer);
      armed.delete(slot);
    },
  };
}

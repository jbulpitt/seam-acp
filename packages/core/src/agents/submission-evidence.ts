import { randomUUID } from "node:crypto";
import type { AdapterErrorKind } from "@seam/adapters";
import type { Stream } from "@agentclientprotocol/sdk";

/** #536: one submission is one call, not the logical turn and not its retry
 * announcement. Stored only in turn_attempts.runtime_json. No text, argv,
 * exception messages, tool arguments or SDK envelopes belong in this type. */
export interface SubmissionEvidence {
  id: string;
  revision: number;
  intendedUtc: string;
  acpSessionId: string | null;
  adapterId: string | null;
  phase: "intent" | "rpc_invoked" | "local_write_started" | "local_write_completed";
  rpcInvokedUtc?: string;
  localWriteStartedUtc?: string;
  localWriteCompletedUtc?: string;
  /** A mux write can merely enqueue bytes. It is not a provider receipt. */
  transportScope: "controller_to_local_transport";
  acceptance: {
    state: "unknown" | "not_accepted";
    scope: "provider_submission";
    reason: "no_correlated_provider_ack" | "rpc_never_invoked";
  };
  billing: "unknown";
  observedUpdateTypes: string[];
  observedUpdateCorrelation: "active_session_window";
  /** These are session-window observations, NOT submission-correlated acks.
   * Retain count + last identity rather than unbounded raw stream history. */
  providerMessage: {
    state: "unknown" | "accepted";
    scope: "provider_message_started";
    correlation: "active_session_window";
    observations: number;
    lastId?: string;
  };
  wrapperCommand: {
    scope: "claude_wrapper_command_lifecycle";
    correlation: "active_session_window";
    observations: number;
    lastId?: string;
    lastState?: "queued" | "started" | "completed" | "cancelled" | "discarded" | "refused";
  };
  failure?: { kind: AdapterErrorKind };
  retry?: { number: number; delayMs: number; mode: "continue" | "resend"; previousSubmissionId: string };
  outcome: "unknown" | "completed" | "cancelled" | "failed" | "not_sent";
  finishedUtc?: string;
}

export function newSubmissionEvidence(acpSessionId: string | null,
  retry?: SubmissionEvidence["retry"]): SubmissionEvidence {
  return {
    id: randomUUID(), revision: 0, intendedUtc: new Date().toISOString(), acpSessionId, adapterId: null,
    phase: "intent", transportScope: "controller_to_local_transport",
    acceptance: { state: "unknown", scope: "provider_submission", reason: "no_correlated_provider_ack" },
    billing: "unknown", observedUpdateTypes: [], observedUpdateCorrelation: "active_session_window",
    providerMessage: { state: "unknown", scope: "provider_message_started", correlation: "active_session_window", observations: 0 },
    wrapperCommand: { scope: "claude_wrapper_command_lifecycle", correlation: "active_session_window", observations: 0 },
    ...(retry ? { retry } : {}), outcome: "unknown",
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function opaqueId(value: unknown): value is string {
  // Refuse only unusable telemetry IDs, never the turn. Real wrapper UUIDs and
  // provider message IDs fit this shape; URLs/paths/diagnostics must not persist.
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
}

/** Whitelist the supported feed at ingress. A raw SDK event may contain the
 * entire prompt/answer; neither that envelope nor unknown fields escape. */
export function observeClaudeSubmission(evidence: SubmissionEvidence, raw: unknown): boolean {
  const params = record(raw);
  if (params?.sessionId !== evidence.acpSessionId) return false;
  const message = record(params.message);
  if (message?.type === "command_lifecycle" && opaqueId(message.command_uuid)
    && ["queued", "started", "completed", "cancelled", "discarded", "refused"].includes(String(message.state))) {
    evidence.wrapperCommand.observations++;
    evidence.wrapperCommand.lastId = message.command_uuid;
    evidence.wrapperCommand.lastState = message.state as SubmissionEvidence["wrapperCommand"]["lastState"];
    return true;
  }
  const event = record(message?.event);
  const started = record(event?.message);
  if (message?.type === "stream_event" && message.parent_tool_use_id === null
    && event?.type === "message_start" && opaqueId(started?.id)
    && typeof started?.model === "string" && started.model !== "<synthetic>") {
    evidence.providerMessage.state = "accepted";
    evidence.providerMessage.observations++;
    evidence.providerMessage.lastId = started.id;
    return true;
  }
  return false;
}

/** Observe the existing transport without changing messages or retries. Match
 * the ORIGINAL request params, not the currently active submission: the SDK's
 * outbound queue can write an old request after recovery has moved on. Capture
 * before awaiting write, too. Neither local boundary proves remote acceptance. */
export function observePromptWrites(
  stream: Stream,
  observer: (params: object) => ((phase: "local_write_started" | "local_write_completed") => Promise<void>) | undefined,
): Stream {
  const writer = stream.writable.getWriter();
  return { readable: stream.readable, writable: new WritableStream({
    async write(frame) {
      const params = "method" in frame && frame.method === "session/prompt" ? record(frame.params) : undefined;
      const observe = params ? observer(params) : undefined;
      await observe?.("local_write_started");
      await writer.write(frame);
      await observe?.("local_write_completed");
    },
    close: () => writer.close(),
    abort: reason => writer.abort(reason),
  }) };
}

/**
 * Structured adapter error classification (#440).
 *
 * Ownership: if the resolver cannot decide, **this adapter under-reported**.
 * That makes unclassified-error rate a per-agent metric, not a vague systemic
 * quality concern. `errorKind: "unclassified"` is the adapter saying it did
 * not recognise a shape it owns — never a licence for downstream to regex the
 * English message.
 *
 * `errorKind` was previously consumed in the orchestrator (`data.errorKind ===
 * "rate_limit"`) and produced nowhere. The only structured check in the error
 * path was dead code; classification fell through to regex-on-English 100% of
 * the time. A captured provider failure arrived as `DispatchTurnError` with
 * `data: null`, the expired OAuth reason flattened into the message before
 * anything could read it.
 *
 * Adapters attach the classification to `error.data` so downstream reads a
 * field. Prefer structured fields (`data.errorKind`, `data.code`, HTTP status,
 * exit code/signal) over message text. Agent-specific wording is parsed here,
 * at the adapter boundary, from shapes those agents actually emitted.
 */

export const ADAPTER_ERROR_KINDS = [
  "rate_limit",
  "quota_exhausted",
  "auth_expired",
  "auth_contention",
  "auth_required",
  "permission_denied",
  "session_gone",
  "connection_closed",
  "protocol_error",
  "agent_exit",
  "host_oom",
  "overloaded",
  "invalid_request",
  "context_length",
  "model_not_found",
  "capability_absent",
  "server_error",
  "timeout",
  "cancelled",
  "unclassified",
] as const;

export type AdapterErrorKind = (typeof ADAPTER_ERROR_KINDS)[number];

const KIND_SET: ReadonlySet<string> = new Set(ADAPTER_ERROR_KINDS);

export function isAdapterErrorKind(value: unknown): value is AdapterErrorKind {
  return typeof value === "string" && KIND_SET.has(value);
}

/**
 * What an adapter reports about one failure. `agentId` is load-bearing: the
 * unclassified rate is counted per adapter, so a missing agent id would put
 * the metric back on a systemic bucket this module exists to retire.
 *
 * `exitCode` and `signal` are always present when `errorKind` is `agent_exit`,
 * including when both are null. Grok dying of SIGILL and a clean exit are
 * otherwise indistinguishable; that pair is the field classification keys on.
 */
export interface AdapterErrorClassification {
  errorKind: AdapterErrorKind;
  agentId: string;
  exitCode?: number | null;
  signal?: string | null;
  /** Original ACP/provider kind when we remapped it. */
  sourceKind?: string;
  details?: string;
}

export interface ClassifyContext {
  agentId: string;
  message: string;
  /** Lower-cased concatenation of message, workerError, output, and data text. */
  haystack: string;
  data: Record<string, unknown> | null;
  /** `ProbeError.code` / JSON-RPC `code` / `data.code` — not a process exit code. */
  errorCode: unknown;
  exit: { exitCode: number | null; signal: string | null } | null;
}

/** Pull the JSON-RPC `data` object off RequestError, DispatchTurnError, or a log record. */
export function errorData(error: unknown): Record<string, unknown> | null {
  if (!error || typeof error !== "object") return null;
  const raw = (error as { data?: unknown }).data;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const rec = error as { message?: unknown; msg?: unknown };
    if (typeof rec.message === "string") return rec.message;
    if (typeof rec.msg === "string") return rec.msg;
  }
  return "";
}

function textFrom(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/**
 * Flatten the fields a wrapped failure still carries after DispatchTurnError
 * strips `data`. Worker output is where Codex put the usage-limit reason
 * while the error message collapsed to "Internal error".
 */
export function errorHaystack(error: unknown): string {
  const rec = error && typeof error === "object" ? (error as Record<string, unknown>) : null;
  const data = errorData(error);
  const parts = [
    errorMessage(error),
    textFrom(rec?.workerError),
    textFrom(rec?.output),
    textFrom(rec?.detail),
    textFrom(data?.details),
    textFrom(data?.message),
    textFrom(data?.code),
    textFrom(data?.errorKind),
    textFrom(data?.streamCode),
    textFrom(data?.streamMessage),
  ];
  return parts.filter(Boolean).join("\n").toLowerCase();
}

const EXIT_IN_MESSAGE =
  /(?:exited(?: mid-turn| before initialize| before billing)?|exited_early)[^\n]*\(code=([^,]*), signal=([^)]*)\)/i;

function parseExitToken(raw: string): number | string | null {
  const token = raw.trim();
  if (!token || token === "null" || token === "undefined" || token === "none") return null;
  if (/^-?\d+$/.test(token)) return Number(token);
  return token;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/** Child-process exit codes are 0–255. JSON-RPC `code` is -32xxx and must not be read as one. */
function asProcessExitCode(value: unknown): number | null {
  const n = asNumber(value);
  if (n == null || n < 0 || n > 255) return null;
  return n;
}

function asSignal(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const token = value.trim();
    if (!token || token === "null" || token === "undefined" || token === "none") return null;
    return token;
  }
  return null;
}

/**
 * Exit cause from structured fields first, then from the message the runtime
 * still interpolates (`code=${code}, signal=${signal}`). Returning null means
 * this is not an exit-shaped error, not that the cause is unknown. An
 * exit-shaped error with both fields missing returns `{ exitCode: null, signal: null }`.
 */
export function parseExitCause(error: unknown): { exitCode: number | null; signal: string | null } | null {
  const rec = error && typeof error === "object" ? (error as Record<string, unknown>) : null;
  const data = errorData(error);
  const fromMessage = EXIT_IN_MESSAGE.exec(errorMessage(error));
  if (fromMessage) {
    const parsedCode = parseExitToken(fromMessage[1] ?? "");
    const parsedSignal = parseExitToken(fromMessage[2] ?? "");
    return {
      exitCode: typeof parsedCode === "number" ? parsedCode : null,
      signal: typeof parsedSignal === "string" ? parsedSignal : null,
    };
  }

  const logMsg = rec && typeof rec.msg === "string" ? rec.msg : "";
  if (logMsg === "agent process exited" || logMsg === "agent process exited abnormally") {
    return {
      exitCode: asProcessExitCode(rec?.code ?? rec?.exitCode),
      signal: asSignal(rec?.signal),
    };
  }
  if (rec && ("exitCode" in rec || (data != null && "exitCode" in data))) {
    return {
      exitCode: asProcessExitCode(rec.exitCode ?? data?.exitCode),
      signal: asSignal(rec.signal ?? data?.signal),
    };
  }
  return null;
}

export function readErrorClassification(error: unknown): AdapterErrorClassification | null {
  const data = errorData(error);
  if (!data || !isAdapterErrorKind(data.errorKind) || typeof data.agentId !== "string" || !data.agentId) {
    return null;
  }
  const classification: AdapterErrorClassification = {
    errorKind: data.errorKind,
    agentId: data.agentId,
  };
  if ("exitCode" in data) classification.exitCode = asProcessExitCode(data.exitCode);
  if ("signal" in data) classification.signal = asSignal(data.signal);
  if (typeof data.sourceKind === "string" && data.sourceKind) classification.sourceKind = data.sourceKind;
  if (typeof data.details === "string" && data.details) classification.details = data.details;
  return classification;
}

/**
 * Attach the classification onto `error.data` so `err.data.errorKind` is a
 * real field. Copies any existing data rather than dropping `details`/`code`
 * the agent already set. DispatchTurnError has no `data` today; this is what
 * gives the wrapper a field downstream can read.
 */
export function attachErrorClassification(
  error: object,
  classification: AdapterErrorClassification,
): AdapterErrorClassification {
  const prev = errorData(error) ?? {};
  const data: Record<string, unknown> = { ...prev, errorKind: classification.errorKind, agentId: classification.agentId };
  if (classification.errorKind === "agent_exit") {
    data.exitCode = classification.exitCode ?? null;
    data.signal = classification.signal ?? null;
  } else {
    if (classification.exitCode !== undefined) data.exitCode = classification.exitCode;
    if (classification.signal !== undefined) data.signal = classification.signal;
  }
  if (classification.sourceKind) data.sourceKind = classification.sourceKind;
  if (classification.details) data.details = classification.details;
  (error as { data: Record<string, unknown> }).data = data;
  return classification;
}

export function classifyAndAttach(
  error: unknown,
  classification: AdapterErrorClassification,
): AdapterErrorClassification {
  if (error && typeof error === "object") attachErrorClassification(error, classification);
  return classification;
}

export function unclassified(agentId: string, details?: string): AdapterErrorClassification {
  return details
    ? { errorKind: "unclassified", agentId, details }
    : { errorKind: "unclassified", agentId };
}

export function classified(
  agentId: string,
  errorKind: AdapterErrorKind,
  extra: Omit<AdapterErrorClassification, "errorKind" | "agentId"> = {},
): AdapterErrorClassification {
  const result: AdapterErrorClassification = { errorKind, agentId };
  if (errorKind === "agent_exit") {
    result.exitCode = extra.exitCode ?? null;
    result.signal = extra.signal ?? null;
  } else {
    if (extra.exitCode !== undefined) result.exitCode = extra.exitCode;
    if (extra.signal !== undefined) result.signal = extra.signal;
  }
  if (extra.sourceKind) result.sourceKind = extra.sourceKind;
  if (extra.details) result.details = extra.details;
  return result;
}

/**
 * Payload for `RequestError.invalidParams` / `internalError`. Always includes
 * `errorKind` and `agentId` so the live ACP path produces the field the
 * orchestrator already consumes.
 */
export function classifiedErrorData(
  agentId: string,
  errorKind: AdapterErrorKind,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { errorKind, agentId, ...extra };
}

export function classifyContext(agentId: string, error: unknown): ClassifyContext {
  const data = errorData(error);
  const rec = error && typeof error === "object" ? (error as { code?: unknown }) : null;
  return {
    agentId,
    message: errorMessage(error),
    haystack: errorHaystack(error),
    data,
    errorCode: rec?.code ?? data?.code,
    exit: parseExitCause(error),
  };
}

const HTTP_STATUS_KEYS = ["http_status", "httpStatus", "status", "statusCode"] as const;

export function httpStatusOf(ctx: ClassifyContext): number | null {
  const rec = ctx.data;
  if (!rec) return null;
  for (const key of HTTP_STATUS_KEYS) {
    const code = asNumber(rec[key]);
    if (code != null && code >= 100 && code <= 599) return code;
  }
  const fromMessage = /\bstatus(?:\s+code)?\s+(\d{3})\b/i.exec(ctx.message);
  if (fromMessage) return Number(fromMessage[1]);
  return null;
}

function kindFromHttpStatus(status: number): AdapterErrorKind | null {
  if (status === 401) return "auth_required";
  if (status === 403) return "permission_denied";
  if (status === 404) return "model_not_found";
  if (status === 408 || status === 504) return "timeout";
  if (status === 413) return "invalid_request";
  if (status === 429) return "rate_limit";
  if (status === 503) return "overloaded";
  if (status === 529) return "overloaded";
  if (status >= 500) return "server_error";
  if (status >= 400) return "invalid_request";
  return null;
}

/**
 * Shapes produced by AgentRuntime / the probe helper for every agent, not by
 * a provider. These are still classified at the adapter boundary so the
 * resolver reads a field instead of the interpolated English.
 */
export function classifySharedRuntimeError(ctx: ClassifyContext): AdapterErrorClassification | null {
  const { haystack, message, agentId, exit } = ctx;

  if (/\bunknown rpc method:\s*describemodelcatalog\b/.test(haystack) ||
      /\brpc 'describemodelcatalog' timed out\b/.test(haystack)) {
    return classified(agentId, "capability_absent", { details: message });
  }

  if (/\bacp connection closed\b/.test(haystack)) {
    return classified(agentId, "connection_closed", { details: message });
  }

  if (/\bacp (?:initialize|session\/load) timed out\b/.test(haystack) ||
      ctx.errorCode === "session_load_timeout") {
    return classified(agentId, "timeout", { details: message });
  }

  if (exit || /\bagent process exited\b/.test(haystack) || /\bexited before billing\b/.test(haystack)) {
    if (exit || /\(code=/.test(message) || /\bagent process exited\b/.test(haystack)) {
      return classified(agentId, "agent_exit", {
        exitCode: exit?.exitCode ?? null,
        signal: exit?.signal ?? null,
        details: message,
      });
    }
  }

  const status = httpStatusOf(ctx);
  if (status != null) {
    const kind = kindFromHttpStatus(status);
    if (kind) return classified(agentId, kind, { details: message, sourceKind: String(status) });
  }

  return null;
}

export type AgentErrorMatcher = (ctx: ClassifyContext) => AdapterErrorClassification | AdapterErrorKind | null;

/**
 * Run agent-specific matchers first, then shared runtime shapes, then
 * unclassified. Returning unclassified is an adapter report, not a missing
 * default.
 */
export function classifyWith(
  agentId: string,
  error: unknown,
  matcher: AgentErrorMatcher,
): AdapterErrorClassification {
  const existing = readErrorClassification(error);
  if (existing && existing.agentId === agentId) return existing;

  const ctx = classifyContext(agentId, error);
  const matched = matcher(ctx);
  if (matched) {
    const result = typeof matched === "string" ? classified(agentId, matched, { details: ctx.message }) : matched;
    return result.agentId ? result : { ...result, agentId };
  }
  const shared = classifySharedRuntimeError(ctx);
  if (shared) return shared;
  return unclassified(agentId, ctx.message || undefined);
}

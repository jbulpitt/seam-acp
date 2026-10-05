import type { AdapterErrorKind, ClassifyContext } from "./error-classification.js";

export const SESSION_FAILURE_CAPABILITIES = Object.freeze({
  jetbrains: Object.freeze({ air: Object.freeze({ version: 1, capabilities: Object.freeze(["sessionFailure"]) }) }),
});

export interface SessionFailure {
  id: string;
  category: string;
  severity: "error" | "warning";
  title: string;
  details?: string;
  reason?: string;
  actions: string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function supportsSessionFailures(value: unknown): boolean {
  const air = record(record(record(record(value)?._meta)?.jetbrains)?.air);
  return Array.isArray(air?.capabilities) && air.capabilities.includes("sessionFailure");
}

export function readSessionFailure(value: unknown): SessionFailure | undefined {
  const meta = record(record(value)?._meta);
  const air = record(record(meta?.jetbrains)?.air);
  const failure = record(air?.sessionFailure);
  if (!failure || typeof failure.id !== "string" || typeof failure.category !== "string"
    || typeof failure.title !== "string" || !Array.isArray(failure.actions)
    || !failure.actions.every(action => typeof action === "string")
    || (failure.severity !== "error" && failure.severity !== "warning")) return undefined;
  return failure as unknown as SessionFailure;
}

export function providerResponse(text: string): Record<string, unknown> | undefined {
  try {
    const response = record(JSON.parse(text));
    const error = record(response?.error);
    return response?.type === "error" && typeof response.status === "number"
      && typeof error?.message === "string" && typeof error.type === "string" ? response : undefined;
  } catch { return undefined; }
}

export function sessionFailureError(value: unknown): (Error & { data: Record<string, unknown> }) | undefined {
  const failure = readSessionFailure(value);
  if (failure?.severity !== "error") return undefined;
  const response = providerResponse(failure.title) ?? providerResponse(failure.details ?? "");
  const provider = record(response?.error);
  const message = failure.details ? `${failure.title}\n${failure.details}` : failure.title;
  return Object.assign(new Error(message), { data: {
    sessionFailure: failure,
    ...(response ? { providerResponse: response, status: response.status, code: provider?.code } : {}),
  } });
}

export function classifySessionFailure(ctx: ClassifyContext): AdapterErrorKind | null {
  const failure = record(ctx.data?.sessionFailure);
  const actions = Array.isArray(failure?.actions) ? failure.actions : [];
  switch (failure?.category) {
    case "service": return actions.includes("retry") ? "server_error" : "unclassified";
    case "limit": return actions.includes("retry") ? "rate_limit"
      : actions.includes("new_session") && failure.reason !== "budget_exhausted" ? "context_length" : "quota_exhausted";
    case "access": return actions.includes("login") ? "auth_required" : "permission_denied";
    case "connection": return "connection_closed";
    case "request": return "invalid_request";
    default: return null;
  }
}

const CODEX_CAPACITY = "Selected model is at capacity. Please try a different model.";
const CODEX_ERROR_PREFIX = '{"type":"error"';

/** Legacy Codex emits these provider responses as the entire answer. */
export function codexReplyFailure(text: string): Error | undefined {
  const reply = text.trim();
  if (reply === CODEX_CAPACITY) return new Error(reply);
  const response = providerResponse(reply);
  if (!response) return undefined;
  return Object.assign(new Error(reply), { data: { providerResponse: response, status: response.status,
    code: record(response.error)?.code } });
}

/** Hold only a leading legacy error candidate; ordinary replies still stream. */
export class CodexReplyGate {
  private held = "";
  private streaming = false;

  push(text: string): string {
    if (this.streaming) return text;
    this.held += text;
    const prefix = this.held.trimStart();
    const jsonPrefix = prefix.replace(/\s/g, "");
    if (CODEX_CAPACITY.startsWith(prefix) || prefix.trimEnd() === CODEX_CAPACITY
      || CODEX_ERROR_PREFIX.startsWith(jsonPrefix) || jsonPrefix.startsWith(CODEX_ERROR_PREFIX)) return "";
    this.streaming = true;
    return this.flush();
  }

  failure(): Error | undefined { return this.streaming ? undefined : codexReplyFailure(this.held); }
  flush(): string { const text = this.held; this.held = ""; return text; }
}

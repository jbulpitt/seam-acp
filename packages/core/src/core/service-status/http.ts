import { SERVICE_STATUS_DEFAULTS } from "./types.js";

/**
 * Patterns for material that must never reach a log line, an error message, a
 * persisted `last_error`, or a test fixture. Google's public bootstrap API keys
 * are the concrete case (#182), but bearer tokens and `key=`/`token=` query
 * parameters are redacted for the same reason.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /AIza[0-9A-Za-z_-]{20,}/g,
  /\b(?:bearer|token|api[_-]?key)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /([?&](?:key|token|api_key|apikey|access_token)=)[^&\s"']+/gi,
];

export const REDACTED = "[redacted]";

/** Strip secrets and bound the length of any operator-visible message. */
export function sanitizeErrorMessage(message: string, maxLength = 300): string {
  let clean = message;
  for (const pattern of SECRET_PATTERNS) {
    clean = clean.replace(pattern, (match, prefix?: string) =>
      typeof prefix === "string" ? `${prefix}${REDACTED}` : REDACTED
    );
  }
  clean = clean.replace(/\s+/g, " ").trim();
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}…` : clean;
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return sanitizeErrorMessage(error.message || error.name);
  return sanitizeErrorMessage(String(error));
}

export class ServiceStatusFetchError extends Error {
  constructor(message: string) {
    super(sanitizeErrorMessage(message));
    this.name = "ServiceStatusFetchError";
  }
}

export interface BoundedFetchOptions {
  /** Operator-facing label used in errors instead of the raw URL. */
  label: string;
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /** Response content-type must match, or the read fails closed. */
  expectContentType: RegExp;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface BoundedFetchResult {
  text: string;
  status: number;
  contentType: string;
  bytes: number;
}

/**
 * A single bounded external read: hard timeout, byte cap enforced while
 * streaming (not just from `Content-Length`), status check, content-type check,
 * and sanitized errors. Every adapter goes through this — there is no other
 * network surface in the subsystem.
 */
export async function fetchBoundedText(options: BoundedFetchOptions): Promise<BoundedFetchResult> {
  const timeoutMs = options.timeoutMs ?? SERVICE_STATUS_DEFAULTS.fetchTimeoutMs;
  const maxBytes = options.maxBytes ?? SERVICE_STATUS_DEFAULTS.maxResponseBytes;
  const fetchImpl = options.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`${options.label}: timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;

  try {
    let response: Response;
    try {
      response = await fetchImpl(options.url, {
        method: options.method ?? "GET",
        headers: options.headers,
        body: options.body,
        redirect: "follow",
        signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ServiceStatusFetchError(`${options.label}: timed out after ${timeoutMs}ms`);
      }
      throw new ServiceStatusFetchError(`${options.label}: request failed — ${describeError(error)}`);
    }

    if (!response.ok) {
      throw new ServiceStatusFetchError(`${options.label}: HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!options.expectContentType.test(contentType)) {
      throw new ServiceStatusFetchError(
        `${options.label}: unexpected content-type ${JSON.stringify(contentType.slice(0, 80))}`
      );
    }

    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new ServiceStatusFetchError(
        `${options.label}: response too large (${declared} > ${maxBytes} bytes)`
      );
    }

    const text = await readBounded(response, options.label, maxBytes);
    return {
      text,
      status: response.status,
      contentType,
      bytes: Buffer.byteLength(text, "utf8"),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readBounded(response: Response, label: string, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) {
    // A fetch stub (or a HEAD-like response) may expose only `text()`.
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new ServiceStatusFetchError(`${label}: response exceeded ${maxBytes} bytes`);
    }
    return text;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new ServiceStatusFetchError(`${label}: response exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
    // The cap path leaves the body unread; cancelling frees the socket. It can
    // reject if the stream is already errored, which is not actionable here.
    void body.cancel().catch(() => {});
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

/** Parse JSON with a sanitized, source-labelled failure. */
export function parseJson(label: string, text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return failSchema(label, "response was not valid JSON");
  }
}

export class ServiceStatusSchemaError extends Error {
  constructor(message: string) {
    super(sanitizeErrorMessage(message));
    this.name = "ServiceStatusSchemaError";
  }
}

/** Fail closed on schema drift. Never returns. */
export function failSchema(label: string, reason: string): never {
  throw new ServiceStatusSchemaError(`${label}: ${reason}`);
}

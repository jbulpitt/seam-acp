import type { AdapterErrorKind } from "./error-classification.js";

export const PROVIDER_RETRY_WINDOW_MS = 30 * 60_000;
const BACKOFF = Object.freeze([10_000, 30_000, 120_000, 300_000, 420_000]);
const AUTH_CONTENTION_BACKOFF = Object.freeze([60_000, 60_000, 60_000]);
const QUOTA_BACKOFF = Object.freeze([300_000]);

export function providerRetryWindow(kind: AdapterErrorKind): number | undefined {
  switch (kind) {
    case "overloaded": case "server_error": case "rate_limit": case "timeout":
    case "protocol_error": case "unclassified": return PROVIDER_RETRY_WINDOW_MS;
    default: return undefined;
  }
}

export function providerRetryBackoff(kind: AdapterErrorKind): readonly number[] | undefined {
  switch (kind) {
    case "overloaded": case "server_error": case "rate_limit": case "timeout":
    case "protocol_error": case "unclassified": return BACKOFF;
    case "auth_contention": return AUTH_CONTENTION_BACKOFF;
    case "quota_exhausted": return QUOTA_BACKOFF;
    default: return undefined;
  }
}

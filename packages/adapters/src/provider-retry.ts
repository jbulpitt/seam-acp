import type { AdapterErrorKind } from "./error-classification.js";

export const PROVIDER_RETRY_WINDOW_MS = 15 * 60_000;
const BACKOFF = Object.freeze([10_000, 30_000, 120_000, 300_000, 420_000]);

export function providerRetryBackoff(kind: AdapterErrorKind): readonly number[] | undefined {
  return kind === "overloaded" || kind === "server_error" ? BACKOFF : undefined;
}

import { vi } from "vitest";
import { providerRetryBackoff } from "@seam/adapters";

/** Accelerate provider waits and their deadline together, without faking ACP I/O. */
export function fastProviderRetryClock(): void {
  const timeout = globalThis.setTimeout;
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const backoff = new Set([2_000, 5_000, 80_000,
    ...providerRetryBackoff("overloaded")!, ...providerRetryBackoff("auth_contention")!,
    ...providerRetryBackoff("quota_exhausted")!]);
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) =>
    backoff.has(ms ?? 0) ? timeout(() => { now += ms!; fn(); }, 0) : timeout(fn, ms)) as typeof setTimeout);
}

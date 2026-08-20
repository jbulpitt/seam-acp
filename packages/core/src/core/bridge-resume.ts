/**
 * #85 — resume a bridged turn on the SAME host, event-driven.
 *
 * A `@<bridge>` marker waits for that bridge's reconciliation "ready"
 * signal. Past the resume max-age window the turn is abandoned. A `@mac`
 * session is never rebound to `@local`.
 */
import type { BridgeHub } from "./bridge-hub.js";
import { isLocalLocation, normalizeLocation } from "./location.js";
import { isPastMaxAge } from "./dispatch/turn-resume.js";

export type BridgeResumeWait = "ready" | "timeout" | "local";

export function remainingMaxAgeMs(
  startedUtc: string,
  maxAgeSeconds: number,
  now: Date = new Date()
): number {
  if (maxAgeSeconds <= 0) return Number.POSITIVE_INFINITY;
  const then = Date.parse(startedUtc);
  if (Number.isNaN(then)) return 0;
  const ageMs = Math.max(0, now.getTime() - then);
  return Math.max(0, maxAgeSeconds * 1000 - ageMs);
}

/**
 * Wait until `bridgeId` has finished hello + prepare(), or until `deadlineMs`.
 * Local is always ready. Subscribes to the hub's ready event — no polling.
 */
export function waitUntilBridgeReady(
  hub: Pick<BridgeHub, "isBridgeReady" | "onBridgeReady">,
  location: string | undefined,
  opts: { deadlineMs: number }
): Promise<BridgeResumeWait> {
  const loc = normalizeLocation(location);
  if (isLocalLocation(loc)) return Promise.resolve("local");
  if (hub.isBridgeReady(loc)) return Promise.resolve("ready");
  if (opts.deadlineMs <= 0) return Promise.resolve("timeout");

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: BridgeResumeWait) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      resolve(result);
    };
    const off = hub.onBridgeReady((id) => {
      if (id === loc) finish("ready");
    });
    const timer = setTimeout(() => finish("timeout"), opts.deadlineMs);
    // Ready may have flipped between the pre-check and the subscribe.
    if (hub.isBridgeReady(loc)) finish("ready");
  });
}

export function resumeLocationOrAbandon(opts: {
  location: string | undefined;
  startedUtc: string;
  maxAgeSeconds: number;
  now?: Date;
}): { action: "proceed" | "abandon"; reason: string; location: string } {
  const location = normalizeLocation(opts.location);
  const now = opts.now ?? new Date();
  if (isPastMaxAge(opts.startedUtc, opts.maxAgeSeconds, now)) {
    return { action: "abandon", reason: "past max-age", location };
  }
  return { action: "proceed", reason: "ok", location };
}

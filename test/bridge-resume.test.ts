/**
 * #85 — resume same host. A @bridge marker waits for that bridge's ready
 * event (no busy-poll). Past max-age → abandon. Never reattach @mac on @local.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  remainingMaxAgeMs,
  resumeLocationOrAbandon,
  waitUntilBridgeReady,
} from "../packages/core/src/core/bridge-resume.js";
import type { BridgeHub } from "../packages/core/src/core/bridge-hub.js";
import { bindSessionLocation } from "../packages/core/src/core/location-bind.js";
import { isLocalLocation } from "../packages/core/src/core/location.js";

function fakeHub(opts?: {
  ready?: Set<string>;
  emitAfterMs?: { id: string; ms: number };
}): Pick<BridgeHub, "isBridgeReady" | "onBridgeReady" | "markSessionBridge"> & {
  bound: Map<string, string>;
} {
  const ready = opts?.ready ?? new Set<string>();
  const events = new EventEmitter();
  const bound = new Map<string, string>();
  if (opts?.emitAfterMs) {
    setTimeout(() => {
      ready.add(opts.emitAfterMs!.id);
      events.emit("ready", opts.emitAfterMs!.id);
    }, opts.emitAfterMs.ms);
  }
  return {
    bound,
    isBridgeReady: (id: string) => ready.has(id) || isLocalLocation(id),
    onBridgeReady: (listener: (bridgeId: string) => void) => {
      events.on("ready", listener);
      return () => {
        events.off("ready", listener);
      };
    },
    markSessionBridge: (sessionId: string, bridgeId: string) => {
      if (isLocalLocation(bridgeId)) bound.delete(sessionId);
      else bound.set(sessionId, bridgeId);
    },
  };
}

describe("resume same host (#85)", () => {
  it("local resume does not wait on a bridge", async () => {
    const hub = fakeHub();
    const result = await waitUntilBridgeReady(hub, "local", { deadlineMs: 1 });
    expect(result).toBe("local");
  });

  it("resume is deferred until the same bridge is ready (event, not poll)", async () => {
    const hub = fakeHub({ emitAfterMs: { id: "mac", ms: 40 } });
    const started = Date.now();
    const result = await waitUntilBridgeReady(hub, "mac", { deadlineMs: 1000 });
    expect(result).toBe("ready");
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
  });

  it("past max-age / deadline abandons instead of resuming", async () => {
    const hub = fakeHub(); // mac never becomes ready
    const result = await waitUntilBridgeReady(hub, "mac", { deadlineMs: 30 });
    expect(result).toBe("timeout");
    expect(
      resumeLocationOrAbandon({
        location: "mac",
        startedUtc: "2026-08-18T10:00:00.000Z",
        maxAgeSeconds: 7200,
        now: new Date("2026-08-18T14:00:00.000Z"),
      })
    ).toEqual({ action: "abandon", reason: "past max-age", location: "mac" });
  });

  it("never rebinds a @mac session onto @local", () => {
    const hub = fakeHub();
    bindSessionLocation(hub, "discord:thread-1", "mac");
    expect(hub.bound.get("discord:thread-1")).toBe("mac");
    // A resume on the same host keeps mac. Switching to local would unbind —
    // #85 forbids using that path for a @mac marker.
    expect(hub.bound.get("discord:thread-1")).not.toBe("local");
    expect(hub.bound.get("discord:thread-1")).not.toBeUndefined();
  });

  it("remainingMaxAgeMs hits zero after the window", () => {
    expect(
      remainingMaxAgeMs("2026-08-18T10:00:00.000Z", 7200, new Date("2026-08-18T14:00:00.000Z"))
    ).toBe(0);
    expect(
      remainingMaxAgeMs("2026-08-18T13:00:00.000Z", 7200, new Date("2026-08-18T14:00:00.000Z"))
    ).toBe(3600_000);
  });
});

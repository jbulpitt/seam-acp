import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  evaluateWatch,
  isCommandAllowed,
  type WatchCommandPolicy,
} from "../src/core/watch/evaluate.js";
import type { WatchEvent } from "../src/core/watch/types.js";

function makeWatch(over: Partial<WatchEvent> = {}): WatchEvent {
  return {
    id: "w",
    platform: "discord",
    channelRef: "t",
    parentRef: null,
    kind: "file",
    spec: "/tmp/x",
    match: null,
    intervalSeconds: 30,
    prompt: "p",
    reason: "",
    mode: "once",
    maxFires: 1,
    fireCount: 0,
    lastCheckedUtc: null,
    lastFiredUtc: null,
    lastObserved: null,
    expiresAtUtc: new Date(Date.now() + 3600_000).toISOString(),
    createdBy: "discord:t",
    correlationId: null,
    createdUtc: new Date().toISOString(),
    ...over,
  };
}

const OFF: WatchCommandPolicy = { enabled: false, allowlist: [] };

describe("evaluateWatch — file source (#60)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-watch-file-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("establishes a baseline on the first check without firing", async () => {
    const p = path.join(dir, "absent.txt");
    const r = await evaluateWatch(makeWatch({ kind: "file", spec: p, lastObserved: null }), OFF);
    expect(r.fired).toBe(false);
    expect(r.observed).toBe("absent");
  });

  it("fires when a watched file appears (absent → exists)", async () => {
    const p = path.join(dir, "build.done");
    const w = makeWatch({ kind: "file", spec: p, lastObserved: "absent" });
    fs.writeFileSync(p, "ok");
    const r = await evaluateWatch(w, OFF);
    expect(r.fired).toBe(true);
    expect(r.observed).toMatch(/^exists:/);
    expect(r.eventText).toContain("changed");
  });

  it("does not fire when the signature is unchanged", async () => {
    const p = path.join(dir, "steady.txt");
    fs.writeFileSync(p, "hello");
    const baseline = await evaluateWatch(makeWatch({ kind: "file", spec: p }), OFF);
    const again = await evaluateWatch(
      makeWatch({ kind: "file", spec: p, lastObserved: baseline.observed }),
      OFF
    );
    expect(again.fired).toBe(false);
  });
});

describe("evaluateWatch — http source (#60)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fires on a status match (match=status:200)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("body", { status: 200 })
    );
    const r = await evaluateWatch(
      makeWatch({ kind: "http", spec: "https://ci/x", match: "status:200" }),
      OFF
    );
    expect(r.fired).toBe(true);
    expect(r.eventText).toContain("status 200");
  });

  it("does not fire when the status does not match", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
    const r = await evaluateWatch(
      makeWatch({ kind: "http", spec: "https://ci/x", match: "status:200" }),
      OFF
    );
    expect(r.fired).toBe(false);
  });

  it("fires on a body regex match", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("status: SUCCESS", { status: 200 })
    );
    const r = await evaluateWatch(
      makeWatch({ kind: "http", spec: "https://ci/x", match: "SUCCESS|FAILED" }),
      OFF
    );
    expect(r.fired).toBe(true);
  });

  it("survives a transient request failure without firing (|| true)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const r = await evaluateWatch(
      makeWatch({ kind: "http", spec: "https://ci/x", match: "status:200", lastObserved: "status:500" }),
      OFF
    );
    expect(r.fired).toBe(false);
    expect(r.error).toBeDefined();
    // Keeps the prior snapshot so a blip doesn't reset change-detection.
    expect(r.observed).toBe("status:500");
  });

  it("default change-detection fires when status+length differs from the baseline", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("longer body now", { status: 200 }));
    const r = await evaluateWatch(
      makeWatch({ kind: "http", spec: "https://ci/x", match: null, lastObserved: "200:5" }),
      OFF
    );
    expect(r.fired).toBe(true);
  });
});

describe("evaluateWatch — command source (D8 guard, #60)", () => {
  it("isCommandAllowed is exact-match only (no prefix escape)", () => {
    const policy: WatchCommandPolicy = { enabled: true, allowlist: ["git status"] };
    expect(isCommandAllowed("git status", policy)).toBe(true);
    expect(isCommandAllowed("git status; rm -rf /", policy)).toBe(false);
    expect(isCommandAllowed("git", policy)).toBe(false);
  });

  it("REFUSES to run when the command flag is OFF", async () => {
    const r = await evaluateWatch(makeWatch({ kind: "command", spec: "echo hi" }), OFF);
    expect(r.fired).toBe(false);
    expect(r.refused).toMatch(/disabled/);
  });

  it("REFUSES to run a command that is not on the allowlist (flag on)", async () => {
    const policy: WatchCommandPolicy = { enabled: true, allowlist: ["echo other"] };
    const r = await evaluateWatch(makeWatch({ kind: "command", spec: "echo hi" }), policy);
    expect(r.fired).toBe(false);
    expect(r.refused).toMatch(/allowlist/);
  });

  it("runs an allowlisted command and fires on non-empty stdout", async () => {
    const policy: WatchCommandPolicy = { enabled: true, allowlist: ["echo fired-event"] };
    const r = await evaluateWatch(makeWatch({ kind: "command", spec: "echo fired-event" }), policy);
    expect(r.fired).toBe(true);
    expect(r.eventText).toBe("fired-event");
  });

  it("does not fire when an allowlisted command produces no stdout", async () => {
    const policy: WatchCommandPolicy = { enabled: true, allowlist: ["true"] };
    const r = await evaluateWatch(makeWatch({ kind: "command", spec: "true" }), policy);
    expect(r.fired).toBe(false);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import {
  WAKE_MIN_DELAY_SECONDS,
  WAKE_MAX_DELAY_SECONDS,
  WAKE_MAX_CHAIN_DEPTH,
  WAKE_MAX_PENDING_PER_THREAD,
} from "../packages/core/src/core/wake/types.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

let dir: string;
let store: SessionStore;
let orch: Orchestrator;

const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  id: "discord:thread-1",
  platform: "discord",
  channelRef: "thread-1",
  parentRef: "channel-1",
  agentId: "claude",
  acpSessionId: "acp-1",
  repoPath: "/repo",
  configJson: "{}",
  createdUtc: new Date().toISOString(),
  updatedUtc: new Date().toISOString(),
  ...over,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-wake-sched-"));
  store = new SessionStore(path.join(dir, "test.db"));
  // Only store/logger are exercised by scheduleWake/cancelWake/listWakes; the
  // adapter/router/renderer/config are unused on these paths, so stub them.
  // The constructor eagerly reads router.listProfiles() to seed the #58 P2/P3
  // config-mutation engine, so that one method must exist on the stub.
  orch = new Orchestrator({
    logger: silent,
    config: { DATA_DIR: dir } as any,
    adapter: {} as any,
    router: { listProfiles: () => [] } as any,
    store,
    renderer: {} as any,
  });
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("Orchestrator.scheduleWake guards (#59)", () => {
  it("arms a valid wake and persists it", () => {
    const res = orch.scheduleWake(record(), { delaySeconds: 1200, reason: "r", prompt: "p" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = store.getWake(res.wakeId)!;
    expect(row.channelRef).toBe("thread-1");
    expect(row.prompt).toBe("p");
    expect(row.chainDepth).toBe(0);
    // Fire time is ~delaySeconds in the future.
    expect(Date.parse(row.fireAtUtc) - Date.now()).toBeGreaterThan(1000 * 1000);
  });

  it("rejects a delay below the floor (D8)", () => {
    const res = orch.scheduleWake(record(), { delaySeconds: WAKE_MIN_DELAY_SECONDS - 1, reason: "", prompt: "p" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/floor/);
  });

  it("rejects a delay above the 7-day maximum (D14)", () => {
    const res = orch.scheduleWake(record(), { delaySeconds: WAKE_MAX_DELAY_SECONDS + 1, reason: "", prompt: "p" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/maximum/);
  });

  it("rejects an empty prompt", () => {
    const res = orch.scheduleWake(record(), { delaySeconds: 1200, reason: "", prompt: "   " });
    expect(res.ok).toBe(false);
  });

  it("enforces the per-thread pending cap (D8)", () => {
    for (let n = 0; n < WAKE_MAX_PENDING_PER_THREAD; n++) {
      expect(orch.scheduleWake(record(), { delaySeconds: 1200, reason: "", prompt: "p" }).ok).toBe(true);
    }
    const res = orch.scheduleWake(record(), { delaySeconds: 1200, reason: "", prompt: "p" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/pending wakes/);
  });

  it("inherits chain-depth+1 while a woken turn is active and trips the cap (D8)", () => {
    // Simulate being mid-woken-turn at the top of the cap.
    (orch as any).activeWakeDepth.set("thread-1", WAKE_MAX_CHAIN_DEPTH);
    const res = orch.scheduleWake(record(), { delaySeconds: 1200, reason: "", prompt: "p" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/chain-depth cap/);
  });

  it("nests depth by one when armed during a woken turn below the cap", () => {
    (orch as any).activeWakeDepth.set("thread-1", 2);
    const res = orch.scheduleWake(record(), { delaySeconds: 1200, reason: "", prompt: "p" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(store.getWake(res.wakeId)!.chainDepth).toBe(3);
  });

  it("cancelWake only removes the caller's own thread's wake (scope)", () => {
    const res = orch.scheduleWake(record(), { delaySeconds: 1200, reason: "", prompt: "p" });
    if (!res.ok) throw new Error("setup failed");
    // A different thread cannot cancel it.
    expect(orch.cancelWake(record({ channelRef: "thread-other", id: "discord:thread-other" }), res.wakeId)).toBe(false);
    expect(store.getWake(res.wakeId)).not.toBeNull();
    // The owning thread can.
    expect(orch.cancelWake(record(), res.wakeId)).toBe(true);
    expect(store.getWake(res.wakeId)).toBeNull();
  });

  // --- boot-triggered wakes (#59 extension) ---------------------------------

  it("onStartup=true persists fire_on_startup and ignores delaySeconds", () => {
    // delaySeconds far below the floor would normally reject; onStartup skips it.
    const res = orch.scheduleWake(record(), {
      delaySeconds: 1,
      reason: "resume after restart",
      prompt: "p",
      fireOnStartup: true,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = store.getWake(res.wakeId)!;
    expect(row.fireOnStartup).toBe(true);
    // It's excluded from the time sweep no matter what the clock says.
    expect(store.listDueWakes(new Date(Date.now() + 3600_000).toISOString())).toHaveLength(0);
    expect(store.listStartupWakes().map((w) => w.id)).toEqual([res.wakeId]);
  });

  it("onStartup wakes still count toward the per-thread pending cap (D8)", () => {
    for (let n = 0; n < WAKE_MAX_PENDING_PER_THREAD; n++) {
      expect(
        orch.scheduleWake(record(), { delaySeconds: 1, reason: "", prompt: "p", fireOnStartup: true }).ok
      ).toBe(true);
    }
    const res = orch.scheduleWake(record(), { delaySeconds: 1, reason: "", prompt: "p", fireOnStartup: true });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/pending wakes/);
  });

  it("a normal (timed) wake is unaffected: bad delay still rejects", () => {
    const res = orch.scheduleWake(record(), { delaySeconds: 1, reason: "", prompt: "p" });
    expect(res.ok).toBe(false);
  });

  it("listWakes returns pending wakes for the thread", () => {
    orch.scheduleWake(record(), { delaySeconds: 1200, reason: "a", prompt: "p" });
    orch.scheduleWake(record(), { delaySeconds: 2400, reason: "b", prompt: "p" });
    expect(orch.listWakes("discord", "thread-1")).toHaveLength(2);
    expect(orch.listWakes("discord", "thread-other")).toHaveLength(0);
  });
});

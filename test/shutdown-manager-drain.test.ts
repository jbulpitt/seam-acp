/**
 * #192 — drain model refreshes and close manager admission.
 *
 * Production sequence (not source-text order): stop() gates admission, HTTP
 * ingress drains, then store-writing managers drain, then the #174
 * safe-to-close predicate decides whether SQLite may close.
 */
import { describe, expect, it, vi } from "vitest";
import { scheduledAdmissionFixture, syntheticScheduleExecution } from "./scheduled-admission-fixture.js";
import { ScheduledPromptManager } from "../packages/core/src/core/scheduled-prompts/manager.js";
import type { ScheduledPrompt } from "../packages/core/src/core/scheduled-prompts/types.js";
import { WakeManager } from "../packages/core/src/core/wake/manager.js";
import type { WakeEvent } from "../packages/core/src/core/wake/types.js";
import { WatchManager } from "../packages/core/src/core/watch/manager.js";
import type { WatchEvent } from "../packages/core/src/core/watch/types.js";
import { ParkedPromptManager } from "../packages/core/src/core/parked-prompts/manager.js";
import type { ParkedPrompt } from "../packages/core/src/core/parked-prompts/types.js";
import type { SessionStore } from "../packages/core/src/core/session-store.js";
import {
  runBoundedStep,
  safeToCloseResources,
  undrainedStages,
  type DrainVerdict,
} from "../packages/core/src/lib/shutdown-budget.js";
import {
  drainStoreWritingManagers,
  MANAGER_CALLBACKS_STAGE,
  MODEL_INTELLIGENCE_REFRESH_STAGE,
  type DrainableManager,
  type StoreWritingManagers,
} from "../packages/core/src/lib/shutdown-managers.js";

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as any;

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const flush = async (turns = 8) => {
  for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 0));
};

const idle: DrainableManager = { drain: async () => {} };

function httpDrained(): DrainVerdict[] {
  return [
    { stage: "seam-mcp-ingress", drained: true },
    { stage: "health-ingress", drained: true },
  ];
}

function laterStagesDrained(): DrainVerdict[] {
  return [
    { stage: "pre-dispose-quiesce", drained: true },
    { stage: "voice-console-shutdown", drained: true },
    { stage: "live-help-shutdown", drained: true },
    { stage: "router-dispose", drained: true },
    { stage: "post-dispose-drain", drained: true },
  ];
}

function runGroup(timeoutMs: number) {
  return (label: string, work: () => Promise<unknown>) =>
    runBoundedStep({ label, timeoutMs, work });
}

async function productionClose(
  managers: StoreWritingManagers,
  close: () => void,
  timeoutMs = 2_000
): Promise<DrainVerdict[]> {
  const managerVerdicts = await drainStoreWritingManagers(managers, runGroup(timeoutMs));
  const verdicts = [...httpDrained(), ...managerVerdicts, ...laterStagesDrained()];
  if (safeToCloseResources(verdicts)) close();
  return verdicts;
}

describe("#192 production-sequence manager drains", () => {
  it("a rejected model drain is reported and keeps the store open", async () => {
    const close = vi.fn();
    const verdicts = await productionClose(
      {
        scheduled: idle,
        wake: idle,
        watch: idle,
        parked: idle,
        modelIntelligence: {
          drain: async () => {
            throw new Error("drain exploded");
          },
        },
      },
      close
    );
    expect(verdicts.find((v) => v.stage === MODEL_INTELLIGENCE_REFRESH_STAGE)?.drained).toBe(false);
    expect(verdicts.find((v) => v.stage === MANAGER_CALLBACKS_STAGE)?.drained).toBe(false);
    expect(undrainedStages(verdicts)).toEqual(
      expect.arrayContaining([MANAGER_CALLBACKS_STAGE, MODEL_INTELLIGENCE_REFRESH_STAGE])
    );
    expect(safeToCloseResources(verdicts)).toBe(false);
    expect(close).not.toHaveBeenCalled();
  });

  it("a timed-out model drain is reported and keeps the store open", async () => {
    const close = vi.fn();
    const verdicts = await productionClose(
      {
        scheduled: idle,
        wake: idle,
        watch: idle,
        parked: idle,
        modelIntelligence: { drain: () => new Promise(() => {}) },
      },
      close,
      40
    );
    expect(verdicts.find((v) => v.stage === MODEL_INTELLIGENCE_REFRESH_STAGE)?.drained).toBe(false);
    expect(safeToCloseResources(verdicts)).toBe(false);
    expect(close).not.toHaveBeenCalled();
  });
});

describe("#192 manager admission after stop", () => {
  it("a scheduled cron tick after stop does not touch SQLite or enqueue work", async () => {
    const row = makeScheduledRow();
    const { store, upserts } = makeScheduledStore(row);
    const onFire = vi.fn(async () => {});
    const manager = new ScheduledPromptManager({ resolveExecution: syntheticScheduleExecution, store, onFire, logger: silentLogger });
    manager.stop();
    (manager as unknown as { onCronTick(id: string): void }).onCronTick(row.id);
    await flush();
    expect(onFire).not.toHaveBeenCalled();
    expect(upserts).toEqual([]);
    manager.armFromRow(row);
    expect(upserts).toEqual([]);
  });

  it("runNow after stop still registers so an admitted HTTP fire is not dropped", async () => {
    const row = makeScheduledRow();
    const { store } = makeScheduledStore(row);
    const gate = deferred();
    const onFire = vi.fn(async () => gate.promise);
    const manager = new ScheduledPromptManager({ resolveExecution: syntheticScheduleExecution, store, onFire, logger: silentLogger });
    manager.stop();
    const running = manager.runNow(row.id);
    let drained = false;
    const drain = manager.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(drained).toBe(false);
    gate.resolve();
    await Promise.all([running, drain]);
    expect(drained).toBe(true);
  });

  it("a wake sweep tick after stop does not delete or fire", async () => {
    const wake = makeWake();
    const { store, deletes } = makeWakeStore([wake]);
    const onFire = vi.fn(async () => {});
    const manager = new WakeManager({ store, onFire, logger: silentLogger });
    manager.stop();
    (manager as unknown as { onSweepTick(): void }).onSweepTick();
    await manager.sweep();
    expect(onFire).not.toHaveBeenCalled();
    expect(deletes).toEqual([]);
  });

  it("NEGATIVE CONTROL: skipping the wake admission gate deletes after stop", async () => {
    const wake = makeWake();
    const { store, deletes } = makeWakeStore([wake]);
    const onFire = vi.fn(async (_wake, consume) => consume());
    const manager = new WakeManager({ store, onFire, logger: silentLogger });
    manager.stop();
    await (manager as unknown as { sweepInner(): Promise<void> }).sweepInner();
    expect(deletes).toEqual(["wake-1"]);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("a watch sweep tick after stop does not evaluate or write", async () => {
    const { store, deletes } = makeWatchStore([makeWatch()]);
    const evaluate = vi.fn(async () => ({ fired: true, eventText: "x", observed: "x" }));
    const onFire = vi.fn(async () => {});
    const manager = new WatchManager({
      store,
      evaluate,
      onFire,
      onExpire: async () => {},
      onStopped: async () => {},
      logger: silentLogger,
    });
    manager.stop();
    (manager as unknown as { onSweepTick(): void }).onSweepTick();
    await manager.sweep();
    expect(evaluate).not.toHaveBeenCalled();
    expect(onFire).not.toHaveBeenCalled();
    expect(deletes).toEqual([]);
  });

  it("a parked hub event after stop does not delete or fire", async () => {
    const parked = makeParked();
    const { store, deletes } = makeParkedStore([parked]);
    const onFire = vi.fn(async () => {});
    const manager = new ParkedPromptManager({
      store,
      hub: {
        isBridgeReady: () => true,
        onBridgeReady: () => () => {},
      },
      onFire,
      logger: silentLogger,
    });
    manager.stop();
    (manager as unknown as { onHubReady(id: string): void }).onHubReady("mac");
    await manager.fireLocation("mac");
    expect(onFire).not.toHaveBeenCalled();
    expect(deletes).toEqual([]);
  });
});

function makeScheduledRow(): ScheduledPrompt {
  return {
    id: "sch_live",
    platform: "discord",
    channelRef: "thread-1",
    parentRef: "channel-1",
    name: "live nightly",
    promptText: "summarize the day",
    cron: "0 9 * * *",
    timezone: "UTC",
    model: null,
    cwd: null,
    targetChannel: null,
    outputType: "card",
    sessionMode: "live",
    catchupSeconds: 900,
    enabled: true,
    legacyAttachmentCount: 0,
    createdBy: "user-1",
    createdUtc: new Date().toISOString(),
    updatedUtc: new Date().toISOString(),
    lastRunUtc: null,
    lastStatus: null,
    nextRunUtc: null,
    pinnedSessionId: null,
  };
}

function makeScheduledStore(row: ScheduledPrompt) {
  const upserts: ScheduledPrompt[] = [];
  const store = {
    scheduledOccurrences: scheduledAdmissionFixture(),
    getScheduled: (id: string) => (id === row.id ? { ...row } : null),
    upsertScheduled: (s: ScheduledPrompt) => {
      upserts.push(s);
      Object.assign(row, s);
    },
    listScheduledEnabled: () => (row.enabled ? [{ ...row }] : []),
  } as unknown as SessionStore;
  return { store, upserts };
}

function makeWake(over: Partial<WakeEvent> = {}): WakeEvent {
  const now = Date.now();
  return {
    id: "wake-1",
    platform: "discord",
    channelRef: "thread-1",
    parentRef: "channel-1",
    fireAtUtc: new Date(now - 1000).toISOString(),
    prompt: "resume",
    reason: "why",
    createdBy: "discord:thread-1",
    correlationId: null,
    chainDepth: 0,
    catchupSeconds: 900,
    fireOnStartup: false,
    createdUtc: new Date(now).toISOString(),
    ...over,
  };
}

function makeWakeStore(initial: WakeEvent[]) {
  const rows = new Map(initial.map((w) => [w.id, w]));
  const deletes: string[] = [];
  const store = {
    listDueWakes: (nowIso: string) =>
      [...rows.values()]
        .filter((w) => w.fireAtUtc <= nowIso && !w.fireOnStartup)
        .sort((a, b) => a.fireAtUtc.localeCompare(b.fireAtUtc)),
    listStartupWakes: () => [...rows.values()].filter((w) => w.fireOnStartup),
    getWake: (id: string) => rows.get(id) ?? null,
    deleteWake: (id: string) => {
      deletes.push(id);
      rows.delete(id);
    },
  } as unknown as SessionStore;
  return { store, rows, deletes };
}

function makeWatch(): WatchEvent {
  const now = Date.now();
  return {
    id: "w1",
    platform: "discord",
    channelRef: "thread-1",
    parentRef: null,
    kind: "file",
    spec: "/tmp/x",
    match: null,
    intervalSeconds: 30,
    prompt: "resume",
    reason: "why",
    mode: "once",
    maxFires: 1,
    fireCount: 0,
    lastCheckedUtc: null,
    lastFiredUtc: null,
    lastObserved: null,
    expiresAtUtc: new Date(now + 3600_000).toISOString(),
    createdBy: "discord:thread-1",
    correlationId: null,
    createdUtc: new Date(now).toISOString(),
  };
}

function makeWatchStore(initial: WatchEvent[]) {
  const rows = new Map(initial.map((w) => [w.id, { ...w }]));
  const deletes: string[] = [];
  const store = {
    listAllWatches: () => [...rows.values()],
    markWatchChecked: (id: string, checkedUtc: string, observed: string | null) => {
      const w = rows.get(id);
      if (w) {
        w.lastCheckedUtc = checkedUtc;
        w.lastObserved = observed;
      }
    },
    incrementWatchFire: (id: string, firedUtc: string) => {
      const w = rows.get(id);
      if (w) {
        w.fireCount += 1;
        w.lastFiredUtc = firedUtc;
      }
    },
    deleteWatch: (id: string) => {
      deletes.push(id);
      rows.delete(id);
    },
  };
  return { store, rows, deletes };
}

function makeParked(): ParkedPrompt {
  return {
    id: "park-1",
    platform: "discord",
    channelRef: "thread-1",
    parentRef: "channel-1",
    location: "mac",
    kind: "bridge_offline",
    prompt: "hello",
    authorId: "u1",
    authorName: "Alex",
    noticeMessageId: "m1",
    attachments: [],
    createdUtc: "2026-08-18T00:00:00.000Z",
  };
}

function makeParkedStore(initial: ParkedPrompt[]) {
  const rows = new Map(initial.map((p) => [p.id, p]));
  const deletes: string[] = [];
  const store = {
    listParked: () => [...rows.values()],
    listParkedByLocation: (location: string) =>
      [...rows.values()].filter((p) => p.location === location),
    deleteParked: (id: string) => {
      deletes.push(id);
      rows.delete(id);
    },
  } as unknown as SessionStore;
  return { store, rows, deletes };
}

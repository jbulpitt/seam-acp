import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduledJobs } from "croner";
import { scheduledAdmissionFixture, syntheticScheduleExecution } from "./scheduled-admission-fixture.js";
import { ScheduledPromptManager } from "../packages/core/src/core/scheduled-prompts/manager.js";
import { scheduledOccurrenceKey, type ScheduledOccurrenceKey } from "../packages/core/src/core/scheduled-prompts/occurrence-store.js";
import type { SessionStore } from "../packages/core/src/core/session-store.js";
import type { ScheduledPrompt } from "../packages/core/src/core/scheduled-prompts/types.js";

const clockBoundary = vi.hoisted(() => ({
  id: "sch_date_binding",
  afterConstruction: undefined as (() => void) | undefined,
  beforeCallback: undefined as (() => void) | undefined,
}));

// Forward the real constructor and its registered callback; only move the clock.
vi.mock("croner", async importOriginal => {
  const actual = await importOriginal<typeof import("croner")>();
  return { ...actual, Cron: new Proxy(actual.Cron, {
    construct(target, received, newTarget) {
      const args = [...received];
      const named = args[1]?.name === clockBoundary.id;
      if (named && typeof args[2] === "function") {
        const callback = args[2];
        args[2] = function (this: unknown, ...values: unknown[]) {
          clockBoundary.beforeCallback?.();
          return Reflect.apply(callback, this, values);
        };
      }
      const job = Reflect.construct(target, args, newTarget);
      if (named) clockBoundary.afterConstruction?.();
      return job;
    },
  }) };
});

const due = "2026-10-31T08:40:00.000Z";
const dueMs = Date.parse(due);
const initialJobs = [...scheduledJobs];

afterEach(() => {
  try {
    expect(vi.getTimerCount()).toBe(0);
    expect(scheduledJobs).toEqual(initialJobs);
  } finally {
    clockBoundary.afterConstruction = undefined;
    clockBoundary.beforeCallback = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

function setup(overrides: Partial<ScheduledPrompt> = {}) {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(dueMs - 1);
  const row: ScheduledPrompt = {
    id: clockBoundary.id, platform: "discord", channelRef: "synthetic-thread", parentRef: "synthetic-parent",
    name: "Date binding", promptText: "synthetic no-provider schedule", cron: "* * * * *", timezone: "UTC",
    model: null, cwd: null, targetChannel: null, outputType: "card", sessionMode: "isolated",
    catchupSeconds: 900, enabled: true, legacyAttachmentCount: 0, createdBy: "synthetic",
    createdUtc: new Date().toISOString(), updatedUtc: new Date().toISOString(),
    lastRunUtc: null, lastStatus: null, nextRunUtc: null, pinnedSessionId: null, ...overrides,
  };
  const admission = scheduledAdmissionFixture();
  const store = {
    scheduledOccurrences: admission,
    turnAttempts: { get: () => null },
    listScheduledEnabled: () => row.enabled ? [{ ...row }] : [],
    getScheduled: (id: string) => id === row.id ? { ...row } : null,
    upsertScheduled: (value: ScheduledPrompt) => { Object.assign(row, value); },
  } as unknown as SessionStore;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const deliveries: { key: ScheduledOccurrenceKey; durableDue: string | null | undefined }[] = [];
  const onFire = vi.fn(async (_id: string, key: ScheduledOccurrenceKey) => {
    deliveries.push({ key, durableDue: admission.get(key.id)?.scheduledFor });
    admission.settle(key.id);
  });
  const manager = new ScheduledPromptManager({ store, onFire,
    resolveExecution: syntheticScheduleExecution, logger: logger as any });
  return { row, admission, manager, onFire, deliveries, logger };
}

describe("scheduled Date binding", () => {
  it("keeps the armed Date, persisted due and durable key aligned across a 2ms constructor crossing", async () => {
    const h = setup({ cron: "40 3 * * *", timezone: "America/Chicago" });
    clockBoundary.afterConstruction = () => {
      clockBoundary.afterConstruction = undefined;
      vi.setSystemTime(dueMs + 1);
    };
    try {
      h.manager.start();
      expect(Date.now()).toBe(dueMs + 1);
      expect(h.row.nextRunUtc).toBe(due);
      await vi.advanceTimersByTimeAsync(1002);
      await h.manager.drain();
      expect(h.deliveries).toEqual([{ key: scheduledOccurrenceKey(h.row.id, due), durableDue: due }]);
      expect(h.admission.get(scheduledOccurrenceKey(h.row.id, due).id)?.settled).toBe(true);
      expect(h.row.nextRunUtc).toBe("2026-11-01T09:40:00.000Z");
    } finally { h.manager.stop(); await h.manager.drain(); }
  });

  it("retries a failed reservation on the next normal tick with the old key, then advances", async () => {
    const h = setup();
    const failure = new Error("synthetic admission write failure");
    const reserve = vi.spyOn(h.admission, "reserve").mockImplementationOnce(() => { throw failure; });
    try {
      h.manager.start();
      await vi.advanceTimersByTimeAsync(1); await h.manager.drain();
      expect(h.onFire).not.toHaveBeenCalled();
      expect(h.admission.pending()).toEqual([]);
      expect(h.row.nextRunUtc).toBe(due);
      expect(h.logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: failure }), "scheduled fire failed");
      await vi.advanceTimersByTimeAsync(59999);
      expect(reserve).toHaveBeenCalledTimes(1);
      expect(h.onFire).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1); await h.manager.drain();
      expect(h.deliveries).toEqual([{ key: scheduledOccurrenceKey(h.row.id, due), durableDue: due }]);
      expect(reserve.mock.calls.every(([key]) => key.id === scheduledOccurrenceKey(h.row.id, due).id)).toBe(true);
      expect(h.row.nextRunUtc).toBe("2026-10-31T08:42:00.000Z");
    } finally { h.manager.stop(); await h.manager.drain(); }
  });

  it("plans beyond the fired retry wake when the clock moves behind the retained failed intent", async () => {
    const h = setup();
    vi.spyOn(h.admission, "reserve").mockImplementationOnce(() => { throw new Error("synthetic admission write failure"); });
    let callbacks = 0;
    clockBoundary.beforeCallback = () => {
      if (++callbacks === 2) vi.setSystemTime(dueMs - 60000);
    };
    try {
      h.manager.start();
      await vi.advanceTimersByTimeAsync(1); await h.manager.drain();
      expect(h.row.nextRunUtc).toBe(due);
      await vi.advanceTimersByTimeAsync(60000); await h.manager.drain();
      expect(callbacks).toBe(2);
      expect(Date.now()).toBe(dueMs - 60000);
      expect(h.deliveries).toEqual([{ key: scheduledOccurrenceKey(h.row.id, due), durableDue: due }]);
      expect(h.row.nextRunUtc).toBe("2026-10-31T08:42:00.000Z");
    } finally { h.manager.stop(); await h.manager.drain(); }
  });

  it("retains a failed finite intent without keeping an exhausted timer armed", async () => {
    const h = setup({ cron: "0 40 8 31 10 * 2026" });
    const reserve = vi.spyOn(h.admission, "reserve").mockImplementationOnce(() => { throw new Error("synthetic admission write failure"); });
    try {
      h.manager.start();
      await vi.advanceTimersByTimeAsync(1); await h.manager.drain();
      expect(h.manager.armedCount).toBe(0);
      expect(h.row.nextRunUtc).toBe(due);
      expect(h.row.lastStatus).toBe("error: scheduled occurrence admission failed");
      expect(h.admission.pending()).toEqual([]);
      expect(h.onFire).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60000);
      expect(reserve).toHaveBeenCalledTimes(1);
      expect(h.row.nextRunUtc).toBe(due);
    } finally { h.manager.stop(); await h.manager.drain(); }
  });
});

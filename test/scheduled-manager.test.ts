import { describe, it, expect, vi } from "vitest";
import { scheduledAdmissionFixture, syntheticScheduleExecution } from "./scheduled-admission-fixture.js";
import { ScheduledPromptManager } from "../packages/core/src/core/scheduled-prompts/manager.js";
import type { SessionStore } from "../packages/core/src/core/session-store.js";
import type { ScheduledPrompt } from "../packages/core/src/core/scheduled-prompts/types.js";
import { scheduledOccurrenceKey, type ScheduledOccurrenceKey } from "../packages/core/src/core/scheduled-prompts/occurrence-store.js";
import { SessionStore as SqliteSessionStore } from "../packages/core/src/core/session-store.js";
import { REAUTH_WAITING_TEXT } from "../packages/core/src/core/reauth-negotiation.js";

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as any;

function makeRow(over: Partial<ScheduledPrompt> = {}): ScheduledPrompt {
  return {
    id: "sch_live",
    platform: "discord",
    channelRef: "thread-1",
    parentRef: "channel-1",
    name: "live nightly",
    promptText: "summarize the day",
    cron: "* * * * *",
    timezone: "America/Chicago",
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
    ...over,
  };
}

/** Minimal store double: the guard only touches getScheduled + upsertScheduled
 *  (via patchRow). Captures every upsert so we can inspect the status breadcrumb. */
function makeStore(row: ScheduledPrompt) {
  const upserts: ScheduledPrompt[] = [];
  const store = {
    scheduledOccurrences: scheduledAdmissionFixture(),
    turnAttempts: { get: () => null },
    getScheduled: (id: string) => (id === row.id ? { ...row } : null),
    upsertScheduled: (s: ScheduledPrompt) => {
      upserts.push(s);
      Object.assign(row, s);
    },
    listScheduledEnabled: () => (row.enabled ? [{ ...row }] : []),
  } as unknown as SessionStore;
  return { store, upserts };
}

describe("ScheduledPromptManager overlap guard (D3)", () => {
  it.each(["cancelled", "completed"] as const)("admits a new slot after %s even while the old callback is wrapping up", async state => {
    const row = makeRow();
    const store = new SqliteSessionStore(":memory:");
    store.upsertScheduled(row);
    const old = scheduledOccurrenceKey(row.id, "2026-10-19T22:30:00.000Z");
    const next = scheduledOccurrenceKey(row.id, "2026-10-20T12:00:00.000Z");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const onFire = vi.fn(async (_id: string, key: ScheduledOccurrenceKey) => {
      const attempt = store.turnAttempts.claim({ id: key.id, target: row.channelRef,
        prompt: row.promptText, session: "live", kind: "scheduled", createdUtc: key.scheduledFor! },
      syntheticScheduleExecution().fingerprint, "test", "schedule");
      if (key.id === old.id && state === "cancelled") store.turnAttempts.cancel(key.id);
      else store.turnAttempts.complete(attempt, { id: key.id, target: row.channelRef,
        status: "completed", finishedUtc: new Date().toISOString() });
      if (key.id === old.id) await gate;
      store.scheduledOccurrences.settle(key.id);
    });
    const manager = new ScheduledPromptManager({ store, onFire, logger: silentLogger,
      resolveExecution: syntheticScheduleExecution });
    const running = manager["fire"](row.id, old);
    try {
      await manager["fire"](row.id, old);
      expect(onFire).toHaveBeenCalledTimes(1);
      await manager["fire"](row.id, next);
      expect(onFire.mock.calls.map(([, key]) => key.id)).toEqual([old.id, next.id]);
      expect(store.scheduledOccurrences.get(old.id)?.settled).toBe(true);
    } finally {
      release(); await running; manager.stop(); store.close();
    }
  });

  it("a later tick rechecks the original reauth occurrence instead of silently skipping forever", async () => {
    const row = makeRow({ sessionMode: "isolated" });
    const store = new SqliteSessionStore(":memory:");
    store.upsertScheduled(row);
    const first = scheduledOccurrenceKey(row.id, "2026-10-14T11:00:00.000Z");
    store.scheduledOccurrences.prepare(first, row, syntheticScheduleExecution);
    store.turnAttempts.registerOwner("test");
    const attempt = store.turnAttempts.claim({ id: first.id, target: row.channelRef,
      prompt: row.promptText, session: "isolated", kind: "scheduled", createdUtc: first.scheduledFor!,
      agentId: "claude", location: "local" }, "synthetic-not-a-provider-identity", "test", "schedule");
    store.turnAttempts.bind(attempt, "original-acp");
    store.turnAttempts.startPrompt(attempt);
    store.turnAttempts.markStalled(first.id, REAUTH_WAITING_TEXT, "2026-10-14T11:30:00.000Z");
    const onFire = vi.fn(async () => {});
    const manager = new ScheduledPromptManager({ store, onFire, logger: silentLogger,
      resolveExecution: syntheticScheduleExecution });
    try {
      await (manager as unknown as { fire(id: string, key: ScheduledOccurrenceKey): Promise<void> })
        .fire(row.id, scheduledOccurrenceKey(row.id, "2026-10-14T12:00:00.000Z"));
      expect(onFire).toHaveBeenCalledExactlyOnceWith(row.id, expect.objectContaining({ id: first.id }));
      expect(store.getScheduled(row.id)?.lastStatus).toBe("waiting for provider sign-in since 06:30 CDT");
      expect(store.scheduledOccurrences.pending().map(item => item.id)).toEqual([first.id]);
      expect(store.turnAttempts.get(first.id)).toMatchObject({ acpSessionId: "original-acp", promptStarted: true });
    } finally { manager.stop(); store.close(); }
  });

  it("drain waits for a fire admitted before stop", async () => {
    const row = makeRow();
    const { store } = makeStore(row);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const manager = new ScheduledPromptManager({ resolveExecution: syntheticScheduleExecution,
      store,
      onFire: async () => gate,
      logger: silentLogger,
    });
    const fire = (manager as unknown as { fire(id: string): Promise<void> }).fire.bind(manager);
    const running = fire(row.id);
    manager.stop();
    let drained = false;
    const drain = manager.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await Promise.all([running, drain]);
    expect(drained).toBe(true);
  });

  it("skips a second fire while the first is still running and stamps lastStatus", async () => {
    const row = makeRow();
    const { store, upserts } = makeStore(row);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const onFire = vi.fn(async (_id: string, key: ScheduledOccurrenceKey) => {
      await gate; store.scheduledOccurrences.settle(key.id);
    });

    const manager = new ScheduledPromptManager({ resolveExecution: syntheticScheduleExecution, store, onFire, logger: silentLogger });
    const fire = (manager as unknown as { fire(id: string): Promise<void> }).fire.bind(manager);

    // First fire enters and suspends on the gate (onFire called once, id marked
    // in-flight synchronously before the await).
    const first = fire(row.id);
    // A second fire lands mid-flight → skipped, not stacked.
    await fire(row.id);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(upserts.some((s) => s.lastStatus === "skipped: still running")).toBe(true);

    // Once the first completes the guard clears and a later fire runs normally.
    release();
    await first;
    await fire(row.id);
    expect(onFire).toHaveBeenCalledTimes(2);
  });

  it("clears the in-flight guard even when onFire throws", async () => {
    const row = makeRow();
    const { store } = makeStore(row);
    const onFire = vi
      .fn<(id: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);

    const manager = new ScheduledPromptManager({ resolveExecution: syntheticScheduleExecution, store, onFire, logger: silentLogger });
    const fire = (manager as unknown as { fire(id: string, key: ScheduledOccurrenceKey): Promise<void> }).fire.bind(manager);
    const key = scheduledOccurrenceKey(row.id);
    await fire(row.id, key); // rejected callback retains this exact occurrence
    expect(store.scheduledOccurrences.pending()).toHaveLength(1);
    await fire(row.id, key); // same occurrence recovery is not blocked by a stuck guard
    expect(onFire).toHaveBeenCalledTimes(2);
  });
});

describe("ScheduledPromptManager.runNow", () => {
  it("keys cron callbacks by the armed slot while manual fires remain distinct", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-09T00:00:00.000Z"));
    const row = makeRow({ timezone: "UTC" });
    const { store } = makeStore(row);
    const onFire = vi.fn(async (_id: string, occurrence: ScheduledOccurrenceKey) => {
      store.scheduledOccurrences.settle(occurrence.id);
    });
    const manager = new ScheduledPromptManager({ resolveExecution: syntheticScheduleExecution, store, onFire, logger: silentLogger });
    try {
      manager.start(); await manager.runNow(row.id);
      await vi.advanceTimersByTimeAsync(60000);
      await vi.advanceTimersByTimeAsync(60000);
      expect(onFire.mock.calls.map(c => c[1])).toEqual([
        { id: expect.stringMatching(/^scheduled-/), scheduledFor: null },
        { id: expect.stringMatching(/^scheduled-/), scheduledFor: "2026-09-09T00:01:00.000Z" },
        { id: expect.stringMatching(/^scheduled-/), scheduledFor: "2026-09-09T00:02:00.000Z" },
      ]);
      expect(new Set(onFire.mock.calls.map(c => (c[1] as { id: string }).id)).size).toBe(3);
    } finally { manager.stop(); vi.useRealTimers(); }
  });
  it("invokes onFire and does not require the row to be enabled", async () => {
    const row = makeRow({ enabled: false, cron: "0 9 * * *" });
    const { store } = makeStore(row);
    const onFire = vi.fn(async () => {});
    const manager = new ScheduledPromptManager({ resolveExecution: syntheticScheduleExecution, store, onFire, logger: silentLogger });
    await manager.runNow(row.id);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire).toHaveBeenCalledWith(row.id, { id: expect.stringMatching(/^scheduled-/), scheduledFor: null });
    manager.stop();
  });
});

describe("ScheduledPromptManager catch-up", () => {
  it.each(['cron', 'catch-up'] as const)("does not consume a %s slot if durable admission itself fails", async trigger => {
    const due = '2026-09-09T00:01:00.000Z';
    const row = makeRow({ nextRunUtc: due });
    const { store } = makeStore(row);
    const onFire = vi.fn(async () => {});
    vi.spyOn(store.scheduledOccurrences, 'reserve').mockImplementation(() => { throw new Error('synthetic admission write failure'); });
    const manager = new ScheduledPromptManager({ store, onFire, resolveExecution: syntheticScheduleExecution, logger: silentLogger });
    try {
      if (trigger === 'cron') {
        (manager as any).nextDue.set(row.id, due);
        (manager as any).onCronTick(row.id);
      } else manager.start();
      await manager.drain();
      expect(onFire).not.toHaveBeenCalled();
      expect(row.nextRunUtc).toBe(due);
      expect(row.lastStatus).toBe('error: scheduled occurrence admission failed');
      expect(store.scheduledOccurrences.pending()).toEqual([]);
    } finally { manager.stop(); }
  });

  it("fires once on start when nextRunUtc is in the past, even far outside catchupSeconds", async () => {
    const row = makeRow({
      cron: "0 9 * * *",
      catchupSeconds: 900,
      nextRunUtc: new Date(Date.now() - 6 * 3600 * 1000).toISOString(),
    });
    const { store } = makeStore(row);
    const onFire = vi.fn(async () => {});
    const manager = new ScheduledPromptManager({ resolveExecution: syntheticScheduleExecution, store, onFire, logger: silentLogger });
    manager.start();
    await vi.waitFor(() => expect(onFire).toHaveBeenCalledTimes(1));
    manager.stop();
  });

  it("does not catch-up a schedule whose next run is still in the future", async () => {
    const row = makeRow({
      cron: "0 9 * * *",
      nextRunUtc: new Date(Date.now() + 3600 * 1000).toISOString(),
    });
    const { store } = makeStore(row);
    const onFire = vi.fn(async () => {});
    const manager = new ScheduledPromptManager({ resolveExecution: syntheticScheduleExecution, store, onFire, logger: silentLogger });
    manager.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(onFire).not.toHaveBeenCalled();
    manager.stop();
  });
});

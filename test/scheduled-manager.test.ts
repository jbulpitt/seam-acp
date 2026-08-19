import { describe, it, expect, vi } from "vitest";
import { ScheduledPromptManager } from "../src/core/scheduled-prompts/manager.js";
import type { SessionStore } from "../src/core/session-store.js";
import type { ScheduledPrompt } from "../src/core/scheduled-prompts/types.js";

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
    attachments: [],
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
  it("skips a second fire while the first is still running and stamps lastStatus", async () => {
    const row = makeRow();
    const { store, upserts } = makeStore(row);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const onFire = vi.fn(async () => { await gate; });

    const manager = new ScheduledPromptManager({ store, onFire, logger: silentLogger });
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
      .fn<[string], Promise<void>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);

    const manager = new ScheduledPromptManager({ store, onFire, logger: silentLogger });
    const fire = (manager as unknown as { fire(id: string): Promise<void> }).fire.bind(manager);

    await fire(row.id); // rejects internally, guard released in finally
    await fire(row.id); // not blocked by a stuck guard
    expect(onFire).toHaveBeenCalledTimes(2);
  });
});

describe("ScheduledPromptManager.runNow", () => {
  it("invokes onFire and does not require the row to be enabled", async () => {
    const row = makeRow({ enabled: false, cron: "0 9 * * *" });
    const { store } = makeStore(row);
    const onFire = vi.fn(async () => {});
    const manager = new ScheduledPromptManager({ store, onFire, logger: silentLogger });
    await manager.runNow(row.id);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire).toHaveBeenCalledWith(row.id);
    manager.stop();
  });
});

describe("ScheduledPromptManager catch-up", () => {
  it("fires once on start when nextRunUtc is in the past, even far outside catchupSeconds", async () => {
    const row = makeRow({
      cron: "0 9 * * *",
      catchupSeconds: 900,
      nextRunUtc: new Date(Date.now() - 6 * 3600 * 1000).toISOString(),
    });
    const { store } = makeStore(row);
    const onFire = vi.fn(async () => {});
    const manager = new ScheduledPromptManager({ store, onFire, logger: silentLogger });
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
    const manager = new ScheduledPromptManager({ store, onFire, logger: silentLogger });
    manager.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(onFire).not.toHaveBeenCalled();
    manager.stop();
  });
});

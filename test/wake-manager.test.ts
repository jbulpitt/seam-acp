import { describe, it, expect, vi } from "vitest";
import { WakeManager } from "../packages/core/src/core/wake/manager.js";
import type { SessionStore } from "../packages/core/src/core/session-store.js";
import type { WakeEvent } from "../packages/core/src/core/wake/types.js";

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as any;

function makeWake(over: Partial<WakeEvent> = {}): WakeEvent {
  const now = Date.now();
  return {
    id: "wake-1",
    platform: "discord",
    channelRef: "thread-1",
    parentRef: "channel-1",
    fireAtUtc: new Date(now - 1000).toISOString(), // due by default
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

/** Minimal store double backed by an in-memory map. The manager only touches
 *  listDueWakes + deleteWake. */
function makeStore(initial: WakeEvent[]) {
  const rows = new Map(initial.map((w) => [w.id, w]));
  const deletes: string[] = [];
  const store = {
    listDueWakes: (nowIso: string) =>
      [...rows.values()]
        // Mirror the store: the time sweep excludes boot-triggered wakes.
        .filter((w) => w.fireAtUtc <= nowIso && !w.fireOnStartup)
        .sort((a, b) => a.fireAtUtc.localeCompare(b.fireAtUtc)),
    listStartupWakes: () =>
      [...rows.values()]
        .filter((w) => w.fireOnStartup)
        .sort((a, b) => a.createdUtc.localeCompare(b.createdUtc)),
    deleteWake: (id: string) => {
      deletes.push(id);
      rows.delete(id);
    },
  } as unknown as SessionStore;
  return { store, rows, deletes };
}

describe("WakeManager sweeper (#59)", () => {
  it("fires a due wake and deletes it before firing (D1)", async () => {
    const wake = makeWake();
    const { store, deletes, rows } = makeStore([wake]);
    const order: string[] = [];
    const onFire = vi.fn(async (w: WakeEvent) => {
      // Delete must have already happened when onFire runs (delete-before-fire).
      order.push("fire");
      expect(rows.has(w.id)).toBe(false);
    });
    const m = new WakeManager({ store, onFire, logger: silentLogger });
    await m.sweep();
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(deletes).toEqual(["wake-1"]);
    expect(order).toEqual(["fire"]);
  });

  it("does not fire a wake that is not yet due", async () => {
    const future = makeWake({ fireAtUtc: new Date(Date.now() + 60_000).toISOString() });
    const { store, deletes } = makeStore([future]);
    const onFire = vi.fn(async () => {});
    const m = new WakeManager({ store, onFire, logger: silentLogger });
    await m.sweep();
    expect(onFire).not.toHaveBeenCalled();
    expect(deletes).toEqual([]);
  });

  it("drops (deletes without firing) a wake past its catch-up window (D10)", async () => {
    const stale = makeWake({
      fireAtUtc: new Date(Date.now() - 2_000_000).toISOString(), // ~33m overdue
      catchupSeconds: 900,
    });
    const { store, deletes } = makeStore([stale]);
    const onFire = vi.fn(async () => {});
    const m = new WakeManager({ store, onFire, logger: silentLogger });
    await m.sweep();
    expect(onFire).not.toHaveBeenCalled();
    expect(deletes).toEqual(["wake-1"]); // dropped, not fired
  });

  it("fires a wake overdue but WITHIN its catch-up window", async () => {
    const recent = makeWake({
      fireAtUtc: new Date(Date.now() - 60_000).toISOString(), // 1m overdue
      catchupSeconds: 900,
    });
    const { store } = makeStore([recent]);
    const onFire = vi.fn(async () => {});
    const m = new WakeManager({ store, onFire, logger: silentLogger });
    await m.sweep();
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("never fires the same wake twice across sweeps (row is gone after firing)", async () => {
    const wake = makeWake();
    const { store } = makeStore([wake]);
    const onFire = vi.fn(async () => {});
    const m = new WakeManager({ store, onFire, logger: silentLogger });
    await m.sweep();
    await m.sweep();
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("fireStartupWakes fires a boot-triggered wake, deleting it BEFORE onFire (D1)", async () => {
    const wake = makeWake({ fireOnStartup: true });
    const { store, deletes, rows } = makeStore([wake]);
    const order: string[] = [];
    const onFire = vi.fn(async (w: WakeEvent) => {
      // The row must already be gone when onFire runs — a crash during the
      // woken turn must not re-fire it on the next reboot (no boot-loop).
      order.push("fire");
      expect(rows.has(w.id)).toBe(false);
    });
    const m = new WakeManager({ store, onFire, logger: silentLogger });
    await m.fireStartupWakes();
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(deletes).toEqual(["wake-1"]);
    expect(order).toEqual(["fire"]);
  });

  it("a startup wake never fires twice across two boots (start passes)", async () => {
    const wake = makeWake({ fireOnStartup: true });
    const { store } = makeStore([wake]);
    const onFire = vi.fn(async () => {});
    const m = new WakeManager({ store, onFire, logger: silentLogger });
    await m.fireStartupWakes(); // boot #1
    await m.fireStartupWakes(); // boot #2 — row is already gone
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("the time sweep never picks up a boot-triggered wake, even when overdue", async () => {
    // Overdue by default fireAtUtc (now - 1000ms) but fire_on_startup — the
    // sweep must leave it for the boot pass, not fire or drop it.
    const wake = makeWake({ fireOnStartup: true });
    const { store, deletes } = makeStore([wake]);
    const onFire = vi.fn(async () => {});
    const m = new WakeManager({ store, onFire, logger: silentLogger });
    await m.sweep();
    expect(onFire).not.toHaveBeenCalled();
    expect(deletes).toEqual([]);
  });

  it("start() fires boot-triggered wakes once, then stops the interval", async () => {
    const wake = makeWake({ fireOnStartup: true });
    const { store } = makeStore([wake]);
    const onFire = vi.fn(async () => {});
    const m = new WakeManager({ store, onFire, logger: silentLogger, sweepMs: 10_000 });
    m.start();
    // start() kicks the startup pass off non-blocking; let microtasks settle.
    await vi.waitFor(() => expect(onFire).toHaveBeenCalledTimes(1));
    m.stop();
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("continues sweeping other wakes even when one onFire throws", async () => {
    const a = makeWake({ id: "a", fireAtUtc: new Date(Date.now() - 3000).toISOString() });
    const b = makeWake({ id: "b", fireAtUtc: new Date(Date.now() - 2000).toISOString() });
    const { store, deletes } = makeStore([a, b]);
    const onFire = vi
      .fn<[WakeEvent], Promise<void>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);
    const m = new WakeManager({ store, onFire, logger: silentLogger });
    await m.sweep();
    expect(onFire).toHaveBeenCalledTimes(2);
    // Both deleted (delete-before-fire), even the one whose fire threw.
    expect(deletes.sort()).toEqual(["a", "b"]);
  });
});

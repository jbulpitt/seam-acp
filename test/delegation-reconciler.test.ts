import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { DelegationReconciler } from "../packages/core/src/core/delegation-reconciler.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

describe("DelegationReconciler", () => {
  let dir: string;
  let dbPath: string;
  let store: SessionStore;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-delegation-reconcile-"));
    dbPath = path.join(dir, "seam.db");
    store = new SessionStore(dbPath);
  });

  afterEach(() => {
    store.close();
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("boot reconciliation abandons stale running rows durably and leaves fresh rows for crash recovery", () => {
    store.recordDelegation({
      id: "stale",
      kind: "handoff",
      status: "running",
      acpSessionId: "acp-stale",
      createdUtc: "2026-09-01T09:00:00.000Z",
      updatedUtc: "2026-09-01T09:00:00.000Z",
    });
    store.recordDelegation({
      id: "fresh",
      kind: "handoff",
      status: "running",
      createdUtc: "2026-09-01T11:30:00.000Z",
      updatedUtc: "2026-09-01T11:30:00.000Z",
    });
    const reconciler = new DelegationReconciler({
      store,
      logger: silent,
      maxAgeMs: 60 * 60 * 1_000,
      now: () => Date.parse("2026-09-01T12:00:00.000Z"),
    });

    expect(reconciler.reconcile()).toBe(1);
    expect(store.getDelegation("stale")).toMatchObject({
      status: "abandoned",
      acpSessionId: "acp-stale",
      updatedUtc: "2026-09-01T12:00:00.000Z",
    });
    expect(store.getDelegation("fresh")?.status).toBe("running");

    // This is the exact index.ts boot order: stale rows are terminal first;
    // the existing crash-recovery pass then keeps only fresh work resumable.
    expect(
      store.reconcileOrphanedDelegations("2026-09-01T12:00:01.000Z")
    ).toBe(1);
    expect(store.getDelegation("fresh")?.status).toBe("interrupted");
    expect(store.getDelegation("stale")?.status).toBe("abandoned");

    store.close();
    store = new SessionStore(dbPath);
    expect(store.getDelegation("stale")?.status).toBe("abandoned");
    const reopened = new DelegationReconciler({
      store,
      logger: silent,
      maxAgeMs: 60 * 60 * 1_000,
      now: () => Date.parse("2026-09-01T12:00:00.000Z"),
    });
    expect(reopened.reconcile()).toBe(0);
  });

  it("periodically abandons a row after it crosses the max age", async () => {
    let now = Date.parse("2026-09-01T12:00:00.000Z");
    store.recordDelegation({
      id: "running",
      kind: "handoff",
      status: "running",
      createdUtc: new Date(now).toISOString(),
      updatedUtc: new Date(now).toISOString(),
    });
    const reconciler = new DelegationReconciler({
      store,
      logger: silent,
      maxAgeMs: 1_000,
      intervalMs: 100,
      now: () => now,
    });
    reconciler.start();
    now += 1_001;
    await vi.advanceTimersByTimeAsync(100);

    expect(store.getDelegation("running")?.status).toBe("abandoned");
    reconciler.stop();
  });
});

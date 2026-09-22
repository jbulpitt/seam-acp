/**
 * #513 — an accepted dispatch was invisible in turn_attempts until boot
 * recovery finished claiming. The work was not lost; a query during that
 * window could not tell "accepted, not yet claimed" from "gone".
 *
 * `pending` is already that state. These tests fail if the row is still
 * created only when a claim runs: the file can exist, and a later tick would
 * still admit it, and the assertion is made while claim is closed.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { DispatchWatcher } from "../packages/core/src/core/dispatch/watcher.js";
import {
  dispatchDirs,
  enqueueDispatchSpec,
  type DispatchSpec,
} from "../packages/core/src/core/dispatch/types.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const logger = {
  child() { return logger; },
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  fatal() {},
} as unknown as Logger;

const spec = (id: string): DispatchSpec => ({
  id,
  target: "thread-1",
  prompt: "do the thing",
  session: "live",
  kind: "handoff",
  correlationId: id,
  createdUtc: "2026-09-22T04:39:00.000Z",
});

let dataDir: string;
let store: SessionStore;
const watchers = new Set<DispatchWatcher>();

async function dropFile(id: string): Promise<void> {
  const dirs = dispatchDirs(dataDir);
  await mkdir(dirs.pending, { recursive: true });
  await writeFile(
    path.join(dirs.pending, `${id}.json`),
    `${JSON.stringify(spec(id), null, 2)}\n`,
    "utf8",
  );
}

describe("#513 an accepted dispatch is pending before it is claimed", () => {
  afterEach(async () => {
    for (const watcher of watchers) watcher.stop();
    await Promise.all([...watchers].map((watcher) => watcher.drain()));
    watchers.clear();
    store?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it("is queryable as pending the moment enqueue returns, with no watcher running", async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "seam-513-"));
    store = new SessionStore(path.join(dataDir, "w.db"));
    await enqueueDispatchSpec(dataDir, spec("accepted"), store.turnAttempts);
    const row = store.turnAttempts.get("accepted");
    expect(row?.state).toBe("pending");
    expect(row?.promptStarted).toBe(false);
    expect(row?.generation).toBe(0);
    expect(store.turnAttempts.get("never-accepted")).toBeNull();
  });

  it("materializes a leftover pending file while boot recovery still holds claim closed", async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "seam-513-"));
    store = new SessionStore(path.join(dataDir, "w.db"));
    await dropFile("leftover");
    let releaseRecovery: () => void = () => {};
    const recovery = new Promise<void>((resolve) => { releaseRecovery = resolve; });
    let started = 0;
    const watcher = new DispatchWatcher({
      dataDir,
      logger,
      attempts: store.turnAttempts,
      beforeAdmission: () => recovery,
      onDispatch: async () => {
        started += 1;
        return { output: "ran", stopReason: "end_turn" };
      },
    });
    watchers.add(watcher);
    await watcher.start({ waitForInitialDispatches: false });
    expect(watcher.isAcceptingDispatches).toBe(false);
    expect(store.turnAttempts.get("leftover")?.state).toBe("pending");
    expect(started).toBe(0);
    watcher.stop();
    releaseRecovery();
    await watcher.admissionReleased();
  });

  it("stays pending when accepted during closed admission, and does not start", async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "seam-513-"));
    store = new SessionStore(path.join(dataDir, "w.db"));
    let releaseRecovery: () => void = () => {};
    const recovery = new Promise<void>((resolve) => { releaseRecovery = resolve; });
    let started = 0;
    const watcher = new DispatchWatcher({
      dataDir,
      logger,
      attempts: store.turnAttempts,
      beforeAdmission: () => recovery,
      onDispatch: async () => {
        started += 1;
        return { output: "ran", stopReason: "end_turn" };
      },
    });
    watchers.add(watcher);
    await watcher.start({ waitForInitialDispatches: false });
    await enqueueDispatchSpec(dataDir, spec("during-recovery"), store.turnAttempts);
    expect(watcher.isAcceptingDispatches).toBe(false);
    expect(store.turnAttempts.get("during-recovery")?.state).toBe("pending");
    expect(started).toBe(0);
    watcher.stop();
    releaseRecovery();
    await watcher.admissionReleased();
  });
});

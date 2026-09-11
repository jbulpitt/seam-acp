import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { reconcileCompletedDoneFiles, type DoneReconcileDeps } from "../packages/core/src/core/dispatch/done-reconcile.js";
import { dispatchDirs, type DispatchResult } from "../packages/core/src/core/dispatch/types.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const silent = pino({ level: "silent" }) as unknown as Logger;
let dataDir: string;
let store: SessionStore;
beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "seam-193-"));
  store = new SessionStore(path.join(dataDir, "state.sqlite"));
  await mkdir(dispatchDirs(dataDir).done, { recursive: true });
});
afterEach(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
async function writeDone(id: string, fields: Partial<DispatchResult> = {}): Promise<void> {
  await writeFile(path.join(dispatchDirs(dataDir).done, `${id}.json`), JSON.stringify({
    id, target: "worker", status: "completed", output: `result-${id}`,
    finishedUtc: "2026-07-01T00:00:00.000Z", kind: "wake", ...fields,
  }));
}
function deps(replay: DoneReconcileDeps["replay"] = async () => {}): DoneReconcileDeps {
  return { dataDir, logger: silent, getDelegation: (id) => store.getDelegation(id),
    listRecoveryCandidates: (after, limit) => store.listNonTerminalDelegations(after, limit), replay };
}

describe("bounded done recovery remains separate from proof-only retention (#193/#306)", () => {
  it("opens only indexed recovery ids, never terminal history", async () => {
    for (let i = 0; i < 80; i++) await writeDone(`unknown-${i}`);
    for (let i = 0; i < 5; i++) {
      store.recordDelegation({ id: `terminal-${i}`, kind: "wake", status: "completed" });
      await writeDone(`terminal-${i}`);
      store.recordDelegation({ id: `repair-${i}`, kind: "wake", status: "interrupted" });
      await writeDone(`repair-${i}`);
    }
    const replay = vi.fn(async (result: DispatchResult) => { store.updateDelegationStatus(result.id, "completed"); });
    const summary = await reconcileCompletedDoneFiles({ ...deps(replay), recoveryBatchSize: 2 });
    // Without the SQL recovery index, lifetime completed history inflates boot
    // work; recovery must not also implement its own deletion policy.
    expect(summary).toMatchObject({ recoveryCandidates: 2, scanned: 2, reconciled: 2 });
    expect(replay).toHaveBeenCalledTimes(2);
    expect(await readdir(dispatchDirs(dataDir).done)).toHaveLength(90);
  });

  it("replays only completion side effects once, retaining the artifact for the delivery resolver", async () => {
    store.recordDelegation({ id: "finished-worker", kind: "handoff", status: "interrupted" });
    await writeDone("finished-worker", { kind: "handoff", correlationId: "job-1", returnTo: "origin" });
    const replay = vi.fn(async (result: DispatchResult) => {
      store.recordDelegation({ id: "delivery-1", kind: "report_back", status: "dispatched", correlationId: result.correlationId });
      store.updateDelegationStatus(result.id, "completed");
    });
    await reconcileCompletedDoneFiles(deps(replay));
    await reconcileCompletedDoneFiles(deps(replay));
    // Deleting here confuses onward enqueue with delivery and loses the parent's recovery buffer.
    expect(replay).toHaveBeenCalledOnce();
    await expect(access(path.join(dispatchDirs(dataDir).done, "finished-worker.json"))).resolves.toBeUndefined();
  });

  it("retains malformed non-terminal output in its canonical recovery location", async () => {
    store.recordDelegation({ id: "active-corrupt", kind: "wake", status: "interrupted" });
    await writeFile(path.join(dispatchDirs(dataDir).done, "active-corrupt.json"), "{broken");
    const summary = await reconcileCompletedDoneFiles(deps());
    // Quarantining/deleting unparseable undelivered output hides the only evidence available for repair.
    expect(summary).toMatchObject({ recoveryCandidates: 1, failed: 1 });
    await expect(access(path.join(dispatchDirs(dataDir).done, "active-corrupt.json"))).resolves.toBeUndefined();
  });
});

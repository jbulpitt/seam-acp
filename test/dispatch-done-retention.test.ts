import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import {
  reconcileCompletedDoneFiles,
  type DoneReconcileDeps,
} from "../packages/core/src/core/dispatch/done-reconcile.js";
import { dispatchDirs, type DispatchResult } from "../packages/core/src/core/dispatch/types.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const silent = pino({ level: "silent" }) as unknown as Logger;
const NOW = new Date("2026-09-03T12:00:00.000Z");
const OLD = "2026-07-01T00:00:00.000Z";

let dataDir: string;
let store: SessionStore;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "seam-193-"));
  store = new SessionStore(path.join(dataDir, "state.sqlite"));
  await mkdir(dispatchDirs(dataDir).done, { recursive: true });
});

afterEach(async () => {
  store.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function writeDone(
  id: string,
  fields: Partial<DispatchResult> = {}
): Promise<void> {
  await writeFile(
    path.join(dispatchDirs(dataDir).done, `${id}.json`),
    JSON.stringify({
      id,
      target: "worker",
      status: "completed",
      output: `result-${id}`,
      finishedUtc: OLD,
      kind: "wake",
      ...fields,
    }),
    "utf8"
  );
}

function deps(
  replay: DoneReconcileDeps["replay"] = async () => {}
): DoneReconcileDeps {
  return {
    dataDir,
    logger: silent,
    getDelegation: (id) => store.getDelegation(id),
    listRecoveryCandidates: (after, limit) => store.listNonTerminalDelegations(after, limit),
    replay,
    retention: {
      listCandidates: (cutoffUtc, after, limit) =>
        store.listTerminalDelegationsForDoneRetention(cutoffUtc, after, limit),
      getReportBackByCorrelation: (correlationId) =>
        store.getReportBackByCorrelation(correlationId),
      now: () => NOW,
      maxAgeMs: 24 * 60 * 60 * 1000,
      batchSize: 32,
    },
  };
}

function record(
  id: string,
  status: "dispatched" | "running" | "completed" | "failed" | "timed_out" | "parked" | "interrupted" | "abandoned",
  fields: Record<string, unknown> = {}
): void {
  store.recordDelegation({
    id,
    kind: "wake",
    status,
    createdUtc: OLD,
    updatedUtc: OLD,
    ...fields,
  });
}

describe("#193 bounded done-file recovery and retention", () => {
  it("opens only indexed recovery ids plus one hard-capped terminal page", async () => {
    for (let i = 0; i < 80; i++) {
      await writeDone(`lifetime-${i}`); // deliberately no ledger row
    }
    for (let i = 0; i < 5; i++) {
      record(`terminal-${i}`, "completed");
      await writeDone(`terminal-${i}`);
    }
    for (let i = 0; i < 5; i++) {
      record(`repair-${i}`, "interrupted");
      await writeDone(`repair-${i}`);
    }

    const replay = vi.fn(async (result: DispatchResult) => {
      store.updateDelegationStatus(result.id, "completed");
    });
    const configured = deps(replay);
    const info = vi.fn();
    configured.logger = { info, warn: vi.fn() } as unknown as Logger;
    configured.recoveryBatchSize = 2;
    configured.retention!.batchSize = 2;
    const summary = await reconcileCompletedDoneFiles(configured);

    expect(summary).toMatchObject({
      recoveryCandidates: 2,
      retentionCandidates: 2,
      scanned: 4,
      reconciled: 2,
      pruned: 2,
    });
    expect(replay).toHaveBeenCalledTimes(2);
    expect(await readdir(dispatchDirs(dataDir).done)).toHaveLength(88);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ scanned: 4, pruned: 2, quarantined: 0, failed: 0 }),
      "done-reconcile: boot maintenance summary"
    );
  });

  it("replays a crash-before-terminal completion once without invoking a paid worker", async () => {
    record("finished-worker", "interrupted", { kind: "handoff" });
    await writeDone("finished-worker", {
      kind: "handoff",
      correlationId: "job-1",
      returnTo: "origin",
    });
    const paidWorker = vi.fn();
    const replay = vi.fn(async (result: DispatchResult) => {
      record("delivery-1", "dispatched", {
        kind: "report_back",
        correlationId: result.correlationId,
      });
      store.updateDelegationStatus(result.id, "completed");
    });

    await reconcileCompletedDoneFiles(deps(replay));
    await reconcileCompletedDoneFiles(deps(replay));

    expect(replay).toHaveBeenCalledOnce();
    expect(paidWorker).not.toHaveBeenCalled();
    await expect(access(path.join(dispatchDirs(dataDir).done, "finished-worker.json"))).resolves.toBeUndefined();
  });

  it("retains a terminal parent through the report-back crash window, then prunes after ack", async () => {
    record("parent", "completed", { kind: "handoff", correlationId: "job-2" });
    record("delivery", "dispatched", { kind: "report_back", correlationId: "job-2" });
    await writeDone("parent", {
      kind: "handoff",
      correlationId: "job-2",
      returnTo: "origin",
    });

    const pending = await reconcileCompletedDoneFiles(deps());
    expect(pending.retainedPending).toBe(1);
    await expect(access(path.join(dispatchDirs(dataDir).done, "parent.json"))).resolves.toBeUndefined();

    store.updateDelegationStatus("delivery", "abandoned");
    const abandoned = await reconcileCompletedDoneFiles(deps());
    expect(abandoned.retainedPending).toBe(1);

    store.updateDelegationStatus("delivery", "completed");
    const settled = await reconcileCompletedDoneFiles(deps());
    expect(settled.pruned).toBe(1);
    await expect(access(path.join(dispatchDirs(dataDir).done, "parent.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains a chain parent until the durable plan's actual child is settled", async () => {
    record("chain-parent", "completed", { kind: "forward" });
    record("chain-plan", "completed", {
      kind: "report_back",
      correlationId: "chain-parent",
      targetRef: "chain-child",
    });
    record("chain-child", "dispatched", { kind: "forward" });
    await writeDone("chain-parent", { kind: "forward", chainId: "chain-1" });

    const pending = await reconcileCompletedDoneFiles(deps());
    expect(pending.retainedPending).toBe(1);
    store.updateDelegationStatus("chain-child", "completed");
    const settled = await reconcileCompletedDoneFiles(deps());
    expect(settled.pruned).toBe(1);
  });

  it("quarantines malformed and unreadable terminal artifacts without replaying them", async () => {
    record("malformed", "completed");
    record("unreadable", "completed");
    await writeFile(path.join(dispatchDirs(dataDir).done, "malformed.json"), "{broken", "utf8");
    await mkdir(path.join(dispatchDirs(dataDir).done, "unreadable.json"));
    const replay = vi.fn(async () => {});

    const summary = await reconcileCompletedDoneFiles(deps(replay));

    expect(summary).toMatchObject({ recoveryCandidates: 0, scanned: 2, quarantined: 2 });
    expect(replay).not.toHaveBeenCalled();
    expect(await readdir(path.join(dispatchDirs(dataDir).root, "done-quarantine"))).toHaveLength(2);
    expect(await readdir(dispatchDirs(dataDir).done)).toEqual([]);
    expect(store.getDelegation("malformed")?.status).toBe("completed");
  });

  it("never moves a malformed non-terminal artifact out of recovery authority", async () => {
    record("active-corrupt", "interrupted");
    await writeFile(path.join(dispatchDirs(dataDir).done, "active-corrupt.json"), "{broken", "utf8");

    const summary = await reconcileCompletedDoneFiles(deps());

    expect(summary).toMatchObject({ recoveryCandidates: 1, quarantined: 0, failed: 1 });
    await expect(access(path.join(dispatchDirs(dataDir).done, "active-corrupt.json"))).resolves.toBeUndefined();
  });

  it("repeats an already-pruned page safely after a crash before cursor commit", async () => {
    for (const id of ["a", "b", "c"]) {
      record(id, "completed");
      await writeDone(id);
    }
    const configured = deps();
    configured.retention!.batchSize = 2;
    const first = await reconcileCompletedDoneFiles(configured);
    expect(first.pruned).toBe(2);

    const cursor = JSON.parse(
      await readFile(path.join(dispatchDirs(dataDir).root, ".done-retention-cursor.json"), "utf8")
    );
    expect(cursor).toEqual({ updatedUtc: OLD, id: "b" });
    // Restore the exact durable state a process death after unlink but before
    // cursor rename leaves: the artifacts are gone and the old cursor is absent.
    await rm(path.join(dispatchDirs(dataDir).root, ".done-retention-cursor.json"));
    const repeated = await reconcileCompletedDoneFiles(configured);
    expect(repeated).toMatchObject({ retentionCandidates: 2, scanned: 0, pruned: 0 });
    const resumed = await reconcileCompletedDoneFiles(configured);
    expect(resumed).toMatchObject({ retentionCandidates: 1, pruned: 1 });
  });
});

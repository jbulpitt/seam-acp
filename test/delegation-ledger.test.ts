import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import {
  PROMPT_PREVIEW_MAX,
  type LedgerEntryInput,
} from "../packages/core/src/core/types.js";

let dir: string;
let store: SessionStore;

const sample = (over: Partial<LedgerEntryInput> = {}): LedgerEntryInput => ({
  id: "del-1",
  sourceRef: "discord:thread-a",
  targetRef: "discord:thread-b",
  worker: "researcher",
  kind: "handoff",
  promptPreview: "summarize the runbook",
  correlationId: "corr-1",
  ...over,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-ledger-"));
  store = new SessionStore(path.join(dir, "test.db"));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("delegation ledger", () => {
  it("inserts and reads back", () => {
    const written = store.recordDelegation(sample());
    const [read] = store.listRecentDelegations();
    expect(read).toEqual(written);
    expect(read).toMatchObject({
      id: "del-1",
      sourceRef: "discord:thread-a",
      targetRef: "discord:thread-b",
      worker: "researcher",
      kind: "handoff",
      promptPreview: "summarize the runbook",
      correlationId: "corr-1",
    });
  });

  it("defaults status to dispatched and stamps timestamps", () => {
    const w = store.recordDelegation({ id: "del-x", kind: "handoff" });
    expect(w.status).toBe("dispatched");
    expect(w.createdUtc).toBe(w.updatedUtc);
    expect(Number.isNaN(Date.parse(w.createdUtc))).toBe(false);
    // Unset optional fields round-trip as null, not undefined.
    expect(w.sourceRef).toBeNull();
    expect(w.targetRef).toBeNull();
    expect(w.worker).toBeNull();
    expect(w.promptPreview).toBeNull();
    expect(w.correlationId).toBeNull();
    expect(w.acpSessionId).toBeNull();
  });

  it("records a scheduler-origin turn with no source", () => {
    store.recordDelegation({ id: "del-s", kind: "scheduled", sourceRef: null });
    expect(store.listRecentDelegations()[0]?.sourceRef).toBeNull();
  });

  it("truncates promptPreview on write", () => {
    const long = "x".repeat(PROMPT_PREVIEW_MAX + 50);
    const w = store.recordDelegation(sample({ promptPreview: long }));
    expect(w.promptPreview).toHaveLength(PROMPT_PREVIEW_MAX);
    expect(store.listRecentDelegations()[0]?.promptPreview).toHaveLength(
      PROMPT_PREVIEW_MAX
    );
  });

  it("transitions status and re-stamps updated_utc", async () => {
    const w = store.recordDelegation(
      sample({ createdUtc: "2026-01-01T00:00:00.000Z" })
    );
    expect(w.status).toBe("dispatched");

    store.updateDelegationStatus("del-1", "running");
    let row = store.getDelegationByCorrelation("corr-1");
    expect(row?.status).toBe("running");
    expect(row?.createdUtc).toBe("2026-01-01T00:00:00.000Z");
    expect(Date.parse(row!.updatedUtc)).toBeGreaterThan(
      Date.parse(row!.createdUtc)
    );

    store.updateDelegationStatus("del-1", "completed");
    row = store.getDelegationByCorrelation("corr-1");
    expect(row?.status).toBe("completed");
  });

  it("applies an optional patch alongside the status change", () => {
    store.recordDelegation(
      sample({ id: "del-2", targetRef: null, correlationId: "corr-2" })
    );
    store.updateDelegationStatus("del-2", "running", {
      targetRef: "discord:thread-resolved",
      worker: "reviewer",
    });
    const row = store.getDelegationByCorrelation("corr-2");
    expect(row).toMatchObject({
      status: "running",
      targetRef: "discord:thread-resolved",
      worker: "reviewer",
      // Untouched fields survive the patch.
      sourceRef: "discord:thread-a",
      kind: "handoff",
    });
  });

  it("truncates a patched promptPreview too", () => {
    store.recordDelegation(sample({ id: "del-3", correlationId: "corr-3" }));
    store.updateDelegationStatus("del-3", "running", {
      promptPreview: "y".repeat(PROMPT_PREVIEW_MAX + 10),
    });
    expect(
      store.getDelegationByCorrelation("corr-3")?.promptPreview
    ).toHaveLength(PROMPT_PREVIEW_MAX);
  });

  it("treats an unknown id as a no-op", () => {
    store.recordDelegation(sample());
    expect(() => store.updateDelegationStatus("nope", "failed")).not.toThrow();
    expect(store.getDelegationByCorrelation("corr-1")?.status).toBe(
      "dispatched"
    );
  });

  it("getDelegationByCorrelation returns null when absent", () => {
    expect(store.getDelegationByCorrelation("missing")).toBeNull();
  });

  it("getDelegationByCorrelation returns the originating row", () => {
    store.recordDelegation(
      sample({
        id: "late",
        kind: "report_back",
        correlationId: "shared",
        createdUtc: "2026-02-02T00:00:00.000Z",
      })
    );
    store.recordDelegation(
      sample({
        id: "origin",
        kind: "handoff",
        correlationId: "shared",
        createdUtc: "2026-01-01T00:00:00.000Z",
      })
    );
    expect(store.getDelegationByCorrelation("shared")?.id).toBe("origin");
  });

  it("listActiveDelegations returns only in-flight rows, oldest first", () => {
    const mk = (id: string, status: LedgerEntryInput["status"], day: string) =>
      store.recordDelegation(
        sample({
          id,
          status,
          correlationId: id,
          createdUtc: `2026-03-${day}T00:00:00.000Z`,
        })
      );
    mk("running-2", "running", "04");
    mk("dispatched-1", "dispatched", "03");
    mk("done", "completed", "01");
    mk("bad", "failed", "01");
    mk("late", "timed_out", "01");
    mk("held", "parked", "01");

    expect(store.listActiveDelegations().map((e) => e.id)).toEqual([
      "dispatched-1",
      "running-2",
    ]);
  });

  it("listActiveDelegations drops a row once it completes", () => {
    store.recordDelegation(sample());
    expect(store.listActiveDelegations()).toHaveLength(1);
    store.updateDelegationStatus("del-1", "completed");
    expect(store.listActiveDelegations()).toHaveLength(0);
  });

  it("listRecentDelegations orders newest first and honors the limit", () => {
    store.recordDelegation(
      sample({ id: "old", correlationId: "c-old", createdUtc: "2026-01-01T00:00:00.000Z" })
    );
    store.recordDelegation(
      sample({ id: "new", correlationId: "c-new", createdUtc: "2026-06-01T00:00:00.000Z" })
    );
    expect(store.listRecentDelegations().map((e) => e.id)).toEqual([
      "new",
      "old",
    ]);
    expect(store.listRecentDelegations(1).map((e) => e.id)).toEqual(["new"]);
  });

  it("listDelegationsBySource filters by originating thread", () => {
    store.recordDelegation(sample({ id: "a1", correlationId: "c1", sourceRef: "thread-a" }));
    store.recordDelegation(sample({ id: "b1", correlationId: "c2", sourceRef: "thread-b" }));
    store.recordDelegation(sample({ id: "a2", correlationId: "c3", sourceRef: "thread-a" }));

    expect(store.listDelegationsBySource("thread-a").map((e) => e.id).sort()).toEqual(
      ["a1", "a2"]
    );
    expect(store.listDelegationsBySource("thread-b").map((e) => e.id)).toEqual([
      "b1",
    ]);
    expect(store.listDelegationsBySource("thread-z")).toEqual([]);
  });

  it("persists the ledger across store reopen", () => {
    const dbPath = path.join(dir, "reopen.db");
    const s1 = new SessionStore(dbPath);
    s1.recordDelegation(sample());
    s1.close();

    const s2 = new SessionStore(dbPath);
    expect(s2.getDelegationByCorrelation("corr-1")?.id).toBe("del-1");
    s2.close();
  });

  it("tryRecordReportBack claims a correlation once and skips the second write", () => {
    const first = store.tryRecordReportBack({
      id: "rb-1",
      kind: "report_back",
      sourceRef: "thread-w",
      targetRef: "thread-boss",
      correlationId: "corr-dup",
      promptPreview: "done",
    });
    expect(first).toMatchObject({
      id: "rb-1",
      kind: "report_back",
      correlationId: "corr-dup",
      status: "dispatched",
    });
    expect(store.getReportBackByCorrelation("corr-dup")?.id).toBe("rb-1");

    const second = store.tryRecordReportBack({
      id: "rb-2",
      kind: "report_back",
      correlationId: "corr-dup",
    });
    expect(second).toBeNull();
    // Still exactly one report_back row for this correlation.
    expect(
      store.listRecentDelegations().filter(
        (e) => e.kind === "report_back" && e.correlationId === "corr-dup"
      )
    ).toHaveLength(1);
  });

  it("getReportBackByCorrelation ignores a handoff row that shares the correlation", () => {
    store.recordDelegation(
      sample({ id: "handoff-1", kind: "handoff", correlationId: "shared-rb" })
    );
    expect(store.getReportBackByCorrelation("shared-rb")).toBeNull();
    expect(store.getDelegationByCorrelation("shared-rb")?.id).toBe("handoff-1");

    store.tryRecordReportBack({
      id: "rb-shared",
      kind: "report_back",
      correlationId: "shared-rb",
    });
    expect(store.getReportBackByCorrelation("shared-rb")?.id).toBe("rb-shared");
    // Originating-row lookup is still the earlier handoff.
    expect(store.getDelegationByCorrelation("shared-rb")?.id).toBe("handoff-1");
  });

  it("tryRecordReportBack rejects a non-report_back kind", () => {
    expect(() =>
      store.tryRecordReportBack(sample({ kind: "handoff" }))
    ).toThrow(/report_back/);
  });

  it("persists acpSessionId via the running-status patch", () => {
    store.recordDelegation(sample({ id: "del-sid", correlationId: "corr-sid" }));
    store.updateDelegationStatus("del-sid", "running", {
      acpSessionId: "acp-isolated-99",
    });
    const row = store.getDelegation("del-sid");
    expect(row).toMatchObject({
      status: "running",
      acpSessionId: "acp-isolated-99",
      targetRef: "discord:thread-b",
      correlationId: "corr-sid",
    });
    store.close();
    store = new SessionStore(path.join(dir, "test.db"));
    expect(store.getDelegation("del-sid")?.acpSessionId).toBe("acp-isolated-99");
  });

  it("adds acp_session_id to a legacy delegation_log without dropping rows or the report_back index", () => {
    store.close();
    const dbFile = path.join(dir, "legacy-ledger.db");
    const raw = new Database(dbFile);
    raw.exec(`
      CREATE TABLE delegation_log (
        id              TEXT PRIMARY KEY,
        source_ref      TEXT,
        target_ref      TEXT,
        worker          TEXT,
        kind            TEXT NOT NULL,
        prompt_preview  TEXT,
        correlation_id  TEXT,
        status          TEXT NOT NULL,
        created_utc     TEXT NOT NULL,
        updated_utc     TEXT NOT NULL
      );
    `);
    raw
      .prepare(
        `INSERT INTO delegation_log
           (id, source_ref, target_ref, worker, kind, prompt_preview,
            correlation_id, status, created_utc, updated_utc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "legacy-1",
        "thread-a",
        "thread-b",
        "researcher",
        "handoff",
        "old work",
        "corr-legacy",
        "running",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z"
      );
    raw.close();

    store = new SessionStore(dbFile);
    const cols = new Database(dbFile)
      .pragma("table_info(delegation_log)") as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "acp_session_id")).toBe(true);
    const row = store.getDelegation("legacy-1");
    expect(row?.status).toBe("running");
    expect(row?.acpSessionId).toBeNull();
    expect(row?.correlationId).toBe("corr-legacy");

    store.updateDelegationStatus("legacy-1", "running", {
      acpSessionId: "sess-migrated",
    });
    expect(store.getDelegation("legacy-1")?.acpSessionId).toBe("sess-migrated");

    // #77 unique index still claims a report_back once on the migrated table.
    expect(
      store.tryRecordReportBack({
        id: "rb-legacy",
        kind: "report_back",
        correlationId: "corr-legacy",
      })
    ).not.toBeNull();
    expect(
      store.tryRecordReportBack({
        id: "rb-legacy-2",
        kind: "report_back",
        correlationId: "corr-legacy",
      })
    ).toBeNull();
  });

  it("reconcileOrphanedDelegations flips only in-flight rows to interrupted", () => {
    const mk = (id: string, status: LedgerEntryInput["status"], extra: Partial<LedgerEntryInput> = {}) =>
      store.recordDelegation(
        sample({
          id,
          status,
          correlationId: id,
          acpSessionId: extra.acpSessionId ?? null,
          createdUtc: "2026-03-01T00:00:00.000Z",
          updatedUtc: "2026-03-01T00:00:00.000Z",
          ...extra,
        })
      );
    mk("run-1", "running", { acpSessionId: "sess-run", targetRef: "thread-w" });
    mk("disp-1", "dispatched", { targetRef: "thread-x" });
    mk("done-1", "completed", { acpSessionId: "sess-done" });
    mk("fail-1", "failed");
    mk("late-1", "timed_out");
    mk("held-1", "parked");

    const flipped = store.reconcileOrphanedDelegations("2026-03-02T12:00:00.000Z");
    expect(flipped).toBe(2);

    const run = store.getDelegation("run-1")!;
    expect(run.status).toBe("interrupted");
    expect(run.updatedUtc).toBe("2026-03-02T12:00:00.000Z");
    expect(run.acpSessionId).toBe("sess-run");
    expect(run.targetRef).toBe("thread-w");
    expect(run.correlationId).toBe("run-1");

    expect(store.getDelegation("disp-1")).toMatchObject({
      status: "interrupted",
      targetRef: "thread-x",
      updatedUtc: "2026-03-02T12:00:00.000Z",
    });

    expect(store.getDelegation("done-1")).toMatchObject({
      status: "completed",
      acpSessionId: "sess-done",
      updatedUtc: "2026-03-01T00:00:00.000Z",
    });
    expect(store.getDelegation("fail-1")?.status).toBe("failed");
    expect(store.getDelegation("late-1")?.status).toBe("timed_out");
    expect(store.getDelegation("held-1")?.status).toBe("parked");

    // Interrupted is no longer in-flight.
    expect(store.listActiveDelegations()).toEqual([]);
    expect(store.listDelegationsByStatus(["interrupted"]).map((e) => e.id).sort()).toEqual([
      "disp-1",
      "run-1",
    ]);
  });

  it("opening a store does not reconcile — only an explicit boot call does", () => {
    store.recordDelegation(sample({ status: "running", acpSessionId: "keep" }));
    store.close();
    store = new SessionStore(path.join(dir, "test.db"));
    expect(store.getDelegation("del-1")?.status).toBe("running");
    expect(store.getDelegation("del-1")?.acpSessionId).toBe("keep");
  });

  it("abandons only stale running rows and is idempotent", () => {
    store.recordDelegation(sample({
      id: "stale-run",
      correlationId: "stale-run",
      status: "running",
      acpSessionId: "acp-stale",
      updatedUtc: "2026-03-01T10:00:00.000Z",
    }));
    store.recordDelegation(sample({
      id: "fresh-run",
      correlationId: "fresh-run",
      status: "running",
      updatedUtc: "2026-03-01T11:30:00.000Z",
    }));
    store.recordDelegation(sample({
      id: "old-dispatched",
      correlationId: "old-dispatched",
      status: "dispatched",
      updatedUtc: "2026-03-01T10:00:00.000Z",
    }));
    store.recordDelegation(sample({
      id: "old-completed",
      correlationId: "old-completed",
      status: "completed",
      updatedUtc: "2026-03-01T10:00:00.000Z",
    }));

    expect(
      store.abandonStaleRunningDelegations(
        "2026-03-01T11:00:00.000Z",
        "2026-03-01T12:00:00.000Z"
      )
    ).toBe(1);
    expect(store.getDelegation("stale-run")).toMatchObject({
      status: "abandoned",
      acpSessionId: "acp-stale",
      updatedUtc: "2026-03-01T12:00:00.000Z",
    });
    expect(store.getDelegation("fresh-run")?.status).toBe("running");
    expect(store.getDelegation("old-dispatched")?.status).toBe("dispatched");
    expect(store.getDelegation("old-completed")?.status).toBe("completed");
    expect(
      store.abandonStaleRunningDelegations(
        "2026-03-01T11:00:00.000Z",
        "2026-03-01T12:01:00.000Z"
      )
    ).toBe(0);
  });

  it("the report_back claim survives a store reopen", () => {
    const dbPath = path.join(dir, "rb-reopen.db");
    const s1 = new SessionStore(dbPath);
    expect(
      s1.tryRecordReportBack({
        id: "rb-persist",
        kind: "report_back",
        correlationId: "corr-persist",
      })
    ).not.toBeNull();
    s1.close();

    const s2 = new SessionStore(dbPath);
    expect(s2.getReportBackByCorrelation("corr-persist")?.id).toBe("rb-persist");
    expect(
      s2.tryRecordReportBack({
        id: "rb-persist-2",
        kind: "report_back",
        correlationId: "corr-persist",
      })
    ).toBeNull();
    s2.close();
  });
});

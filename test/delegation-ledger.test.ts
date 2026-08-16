import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../src/core/session-store.js";
import {
  PROMPT_PREVIEW_MAX,
  type LedgerEntryInput,
} from "../src/core/types.js";

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
});

import { describe, expect, it } from "vitest";
import { visibleWorkflowHistory, visibleWorkflowLedger } from "../packages/core/src/platforms/discord/workflow-retention.js";
import type { InterruptedTurnRow } from "../packages/core/src/platforms/discord/workflows-view.js";
import type { LedgerEntry } from "../packages/core/src/core/types.js";

const now = new Date("2026-10-05T12:00:00.000Z");
const old = "2026-09-01T12:00:00.000Z";
const recent = "2026-10-04T12:00:00.000Z";
const row = (id: string, startedUtc: string, actions: InterruptedTurnRow["actions"]): InterruptedTurnRow => ({
  id, source: "dispatch", channelRef: "thread", correlationId: null,
  status: "interrupted", startedUtc, acpSessionId: null, actions,
});

describe("workflow history retention", () => {
  it("hides only older inert rows, without removing actionable work or modifying the input", () => {
    const rows = [row("old-inert", old, []), row("old-parked", old, ["abandon"]), row("recent", recent, [])];
    expect(visibleWorkflowHistory(rows, now)).toEqual({ rows: rows.slice(1), hidden: 1 });
    expect(rows.map(item => item.id)).toEqual(["old-inert", "old-parked", "recent"]);
    expect(visibleWorkflowHistory(rows, now, true)).toEqual({ rows, hidden: 0 });
  });

  it("keeps the boundary and unknown dates visible", () => {
    const rows = [row("boundary", "2026-09-28T12:00:00.000Z", []), row("unknown", "", [])];
    expect(visibleWorkflowHistory(rows, now).rows).toEqual(rows);
  });

  it("does not leak old terminal history back through Recent or Anomalies", () => {
    const entries = [
      { id: "old-completed", status: "completed", updatedUtc: old },
      { id: "old-abandoned", status: "abandoned", updatedUtc: old },
      { id: "retained-output", status: "completed", updatedUtc: old },
      { id: "running", status: "running", updatedUtc: old },
      { id: "recent", status: "completed", updatedUtc: recent },
    ] as LedgerEntry[];
    const actionable = new Set(["retained-output"]);
    expect(visibleWorkflowLedger(entries, now, false, actionable).map(entry => entry.id))
      .toEqual(["retained-output", "running", "recent"]);
    expect(visibleWorkflowLedger(entries, now, true, actionable)).toEqual(entries);
  });
});

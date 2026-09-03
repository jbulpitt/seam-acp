import { describe, it, expect } from "vitest";
import type { LedgerEntry } from "../packages/core/src/core/types.js";
import {
  formatWorkflowsView,
  groupByCorrelation,
  shortId,
  shortRef,
  formatAge,
  clampFieldValue,
  formatInterruptedLine,
  formatInterruptedLines,
  interruptedRowActions,
  isActionableInterruptedRow,
  paginateInterruptedRows,
  WORKFLOW_INVENTORY_PAGE_SIZE,
  type InterruptedTurnRow,
} from "../packages/core/src/platforms/discord/workflows-view.js";

const NOW = new Date("2026-08-16T12:00:00.000Z");

const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  id: "del-abc12345def",
  sourceRef: "discord:thread-a",
  targetRef: "discord:thread-b",
  worker: "researcher",
  kind: "handoff",
  promptPreview: "summarize the runbook",
  correlationId: "corr-1",
  acpSessionId: null,
  status: "running",
  createdUtc: "2026-08-16T11:58:00.000Z",
  updatedUtc: "2026-08-16T11:58:00.000Z",
  ...over,
});

describe("shortId", () => {
  it("takes the trailing segment, clamped to 8 chars", () => {
    expect(shortId("del-abc12345def")).toBe("abc12345");
    expect(shortId("del-1")).toBe("1");
    expect(shortId("plainid")).toBe("plainid");
  });
});

describe("shortRef", () => {
  it("strips the platform prefix and falls back when null", () => {
    expect(shortRef("discord:thread-a", "scheduler")).toBe("thread-a");
    expect(shortRef(null, "scheduler")).toBe("scheduler");
    expect(shortRef(null, "…")).toBe("…");
  });
  it("clamps very long refs", () => {
    expect(shortRef("discord:0123456789abcdefghij", "x")).toBe("0123456789abcdefg…");
  });
});

describe("formatAge", () => {
  it("renders coarse buckets", () => {
    expect(formatAge("2026-08-16T11:59:30.000Z", NOW)).toBe("30s");
    expect(formatAge("2026-08-16T11:58:00.000Z", NOW)).toBe("2m");
    expect(formatAge("2026-08-16T09:00:00.000Z", NOW)).toBe("3h");
    expect(formatAge("2026-08-14T12:00:00.000Z", NOW)).toBe("2d");
  });
  it("clamps future timestamps to 0s and handles garbage", () => {
    expect(formatAge("2026-08-16T12:05:00.000Z", NOW)).toBe("0s");
    expect(formatAge("not-a-date", NOW)).toBe("?");
  });
});

describe("groupByCorrelation", () => {
  it("keeps rows sharing a correlation id together at first-seen position", () => {
    const rows = [
      entry({ id: "del-1", correlationId: "c1" }),
      entry({ id: "del-2", correlationId: "c2" }),
      entry({ id: "del-3", correlationId: "c1" }),
    ];
    const groups = groupByCorrelation(rows);
    expect(groups.map((g) => g.map((e) => e.id))).toEqual([
      ["del-1", "del-3"],
      ["del-2"],
    ]);
  });

  it("treats null correlation ids as singleton groups", () => {
    const rows = [
      entry({ id: "del-1", correlationId: null }),
      entry({ id: "del-2", correlationId: null }),
    ];
    expect(groupByCorrelation(rows)).toHaveLength(2);
  });
});

describe("formatWorkflowsView", () => {
  it("flags an empty ledger", () => {
    const view = formatWorkflowsView([], [], NOW);
    expect(view.empty).toBe(true);
    expect(view.active.count).toBe(0);
    expect(view.recent.count).toBe(0);
  });

  it("renders one active line per row", () => {
    const view = formatWorkflowsView([entry({ id: "del-xyz99999" })], [], NOW);
    expect(view.empty).toBe(false);
    expect(view.active.lines).toHaveLength(1);
    expect(view.active.lines[0]).toContain("`xyz99999`");
    expect(view.active.lines[0]).toContain("handoff");
    expect(view.active.lines[0]).toContain("thread-a→thread-b");
    expect(view.active.lines[0]).toContain("running");
    expect(view.active.lines[0]).toContain("2m");
  });

  it("groups a handoff and its report-back into adjacent lines, oldest first", () => {
    const recent = [
      // arrives newest-first, as listRecentDelegations returns
      entry({
        id: "del-back",
        kind: "report_back",
        correlationId: "c1",
        status: "completed",
        createdUtc: "2026-08-16T11:59:00.000Z",
      }),
      entry({
        id: "del-out",
        kind: "handoff",
        correlationId: "c1",
        createdUtc: "2026-08-16T11:58:00.000Z",
      }),
    ];
    const view = formatWorkflowsView([], recent, NOW);
    expect(view.recent.count).toBe(2);
    // handoff (older) first, report_back as a continuation line
    expect(view.recent.lines[0]).toContain("`out`");
    expect(view.recent.lines[0]).toContain("handoff");
    expect(view.recent.lines[1]!.startsWith("↳ ")).toBe(true);
    expect(view.recent.lines[1]).toContain("report_back");
  });

  it("labels scheduler-origin rows and unresolved targets", () => {
    const view = formatWorkflowsView(
      [entry({ sourceRef: null, targetRef: null, kind: "scheduled" })],
      [],
      NOW
    );
    expect(view.active.lines[0]).toContain("scheduler→…");
  });
});

describe("formatInterruptedLine", () => {
  it("renders thread, age, and correlation for Resume/Abandon inventory", () => {
    const line = formatInterruptedLine(
      {
        id: "disp-abc12345",
        source: "dispatch",
        channelRef: "discord:thread-worker",
        correlationId: "corr-xyz98765",
        status: "interrupted",
        startedUtc: "2026-08-16T11:50:00.000Z",
        acpSessionId: "acp-1",
      },
      NOW
    );
    expect(line).toContain("⚠️");
    expect(line).toContain("dispatch");
    expect(line).toContain("interrupted");
    expect(line).toContain("thread-worker");
    expect(line).toContain("corr");
    expect(line).toContain("10m");
  });

  it("uses the abandoned icon", () => {
    const lines = formatInterruptedLines(
      [
        {
          id: "live-1",
          source: "live",
          channelRef: "t",
          correlationId: null,
          status: "abandoned",
          startedUtc: "2026-08-16T11:00:00.000Z",
          acpSessionId: null,
        },
      ],
      NOW
    );
    expect(lines[0]).toContain("🚫");
    expect(lines[0]).toContain("abandoned");
    expect(lines[0]).toContain("live");
  });
});

describe("clampFieldValue", () => {
  it("returns a placeholder for no lines", () => {
    expect(clampFieldValue([])).toBe("_none_");
  });

  it("joins lines under the cap verbatim", () => {
    expect(clampFieldValue(["a", "b", "c"])).toBe("a\nb\nc");
  });

  it("drops overflow with an …and N more summary", () => {
    const lines = Array.from({ length: 50 }, (_, i) => "x".repeat(60) + i);
    const out = clampFieldValue(lines, 200);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).toMatch(/…and \d+ more$/);
  });
});

// --- Workflow inventory controls (#159) -----------------------------------

const irow = (over: Partial<InterruptedTurnRow> = {}): InterruptedTurnRow => ({
  id: "del-aaaa1111",
  source: "dispatch",
  channelRef: "discord:thread-a",
  correlationId: null,
  status: "interrupted",
  startedUtc: "2026-08-16T11:50:00.000Z",
  acpSessionId: "acp-1",
  ...over,
});

describe("interruptedRowActions", () => {
  it("an interrupted row can be resumed or abandoned", () => {
    expect(interruptedRowActions(irow())).toEqual(["resume", "abandon"]);
  });

  it("an already-abandoned dispatch keeps only Resume — Abandon is consumed", () => {
    expect(interruptedRowActions(irow({ status: "abandoned" }))).toEqual(["resume"]);
  });

  it("an abandoned row with no recorded session has no live action at all", () => {
    expect(interruptedRowActions(irow({ status: "abandoned", acpSessionId: null }))).toEqual([]);
    expect(isActionableInterruptedRow(irow({ status: "abandoned", acpSessionId: null }))).toBe(false);
  });

  it("an abandoned live turn has nothing left to click", () => {
    expect(
      interruptedRowActions(irow({ source: "live", status: "abandoned", acpSessionId: "acp-9" }))
    ).toEqual([]);
  });
});

describe("paginateInterruptedRows", () => {
  const rows = Array.from({ length: 9 }, (_, i) => irow({ id: `del-${i}` }));

  it("keeps the inventory compact: 4 actionable rows per page plus a nav row", () => {
    expect(WORKFLOW_INVENTORY_PAGE_SIZE).toBe(4);
    const first = paginateInterruptedRows(rows, 0);
    expect(first.page).toBe(0);
    expect(first.pageCount).toBe(3);
    expect(first.total).toBe(9);
    expect(first.items.map((r) => r.id)).toEqual(["del-0", "del-1", "del-2", "del-3"]);
  });

  it("paginates only the actionable rows — dead ones are summary-only", () => {
    const mixed = [
      irow({ id: "live-1" }),
      irow({ id: "dead-1", status: "abandoned", acpSessionId: null }),
      irow({ id: "dead-2", source: "live", status: "abandoned" }),
      irow({ id: "live-2" }),
    ];
    const slice = paginateInterruptedRows(mixed, 0);
    expect(slice.total).toBe(2);
    expect(slice.pageCount).toBe(1);
    expect(slice.items.map((r) => r.id)).toEqual(["live-1", "live-2"]);
  });

  it("clamps an out-of-range page (the store shrank under the card)", () => {
    expect(paginateInterruptedRows(rows, 99).page).toBe(2);
    expect(paginateInterruptedRows(rows, -4).page).toBe(0);
  });

  it("a Resume/Abandon rebuild drops the consumed row's controls", () => {
    // Page 1 of a two-page inventory, then the acted-on row leaves the set.
    const before = Array.from({ length: 5 }, (_, i) => irow({ id: `del-${i}` }));
    expect(paginateInterruptedRows(before, 1).items.map((r) => r.id)).toEqual(["del-4"]);

    // `del-4` was abandoned: it is still listed, but has no live action, so the
    // rebuilt card has no page 1 and no button for it.
    const after = before.map((r) =>
      r.id === "del-4" ? irow({ id: "del-4", status: "abandoned", acpSessionId: null }) : r
    );
    const rebuilt = paginateInterruptedRows(after, 1);
    expect(rebuilt.total).toBe(4);
    expect(rebuilt.pageCount).toBe(1);
    expect(rebuilt.page).toBe(0);
    expect(rebuilt.items.map((r) => r.id)).not.toContain("del-4");
  });

  it("an inventory with nothing actionable renders no controls at all", () => {
    const dead = [irow({ status: "abandoned", acpSessionId: null })];
    const slice = paginateInterruptedRows(dead, 0);
    expect(slice.total).toBe(0);
    expect(slice.items).toEqual([]);
    // …while the summary still lists it.
    expect(formatInterruptedLines(dead, NOW)).toHaveLength(1);
  });
});

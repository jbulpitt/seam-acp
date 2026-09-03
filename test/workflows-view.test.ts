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
  buildInterruptedInventory,
  fitEmbedFields,
  DISCORD_EMBED_TOTAL_LIMIT,
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
        targetRef: "discord:thread-worker",
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
          targetRef: "t",
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
  targetRef: "discord:thread-b",
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

  // resumeTurnManually's ledger path needs BOTH the target it re-enqueues into
  // and the session to load; offering Resume on either alone renders a button
  // that can only answer "missing target or ACP session".
  it("an abandoned dispatch missing targetRef offers nothing", () => {
    const row = irow({ status: "abandoned", targetRef: null });
    expect(interruptedRowActions(row)).toEqual([]);
    expect(isActionableInterruptedRow(row)).toBe(false);
  });

  it("an interrupted dispatch missing targetRef keeps Abandon but drops Resume", () => {
    expect(interruptedRowActions(irow({ targetRef: null }))).toEqual(["abandon"]);
  });

  it("an interrupted dispatch missing its session keeps Abandon but drops Resume", () => {
    expect(interruptedRowActions(irow({ acpSessionId: null }))).toEqual(["abandon"]);
  });

  it("an abandoned live turn has nothing left to click", () => {
    expect(
      interruptedRowActions(irow({ source: "live", status: "abandoned", acpSessionId: "acp-9" }))
    ).toEqual([]);
  });

  it("a live marker is always abandonable, and resumable only with a session", () => {
    expect(interruptedRowActions(irow({ source: "live" }))).toEqual(["resume", "abandon"]);
    expect(interruptedRowActions(irow({ source: "live", acpSessionId: null }))).toEqual(["abandon"]);
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
      irow({ id: "dead-1", status: "abandoned", targetRef: null }),
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

describe("buildInterruptedInventory — text matches the buttons", () => {
  // 9 actionable rows: three pages of controls.
  const rows = Array.from({ length: 9 }, (_, i) =>
    irow({ id: `del-actionable-${i}`, channelRef: `discord:thread-${i}` })
  );

  it("page 0 lists exactly the rows its buttons act on, in button order", () => {
    const section = buildInterruptedInventory(rows, 0, NOW);
    expect(section.items.map((r) => r.id)).toEqual([
      "del-actionable-0",
      "del-actionable-1",
      "del-actionable-2",
      "del-actionable-3",
    ]);
    for (const row of section.items) {
      expect(section.actionable!.value).toContain(shortId(row.id));
    }
  });

  // The regression QA asked for: with the whole inventory in one field the
  // 1024-char clamp dropped later pages' rows, so buttons pointed at text the
  // operator could not see.
  it("a later page shows its own rows and none of page 0's", () => {
    const section = buildInterruptedInventory(rows, 2, NOW);
    expect(section.page).toBe(2);
    expect(section.items.map((r) => r.id)).toEqual(["del-actionable-8"]);
    expect(section.actionable!.value).toContain("thread-8");
    expect(section.actionable!.value).not.toContain("thread-0");
    expect(section.actionable!.value).not.toContain("thread-3");
  });

  it("every page's visible line count equals its button-row count", () => {
    for (let page = 0; page < 3; page++) {
      const section = buildInterruptedInventory(rows, page, NOW);
      const lines = section
        .actionable!.value.split("\n")
        .filter((line) => !line.startsWith("_"));
      expect(lines).toHaveLength(section.items.length);
      lines.forEach((line, idx) => {
        expect(line).toContain(shortId(section.items[idx]!.id));
      });
    }
  });

  it("carries a page caption only when there is more than one page", () => {
    expect(buildInterruptedInventory(rows, 0, NOW).actionable!.value).toContain("Page 1 of 3");
    const single = buildInterruptedInventory(rows.slice(0, 3), 0, NOW);
    expect(single.actionable!.value).not.toContain("Page");
  });

  it("non-actionable rows stay in their own compact summary, not the button field", () => {
    const mixed = [
      irow({ id: "del-live-1", channelRef: "discord:thread-live" }),
      irow({ id: "del-dead-1", channelRef: "discord:thread-dead", status: "abandoned", targetRef: null }),
    ];
    const section = buildInterruptedInventory(mixed, 0, NOW);
    expect(section.total).toBe(1);
    expect(section.actionable!.value).toContain("thread-live");
    expect(section.actionable!.value).not.toContain("thread-dead");
    expect(section.inert!.name).toContain("no action available (1)");
    expect(section.inert!.value).toContain("thread-dead");
  });

  it("an inventory with nothing actionable has no button field at all", () => {
    const dead = [irow({ status: "abandoned", targetRef: null })];
    const section = buildInterruptedInventory(dead, 0, NOW);
    expect(section.actionable).toBeNull();
    expect(section.items).toEqual([]);
    expect(section.inert).not.toBeNull();
  });

  it("stays inside Discord's field and action-row limits at worst case", () => {
    // Longest line this formatter can emit: every optional part present and
    // every id/ref past its clamp.
    const fat = Array.from({ length: 40 }, (_, i) =>
      irow({
        id: `del-${"9".repeat(24)}${i}`,
        channelRef: `discord:${"z".repeat(40)}`,
        correlationId: `corr-${"8".repeat(24)}`,
        startedUtc: "2020-01-01T00:00:00.000Z",
      })
    );
    for (let page = 0; page < 10; page++) {
      const section = buildInterruptedInventory(fat, page, NOW);
      // 4 control rows + 1 nav row = Discord's 5-action-row cap.
      expect(section.items.length).toBeLessThanOrEqual(4);
      expect(section.actionable!.value.length).toBeLessThanOrEqual(1024);
      expect(section.inert?.value.length ?? 0).toBeLessThanOrEqual(1024);
      // No row a button acts on may be clamped out of the visible text.
      expect(section.actionable!.value).not.toContain("…and");
      for (const row of section.items) {
        expect(section.actionable!.value).toContain(shortId(row.id));
      }
    }
  });
});

describe("fitEmbedFields — Discord's 6000-char aggregate cap", () => {
  const field = (name: string, size: number) => ({ name, value: "x".repeat(size) });

  it("keeps everything when the card already fits", () => {
    const fitted = fitEmbedFields([field("a", 100), field("b", 100)], 50);
    expect(fitted.dropped).toBe(0);
    expect(fitted.fields.map((f) => f.name)).toEqual(["a", "b"]);
  });

  it("ten 1024-char sections would blow the cap, so optional ones are dropped", () => {
    const fields = Array.from({ length: 10 }, (_, i) => field(`f${i}`, 1024));
    const fitted = fitEmbedFields(fields, 200);
    const total =
      200 + fitted.fields.reduce((sum, f) => sum + f.name.length + f.value.length, 0);
    expect(total).toBeLessThanOrEqual(DISCORD_EMBED_TOTAL_LIMIT);
    expect(fitted.dropped).toBeGreaterThan(0);
    expect(fitted.fields.length + fitted.dropped).toBe(10);
  });

  it("never drops a required section — the rows with buttons under them", () => {
    const fields = [
      ...Array.from({ length: 9 }, (_, i) => field(`bulk${i}`, 1024)),
      { ...field("actionable", 400), required: true },
    ];
    const fitted = fitEmbedFields(fields, 200);
    expect(fitted.fields.map((f) => f.name)).toContain("actionable");
    expect(fitted.dropped).toBeGreaterThan(0);
    const total =
      200 + fitted.fields.reduce((sum, f) => sum + f.name.length + f.value.length, 0);
    expect(total).toBeLessThanOrEqual(DISCORD_EMBED_TOTAL_LIMIT);
  });

  it("keeps surviving fields in their original order", () => {
    // "huge" does not fit in what "first" leaves behind, but "last" still does.
    const fields = [field("first", 2000), field("huge", 3900), field("last", 200)];
    const fitted = fitEmbedFields(fields, 100);
    expect(fitted.fields.map((f) => f.name)).toEqual(["first", "last"]);
    expect(fitted.dropped).toBe(1);
  });

  it("a required section that alone exceeds the budget is still kept", () => {
    const fitted = fitEmbedFields([{ ...field("actionable", 1024), required: true }], 5500);
    expect(fitted.fields).toHaveLength(1);
    expect(fitted.dropped).toBe(0);
  });
});

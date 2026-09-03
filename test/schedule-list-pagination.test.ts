/**
 * #152 — `/seamadmin schedule list` pagination.
 *
 * Two classes of test: the pure page math / view budget (this file's first
 * half), and the wired card — that a `sl:page:<n>` click is answered before the
 * schedule-id lookup, that the page survives every refresh, and that a delete
 * on the last page re-clamps instead of stranding the operator.
 */
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import {
  EMBED_DESCRIPTION_LIMIT,
  SCHEDULE_LIST_PAGE_SIZE,
  paginateSchedules,
  parseScheduleListCustomId,
  requestedSchedulePage,
  scheduleListDescription,
  scheduleNavState,
  schedulePageCaption,
  schedulePageCustomId,
  scheduleRunOutcome,
} from "../packages/core/src/platforms/discord/schedule-list-view.js";
import type { ScheduledPrompt } from "../packages/core/src/core/scheduled-prompts/types.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

const ids = (n: number) => Array.from({ length: n }, (_, k) => `s${k}`);

function schedule(over: Partial<ScheduledPrompt> = {}): ScheduledPrompt {
  return {
    id: "sch_1",
    platform: "discord",
    channelRef: "thread-1",
    parentRef: "chan-1",
    name: "nightly",
    promptText: "Follow docs/runbooks/n.md",
    cron: "0 9 * * *",
    timezone: "America/Chicago",
    model: null,
    cwd: null,
    targetChannel: null,
    outputType: "card",
    sessionMode: "isolated",
    catchupSeconds: 7200,
    enabled: true,
    legacyAttachmentCount: 0,
    createdBy: "u1",
    createdUtc: "2026-09-01T00:00:00.000Z",
    updatedUtc: "2026-09-01T00:00:00.000Z",
    lastRunUtc: null,
    lastStatus: null,
    nextRunUtc: null,
    pinnedSessionId: null,
    ...over,
  };
}

// --- page math ---------------------------------------------------------------

describe("#152 paginateSchedules", () => {
  it("pages four at a time so four action rows + one nav row fit Discord's five", () => {
    expect(SCHEDULE_LIST_PAGE_SIZE).toBe(4);
    const slice = paginateSchedules(ids(20), 0);
    expect(slice.items).toHaveLength(4);
    expect(slice.pageCount).toBe(5);
  });

  it("carries a partial remainder on the final page", () => {
    // 6 rows = 4 + 2. The remainder page must be short, not padded or dropped.
    const last = paginateSchedules(ids(6), 1);
    expect(last.items).toEqual(["s4", "s5"]);
    expect(last.pageCount).toBe(2);
    expect(last.start).toBe(4);
  });

  it.each([
    [1, 1, 1],
    [4, 1, 4],
    [5, 2, 1],
    [8, 2, 4],
    [9, 3, 1],
    [20, 5, 4],
  ])("%i rows → %i pages, last page holds %i", (total, pageCount, lastSize) => {
    const first = paginateSchedules(ids(total), 0);
    expect(first.pageCount).toBe(pageCount);
    expect(paginateSchedules(ids(total), pageCount - 1).items).toHaveLength(lastSize);
  });

  it("clamps a negative page to the first", () => {
    expect(paginateSchedules(ids(9), -1).page).toBe(0);
    expect(paginateSchedules(ids(9), -999).page).toBe(0);
  });

  it("clamps an out-of-range page to the last", () => {
    expect(paginateSchedules(ids(9), 3).page).toBe(2);
    expect(paginateSchedules(ids(9), 9_999).page).toBe(2);
  });

  it("clamps NaN and fractional requests rather than producing an empty slice", () => {
    // `Number("x")` from a hand-crafted custom id.
    expect(paginateSchedules(ids(9), Number.NaN).page).toBe(0);
    expect(paginateSchedules(ids(9), Number.POSITIVE_INFINITY).page).toBe(2);
    expect(paginateSchedules(ids(9), 1.7).page).toBe(1);
    expect(paginateSchedules(ids(9), Number.NaN).items).toHaveLength(4);
  });

  it("an empty list is page 1 of 1, not page 1 of 0", () => {
    const slice = paginateSchedules([], 0);
    expect(slice).toMatchObject({ page: 0, pageCount: 1, total: 0, items: [] });
    expect(paginateSchedules([], 5).page).toBe(0);
  });
});

// --- nav state ---------------------------------------------------------------

describe("#152 scheduleNavState", () => {
  it("shows no nav at all for a single page", () => {
    expect(scheduleNavState(0, 1).show).toBe(false);
    expect(schedulePageCaption(paginateSchedules(ids(4), 0))).toBeNull();
  });

  it("disables Prev on the first page and Next on the last", () => {
    const first = scheduleNavState(0, 3);
    expect(first).toMatchObject({ show: true, prevDisabled: true, nextDisabled: false, label: "Page 1/3" });
    const middle = scheduleNavState(1, 3);
    expect(middle).toMatchObject({ prevDisabled: false, nextDisabled: false, label: "Page 2/3" });
    const last = scheduleNavState(2, 3);
    expect(last).toMatchObject({ prevDisabled: false, nextDisabled: true, label: "Page 3/3" });
  });

  it("targets the adjacent pages", () => {
    const nav = scheduleNavState(1, 3);
    expect(schedulePageCustomId(nav.prevPage)).toBe("sl:page:0");
    expect(schedulePageCustomId(nav.nextPage)).toBe("sl:page:2");
  });

  it("captions which slice is on screen once there is more than one page", () => {
    expect(schedulePageCaption(paginateSchedules(ids(9), 1))).toBe(
      "Page 2 of 3 · showing 5-8 of 9"
    );
    expect(schedulePageCaption(paginateSchedules(ids(9), 2))).toBe(
      "Page 3 of 3 · showing 9-9 of 9"
    );
  });
});

// --- custom-id grammar -------------------------------------------------------

describe("#152 sl:<action>:<arg> grammar", () => {
  it("preserves the pre-existing action/arg split", () => {
    expect(parseScheduleListCustomId("sl:run:sch_ab")).toEqual({ action: "run", arg: "sch_ab" });
    expect(parseScheduleListCustomId("sl:edit:sch_ab")).toEqual({ action: "edit", arg: "sch_ab" });
    expect(parseScheduleListCustomId("sl:toggle:sch_ab")).toEqual({ action: "toggle", arg: "sch_ab" });
    expect(parseScheduleListCustomId("sl:del:sch_ab")).toEqual({ action: "del", arg: "sch_ab" });
  });

  it("keeps an arg containing colons intact", () => {
    expect(parseScheduleListCustomId("sl:run:a:b:c")).toEqual({ action: "run", arg: "a:b:c" });
  });

  it("rejects ids that are not ours", () => {
    expect(parseScheduleListCustomId("wf:page:1")).toBeNull();
    expect(parseScheduleListCustomId("sl:run")).toBeNull();
    expect(parseScheduleListCustomId("sl::x")).toBeNull();
    expect(parseScheduleListCustomId("")).toBeNull();
  });

  it("recognises a page click and only a page click", () => {
    expect(requestedSchedulePage("sl:page:0")).toBe(0);
    expect(requestedSchedulePage("sl:page:7")).toBe(7);
    expect(requestedSchedulePage("sl:run:sch_ab")).toBeNull();
    expect(requestedSchedulePage("wf:page:2")).toBeNull();
  });

  it("treats an unparseable page index as a page click for page 0, not a schedule id", () => {
    // The click IS navigation; `paginateSchedules` decides where it lands.
    expect(requestedSchedulePage("sl:page:abc")).toBe(0);
    expect(requestedSchedulePage("sl:page:-3")).toBe(-3);
  });
});

// --- embed budget ------------------------------------------------------------

describe("#152 description budget", () => {
  it("describes only the current page", () => {
    const slice = paginateSchedules(ids(20), 2);
    const text = scheduleListDescription(slice.items, schedulePageCaption(slice));
    expect(text).toContain("s8");
    expect(text).toContain("s11");
    expect(text).not.toContain("s0");
    expect(text).not.toContain("s12");
  });

  it("stays under 4096 for a worst-case page of four maximal entries", () => {
    // Four entries far larger than the whole budget. Each is tagged at its head
    // so we can prove the clamp kept all four rather than dropping any.
    const entries = Array.from({ length: 4 }, (_, k) => `ENTRY${k}-${"E".repeat(3000)}`);
    const caption = "Page 1 of 9 · showing 1-4 of 36";
    const text = scheduleListDescription(entries, caption);

    expect(text.length).toBeLessThanOrEqual(EMBED_DESCRIPTION_LIMIT);
    // Every entry is still represented — one long status must not swallow the
    // page, and no entry may be dropped silently.
    for (let k = 0; k < 4; k++) expect(text, `entry ${k}`).toContain(`ENTRY${k}-`);
    // The caption is the last thing appended, so it must also have survived.
    expect(text).toContain(caption);
    // Each oversized entry was truncated rather than emitted whole.
    expect(text.split("…").length - 1).toBe(4);
  });

  it("splits the budget evenly so one huge entry cannot starve its siblings", () => {
    const entries = ["S".repeat(9000), "tiny", "also-tiny", "third"];
    const text = scheduleListDescription(entries, null);
    expect(text.length).toBeLessThanOrEqual(EMBED_DESCRIPTION_LIMIT);
    expect(text).toContain("tiny");
    expect(text).toContain("also-tiny");
    expect(text).toContain("third");
  });

  it("never exceeds the limit even with an absurd caption", () => {
    const text = scheduleListDescription([`${"x".repeat(9000)}`], "y".repeat(9000));
    expect(text.length).toBeLessThanOrEqual(EMBED_DESCRIPTION_LIMIT);
  });

  it("leaves a normal page untouched", () => {
    const text = scheduleListDescription(["alpha", "beta"], null);
    expect(text).toBe("alpha\n\nbeta");
  });

  it("has an empty-state description", () => {
    expect(scheduleListDescription([], null)).toContain("No scheduled prompts");
  });
});

// --- #163 follow-up: Run now must not claim a refused run finished -----------

describe("#163 scheduleRunOutcome", () => {
  it("does not say a quarantined schedule finished", () => {
    const msg = scheduleRunOutcome({
      name: "Cleanup stories",
      status: "quarantined: 2 legacy attachments (#158) — edit this schedule to re-arm it",
      quarantined: true,
    });
    expect(msg).not.toContain("finished");
    expect(msg).toContain("did not run");
    expect(msg).toContain("quarantined");
    expect(msg).toContain("runbook");
  });

  it("still reports a real run as finished", () => {
    expect(scheduleRunOutcome({ name: "n", status: "ok" })).toContain("finished");
  });

  it("names each non-finishing outcome accurately", () => {
    expect(scheduleRunOutcome({ name: "n", status: "skipped: still running" })).toContain("already running");
    const locked = scheduleRunOutcome({ name: "n", status: "skipped: target locked" });
    expect(locked).toContain("did not run");
    expect(locked).not.toContain("finished");
    const failed = scheduleRunOutcome({ name: "n", status: "error: boom" });
    expect(failed).toContain("failed");
    expect(failed).not.toContain("finished");
    const aborted = scheduleRunOutcome({ name: "n", status: "aborted: user turn" });
    expect(aborted).toContain("interrupted");
    expect(aborted).not.toContain("finished");
  });

  it("falls back to unknown rather than inventing a status", () => {
    expect(scheduleRunOutcome({ name: "n", status: null })).toContain("unknown");
  });
});

// --- the wired card ----------------------------------------------------------

interface Painted {
  embeds?: Array<{ data: { description?: string } }>;
  components?: Array<{ components?: unknown[] }>;
}

/** Drive `cmdScheduleList` against an in-memory store and capture every paint. */
function makeListCard(rows: ScheduledPrompt[]) {
  const store = new Map(rows.map((r) => [r.id, { ...r }]));
  const paints: Painted[] = [];
  const collector = Object.assign(new EventEmitter(), {
    stop: vi.fn((reason?: string) => collector.emit("end", [], reason ?? "user")),
  });
  const interaction = {
    user: { id: "u1" },
    reply: async (p: Painted) => {
      paints.push(p);
    },
    editReply: async (p: Painted) => {
      paints.push(p);
    },
    fetchReply: async () => ({
      id: "m1",
      createMessageComponentCollector: () => collector,
    }),
  };
  const self = {
    logger: silent,
    config: { DATA_DIR: "/tmp" },
    channelRefFromInteraction: () => ({ platform: "discord", id: "thread-1", parentId: "chan-1" }),
    store: {
      listScheduledByChannel: () => [...store.values()],
      getScheduled: (id: string) => store.get(id) ?? null,
      upsertScheduled: (s: ScheduledPrompt) => store.set(s.id, { ...s }),
      deleteScheduled: (id: string) => store.delete(id),
    },
    scheduledManager: { runNow: vi.fn(async () => {}), armFromRow: vi.fn(), disarm: vi.fn() },
    attachListLifecycle: Orchestrator.prototype["attachListLifecycle" as never],
    buildScheduleListMessage: Orchestrator.prototype["buildScheduleListMessage" as never],
    scheduleSummaryLine: Orchestrator.prototype["scheduleSummaryLine" as never],
  };
  const start = (
    Orchestrator.prototype as unknown as {
      cmdScheduleList(this: unknown, i: unknown): Promise<void>;
    }
  ).cmdScheduleList.call(self, interaction);
  return { start, collector, paints, store };
}

function click(customId: string) {
  const replies: string[] = [];
  return {
    interaction: {
      isButton: () => true,
      customId,
      user: { id: "u1" },
      deferUpdate: vi.fn(async () => {}),
      deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async (p: { content?: string } | string) => {
        replies.push(typeof p === "string" ? p : p.content ?? "");
      }),
      reply: vi.fn(async (p: { content?: string }) => {
        replies.push(p.content ?? "");
      }),
    },
    replies,
  };
}

/** Fire one component click and let its async handler settle. */
async function fire(collector: EventEmitter, customId: string) {
  const c = click(customId);
  collector.emit("collect", c.interaction);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  return c;
}

function lastPaint(paints: Painted[]) {
  const p = paints[paints.length - 1]!;
  return {
    description: p.embeds?.[0]?.data.description ?? "",
    rowCount: p.components?.length ?? 0,
    navIds: (p.components ?? []).flatMap((row) =>
      ((row as { components?: Array<{ data?: { custom_id?: string } }> }).components ?? [])
        .map((b) => b.data?.custom_id ?? "")
        .filter((id) => id.startsWith("sl:page:"))
    ),
  };
}

describe("#152 wired schedule list card", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, k) => schedule({ id: `sch_${k}`, name: `job-${k}` }));

  it("renders one page of four plus a nav row, never more than five rows", async () => {
    const { start, paints } = makeListCard(many(20));
    await start;
    const view = lastPaint(paints);
    expect(view.rowCount).toBe(5); // 4 schedules + 1 nav
    expect(view.navIds).toEqual(["sl:page:-1", "sl:page:0", "sl:page:1"]);
    expect(view.description).toContain("job-0");
    expect(view.description).toContain("job-3");
    expect(view.description).not.toContain("job-4");
  });

  it("shows no nav row when everything fits on one page", async () => {
    const { start, paints } = makeListCard(many(3));
    await start;
    const view = lastPaint(paints);
    expect(view.rowCount).toBe(3);
    expect(view.navIds).toEqual([]);
  });

  it("answers sl:page:<n> as navigation, not as a missing schedule", async () => {
    const { start, collector, paints } = makeListCard(many(20));
    await start;
    const c = await fire(collector, "sl:page:2");
    // The regression this guards: the id lookup running first would answer
    // "That schedule no longer exists."
    expect(c.replies.join(" ")).not.toContain("no longer exists");
    expect(c.interaction.deferUpdate).toHaveBeenCalled();
    const view = lastPaint(paints);
    expect(view.description).toContain("job-8");
    expect(view.description).toContain("job-11");
    expect(view.description).not.toContain("job-7");
  });

  it("clamps an out-of-range page click onto the last page", async () => {
    const { start, collector, paints } = makeListCard(many(20));
    await start;
    await fire(collector, "sl:page:99");
    const view = lastPaint(paints);
    expect(view.description).toContain("job-16");
    expect(view.description).toContain("Page 5 of 5");
  });

  it("threads the current page through a toggle refresh", async () => {
    const { start, collector, paints, store } = makeListCard(many(20));
    await start;
    await fire(collector, "sl:page:2");
    await fire(collector, "sl:toggle:sch_9");
    expect(store.get("sch_9")!.enabled).toBe(false);
    const view = lastPaint(paints);
    // Still on page 3 — a toggle must not bounce the operator back to page 1.
    expect(view.description).toContain("Page 3 of 5");
    expect(view.description).toContain("job-9");
  });

  it("threads the current page through a Run-now refresh", async () => {
    const { start, collector, paints } = makeListCard(many(20));
    await start;
    await fire(collector, "sl:page:1");
    await fire(collector, "sl:run:sch_5");
    expect(lastPaint(paints).description).toContain("Page 2 of 5");
  });

  it("re-clamps after deleting the last row on the last page", async () => {
    // 5 rows = page 0 (4) + page 1 (1). Deleting page 1's only row leaves a
    // single page; the card must walk back rather than paint an empty page 2.
    const { start, collector, paints, store } = makeListCard(many(5));
    await start;
    await fire(collector, "sl:page:1");
    expect(lastPaint(paints).description).toContain("Page 2 of 2");
    await fire(collector, "sl:del:sch_4");
    expect(store.has("sch_4")).toBe(false);
    const view = lastPaint(paints);
    expect(view.description).toContain("job-0");
    expect(view.description).not.toContain("Page 2");
    // One page left ⇒ nav is gone entirely.
    expect(view.navIds).toEqual([]);
    expect(view.rowCount).toBe(4);
  });

  it("keeps the operator on a still-valid page when a delete only shrinks it", async () => {
    const { start, collector, paints } = makeListCard(many(9));
    await start;
    await fire(collector, "sl:page:2"); // page 3 of 3, holds sch_8 alone
    await fire(collector, "sl:del:sch_8");
    const view = lastPaint(paints);
    expect(view.description).toContain("Page 2 of 2");
    expect(view.description).toContain("job-7");
  });

  it("reports a quarantined Run-now as not run", async () => {
    const rows = many(2);
    rows[0] = schedule({ id: "sch_0", name: "job-0", legacyAttachmentCount: 2, lastStatus: null });
    const { start, collector } = makeListCard(rows);
    await start;
    const c = await fire(collector, "sl:run:sch_0");
    const text = c.replies.join(" ");
    expect(text).toContain("did not run");
    expect(text).not.toContain("finished");
  });

  it("still refuses a genuinely unknown schedule id", async () => {
    const { start, collector } = makeListCard(many(4));
    await start;
    const c = await fire(collector, "sl:run:sch_nope");
    expect(c.replies.join(" ")).toContain("no longer exists");
  });
});

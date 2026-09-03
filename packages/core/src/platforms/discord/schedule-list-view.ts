/**
 * `/seam schedule list` pagination (#152).
 *
 * The listing rendered every schedule into one embed with controls for the
 * first five. That is two bugs in one card: a channel with twenty schedules
 * produced a description that could exceed Discord's 4096-char limit, and the
 * rows past the fifth were described but had no controls at all.
 *
 * Pagination fixes both by construction — the description carries ONLY the
 * current page, and every described row on that page has its own action row.
 * Four per page is the ceiling: Discord allows five action rows per message,
 * so four schedule rows leave exactly one for Prev/Page/Next.
 *
 * Kept free of `discord.js` imports so the clamp, the nav states, and the
 * embed budget are unit-testable without a gateway.
 */

/** Four schedule action rows + one nav row = Discord's five-action-row cap. */
export const SCHEDULE_LIST_PAGE_SIZE = 4;

/** Discord's hard cap on an embed description. */
export const EMBED_DESCRIPTION_LIMIT = 4096;

/** Separator between two schedule entries in the description. */
const ENTRY_SEPARATOR = "\n\n";

export interface SchedulePage<T> {
  /** The RESOLVED page after clamping — never the raw request. */
  page: number;
  /** Always ≥ 1, so "page 1 of 1" is the empty-list shape too. */
  pageCount: number;
  total: number;
  /** Index of `items[0]` in the full list. */
  start: number;
  items: T[];
}

/**
 * Slice `rows` into one page, clamping the request into range.
 *
 * Clamping is total: negative, fractional, `NaN` (what `Number("sl:page:x")`
 * yields), and beyond-the-end all resolve to a real page. That matters because
 * the page number arrives from a custom id, and because deleting the last row
 * on the last page must land the operator somewhere that exists rather than on
 * an empty page with a live Next button.
 */
export function paginateSchedules<T>(
  rows: ReadonlyArray<T>,
  page: number,
  pageSize: number = SCHEDULE_LIST_PAGE_SIZE
): SchedulePage<T> {
  const size = Math.max(1, Math.floor(pageSize) || SCHEDULE_LIST_PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil(rows.length / size) || 1);
  // NaN has no direction, so it means "page 0". ±Infinity does have one, and
  // clamping it to the near edge (rather than to 0) keeps the clamp monotonic.
  const requested = Number.isNaN(page) ? 0 : Math.floor(page);
  const resolved = Math.min(Math.max(0, requested), pageCount - 1);
  const start = resolved * size;
  return {
    page: resolved,
    pageCount,
    total: rows.length,
    start,
    items: rows.slice(start, start + size) as T[],
  };
}

/**
 * A parsed `sl:<action>:<arg>` custom id, or null when it is not ours.
 *
 * The grammar is load-bearing and unchanged from before #152: `action` is the
 * second segment and `arg` is *the rest*, so a schedule id containing a colon
 * would still round-trip. `sl:page:<n>` rides the same grammar — which is why
 * the caller must branch on `action === "page"` BEFORE looking `arg` up as a
 * schedule id, or a page click answers "That schedule no longer exists."
 */
export interface ScheduleListAction {
  action: string;
  arg: string;
}

export function parseScheduleListCustomId(customId: string): ScheduleListAction | null {
  const parts = customId.split(":");
  if (parts.length < 3 || parts[0] !== "sl") return null;
  const action = parts[1] ?? "";
  const arg = parts.slice(2).join(":");
  if (!action || !arg) return null;
  return { action, arg };
}

/** The custom id for a nav button targeting `page` (0-based). */
export function schedulePageCustomId(page: number): string {
  return `sl:page:${page}`;
}

/**
 * The page a `sl:page:<n>` click asks for, or null when `customId` is not a
 * page click. An unparseable index yields 0 rather than null: the click IS a
 * page click, and `paginateSchedules` is what decides where it lands.
 */
export function requestedSchedulePage(customId: string): number | null {
  const parsed = parseScheduleListCustomId(customId);
  if (!parsed || parsed.action !== "page") return null;
  const n = Number(parsed.arg);
  return Number.isFinite(n) ? Math.floor(n) : 0;
}

/** Prev / Next enablement for a rendered page. Nav is hidden entirely at one page. */
export interface ScheduleNavState {
  show: boolean;
  prevPage: number;
  nextPage: number;
  prevDisabled: boolean;
  nextDisabled: boolean;
  label: string;
}

export function scheduleNavState(page: number, pageCount: number): ScheduleNavState {
  return {
    // A single page needs no navigation, and rendering a fully-disabled nav row
    // would only add a dead control to a card that has nowhere to go.
    show: pageCount > 1,
    prevPage: page - 1,
    nextPage: page + 1,
    prevDisabled: page <= 0,
    nextDisabled: page >= pageCount - 1,
    label: `Page ${page + 1}/${pageCount}`,
  };
}

/** Caption appended under the entries when there is more than one page. */
export function schedulePageCaption(slice: SchedulePage<unknown>): string | null {
  if (slice.pageCount <= 1) return null;
  const first = slice.total === 0 ? 0 : slice.start + 1;
  const last = slice.start + slice.items.length;
  return `Page ${slice.page + 1} of ${slice.pageCount} · showing ${first}-${last} of ${slice.total}`;
}

/**
 * Join one page's entries into a description that cannot exceed Discord's
 * 4096-char cap.
 *
 * Only the current page is ever described, so the realistic worst case is far
 * under the limit — but "realistic" is not a guarantee: `lastStatus` is
 * operator-visible free text (a clamped error message, a quarantine notice),
 * so the budget is enforced rather than assumed. Entries are clamped to an
 * equal share first, which keeps all four visible instead of letting one long
 * status swallow the page, and a final truncate backstops the arithmetic.
 */
export function scheduleListDescription(
  entries: ReadonlyArray<string>,
  caption?: string | null,
  limit: number = EMBED_DESCRIPTION_LIMIT
): string {
  if (entries.length === 0) return "_No scheduled prompts for this thread._";
  const suffix = caption ? ENTRY_SEPARATOR + caption : "";
  const separators = ENTRY_SEPARATOR.length * (entries.length - 1);
  const budget = limit - suffix.length - separators;
  const perEntry = Math.max(1, Math.floor(budget / entries.length));
  const clamped = entries.map((e) => (e.length > perEntry ? e.slice(0, Math.max(1, perEntry - 1)) + "…" : e));
  const text = clamped.join(ENTRY_SEPARATOR) + suffix;
  return text.length > limit ? text.slice(0, limit - 1) + "…" : text;
}

/**
 * The ephemeral reply for a "Run now" click (#163 follow-up).
 *
 * The old copy said "**<name>** finished" for every non-overlap outcome, which
 * is wrong for a run that never started: a schedule quarantined by #158 is
 * refused at the fire boundary, and reporting it as finished told the operator
 * their job had run when nothing had. Each outcome now names itself.
 */
export function scheduleRunOutcome(opts: {
  name: string;
  /** `last_status` after the run attempt. */
  status: string | null | undefined;
  /** True when the row is quarantined and was refused before firing. */
  quarantined?: boolean;
}): string {
  const name = `**${opts.name}**`;
  const status = opts.status ?? "unknown";
  if (opts.quarantined) {
    return (
      `🚫 ${name} did not run — it is quarantined (legacy reference files, #158). ` +
      `Edit the schedule so its prompt stands alone or points at a repository runbook, then it will run again.`
    );
  }
  if (status === "skipped: still running") {
    return `⏸️ ${name} is already running — this click was skipped.`;
  }
  if (status.startsWith("skipped:")) {
    return `⏭️ ${name} did not run — \`${status}\`.`;
  }
  if (status.startsWith("error:")) {
    return `❌ ${name} failed — \`${status}\`.`;
  }
  if (status.startsWith("aborted:")) {
    return `🛑 ${name} was interrupted — \`${status}\`.`;
  }
  return `▶️ ${name} finished — last: \`${status}\`.`;
}

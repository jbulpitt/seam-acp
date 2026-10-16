export {
  SCHEDULE_LIST_PAGE_SIZE, paginateSchedules, parseScheduleListCustomId, requestedSchedulePage,
  schedulePageCustomId, scheduleNavState, schedulePageCaption, scheduleRunOutcome,
  type SchedulePage, type ScheduleListAction, type ScheduleNavState,
} from "../../core/schedule-list.js";

export const EMBED_DESCRIPTION_LIMIT = 4096;
const ENTRY_SEPARATOR = "\n\n";

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

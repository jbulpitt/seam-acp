/**
 * Pure layout helpers for Discord choice pickers.
 *
 * Discord hard-caps a String Select at 25 options and an action-row grid at
 * 5 buttons × 5 rows. We paginate instead of silently dropping overflow, and
 * switch to a select once the button layout would get crowded.
 */

/** StringSelectMenuBuilder.addOptions hard cap. */
export const DISCORD_SELECT_MAX = 25;
/** Soft cap before we drop buttons and use a select (3 rows of 5). */
export const DISCORD_BUTTON_SOFT_MAX = 15;
export const DISCORD_BUTTONS_PER_ROW = 5;

export type ChoicePickerLayout = {
  useButtons: boolean;
  pageSize: number;
  pageCount: number;
};

export function choicePickerLayout(opts: {
  choiceCount: number;
  allowCustom?: boolean;
}): ChoicePickerLayout {
  const n = Math.max(0, opts.choiceCount);
  if (n === 0) {
    // Custom-only (or empty) picker: a single button row, no pages of choices.
    return { useButtons: true, pageSize: 1, pageCount: 1 };
  }
  if (n <= DISCORD_BUTTON_SOFT_MAX) {
    return { useButtons: true, pageSize: n, pageCount: 1 };
  }
  const pageSize = DISCORD_SELECT_MAX;
  return {
    useButtons: false,
    pageSize,
    pageCount: Math.ceil(n / pageSize),
  };
}

export function sliceChoicePage<T>(
  items: ReadonlyArray<T>,
  page: number,
  pageSize: number
): { page: number; start: number; items: T[] } {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize) || 1);
  const p = Math.min(Math.max(0, page), pageCount - 1);
  const start = p * pageSize;
  return { page: p, start, items: items.slice(start, start + pageSize) as T[] };
}

/** Shown in the embed / select placeholder when there is more than one page. */
export function choicePickerPageCaption(
  total: number,
  page: number,
  pageSize: number
): string | undefined {
  if (total <= 0 || pageSize <= 0) return undefined;
  const pageCount = Math.ceil(total / pageSize);
  if (pageCount <= 1) return undefined;
  const start = page * pageSize + 1;
  const end = Math.min(total, (page + 1) * pageSize);
  return `Page ${page + 1} of ${pageCount} (${start}-${end} of ${total}).`;
}

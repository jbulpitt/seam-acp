/**
 * Pagination for `/seam preset list`.
 *
 * Discord caps a message at 5 action rows. Each preset gets its own
 * Apply/Edit/Delete row; when there is more than one page the last row is
 * Prev / Page X/Y / Next, so a page holds at most 4 presets.
 */
import { sliceChoicePage } from "./choice-picker.js";

export const PRESET_LIST_PAGE_SIZE = 4;

export function paginatePresetList<T>(
  items: ReadonlyArray<T>,
  page: number,
  pageSize: number = PRESET_LIST_PAGE_SIZE
): { page: number; pageCount: number; items: T[] } {
  const { page: p, items: slice } = sliceChoicePage(items, page, pageSize);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize) || 1);
  return { page: p, pageCount, items: slice };
}

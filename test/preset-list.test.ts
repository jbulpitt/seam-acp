import { describe, it, expect } from "vitest";
import {
  paginatePresetList,
  PRESET_LIST_PAGE_SIZE,
} from "../packages/core/src/platforms/discord/preset-list.js";
import { choicePickerPageCaption } from "../packages/core/src/platforms/discord/choice-picker.js";

describe("paginatePresetList", () => {
  const items = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];

  it("uses 4 presets per page so a nav row still fits the 5-row cap", () => {
    expect(PRESET_LIST_PAGE_SIZE).toBe(4);
    const first = paginatePresetList(items, 0);
    expect(first.page).toBe(0);
    expect(first.pageCount).toBe(3);
    expect(first.items).toEqual(["a", "b", "c", "d"]);
  });

  it("returns the remainder on the last page", () => {
    const last = paginatePresetList(items, 2);
    expect(last.page).toBe(2);
    expect(last.items).toEqual(["i"]);
  });

  it("clamps an out-of-range page to the last page", () => {
    const slice = paginatePresetList(items, 99);
    expect(slice.page).toBe(2);
    expect(slice.items).toEqual(["i"]);
  });

  it("clamps a negative page to 0", () => {
    const slice = paginatePresetList(items, -3);
    expect(slice.page).toBe(0);
    expect(slice.items[0]).toBe("a");
  });

  it("a single page (≤4) is pageCount 1 — no nav row needed", () => {
    const slice = paginatePresetList(["a", "b", "c", "d"], 0);
    expect(slice.pageCount).toBe(1);
    expect(slice.items).toHaveLength(4);
    expect(choicePickerPageCaption(4, 0, PRESET_LIST_PAGE_SIZE)).toBeUndefined();
  });

  it("deleting the last item on the last page drops you to the previous page", () => {
    // 5 presets: page 0 has 4, page 1 has the 5th.
    const before = ["a", "b", "c", "d", "e"];
    expect(paginatePresetList(before, 1).items).toEqual(["e"]);
    const after = before.slice(0, 4);
    const clamped = paginatePresetList(after, 1);
    expect(clamped.page).toBe(0);
    expect(clamped.pageCount).toBe(1);
    expect(clamped.items).toEqual(after);
  });

  it("empty list clamps to page 0", () => {
    const slice = paginatePresetList([], 3);
    expect(slice.page).toBe(0);
    expect(slice.pageCount).toBe(1);
    expect(slice.items).toEqual([]);
  });
});

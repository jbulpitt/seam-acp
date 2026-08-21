import { describe, it, expect } from "vitest";
import {
  DISCORD_SELECT_MAX,
  DISCORD_BUTTON_SOFT_MAX,
  choicePickerLayout,
  sliceChoicePage,
  choicePickerPageCaption,
} from "../packages/core/src/platforms/discord/choice-picker.js";

describe("choicePickerLayout", () => {
  it("uses buttons for a small list (Discord 25-option cap is not the issue yet)", () => {
    const layout = choicePickerLayout({ choiceCount: 10 });
    expect(layout.useButtons).toBe(true);
    expect(layout.pageCount).toBe(1);
    expect(layout.pageSize).toBe(10);
  });

  it("switches to a select once the button grid would get crowded", () => {
    const layout = choicePickerLayout({
      choiceCount: DISCORD_BUTTON_SOFT_MAX + 1,
    });
    expect(layout.useButtons).toBe(false);
    expect(layout.pageSize).toBe(DISCORD_SELECT_MAX);
    expect(layout.pageCount).toBe(1);
  });

  it("paginates once the Discord 25-option select cap is exceeded", () => {
    const layout = choicePickerLayout({ choiceCount: DISCORD_SELECT_MAX + 1 });
    expect(layout.useButtons).toBe(false);
    expect(layout.pageSize).toBe(25);
    expect(layout.pageCount).toBe(2);
  });

  it("covers a large folder list without dropping items", () => {
    const n = 73;
    const layout = choicePickerLayout({ choiceCount: n });
    expect(layout.pageCount).toBe(3);
    expect((layout.pageCount - 1) * layout.pageSize).toBeLessThan(n);
    expect(layout.pageCount * layout.pageSize).toBeGreaterThanOrEqual(n);
  });

  it("still produces a page when the list is empty (custom-path button only)", () => {
    const layout = choicePickerLayout({ choiceCount: 0, allowCustom: true });
    expect(layout.useButtons).toBe(true);
    expect(layout.pageCount).toBe(1);
  });
});

describe("sliceChoicePage", () => {
  const items = Array.from({ length: 26 }, (_, i) => i);

  it("returns the first 25 on page 0", () => {
    const slice = sliceChoicePage(items, 0, 25);
    expect(slice.start).toBe(0);
    expect(slice.items).toEqual(items.slice(0, 25));
  });

  it("returns the remainder on the last page", () => {
    const slice = sliceChoicePage(items, 1, 25);
    expect(slice.page).toBe(1);
    expect(slice.start).toBe(25);
    expect(slice.items).toEqual([25]);
  });

  it("clamps an out-of-range page to the last page", () => {
    const slice = sliceChoicePage(items, 99, 25);
    expect(slice.page).toBe(1);
    expect(slice.items).toEqual([25]);
  });

  it("clamps a negative page to 0", () => {
    const slice = sliceChoicePage(items, -3, 25);
    expect(slice.page).toBe(0);
    expect(slice.items[0]).toBe(0);
  });
});

describe("choicePickerPageCaption", () => {
  it("is omitted on a single page", () => {
    expect(choicePickerPageCaption(10, 0, 25)).toBeUndefined();
  });

  it("labels the current window on a multi-page list", () => {
    expect(choicePickerPageCaption(73, 0, 25)).toBe("Page 1 of 3 (1-25 of 73).");
    expect(choicePickerPageCaption(73, 2, 25)).toBe("Page 3 of 3 (51-73 of 73).");
  });
});

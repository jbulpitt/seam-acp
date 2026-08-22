import { describe, it, expect } from "vitest";
import {
  DISCORD_SELECT_MAX,
  DISCORD_BUTTON_SOFT_MAX,
  MULTI_SELECT_PLACEHOLDER,
  choicePickerLayout,
  describeMultiSelectMenu,
  sliceChoicePage,
  choicePickerPageCaption,
} from "../packages/core/src/platforms/discord/choice-picker.js";
import {
  makeChoiceConfirmId,
  makeChoiceSelectId,
} from "../packages/core/src/core/choice/types.js";
import { buildChoiceCardComponents } from "../packages/core/src/platforms/discord/adapter.js";

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

describe("multi-select menu + Confirm (#94)", () => {
  const options = [
    { label: "Loops" },
    { label: "Recursion" },
    { label: "Testing" },
  ];

  it("renders one menu (min/max) + Confirm disabled initially", () => {
    const spec = describeMultiSelectMenu({
      choiceId: "abc",
      options,
      min: 1,
      max: 3,
      makeSelectId: makeChoiceSelectId,
      makeConfirmId: makeChoiceConfirmId,
    });
    expect(spec.customId).toBe("choice:abc:s");
    expect(spec.minValues).toBe(1);
    expect(spec.maxValues).toBe(3);
    expect(spec.placeholder).toBe(MULTI_SELECT_PLACEHOLDER);
    expect(spec.options).toEqual([
      { label: "Loops", value: "0" },
      { label: "Recursion", value: "1" },
      { label: "Testing", value: "2" },
    ]);
    expect(spec.confirmCustomId).toBe("choice:abc:c");
    expect(spec.confirmDisabled).toBe(true);
    expect(spec.confirmLabel).toBe("Confirm");
  });

  it("marks pending picks as default and enables Confirm in [min,max]", () => {
    const spec = describeMultiSelectMenu({
      choiceId: "abc",
      options,
      min: 2,
      max: 3,
      pendingSelection: [0, 2],
      makeSelectId: makeChoiceSelectId,
      makeConfirmId: makeChoiceConfirmId,
    });
    expect(spec.options[0]!.default).toBe(true);
    expect(spec.options[1]!.default).toBeUndefined();
    expect(spec.options[2]!.default).toBe(true);
    expect(spec.confirmDisabled).toBe(false);
  });

  it("keeps Confirm disabled when the pending count is below min", () => {
    const spec = describeMultiSelectMenu({
      choiceId: "abc",
      options,
      min: 2,
      max: 3,
      pendingSelection: [1],
      makeSelectId: makeChoiceSelectId,
      makeConfirmId: makeChoiceConfirmId,
    });
    expect(spec.confirmDisabled).toBe(true);
  });

  it("single-select card is unchanged: buttons, no Confirm", () => {
    const rows = buildChoiceCardComponents({
      panel: { color: 0, title: "t", fields: [] },
      choiceId: "abc",
      options: [
        { label: "Approve", kind: "prompt" },
        { label: "Type…", kind: "custom" },
      ],
    });
    const json = rows.map((r) => r.toJSON()) as Array<{
      components: Array<{ custom_id: string; type: number; min_values?: number }>;
    }>;
    const ids = json.flatMap((r) => r.components.map((c) => c.custom_id));
    expect(ids).toEqual(["choice:abc:0", "choice:abc:1"]);
    expect(ids.some((id) => id.endsWith(":c"))).toBe(false);
    expect(json.some((r) => r.components.some((c) => c.min_values != null))).toBe(false);
  });

  it("adapter payload: select min/max + Confirm disabled with no pending", () => {
    const rows = buildChoiceCardComponents({
      panel: { color: 0, title: "t", fields: [] },
      choiceId: "abc",
      options: options.map((o) => ({ ...o, kind: "prompt" as const })),
      select: { min: 1, max: 3 },
    });
    expect(rows).toHaveLength(2);
    const selectJson = rows[0]!.toJSON() as {
      components: Array<{
        custom_id: string;
        min_values: number;
        max_values: number;
        placeholder: string;
        options: Array<{ value: string; default?: boolean }>;
      }>;
    };
    const confirmJson = rows[1]!.toJSON() as {
      components: Array<{ custom_id: string; label: string; disabled: boolean }>;
    };
    expect(selectJson.components[0]!.custom_id).toBe("choice:abc:s");
    expect(selectJson.components[0]!.min_values).toBe(1);
    expect(selectJson.components[0]!.max_values).toBe(3);
    expect(selectJson.components[0]!.placeholder).toBe(MULTI_SELECT_PLACEHOLDER);
    expect(confirmJson.components[0]!.custom_id).toBe("choice:abc:c");
    expect(confirmJson.components[0]!.label).toBe("Confirm");
    expect(confirmJson.components[0]!.disabled).toBe(true);
  });
});

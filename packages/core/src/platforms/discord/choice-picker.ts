/**
 * Pure layout helpers for Discord choice pickers.
 *
 * Discord hard-caps a String Select at 25 options and an action-row grid at
 * 5 buttons × 5 rows. We paginate instead of silently dropping overflow, and
 * switch to a select once the button layout would get crowded.
 */
import type { StructuredPanel } from "../../core/types.js";
import { choiceOptionList } from "../../core/choice/types.js";
import { toGraphemes } from "../../core/prompt-excerpt.js";

/** StringSelectMenuBuilder.addOptions hard cap. */
export const DISCORD_SELECT_MAX = 25;
/** Soft cap before we drop buttons and use a select (3 rows of 5). */
export const DISCORD_BUTTON_SOFT_MAX = 15;
export const DISCORD_BUTTONS_PER_ROW = 5;
export const DISCORD_BUTTON_LABEL_MAX = 80;
export const DISCORD_SELECT_LABEL_MAX = 100;

function labelExcerpt(text: string, max: number): string {
  if (text.length <= max) return text;
  let prefix = "";
  for (const grapheme of toGraphemes(text)) {
    if (prefix.length + grapheme.length > max - 1) break;
    prefix += grapheme;
  }
  const wordEnd = prefix.lastIndexOf(" ");
  return `${(wordEnd > 0 ? prefix.slice(0, wordEnd) : prefix).trimEnd()}…`;
}

/** Control excerpts only; clicks still resolve the original option by index. */
export function describeChoiceOption(label: string, index: number, numbered: boolean, max: number): {
  label: string; description?: string;
} {
  const text = label.replace(/\s+/g, " ").trim();
  const prefix = numbered ? `${index + 1}. ` : "";
  const excerpt = labelExcerpt(text, max - prefix.length);
  return {
    label: `${prefix}${excerpt}`,
    ...(excerpt !== text ? { description: labelExcerpt(text.slice(excerpt.length - 1).trimStart(), 100) } : {}),
  };
}

/** Keep whole numbered options together; publish overflow before the clickable message. */
export function choiceBodyChunks(options: ReadonlyArray<{ label: string }>): string[] {
  const chunks: string[] = [];
  for (const entry of choiceOptionList(options)) {
    const last = chunks.at(-1);
    if (last && last.length + entry.length + 2 <= 2000) chunks[chunks.length - 1] = `${last}\n\n${entry}`;
    else chunks.push(entry);
  }
  return chunks;
}

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

/** Placeholder on a #94 multi-select menu. */
export const MULTI_SELECT_PLACEHOLDER = "Select one or more…";

export type MultiSelectMenuSpec = {
  customId: string;
  minValues: number;
  maxValues: number;
  placeholder: string;
  options: Array<{ label: string; description?: string; value: string; default?: boolean }>;
  confirmCustomId: string;
  confirmDisabled: boolean;
  confirmLabel: string;
};

/** Pure layout for a multi-select card: one menu + Confirm (disabled until a
 *  valid pending pick). Adapter turns this into Discord components. */
export function describeMultiSelectMenu(opts: {
  choiceId: string;
  options: ReadonlyArray<{ label: string }>;
  min: number;
  max: number;
  pendingSelection?: ReadonlyArray<number>;
  disabled?: boolean;
  makeSelectId: (choiceId: string) => string;
  makeConfirmId: (choiceId: string) => string;
}): MultiSelectMenuSpec {
  const pending = new Set(opts.pendingSelection ?? []);
  const n = opts.options.length;
  const minValues = Math.min(Math.max(1, opts.min), Math.max(1, n));
  const maxValues = Math.min(Math.max(minValues, opts.max), Math.max(1, n));
  const count = pending.size;
  const inRange = count >= minValues && count <= maxValues;
  const numbered = choiceOptionList(opts.options).length > 0;
  return {
    customId: opts.makeSelectId(opts.choiceId),
    minValues,
    maxValues,
    placeholder: MULTI_SELECT_PLACEHOLDER,
    options: opts.options.map((o, i) => ({
      ...describeChoiceOption(o.label, i, numbered, DISCORD_SELECT_LABEL_MAX),
      value: String(i),
      ...(pending.has(i) ? { default: true as const } : {}),
    })),
    confirmCustomId: opts.makeConfirmId(opts.choiceId),
    confirmDisabled: Boolean(opts.disabled) || !inRange,
    confirmLabel: "Confirm",
  };
}

export type ChoicePick = { value: string; label: string };

export type ChoicePickCommitResult =
  | { ok: true; successPanel?: StructuredPanel }
  | { ok: false; error: string; failurePanel?: StructuredPanel };

/**
 * Commit-then-render ordering for a picker selection.
 *
 * When `commit` is provided, the success panel MUST NOT render until commit
 * resolves ok. A failed or thrown commit renders failure instead. Callers that
 * omit `commit` keep the historical immediate-success path.
 */
export async function finalizeChoicePick(opts: {
  picked: ChoicePick;
  username: string;
  successPanel?: (picked: ChoicePick, username: string) => StructuredPanel;
  commit?: (picked: ChoicePick, username: string) => Promise<ChoicePickCommitResult>;
  showSuccess: (panel: StructuredPanel | undefined) => Promise<void>;
  showFailure: (error: string, panel?: StructuredPanel) => Promise<void>;
}): Promise<{ applied: boolean; error?: string }> {
  if (opts.commit) {
    let result: ChoicePickCommitResult;
    try {
      result = await opts.commit(opts.picked, opts.username);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await opts.showFailure(error);
      return { applied: false, error };
    }
    if (!result.ok) {
      await opts.showFailure(result.error, result.failurePanel);
      return { applied: false, error: result.error };
    }
    await opts.showSuccess(
      result.successPanel ?? opts.successPanel?.(opts.picked, opts.username)
    );
    return { applied: true };
  }
  await opts.showSuccess(opts.successPanel?.(opts.picked, opts.username));
  return { applied: true };
}

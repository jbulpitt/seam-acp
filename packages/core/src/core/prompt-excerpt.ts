/**
 * ONE prompt-excerpt convention, shared by every observability card
 * (#153 handoff / report-back, #154 queued prompt, #155 slash steer).
 *
 * Before this module each card invented its own `slice(0, n) + "…"`, so the
 * same prompt read differently depending on which card you happened to be
 * looking at — and every one of those slices could cut a character in half.
 * The rules live here, in one place:
 *
 *   1. Collapse all whitespace to single spaces — a card excerpt is one line.
 *   2. Keep at most `words` whitespace-separated words.
 *   3. Then clamp to `chars` **grapheme clusters**, backing off to the last
 *      word boundary inside the budget when there is one.
 *   4. Append a single "…" if — and only if — something was dropped.
 *
 * "Grapheme cluster" is the load-bearing part. Slicing a JS string by UTF-16
 * code units can split a surrogate pair (👍 → a lone surrogate), a ZWJ emoji
 * sequence (👨‍👩‍👧 → three separate people), a regional-indicator flag pair
 * (🇯🇵 → 🇯 🇵), a skin-tone modifier off its base emoji, or a combining mark
 * off its base letter. Discord renders the debris as replacement characters.
 * We segment with `Intl.Segmenter` and fall back to code points (`Array.from`)
 * on a runtime without it — which still never splits a surrogate pair.
 */

/** The ellipsis every card appends when an excerpt was truncated. */
export const EXCERPT_ELLIPSIS = "…";

/** Default word budget — "the first ~100 words" from #153. */
export const PROMPT_EXCERPT_WORDS = 100;

/**
 * Default character budget. A Discord embed field value caps at 1024; we stay
 * well under so a label, quoting, and the ellipsis all still fit, and so a
 * single excerpt can never eat the 6000-char aggregate embed budget on its own.
 */
export const PROMPT_EXCERPT_CHARS = 600;

const segmenter: Intl.Segmenter | undefined =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined;

/** Split into user-perceived characters (grapheme clusters). */
export function toGraphemes(s: string): string[] {
  if (!s) return [];
  if (segmenter) return Array.from(segmenter.segment(s), (seg) => seg.segment);
  // No Intl.Segmenter: code points still never split a surrogate pair.
  return Array.from(s);
}

/** Length in user-perceived characters, not UTF-16 code units. */
export function graphemeLength(s: string): number {
  return toGraphemes(s).length;
}

/** Hard cut to at most `max` grapheme clusters. No ellipsis, no word backoff. */
export function clampGraphemes(s: string, max: number): string {
  if (max <= 0) return "";
  const g = toGraphemes(s);
  return g.length <= max ? s : g.slice(0, max).join("");
}

/**
 * Truncate to at most `max` grapheme clusters **including** the ellipsis, so
 * the result always fits a hard platform cap. Used by the Discord embed
 * limiter for field values / description / footer.
 */
export function truncateGraphemes(s: string, max: number): string {
  if (max <= 0) return "";
  const g = toGraphemes(s);
  if (g.length <= max) return s;
  if (max === 1) return EXCERPT_ELLIPSIS;
  return `${g.slice(0, max - 1).join("").trimEnd()}${EXCERPT_ELLIPSIS}`;
}

export interface PromptExcerptOptions {
  /** Max whitespace-separated words. Default {@link PROMPT_EXCERPT_WORDS}. */
  words?: number;
  /** Max grapheme clusters, ellipsis excluded. Default {@link PROMPT_EXCERPT_CHARS}. */
  chars?: number;
}

/**
 * The convention. Returns a single-line excerpt of `raw`, ending in "…" when
 * anything was dropped and never mid-word or mid-grapheme.
 *
 * An empty / whitespace-only prompt returns "" — callers omit the line rather
 * than render a lone ellipsis.
 */
export function promptExcerpt(
  raw: string | null | undefined,
  opts: PromptExcerptOptions = {}
): string {
  const words = opts.words ?? PROMPT_EXCERPT_WORDS;
  const chars = opts.chars ?? PROMPT_EXCERPT_CHARS;
  const flat = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "";

  const parts = flat.split(" ");
  let truncated = words > 0 && parts.length > words;
  let text = truncated ? parts.slice(0, words).join(" ") : flat;

  if (chars > 0 && graphemeLength(text) > chars) {
    const cut = clampGraphemes(text, chars);
    // Back off to the last word boundary inside the budget. A budget that
    // contains no space at all (long URL, CJK run, one giant token) keeps the
    // grapheme-exact cut — still safe, just not word-aligned.
    const lastSpace = cut.lastIndexOf(" ");
    text = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
    truncated = true;
  }

  text = text.trimEnd();
  if (!text) return truncated ? EXCERPT_ELLIPSIS : "";
  return truncated ? `${text}${EXCERPT_ELLIPSIS}` : text;
}

/**
 * Auto-numbered Discord thread names for a slug: `[threadAbbr] [slug] [n-keycap]`.
 * Numbers are keycap sequences 1️⃣–9️⃣ only (digit + U+FE0F + U+20E3). Pure.
 */

/** Variation selector-16 + combining enclosing keycap. */
export const KEYCAP_VS = "\uFE0F";
export const KEYCAP_ENCLOSING = "\u20E3";
export const THREAD_NUMBER_MAX = 9;
export const THREAD_NAME_MAX = 100;

const KEYCAP_RE = /([1-9])\uFE0F\u20E3/g;

export const THREAD_LIMIT_MESSAGE =
  "the limit (9) for this kind of thread has been reached.";

/** `1️⃣` … `9️⃣`. Throws if n is outside 1–9. */
export function formatKeycap(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > THREAD_NUMBER_MAX) {
    throw new RangeError(`keycap number must be an integer 1–${THREAD_NUMBER_MAX}`);
  }
  return `${n}${KEYCAP_VS}${KEYCAP_ENCLOSING}`;
}

/** First 1–9 keycap in `name`, or null. Does not match 🔟. */
export function parseKeycapNumber(name: string): number | null {
  KEYCAP_RE.lastIndex = 0;
  const m = KEYCAP_RE.exec(name);
  if (!m?.[1]) return null;
  return Number(m[1]);
}

/** True when a whitespace token equals `slug` (case-insensitive). */
export function nameContainsSlug(name: string, slug: string): boolean {
  const token = slug.trim();
  if (!token) return false;
  const needle = token.toLowerCase();
  return name.split(/\s+/).some((part) => part.toLowerCase() === needle);
}

/** Keycap 1–9 if `name` is a slug-matching numbered thread; otherwise null. */
export function parseSlugThreadNumber(name: string, slug: string): number | null {
  if (!nameContainsSlug(name, slug)) return null;
  return parseKeycapNumber(name);
}

/**
 * Lowest unused 1–9 among slug-matching numbered names. `null` if all nine
 * slots are taken. Non-matching names are ignored.
 */
export function nextThreadNumber(existingNames: string[], slug: string): number | null {
  const taken = new Set<number>();
  for (const name of existingNames) {
    const n = parseSlugThreadNumber(name, slug);
    if (n !== null) taken.add(n);
  }
  for (let i = 1; i <= THREAD_NUMBER_MAX; i++) {
    if (!taken.has(i)) return i;
  }
  return null;
}

/** `[threadAbbr] [slug] [n-emoji]`, omitting an empty abbr. */
export function buildThreadName(
  threadAbbr: string | null | undefined,
  slug: string,
  n: number
): string {
  const cap = formatKeycap(n);
  const abbr = (threadAbbr ?? "").trim();
  const s = slug.trim();
  const parts = [abbr, s, cap].filter((p) => p.length > 0);
  return parts.join(" ").slice(0, THREAD_NAME_MAX);
}

export function isSlugNumberedName(name: string, slug: string): boolean {
  return parseSlugThreadNumber(name, slug) !== null;
}

/** Empty, Discord default, or leftover `/seam new` "seam" titles. */
export function isEmptyOrDefaultThreadName(
  name: string | undefined | null,
  threadAbbr?: string | null
): boolean {
  if (name == null) return true;
  const t = name.trim();
  if (!t) return true;
  const lower = t.toLowerCase();
  if (lower === "seam" || lower === "new thread") return true;
  const abbr = (threadAbbr ?? "").trim();
  if (abbr && t === abbr) return true;
  if (abbr && lower === `${abbr} seam`.toLowerCase()) return true;
  return false;
}

/** Trim; empty → null. Rejects whitespace and over-long values. */
export function normalizeThreadSlug(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}$/.test(t)) return null;
  return t;
}

/** DB preset slug, then thread-preset, then channel-preset. */
export function resolveEffectiveSlug(opts: {
  presetSlug?: string | null;
  threadSlug?: string | null;
  channelSlug?: string | null;
}): string | undefined {
  for (const raw of [opts.presetSlug, opts.threadSlug, opts.channelSlug]) {
    const v = raw?.trim();
    if (v) return v;
  }
  return undefined;
}

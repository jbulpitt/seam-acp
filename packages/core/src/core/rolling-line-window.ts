/**
 * Rolling complete-line window for the stateless-handoff embed card.
 *
 * Newest lines stay at the bottom. Oldest complete lines drop from the top
 * once the joined text exceeds `maxChars`. A single newest line that itself
 * exceeds the cap is kept whole — never cut mid-line, never split graphemes.
 * Split is `\n` only (`\r\n` keeps the `\r` on the line).
 */

/** Character budget for the live body and the Done Result section. */
export const DISPATCH_CARD_WINDOW_CHARS = 750;

export function rollingLineWindow(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  const parts = text.split("\n");
  let start = 0;
  let joined = text;
  while (start < parts.length - 1) {
    start += 1;
    joined = parts.slice(start).join("\n");
    if (joined.length <= maxChars) return joined;
  }
  return parts[parts.length - 1] ?? "";
}

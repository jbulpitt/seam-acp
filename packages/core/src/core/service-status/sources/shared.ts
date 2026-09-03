import { createHash } from "node:crypto";
import { failSchema } from "../http.js";
import type { NormalizedIncidentUpdate } from "../types.js";

export interface RawIncidentUpdate {
  id: string;
  lifecycle: string;
  body: string;
  createdAt: string;
}

/**
 * Deterministic update ordering, shared by every adapter.
 *
 * Feed order is never trusted — several upstreams emit updates newest-first,
 * oldest-first, or inconsistently between items. Ties on the explicit
 * timestamp are broken by update id, so repeated polls of an unchanged
 * incident always produce byte-identical `order` values and therefore no
 * spurious transition events.
 */
export function orderUpdates(
  updates: readonly RawIncidentUpdate[],
  incidentLabel: string
): NormalizedIncidentUpdate[] {
  const seen = new Set<string>();
  for (const update of updates) {
    if (seen.has(update.id)) {
      failSchema(incidentLabel, `duplicate update id ${JSON.stringify(update.id)}`);
    }
    seen.add(update.id);
  }
  return [...updates]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((update, index) => ({ ...update, order: index }));
}

export function maxTimestamp(values: readonly (string | null)[]): string | null {
  let max: string | null = null;
  for (const value of values) {
    if (value === null) continue;
    if (max === null || value > max) max = value;
  }
  return max;
}

export function minTimestamp(values: readonly (string | null)[]): string | null {
  let min: string | null = null;
  for (const value of values) {
    if (value === null) continue;
    if (min === null || value < min) min = value;
  }
  return min;
}

/**
 * A short, stable content hash. Used where an upstream offers no identifier of
 * its own — never as a substitute for an identifier the upstream does provide.
 *
 * The parts are JSON-encoded rather than joined on a separator. No separator
 * character is safe: whichever byte is chosen, an upstream that emits it inside
 * a part makes two different inputs hash alike — a two-part list whose split
 * point moves by one character collides under any plain join. JSON encoding is
 * unambiguous because its delimiters are escaped inside the values.
 */
export function stableHash(...parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

/**
 * Blank out regions whose contents must not be scanned for markup, keeping
 * every other character at its original index.
 *
 * Structural checks only work if tag-like text *inside* CDATA, comments or
 * raw-text elements cannot be mistaken for real markup — a `</rss>` quoted in
 * an incident body, or a `</html>` inside a `<script>`, would otherwise satisfy
 * a naive scan. Replacing those spans with spaces of the same length means
 * offsets found on the masked copy still address the original text.
 *
 * Patterns are applied in order, so the caller decides which container wins
 * when two could overlap.
 */
export function maskRegions(text: string, patterns: readonly RegExp[]): string {
  let masked = text;
  for (const pattern of patterns) {
    masked = masked.replace(pattern, (match) => match.replace(/[^\n]/g, " "));
  }
  return masked;
}

/**
 * Assign unique ids to content-derived updates without losing determinism.
 *
 * Generic over the update shape so adapter-specific fields — notably Google AI
 * Studio's lifecycle code — survive uniquifying and stay attached to the id
 * they belong to.
 */
export function withUniqueIds<T extends RawIncidentUpdate>(updates: readonly T[]): T[] {
  const counts = new Map<string, number>();
  return updates.map((update) => {
    const seen = counts.get(update.id) ?? 0;
    counts.set(update.id, seen + 1);
    return seen === 0 ? update : { ...update, id: `${update.id}#${String(seen)}` };
  });
}

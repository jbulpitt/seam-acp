/**
 * Discord embed budget enforcement for {@link StructuredPanel}.
 *
 * Discord rejects a whole message (DiscordAPIError 50035) when an embed
 * breaches either a **per-part** cap or the **aggregate** 6000-character cap
 * across title + description + fields + footer + author. The adapter used to
 * enforce only the per-part caps, with raw `slice()` — which both ignored the
 * aggregate (a card that grew a couple of long fields could 400 the whole
 * post) and could cut a UTF-16 surrogate pair or emoji cluster in half.
 *
 * Now that observability cards carry prompt excerpts and thread/channel
 * provenance (#153/#154/#155), those cards are the ones most likely to push
 * against both limits, so the clamp lives here — one grapheme-safe pass every
 * embed goes through.
 *
 * Order of sacrifice when the aggregate is over budget (most disposable
 * first, so provenance survives):
 *   1. `description` (activity tags / streamed body)
 *   2. the longest field values, shrunk toward a floor
 *   3. trailing fields, dropped outright
 *   4. `footer`
 */
import { graphemeLength, truncateGraphemes } from "./prompt-excerpt.js";
import type { StructuredPanel } from "./types.js";

/** Documented Discord embed caps. */
export const DISCORD_EMBED_LIMITS = {
  title: 256,
  description: 4096,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
  author: 256,
  /** Max fields per embed. */
  fieldCount: 25,
  /** Aggregate across title + description + field names/values + footer + author. */
  total: 6000,
} as const;

/** Never shrink a surviving field value below this — a 2-char stub is noise. */
const MIN_FIELD_VALUE = 12;

/** Discord counts an embed's characters across these parts. */
function panelWeight(panel: StructuredPanel): number {
  let n = 0;
  n += graphemeLength(panel.title ?? "");
  n += graphemeLength(panel.author ?? "");
  n += graphemeLength(panel.description ?? "");
  n += graphemeLength(panel.footer ?? "");
  for (const f of panel.fields) {
    n += graphemeLength(f.name) + graphemeLength(f.value);
  }
  return n;
}

/**
 * Return a copy of `panel` that satisfies every Discord embed limit, cutting
 * only on grapheme-cluster boundaries and marking each cut with "…".
 * Panels already inside budget are returned structurally unchanged.
 */
export function clampPanelForDiscord(panel: StructuredPanel): StructuredPanel {
  const out: StructuredPanel = {
    ...panel,
    fields: panel.fields
      .slice(0, DISCORD_EMBED_LIMITS.fieldCount)
      .map((f) => ({
        ...f,
        name: truncateGraphemes(f.name, DISCORD_EMBED_LIMITS.fieldName),
        value: truncateGraphemes(f.value, DISCORD_EMBED_LIMITS.fieldValue),
      })),
  };
  if (out.title !== undefined) {
    out.title = truncateGraphemes(out.title, DISCORD_EMBED_LIMITS.title);
  }
  if (out.author !== undefined) {
    out.author = truncateGraphemes(out.author, DISCORD_EMBED_LIMITS.author);
  }
  if (out.description !== undefined) {
    out.description = truncateGraphemes(out.description, DISCORD_EMBED_LIMITS.description);
  }
  if (out.footer !== undefined) {
    out.footer = truncateGraphemes(out.footer, DISCORD_EMBED_LIMITS.footer);
  }

  let over = panelWeight(out) - DISCORD_EMBED_LIMITS.total;
  if (over <= 0) return out;

  // 1. Description — the most disposable body text.
  if (out.description) {
    const len = graphemeLength(out.description);
    const keep = Math.max(0, len - over);
    out.description = keep === 0 ? undefined : truncateGraphemes(out.description, keep);
    over = panelWeight(out) - DISCORD_EMBED_LIMITS.total;
    if (over <= 0) return out;
  }

  // 2. Shrink the longest field value, repeatedly, down to a readable floor.
  for (;;) {
    let widest = -1;
    let widestLen = MIN_FIELD_VALUE;
    for (let i = 0; i < out.fields.length; i++) {
      const len = graphemeLength(out.fields[i]!.value);
      if (len > widestLen) {
        widest = i;
        widestLen = len;
      }
    }
    if (widest < 0) break;
    const keep = Math.max(MIN_FIELD_VALUE, widestLen - over);
    out.fields[widest] = {
      ...out.fields[widest]!,
      value: truncateGraphemes(out.fields[widest]!.value, keep),
    };
    over = panelWeight(out) - DISCORD_EMBED_LIMITS.total;
    if (over <= 0) return out;
  }

  // 3. Drop trailing fields outright.
  while (over > 0 && out.fields.length > 0) {
    out.fields = out.fields.slice(0, -1);
    over = panelWeight(out) - DISCORD_EMBED_LIMITS.total;
  }
  if (over <= 0) return out;

  // 4. Footer, last.
  if (out.footer) {
    const keep = Math.max(0, graphemeLength(out.footer) - over);
    out.footer = keep === 0 ? undefined : truncateGraphemes(out.footer, keep);
  }
  return out;
}

// Pure formatting for the `/seam config audit` view (#70). Turns immutable
// `config_audit` rows (SessionStore.listConfigMutations) into the strings the
// orchestrator drops into an ephemeral embed. Kept free of discord.js so the
// layout logic is unit-testable in isolation, mirroring `workflows-view.ts`.
//
// Read-only — this module never touches the store. The trail spans EVERY
// channel, so it is deliberately slash-command-only (never a cross-thread MCP
// read); nothing here widens the read surface.

import type { ConfigAuditEntry } from "../../core/types.js";
// Reuse the ledger view's line helpers so the audit view reads in the same
// visual language as `/seam workflows` (short ids, coarse age, one-line refs).
import { formatAge, shortId, shortRef } from "./workflows-view.js";

/** Tier → glyph. Falls back to a bullet for an unknown tier string. */
const TIER_ICON: Record<string, string> = {
  session: "🧵",
  preset: "📦",
  "channel-preset": "📌",
  "thread-preset": "🪡",
  schedule: "📅",
};

/** One-line summary is human text — clamp it so a wordy summary stays on its
 *  row. Same slice+ellipsis discipline as `shortRef`. */
export const AUDIT_SUMMARY_MAX = 120;

/** Max chars of a before/after payload previewed in the detail view. The
 *  before_json/after_json columns can hold rider text, so a payload is
 *  hard-truncated (with a `…[+N chars]` marker) before it ever reaches an embed
 *  field — a long rider can shorten, but never break, the render. Left of
 *  Discord's 1024 field cap so a ```json fence + marker still fits. */
export const AUDIT_PAYLOAD_MAX = 900;

/** Rendered, embed-ready summary view of the config-mutation trail. */
export interface ConfigAuditView {
  /** True when there are no audit rows at all. */
  empty: boolean;
  /** Newest-first, one line per mutation. */
  lines: string[];
}

/** The before→after detail of a single entry, ready to wrap in embed fields. */
export interface ConfigAuditDetail {
  entry: ConfigAuditEntry;
  /** Header rows: actor / tier / scope / when / correlation. */
  meta: Array<{ label: string; value: string }>;
  /** Pretty-printed + payload-clamped snapshots. */
  before: string;
  after: string;
}

/** Clamp inline human text to `max`, marking the cut with an ellipsis. */
function clampInline(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** One audit row → one line: `<tier> <id> · <age> · <actor> · <tier> · <scope>
 *  · <summary>`. Newest-first is the caller's ordering (the store already
 *  returns rows in `applied_utc DESC`). */
export function auditLine(e: ConfigAuditEntry, now: Date): string {
  const icon = TIER_ICON[e.tier] ?? "•";
  const actor = e.actorName ?? e.actorId ?? "unknown";
  const scope = shortRef(e.scope, "—");
  const summary = clampInline(e.summary, AUDIT_SUMMARY_MAX);
  return `${icon} \`${shortId(e.id)}\` · ${formatAge(e.appliedUtc, now)} · ${actor} · ${e.tier} · ${scope} · ${summary}`;
}

/** Build the read-only summary view from `listConfigMutations` rows (already
 *  newest-first). */
export function formatConfigAuditView(
  entries: ConfigAuditEntry[],
  now: Date
): ConfigAuditView {
  return {
    empty: entries.length === 0,
    lines: entries.map((e) => auditLine(e, now)),
  };
}

/** Locate one entry by its full id or the short id shown in the summary line
 *  (so a user can copy the visible `\`abc123\`` and get a match). */
export function findAuditEntry(
  entries: ConfigAuditEntry[],
  id: string
): ConfigAuditEntry | undefined {
  const needle = id.trim();
  return entries.find((e) => e.id === needle || shortId(e.id) === needle);
}

/** Pretty-print a JSON snapshot for display and hard-truncate long payloads.
 *  Invalid JSON is shown verbatim (still clamped) rather than dropped — the
 *  audit column is a raw string and observability must never hide it. */
export function truncatePayload(raw: string, max = AUDIT_PAYLOAD_MAX): string {
  let text = raw;
  try {
    text = JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    // Not JSON (or already a bare string) — preview the raw value.
  }
  return text.length <= max
    ? text
    : `${text.slice(0, max)} …[+${text.length - max} chars]`;
}

/** Build the before→after detail for a single entry. */
export function formatConfigAuditDetail(
  e: ConfigAuditEntry,
  now: Date
): ConfigAuditDetail {
  const actor = e.actorName
    ? `${e.actorName}${e.actorId ? ` (${e.actorId})` : ""}`
    : e.actorId ?? "unknown";
  const meta: Array<{ label: string; value: string }> = [
    { label: "actor", value: actor },
    { label: "tier", value: e.tier },
    { label: "scope", value: e.scope },
    { label: "when", value: `${e.appliedUtc} (${formatAge(e.appliedUtc, now)} ago)` },
  ];
  if (e.correlationId) meta.push({ label: "correlation", value: e.correlationId });
  return {
    entry: e,
    meta,
    before: truncatePayload(e.beforeJson),
    after: truncatePayload(e.afterJson),
  };
}

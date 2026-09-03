// Pure formatting for the `/seam workflows` ledger view. Kept free of
// discord.js so the layout logic is unit-testable in isolation: it turns raw
// `LedgerEntry` rows into the strings the orchestrator drops into an embed.
// Read-only — this module never touches the store.

import type { LedgerEntry, DelegationStatus } from "../../core/types.js";
import type { AnomalySummary } from "../../core/watchdog.js";
import { choicePickerPageCaption, sliceChoicePage } from "./choice-picker.js";

/** Rendered, embed-ready view of the ledger. */
export interface WorkflowsView {
  /** True when there are neither active nor recent rows. */
  empty: boolean;
  active: { count: number; lines: string[] };
  recent: { count: number; lines: string[] };
}

const STATUS_ICON: Record<DelegationStatus, string> = {
  dispatched: "📤",
  running: "▶️",
  completed: "✅",
  failed: "❌",
  timed_out: "⏱️",
  parked: "🅿️",
  interrupted: "⚠️",
  abandoned: "🚫",
};

/** Trailing, human-sized slice of an id (drops a `del-`/`corr-` style prefix). */
export function shortId(id: string): string {
  const tail = id.includes("-") ? id.slice(id.lastIndexOf("-") + 1) : id;
  return tail.length > 8 ? tail.slice(0, 8) : tail;
}

/** A thread/session ref without its platform prefix, clamped for one line. */
export function shortRef(ref: string | null, fallback: string): string {
  if (!ref) return fallback;
  const seg = ref.includes(":") ? ref.slice(ref.indexOf(":") + 1) : ref;
  return seg.length > 18 ? seg.slice(0, 17) + "…" : seg;
}

/** Coarse age (`s`/`m`/`h`/`d`) of an ISO timestamp relative to `now`. */
export function formatAge(fromUtc: string, now: Date): string {
  const then = Date.parse(fromUtc);
  if (Number.isNaN(then)) return "?";
  const secs = Math.max(0, Math.floor((now.getTime() - then) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** One ledger row → one line. `continuation` marks a report-back/forward that
 *  belongs to the correlation group opened by the line above it. */
function entryLine(e: LedgerEntry, now: Date, continuation: boolean): string {
  const icon = STATUS_ICON[e.status] ?? "•";
  const route = `${shortRef(e.sourceRef, "scheduler")}→${shortRef(e.targetRef, "…")}`;
  const prefix = continuation ? "↳ " : "";
  return `${prefix}${icon} \`${shortId(e.id)}\` ${e.kind} · ${route} · ${e.status} · ${formatAge(e.createdUtc, now)}`;
}

/**
 * Bucket rows by `correlationId`, preserving input order: each group appears
 * where its first member did, and rows without a correlation id are their own
 * singleton group. Lets a handoff and its later report-back render as one unit.
 */
export function groupByCorrelation(entries: LedgerEntry[]): LedgerEntry[][] {
  const groups: LedgerEntry[][] = [];
  const byCorrelation = new Map<string, LedgerEntry[]>();
  for (const e of entries) {
    if (!e.correlationId) {
      groups.push([e]);
      continue;
    }
    let group = byCorrelation.get(e.correlationId);
    if (!group) {
      group = [];
      byCorrelation.set(e.correlationId, group);
      groups.push(group);
    }
    group.push(e);
  }
  return groups;
}

/**
 * Build the read-only view. `active` (oldest-first, still in flight) renders one
 * line per row; `recent` (newest-first) is grouped by correlation with each
 * group ordered oldest-first so a handoff reads above its report-back.
 */
export function formatWorkflowsView(
  active: LedgerEntry[],
  recent: LedgerEntry[],
  now: Date
): WorkflowsView {
  const activeLines = active.map((e) => entryLine(e, now, false));

  const recentLines: string[] = [];
  for (const group of groupByCorrelation(recent)) {
    const chronological = [...group].sort((a, b) =>
      a.createdUtc.localeCompare(b.createdUtc)
    );
    chronological.forEach((e, idx) => recentLines.push(entryLine(e, now, idx > 0)));
  }

  return {
    empty: active.length === 0 && recent.length === 0,
    active: { count: active.length, lines: activeLines },
    recent: { count: recent.length, lines: recentLines },
  };
}

/**
 * Render an anomaly summary (from `summarizeAnomalies`) into embed-ready lines
 * for the additive "⚠️ Anomalies" section of `/seam workflows`. Returns `[]`
 * when nothing is anomalous, so the caller can skip the section entirely.
 */
export function formatAnomalyLines(anomalies: AnomalySummary, now: Date): string[] {
  const lines: string[] = [];
  for (const loop of anomalies.loops) {
    const path = loop.cycle.map((r) => shortRef(r, "?")).join("→");
    lines.push(`🔁 loop: ${path}→…`);
  }
  for (const spike of anomalies.spikes) {
    lines.push(
      `📈 spike: ${shortRef(spike.sourceRef, "?")} · ${spike.count} dispatches`
    );
  }
  for (const q of anomalies.quiet) {
    const route = `${shortRef(q.sourceRef, "scheduler")}→${shortRef(q.targetRef, "…")}`;
    lines.push(
      `🕰️ quiet: \`${shortId(q.id)}\` ${route} · ${q.status} · ${formatAge(q.updatedUtc, now)}`
    );
  }
  return lines;
}

/**
 * Join lines into one embed field value, staying under Discord's 1024-char
 * cap. Overflow is dropped and summarised as `…and N more` rather than
 * silently truncated mid-line.
 */
/** One interrupted/abandoned turn for the `/seam workflows` inventory (#76). */
export interface InterruptedTurnRow {
  id: string;
  source: "dispatch" | "live";
  channelRef: string;
  correlationId: string | null;
  status: "interrupted" | "abandoned";
  startedUtc: string;
  acpSessionId: string | null;
  /**
   * Where a resume would land: the ledger's dispatch target for a `dispatch`
   * row, the thread for a `live` marker. A dispatch resume re-enqueues into
   * this ref, so a row without one cannot be resumed at all (#159).
   */
  targetRef: string | null;
}

/** One inventory line: thread, age, correlation — what the operator needs
 *  to decide Resume vs Abandon. */
export function formatInterruptedLine(row: InterruptedTurnRow, now: Date): string {
  const icon = row.status === "abandoned" ? "🚫" : "⚠️";
  const corr = row.correlationId ? ` · corr \`${shortId(row.correlationId)}\`` : "";
  return `${icon} \`${shortId(row.id)}\` ${row.source} · ${shortRef(row.channelRef, "?")} · ${row.status} · ${formatAge(row.startedUtc, now)}${corr}`;
}

export function formatInterruptedLines(rows: InterruptedTurnRow[], now: Date): string[] {
  return rows.map((r) => formatInterruptedLine(r, now));
}

/** The buttons `/seam workflows` may offer for one inventory row. */
export type InterruptedRowAction = "resume" | "abandon";

/**
 * Which actions are still *live* for a row (#159).
 *
 * A control whose backing operation has already been consumed is exactly the
 * bug this inventory used to have: an abandoned turn kept an "Abandon" button
 * that could only answer "No resumable turn". A rendered button must not be
 * able to fail deterministically, so this mirrors every precondition
 * `resumeTurnManually` / `abandonTurnManually` actually check:
 *
 * - A **live** marker resumes from its recorded ACP session and is abandoned
 *   by dropping the marker itself (no ledger row involved). Once abandoned the
 *   marker is gone, so neither action can reach anything.
 * - A **dispatch** row resumes through the ledger, which re-enqueues into
 *   `targetRef` *and* loads `acpSessionId` — it needs both. Abandoning only
 *   means something while the row is still interrupted.
 */
export function interruptedRowActions(
  row: InterruptedTurnRow
): readonly InterruptedRowAction[] {
  const actions: InterruptedRowAction[] = [];
  if (row.source === "live") {
    if (row.status === "abandoned") return actions;
    if (row.acpSessionId) actions.push("resume");
    actions.push("abandon");
    return actions;
  }
  if (row.targetRef && row.acpSessionId) actions.push("resume");
  if (row.status === "interrupted") actions.push("abandon");
  return actions;
}

/** True when the row still has at least one action a click could perform. */
export function isActionableInterruptedRow(row: InterruptedTurnRow): boolean {
  return interruptedRowActions(row).length > 0;
}

/**
 * `/seam workflows` is rarely used, so the inventory stays deliberately
 * compact: one summary page of every interrupted/abandoned row, and controls
 * (with pagination) only for the rows that can still be acted on. Four rows
 * per page leaves the fifth of Discord's five action rows for Prev/Page/Next.
 */
export const WORKFLOW_INVENTORY_PAGE_SIZE = 4;

/** Paginate the *actionable* subset of the inventory. */
export function paginateInterruptedRows(
  rows: ReadonlyArray<InterruptedTurnRow>,
  page: number,
  pageSize: number = WORKFLOW_INVENTORY_PAGE_SIZE
): {
  page: number;
  pageCount: number;
  total: number;
  items: InterruptedTurnRow[];
} {
  const actionable = rows.filter(isActionableInterruptedRow);
  const { page: p, items } = sliceChoicePage(actionable, page, pageSize);
  const pageCount = Math.max(1, Math.ceil(actionable.length / pageSize) || 1);
  return { page: p, pageCount, total: actionable.length, items };
}

/** The embed fields for the inventory's interrupted section. */
export interface InterruptedInventorySection {
  page: number;
  pageCount: number;
  /** Actionable rows across every page. */
  total: number;
  /** The rows this page's controls act on, in button order. */
  items: InterruptedTurnRow[];
  /** One line per control row, same order — or `null` when nothing is actionable. */
  actionable: { name: string; value: string } | null;
  /** Compact summary of everything with no live action left. */
  inert: { name: string; value: string } | null;
}

/**
 * Build the interrupted section so the visible text and the buttons always
 * describe the same rows.
 *
 * Listing the whole inventory in one field while paginating only the
 * actionable subset breaks down past page 1: the 1024-char clamp can drop
 * exactly the rows the buttons act on, leaving controls pointing at text the
 * operator cannot see. The actionable field therefore carries *only* this
 * page's controlled rows, in button order, and everything inert moves to its
 * own compact summary.
 */
export function buildInterruptedInventory(
  rows: ReadonlyArray<InterruptedTurnRow>,
  page: number,
  now: Date,
  pageSize: number = WORKFLOW_INVENTORY_PAGE_SIZE
): InterruptedInventorySection {
  const slice = paginateInterruptedRows(rows, page, pageSize);
  const caption = choicePickerPageCaption(slice.total, slice.page, pageSize);
  const lines = formatInterruptedLines(slice.items, now);
  const inertRows = rows.filter((row) => !isActionableInterruptedRow(row));
  return {
    page: slice.page,
    pageCount: slice.pageCount,
    total: slice.total,
    items: slice.items,
    actionable: slice.items.length
      ? {
          name: `⚠️ Interrupted / abandoned — actionable (${slice.total})`,
          // Caption last: if anything must be dropped it is the caption, never
          // a row that has a button under it.
          value: clampFieldValue(caption ? [...lines, `_${caption}_`] : lines),
        }
      : null,
    inert: inertRows.length
      ? {
          name: `🗄️ Interrupted / abandoned — no action available (${inertRows.length})`,
          value: clampFieldValue(formatInterruptedLines(inertRows, now)),
        }
      : null,
  };
}

export function clampFieldValue(lines: string[], max = 1024): string {
  if (lines.length === 0) return "_none_";
  const out: string[] = [];
  let len = 0;
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]!;
    const added = (out.length ? 1 : 0) + line.length;
    if (len + added > max) {
      out.push(`…and ${lines.length - idx} more`);
      break;
    }
    out.push(line);
    len += added;
  }
  return out.join("\n");
}

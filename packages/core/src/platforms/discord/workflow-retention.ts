import { interruptedRowActions, type InterruptedTurnRow } from "./workflows-view.js";
import type { LedgerEntry } from "../../core/types.js";

export const WORKFLOW_HISTORY_RETENTION_DAYS = 7;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Display only: actionable work never disappears and no record is deleted. */
export function visibleWorkflowHistory(rows: InterruptedTurnRow[], now: Date, includeHistory = false) {
  if (includeHistory) return { rows, hidden: 0 };
  const cutoff = now.getTime() - WORKFLOW_HISTORY_RETENTION_DAYS * DAY_MS;
  const visible = rows.filter(row => interruptedRowActions(row).length > 0 || !(Date.parse(row.startedUtc) < cutoff));
  return { rows: visible, hidden: rows.length - visible.length };
}

export function visibleWorkflowLedger(rows: LedgerEntry[], now: Date, includeHistory: boolean, actionableIds: ReadonlySet<string>) {
  if (includeHistory) return rows;
  const cutoff = now.getTime() - WORKFLOW_HISTORY_RETENTION_DAYS * DAY_MS;
  return rows.filter(row => ["dispatched", "running", "parked", "interrupted"].includes(row.status)
    || actionableIds.has(row.id) || !(Date.parse(row.updatedUtc || row.createdUtc) < cutoff));
}

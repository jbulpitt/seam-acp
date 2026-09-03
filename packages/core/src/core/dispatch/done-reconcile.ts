/**
 * Boot-time completion reconciliation (#174).
 *
 * A dispatch completes in two places. The **output** becomes durable the moment
 * `DispatchWatcher.finish` writes `done/<id>.json` — a filesystem write that
 * needs nothing from SQLite. The **completion side effects** — flipping the
 * ledger row terminal, enqueuing the report-back, advancing a chain — are
 * DB-first and run earlier, inside the turn.
 *
 * Shutdown could close the store between those two, which left a worker whose
 * answer was already on disk with a non-terminal ledger row and no report-back
 * spec. Boot reconciled that row to `interrupted`, so `/seam workflows` offered
 * to rerun work that had already been paid for.
 *
 * This module closes that window from the other side: on boot, any done-file
 * whose ledger row is still non-terminal replays ONLY the durable completion
 * actions. It never reruns the worker — the output is read from the file.
 *
 * Deliberately NOT filesystem-first dedup. The report-back claim stays DB-first
 * and atomic: a `pending/`+`running/` scan cannot see an ALREADY-DELIVERED
 * report-back (that spec has moved to `done/`), so trusting the filesystem
 * would re-deliver. The ledger row is the only thing that distinguishes
 * "never enqueued" from "enqueued and finished".
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../../lib/logger.js";
import { dispatchDirs } from "./types.js";
import type { DispatchResult } from "./types.js";

/** Ledger statuses that mean the completion side effects already ran. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "abandoned",
  "cancelled",
]);

export interface DoneReconcileDeps {
  dataDir: string;
  logger: Logger;
  /** Ledger row lookup — `null` when the id is unknown. */
  getDelegation: (id: string) => { status: string } | null;
  /** Replay the completion side effects for one finished dispatch. */
  replay: (result: DispatchResult) => Promise<void>;
}

export interface DoneReconcileSummary {
  scanned: number;
  reconciled: number;
  skippedTerminal: number;
  skippedUnknown: number;
  failed: number;
}

/**
 * True when `result` still has completion work owed to it.
 *
 * Split out so the predicate is testable without a filesystem: a done-file is
 * reconcilable when its ledger row exists and is non-terminal. Routing is
 * irrelevant here — it decides WHAT the replay does, not WHETHER it is owed.
 */
export function needsCompletionReplay(
  _result: Pick<DispatchResult, "returnTo" | "chainId">,
  row: { status: string } | null
): boolean {
  if (!row) return false;
  // Onward routing is NOT part of this decision. A done-file proves the work
  // finished; a non-terminal row for it is wrong regardless of whether anything
  // had to be delivered onward. An unrouted completion (a wake, a watch, a
  // report_back, a plain handoff with no returnTo) left `interrupted` is the
  // same corruption — `/seam workflows` offers a paid rerun of finished work.
  return !TERMINAL_STATUSES.has(row.status);
}

/**
 * Scan `done/` once and replay completion for any dispatch whose ledger row is
 * non-terminal. Idempotent: a row this pass terminalizes is skipped on the
 * next boot, and the report-back's own DB-first claim absorbs a double call.
 *
 * Best-effort by contract — a failure to replay one dispatch is logged and the
 * scan continues, because blocking boot on a stale done-file would be worse
 * than the undelivered report-back it is trying to repair.
 */
export async function reconcileCompletedDoneFiles(
  deps: DoneReconcileDeps
): Promise<DoneReconcileSummary> {
  const dirs = dispatchDirs(deps.dataDir);
  const summary: DoneReconcileSummary = {
    scanned: 0,
    reconciled: 0,
    skippedTerminal: 0,
    skippedUnknown: 0,
    failed: 0,
  };

  let names: string[];
  try {
    names = await readdir(dirs.done);
  } catch {
    return summary; // no done dir yet — nothing has ever completed
  }

  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let result: DispatchResult;
    try {
      const raw = await readFile(path.join(dirs.done, name), "utf8");
      const parsed = JSON.parse(raw) as DispatchResult;
      // The filename is authoritative for id, matching `finish()`.
      result = { ...parsed, id: name.slice(0, -".json".length) };
    } catch {
      continue; // unparseable / partially-written — ignore
    }
    summary.scanned++;

    let row: { status: string } | null;
    try {
      row = deps.getDelegation(result.id);
    } catch (err) {
      deps.logger.warn({ err, id: result.id }, "done-reconcile: ledger lookup failed");
      summary.failed++;
      continue;
    }
    if (!row) {
      summary.skippedUnknown++;
      continue;
    }
    if (!needsCompletionReplay(result, row)) {
      summary.skippedTerminal++;
      continue;
    }

    try {
      await deps.replay(result);
      summary.reconciled++;
    } catch (err) {
      deps.logger.warn(
        { err, id: result.id, target: result.target },
        "done-reconcile: completion replay failed"
      );
      summary.failed++;
    }
  }

  return summary;
}

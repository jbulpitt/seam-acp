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
import { DELEGATION_TERMINAL_STATUSES } from "../types.js";
import { dispatchDirs } from "./types.js";
import type { DispatchResult } from "./types.js";

/**
 * Ledger statuses that mean the completion side effects already ran.
 *
 * The canonical list, NOT a local copy. The copy this replaced listed
 * "cancelled" — which is not a `DelegationStatus` at all — and omitted
 * `timed_out`, so a timed-out row with a done-file read as non-terminal and got
 * replayed. `parked` is deliberately absent here too (it means "set aside",
 * not "finished"), which matches how `index.ts` decides recoverability.
 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set<string>(DELEGATION_TERMINAL_STATUSES);

/**
 * Kinds whose dispatch is an EARLY-RETURN branch of `dispatchInjectTurn` with
 * its own delivery (a result card, an HTTP response, a voice reply). They never
 * take the generic report-back path, so replay must not either — and critically,
 * `compact` puts the ACTOR thread in `returnTo`, so a routing-only replay would
 * post a report-back to a thread that never asked for one.
 */
const SELF_DELIVERING_KINDS: ReadonlySet<string> = new Set([
  "compact",
  "ingest",
  "thread_voice",
]);

/**
 * Kinds that legitimately finish with NO onward delivery. Seeing one with no
 * routing is not evidence of a lost report-back, so terminalizing is safe.
 */
const NO_ONWARD_KINDS: ReadonlySet<string> = new Set([
  "report_back",
  "wake",
  "watch",
  "scheduled",
  "peek",
  "parked",
  "choice",
  "inbox",
  "migrate_self",
]);

/** What replay owes a finished dispatch. */
export type CompletionRoute =
  /** Advance the chain, then terminalize. */
  | { action: "chain"; chainId: string }
  /** Enqueue the report-back, then terminalize. */
  | { action: "report_back"; returnTo: string }
  /** Nothing onward; just fix the row. */
  | { action: "terminalize" }
  /** Leave the row alone — see `reason`. */
  | { action: "skip"; reason: "terminal" | "unknown-row" | "delivery-unprovable" };

export interface DoneReconcileDeps {
  dataDir: string;
  logger: Logger;
  /** Ledger row lookup — `null` when the id is unknown. */
  getDelegation: (id: string) => { status: string; kind?: string; correlationId?: string | null } | null;
  /** Replay the completion side effects for one finished dispatch. */
  replay: (result: DispatchResult, route: CompletionRoute) => Promise<void>;
}

export interface DoneReconcileSummary {
  scanned: number;
  reconciled: number;
  skippedTerminal: number;
  skippedUnknown: number;
  /** Legacy done-files whose delivery cannot be proven — deliberately left. */
  skippedUnprovable: number;
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
  result: Pick<DispatchResult, "returnTo" | "chainId" | "kind">,
  row: { status: string; kind?: string; correlationId?: string | null } | null
): boolean {
  return completionRoute(result, row).action !== "skip";
}

/**
 * Decide what a finished dispatch is owed. Pure, so the contract is testable
 * without a filesystem or a store.
 *
 * This MUST mirror the live dispatch contract, because replay is standing in
 * for a completion that the live path would otherwise have done:
 *
 *   - self-delivering kinds (compact / ingest / thread_voice) already posted
 *     their own result; they owe only the ledger row;
 *   - a chainId advances the chain;
 *   - otherwise a returnTo enqueues the report-back;
 *   - a kind that never delivers onward owes only the ledger row.
 *
 * A legacy `forward` needs no guesswork: by contract its `correlationId` IS its
 * chain id, so the chain advance is reconstructed straight off the ledger row.
 *
 * The remaining case is the dangerous one. A done-file with no routing and a
 * DELIVERY-BEARING kind — in practice a plain `handoff` — is a legacy file
 * written before #174 carried routing. It cannot prove its report-back was ever
 * enqueued, and terminalizing it would strand the answer permanently and
 * silently. So it is left non-terminal: `/seam workflows` may offer a rerun,
 * which is the pre-existing behaviour and recoverable, unlike deletion.
 */
export function completionRoute(
  result: Pick<DispatchResult, "returnTo" | "chainId" | "kind">,
  row: { status: string; kind?: string; correlationId?: string | null } | null
): CompletionRoute {
  if (!row) return { action: "skip", reason: "unknown-row" };
  if (TERMINAL_STATUSES.has(row.status)) return { action: "skip", reason: "terminal" };

  // The done-file's own kind wins; the ledger row is the fallback for files
  // written before `kind` was carried.
  const kind = result.kind ?? row.kind;

  if (kind && SELF_DELIVERING_KINDS.has(kind)) return { action: "terminalize" };
  // A forward's correlationId is its chain id by contract, so a legacy forward
  // recovers its chain advance from the row rather than being written off.
  const chainId =
    result.chainId ?? (kind === "forward" ? (row.correlationId ?? undefined) : undefined);
  if (chainId) return { action: "chain", chainId };
  if (result.returnTo) return { action: "report_back", returnTo: result.returnTo };
  if (kind && NO_ONWARD_KINDS.has(kind)) return { action: "terminalize" };
  return { action: "skip", reason: "delivery-unprovable" };
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
    skippedUnprovable: 0,
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

    let row: { status: string; kind?: string; correlationId?: string | null } | null;
    try {
      row = deps.getDelegation(result.id);
    } catch (err) {
      deps.logger.warn({ err, id: result.id }, "done-reconcile: ledger lookup failed");
      summary.failed++;
      continue;
    }

    const route = completionRoute(result, row);
    if (route.action === "skip") {
      if (route.reason === "unknown-row") summary.skippedUnknown++;
      else if (route.reason === "terminal") summary.skippedTerminal++;
      else {
        summary.skippedUnprovable++;
        deps.logger.warn(
          { id: result.id, kind: result.kind ?? row?.kind, status: row?.status },
          "done-reconcile: cannot prove onward delivery; leaving row non-terminal"
        );
      }
      continue;
    }

    try {
      await deps.replay(result, route);
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

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
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../../lib/logger.js";
import { DELEGATION_TERMINAL_STATUSES } from "../types.js";
import type { LedgerEntry } from "../types.js";
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
  getDelegation: (id: string) => DoneLedgerState | null;
  /** Non-terminal ledger rows are the bounded recovery index. */
  listRecoveryCandidates: (
    after: DoneRetentionCursor | null,
    limit: number
  ) => DoneLedgerRow[];
  recoveryBatchSize?: number;
  /** Replay the completion side effects for one finished dispatch. */
  replay: (result: DispatchResult, route: CompletionRoute) => Promise<void>;
}

export type DoneLedgerRow = Pick<
  LedgerEntry,
  "id" | "status" | "updatedUtc"
> & Partial<Pick<LedgerEntry, "kind" | "correlationId" | "targetRef">>;

export type DoneLedgerState = Pick<LedgerEntry, "status"> &
  Partial<Pick<LedgerEntry, "id" | "updatedUtc" | "kind" | "correlationId" | "targetRef">>;

export interface DoneRetentionCursor {
  updatedUtc: string;
  id: string;
}

/** Recovery also has a hard ceiling; its cursor makes overflow resumable. */
export const DONE_RECOVERY_BATCH_SIZE = 256;

export interface DoneReconcileSummary {
  /** Existing recovery files opened. */
  scanned: number;
  recoveryCandidates: number;
  reconciled: number;
  skippedTerminal: number;
  skippedUnknown: number;
  /** Legacy done-files whose delivery cannot be proven — deliberately left. */
  skippedUnprovable: number;
  failed: number;
}

const RECOVERY_CURSOR_FILE = ".done-recovery-cursor.json";

function safeDonePath(doneDir: string, id: string): string | null {
  if (!id || id.includes("/") || id.includes("\\") || id.includes("\0")) return null;
  const candidate = path.resolve(doneDir, `${id}.json`);
  return path.dirname(candidate) === path.resolve(doneDir) ? candidate : null;
}

function handleInvalidDoneFile(
  row: DoneLedgerRow,
  logger: Logger,
  summary: DoneReconcileSummary,
  reason: string
): void {
  // Malformed output is unresolved evidence, not permission to discard it.
  // Retention owns deletion and requires the canonical delivery resolver.
  summary.failed++;
  logger.warn({ id: row.id, reason }, "done-reconcile: invalid artifact retained for operator repair");
}

async function readDone(
  row: DoneLedgerRow,
  dirs: ReturnType<typeof dispatchDirs>,
  logger: Logger,
  summary: DoneReconcileSummary
): Promise<DispatchResult | null> {
  const file = safeDonePath(dirs.done, row.id);
  if (!file) {
    summary.failed++;
    logger.warn({ id: row.id }, "done-reconcile: refused unsafe ledger artifact id");
    return null;
  }
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    summary.scanned++;
    handleInvalidDoneFile(row, logger, summary, "read failed");
    return null;
  }
  summary.scanned++;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") throw new Error("result is not an object");
    const result = parsed as Partial<DispatchResult>;
    if (
      typeof result.target !== "string" ||
      (result.status !== "completed" && result.status !== "failed") ||
      typeof result.finishedUtc !== "string"
    ) {
      throw new Error("result is missing required completion fields");
    }
    // The filename/ledger id is authoritative, matching watcher finalization.
    return { ...result, id: row.id } as DispatchResult;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    handleInvalidDoneFile(row, logger, summary, reason);
    return null;
  }
}

async function readMaintenanceCursor(
  root: string,
  name: string,
  logger: Logger
): Promise<DoneRetentionCursor | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(root, name), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") throw new Error("cursor is not an object");
    const cursor = parsed as Partial<DoneRetentionCursor>;
    if (typeof cursor.updatedUtc !== "string" || typeof cursor.id !== "string") {
      throw new Error("cursor fields are invalid");
    }
    return { updatedUtc: cursor.updatedUtc, id: cursor.id };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn({ err, cursor: name }, "done-reconcile: maintenance cursor unreadable; restarting sweep");
    }
    return null;
  }
}

async function writeMaintenanceCursor(
  root: string,
  name: string,
  cursor: DoneRetentionCursor | null
): Promise<void> {
  await mkdir(root, { recursive: true });
  const file = path.join(root, name);
  if (!cursor) {
    await unlink(file).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });
    return;
  }
  const tmp = path.join(root, `.${name}.tmp`);
  await writeFile(tmp, `${JSON.stringify(cursor)}\n`, "utf8");
  await rename(tmp, file);
}

/**
 * True when `result` still has completion work owed to it.
 *
 * Split out so the predicate is testable without a filesystem: a done-file is
 * reconcilable when its ledger row exists and is non-terminal. Routing is
 * irrelevant here — it decides WHAT the replay does, not WHETHER it is owed.
 */
export function needsCompletionReplay(
  result: Pick<DispatchResult, "returnTo" | "chainId" | "kind" | "suppressedOnward" | "inlinedReportBack">,
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
 *   - an interrupt-suppressed completion (#67) owes only the ledger row;
 *   - a same-thread stateless-handoff card already wrote the report-back onto
 *     its Done embed; it owes only the ledger row;
 *   - self-delivering kinds (compact / ingest / thread_voice) already posted
 *     their own result; they owe only the ledger row;
 *   - a chainId advances the chain;
 *   - otherwise a returnTo enqueues the report-back;
 *   - a kind that never delivers onward owes only the ledger row.
 *
 * The remaining case is the dangerous one. A done-file with no routing and a
 * delivery-bearing kind was written before #174 carried routing. It cannot
 * prove its report-back was ever
 * enqueued, and terminalizing it would strand the answer permanently and
 * silently. So it is left non-terminal: `/seam workflows` may offer a rerun,
 * which is the pre-existing behaviour and recoverable, unlike deletion.
 */
export function completionRoute(
  result: Pick<DispatchResult, "returnTo" | "chainId" | "kind" | "suppressedOnward" | "inlinedReportBack">,
  row: { status: string; kind?: string; correlationId?: string | null } | null
): CompletionRoute {
  if (!row) return { action: "skip", reason: "unknown-row" };
  if (TERMINAL_STATUSES.has(row.status)) return { action: "skip", reason: "terminal" };

  // #67: the live path already decided this completion owes nothing onward
  // because an interrupt cancelled the turn and issued a replacement directive
  // in its place. The routing below is still on the file — it is copied from
  // the spec unconditionally — so this check has to come FIRST, or replay
  // delivers the stale answer after the directive that superseded it. Only the
  // ledger row is owed.
  if (result.suppressedOnward) return { action: "terminalize" };

  // Stateless handoff card: the live path already put the report-back on the
  // Done embed. `returnTo` is still copied onto the done-file (it names the
  // caller), so without this check replay would inject a live caller turn.
  if (result.inlinedReportBack) return { action: "terminalize" };

  // The done-file's own kind wins; the ledger row is the fallback for files
  // written before `kind` was carried.
  const kind = result.kind ?? row.kind;

  if (kind && SELF_DELIVERING_KINDS.has(kind)) return { action: "terminalize" };
  // `kind: "forward"` is shared by chain hops and the plain MCP forward tool.
  // Only an explicit `chainId` proves this completion belongs to a chain;
  // `correlationId` is merely the dispatch id on a plain forward. Guessing from
  // it can terminalize the worker row without delivering its report-back.
  if (result.chainId) return { action: "chain", chainId: result.chainId };
  if (result.returnTo) return { action: "report_back", returnTo: result.returnTo };
  if (kind && NO_ONWARD_KINDS.has(kind)) return { action: "terminalize" };
  return { action: "skip", reason: "delivery-unprovable" };
}

/**
 * Replay completion from exact non-terminal ledger ids. Retention is a
 * separate proof-only background sweep; this recovery pass never deletes an
 * output or enumerates the lifetime done directory.
 *
 * Best-effort by contract — a failure to replay one dispatch is logged and the
 * pass continues, because blocking boot on a stale done-file would be worse
 * than the undelivered report-back it is trying to repair.
 */
export async function reconcileCompletedDoneFiles(
  deps: DoneReconcileDeps
): Promise<DoneReconcileSummary> {
  const dirs = dispatchDirs(deps.dataDir);
  const summary: DoneReconcileSummary = {
    scanned: 0,
    recoveryCandidates: 0,
    reconciled: 0,
    skippedTerminal: 0,
    skippedUnknown: 0,
    skippedUnprovable: 0,
    failed: 0,
  };

  const recoveryBatchSize = Math.max(
    1,
    Math.floor(deps.recoveryBatchSize ?? DONE_RECOVERY_BATCH_SIZE)
  );
  const recoveryAfter = await readMaintenanceCursor(
    dirs.root,
    RECOVERY_CURSOR_FILE,
    deps.logger
  );
  let recoveryRows: DoneLedgerRow[];
  try {
    recoveryRows = deps.listRecoveryCandidates(recoveryAfter, recoveryBatchSize);
  } catch (err) {
    summary.failed++;
    deps.logger.warn({ err }, "done-reconcile: recovery index lookup failed");
    deps.logger.info(summary, "done-reconcile: boot maintenance summary");
    return summary;
  }
  summary.recoveryCandidates = recoveryRows.length;

  for (const indexedRow of recoveryRows) {
    const result = await readDone(indexedRow, dirs, deps.logger, summary);
    if (!result) continue;
    let row: DoneLedgerState | null;
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

  try {
    const last = recoveryRows.at(-1);
    const next =
      last && recoveryRows.length >= recoveryBatchSize
        ? { updatedUtc: last.updatedUtc, id: last.id }
        : null;
    await writeMaintenanceCursor(dirs.root, RECOVERY_CURSOR_FILE, next);
  } catch (err) {
    summary.failed++;
    deps.logger.warn({ err }, "done-reconcile: recovery cursor update failed");
  }

  deps.logger.info(summary, "done-reconcile: boot maintenance summary");
  return summary;
}

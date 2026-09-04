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
import { createHash, randomUUID } from "node:crypto";
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
  /** Optional retention surface. Omitted by narrow callers that only repair. */
  retention?: {
    listCandidates: (
      cutoffUtc: string,
      after: DoneRetentionCursor | null,
      limit: number
    ) => DoneLedgerRow[];
    getReportBackByCorrelation: (correlationId: string) => DoneLedgerRow | null;
    now?: () => Date;
    maxAgeMs?: number;
    batchSize?: number;
  };
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

/** Thirty days keeps operator evidence while placing a finite ceiling on it. */
export const DONE_RETENTION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** At most this many old terminal artifacts are opened during one boot. */
export const DONE_RETENTION_BATCH_SIZE = 256;
/** Recovery also has a hard ceiling; its cursor makes overflow resumable. */
export const DONE_RECOVERY_BATCH_SIZE = 256;

export interface DoneReconcileSummary {
  /** Existing files opened across recovery and retention. */
  scanned: number;
  recoveryCandidates: number;
  retentionCandidates: number;
  reconciled: number;
  pruned: number;
  quarantined: number;
  retainedPending: number;
  skippedTerminal: number;
  skippedUnknown: number;
  /** Legacy done-files whose delivery cannot be proven — deliberately left. */
  skippedUnprovable: number;
  failed: number;
}

const SETTLED_ONWARD_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "timed_out",
]);

const RECOVERY_CURSOR_FILE = ".done-recovery-cursor.json";
const RETENTION_CURSOR_FILE = ".done-retention-cursor.json";

function safeDonePath(doneDir: string, id: string): string | null {
  if (!id || id.includes("/") || id.includes("\\") || id.includes("\0")) return null;
  const candidate = path.resolve(doneDir, `${id}.json`);
  return path.dirname(candidate) === path.resolve(doneDir) ? candidate : null;
}

async function quarantineDoneFile(
  source: string,
  id: string,
  dirs: ReturnType<typeof dispatchDirs>,
  logger: Logger,
  reason: string
): Promise<boolean> {
  const quarantineDir = path.join(dirs.root, "done-quarantine");
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 24);
  const destination = path.join(quarantineDir, `${digest}-${randomUUID()}.json`);
  try {
    await mkdir(quarantineDir, { recursive: true });
    await rename(source, destination);
    logger.warn({ id, destination, reason }, "done-reconcile: quarantined unreadable artifact");
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    logger.warn({ err, id, reason }, "done-reconcile: artifact quarantine failed");
    return false;
  }
}

async function handleInvalidDoneFile(
  source: string,
  row: DoneLedgerRow,
  dirs: ReturnType<typeof dispatchDirs>,
  logger: Logger,
  summary: DoneReconcileSummary,
  reason: string
): Promise<void> {
  // A non-terminal file is recovery authority even when it is malformed. Do
  // not move it out of the canonical location; make the failure visible and
  // leave it for operator repair. Terminal files may be moved losslessly into
  // quarantine because the ledger already prevents a paid rerun.
  if (!TERMINAL_STATUSES.has(row.status)) {
    summary.failed++;
    logger.warn(
      { id: row.id, reason },
      "done-reconcile: invalid non-terminal artifact retained for operator repair"
    );
    return;
  }
  if (await quarantineDoneFile(source, row.id, dirs, logger, reason)) {
    summary.quarantined++;
  } else {
    summary.failed++;
  }
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
    await handleInvalidDoneFile(file, row, dirs, logger, summary, "read failed");
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
    await handleInvalidDoneFile(file, row, dirs, logger, summary, reason);
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

function onwardIsSettled(
  result: DispatchResult,
  row: DoneLedgerState,
  deps: DoneReconcileDeps
): boolean {
  // Reclassify with a non-terminal status: the live route is still required
  // to prove whether a terminal source had an onward obligation.
  const route = completionRoute(result, { ...row, status: "interrupted" });
  if (route.action === "terminalize") return true;
  if (route.action === "skip") return false;

  const lookup = deps.retention!.getReportBackByCorrelation;
  if (route.action === "report_back") {
    const correlation = result.correlationId ?? result.id;
    const delivery = lookup(correlation);
    return Boolean(delivery && SETTLED_ONWARD_STATUSES.has(delivery.status));
  }

  // A chain plan is a terminal synthetic row; its targetRef names the actual
  // next hop/origin-delivery. Only that target becoming settled proves the
  // parent's output is no longer needed to reconstruct the onward spec.
  const plan = lookup(result.id);
  if (!plan?.targetRef) return false;
  const child = deps.getDelegation(plan.targetRef);
  return Boolean(child && SETTLED_ONWARD_STATUSES.has(child.status));
}

/**
 * True when `result` still has completion work owed to it.
 *
 * Split out so the predicate is testable without a filesystem: a done-file is
 * reconcilable when its ledger row exists and is non-terminal. Routing is
 * irrelevant here — it decides WHAT the replay does, not WHETHER it is owed.
 */
export function needsCompletionReplay(
  result: Pick<DispatchResult, "returnTo" | "chainId" | "kind" | "suppressedOnward">,
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
  result: Pick<DispatchResult, "returnTo" | "chainId" | "kind" | "suppressedOnward">,
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
 * Replay completion from exact non-terminal ledger ids, then inspect one
 * keyset-paginated retention window of old terminal ids. At no point does boot
 * enumerate `done/`, so lifetime completion volume cannot inflate startup.
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
    retentionCandidates: 0,
    reconciled: 0,
    pruned: 0,
    quarantined: 0,
    retainedPending: 0,
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

  if (deps.retention) {
    const now = deps.retention.now?.() ?? new Date();
    const maxAgeMs = deps.retention.maxAgeMs ?? DONE_RETENTION_MAX_AGE_MS;
    const batchSize = Math.max(
      1,
      Math.floor(deps.retention.batchSize ?? DONE_RETENTION_BATCH_SIZE)
    );
    const cutoffMs = now.getTime() - maxAgeMs;
    const cutoffUtc = new Date(cutoffMs).toISOString();
    const after = await readMaintenanceCursor(dirs.root, RETENTION_CURSOR_FILE, deps.logger);
    let retentionRows: DoneLedgerRow[] = [];
    try {
      retentionRows = deps.retention.listCandidates(cutoffUtc, after, batchSize);
    } catch (err) {
      summary.failed++;
      deps.logger.warn({ err }, "done-reconcile: retention index lookup failed");
    }
    summary.retentionCandidates = retentionRows.length;

    for (const indexedRow of retentionRows) {
      const result = await readDone(indexedRow, dirs, deps.logger, summary);
      if (!result) continue;
      const finishedMs = Date.parse(result.finishedUtc);
      if (!Number.isFinite(finishedMs)) {
        const file = safeDonePath(dirs.done, result.id);
        if (file) {
          await handleInvalidDoneFile(
            file,
            indexedRow,
            dirs,
            deps.logger,
            summary,
            "finishedUtc is invalid"
          );
        } else {
          summary.failed++;
        }
        continue;
      }
      if (finishedMs >= cutoffMs) {
        continue;
      }
      try {
        // Re-read the source and onward rows immediately before deletion. The
        // paginated candidate snapshot is never deletion authority.
        const current = deps.getDelegation(result.id);
        if (!current || !TERMINAL_STATUSES.has(current.status)) {
          summary.retainedPending++;
          continue;
        }
        if (!onwardIsSettled(result, current, deps)) {
          summary.retainedPending++;
          continue;
        }
        const file = safeDonePath(dirs.done, result.id);
        if (!file) {
          summary.failed++;
          continue;
        }
        await unlink(file);
        summary.pruned++;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          summary.failed++;
          deps.logger.warn({ err, id: result.id }, "done-reconcile: terminal prune failed");
        }
      }
    }

    try {
      const last = retentionRows.at(-1);
      // A short page reached the end. Clearing wraps the next boot to the
      // oldest retained item; full pages advance monotonically without any
      // artifact being able to starve later ids.
      const next =
        last && retentionRows.length >= batchSize
          ? { updatedUtc: last.updatedUtc, id: last.id }
          : null;
      await writeMaintenanceCursor(dirs.root, RETENTION_CURSOR_FILE, next);
    } catch (err) {
      summary.failed++;
      deps.logger.warn({ err }, "done-reconcile: retention cursor update failed");
    }
  }

  deps.logger.info(summary, "done-reconcile: boot maintenance summary");
  return summary;
}

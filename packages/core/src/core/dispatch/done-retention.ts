import { lstatSync, readFileSync, unlinkSync } from "node:fs";
import { opendir } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { Logger } from "../../lib/logger.js";
import { dispatchDirs, type DispatchResult } from "./types.js";
import { isDoneArtifactDeletable, type DoneDeliveryProofLookup } from "./done-reconcile.js";

export interface DoneRetentionDeps {
  dataDir: string;
  logger: Logger;
  /** The delivery resolver's durable decision, never inferred from file age,
   * worker success, or a completed parent with an unresolved onward result. */
  isArtifactDeletable: (id: string) => boolean;
}

/** Bind the canonical #305 route-aware resolver without putting any delivery
 * interpretation in the retention mechanism or the maintenance CLI. */
export function bindDoneDeliveryResolver(opts: DoneDeliveryProofLookup & {
  dataDir: string;
  logger: Logger;
}): DoneRetentionDeps {
  return { dataDir: opts.dataDir, logger: opts.logger, isArtifactDeletable: (id) => {
    const row = opts.getDelegation(id);
    if (!row) return false; // Unknown ownership cannot supply the canonical proof input.
    const raw = readFileSync(path.join(dispatchDirs(opts.dataDir).done, `${id}.json`), "utf8");
    let result: DispatchResult;
    try {
      const parsed = JSON.parse(raw);
      // Malformed legacy output is unresolved evidence. Without validation a
      // missing route can be mistaken for a no-onward obligation.
      if (!parsed || typeof parsed !== "object" || typeof parsed.target !== "string" ||
        !["completed", "failed"].includes(parsed.status) || typeof parsed.finishedUtc !== "string") {
        throw new Error("invalid result");
      }
      result = { ...parsed, id };
    } catch {
      // JSON parser errors can contain private prompt/output fragments.
      throw new Error("invalid done artifact; retained for operator repair");
    }
    return isDoneArtifactDeletable(result, row, opts);
  } };
}

export interface DonePruneSummary {
  scanned: number;
  pruned: number;
  retained: number;
  failed: number;
  bytes: number;
  dryRun: boolean;
  limitReached: boolean;
}

/** Bound destructive work per pass, including bulk operator-authorized expiry.
 * Dry-run audits the whole buffer; retained prefixes must not starve later ids. */
export const DONE_PRUNE_MAX_PER_SWEEP = 1000;

/** Delete only the redundant artifact, not the durable outcome or delivery
 * evidence. Synchronous proof + unlink leaves no in-process await gap in which
 * the checked artifact can be replaced. Missing files make retry idempotent. */
export function pruneDoneArtifact(
  deps: DoneRetentionDeps,
  id: string,
  dryRun = false
): { state: "pruned" | "retained" | "missing"; bytes: number } {
  // Exact basename confinement prevents a malformed ledger/operator id from
  // deleting outside done/. Removing it turns this API into arbitrary unlink.
  if (!id || id === "." || id === ".." || /[/\\\0]/.test(id)) {
    throw new Error("invalid dispatch artifact id");
  }
  const file = path.join(dispatchDirs(deps.dataDir).done, `${id}.json`);
  try {
    const stat = lstatSync(file);
    // Non-files are unresolved operator evidence; never recurse or follow a
    // symlink. Without this check a malformed artifact silently disappears.
    if (!stat.isFile() || !deps.isArtifactDeletable(id)) return { state: "retained", bytes: 0 };
    if (!dryRun) unlinkSync(file);
    return { state: "pruned", bytes: stat.size };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing", bytes: 0 };
    throw err;
  }
}

/** Stream existing filenames, not the lifetime SQL ledger. The canonical
 * resolver reads one result at a time for routing, never logging its body.
 * Repeated sweeps are idempotent, so no maintenance cursor is needed.
 * Yield between small batches to keep backlog cleanup off the boot critical
 * path. Unknown/undelivered files remain in their recovery location. */
export async function pruneDoneArtifacts(
  deps: DoneRetentionDeps,
  opts: { dryRun?: boolean; shouldStop?: () => boolean; maxPruned?: number } = {}
): Promise<DonePruneSummary> {
  const maxPruned = opts.maxPruned ?? DONE_PRUNE_MAX_PER_SWEEP;
  // Invalid or unbounded budgets must fail before the first destructive operation.
  if (!Number.isInteger(maxPruned) || maxPruned < 1 || maxPruned > DONE_PRUNE_MAX_PER_SWEEP) {
    throw new Error(`maxPruned must be an integer from 1 to ${DONE_PRUNE_MAX_PER_SWEEP}`);
  }
  const summary: DonePruneSummary = { scanned: 0, pruned: 0, retained: 0, failed: 0, bytes: 0, dryRun: opts.dryRun === true, limitReached: false };
  try {
    const dir = await opendir(dispatchDirs(deps.dataDir).done);
    for await (const entry of dir) {
      // A stopped manager must not reach SQLite after shutdown closes it.
      if (opts.shouldStop?.()) break;
      if (!entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(0, -5);
      summary.scanned++;
      try {
        const result = pruneDoneArtifact(deps, id, summary.dryRun);
        if (result.state === "pruned") { summary.pruned++; summary.bytes += result.bytes; }
        else if (result.state === "retained") summary.retained++;
      } catch (err) {
        summary.failed++;
        deps.logger.warn({ id, err }, "done-retention: artifact retained after prune failure");
      }
      if (!summary.dryRun && summary.pruned >= maxPruned) {
        summary.limitReached = true;
        break;
      }
      if (summary.scanned % 64 === 0) await setImmediate();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      summary.failed++;
      deps.logger.warn({ err }, "done-retention: cannot enumerate artifacts");
    }
  }
  return summary;
}

/** The post-publication fast path handles already-resolved delivery. This
 * background sweep handles the backlog and delivery established later. */
export class DoneRetention {
  private timer?: NodeJS.Timeout;
  private stopped = true;
  private active?: Promise<DonePruneSummary>;

  constructor(private readonly deps: DoneRetentionDeps, private readonly intervalMs = 60_000) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async drain(): Promise<void> { await this.active; }

  async resultPublished(id: string): Promise<void> {
    pruneDoneArtifact(this.deps, id);
  }

  private sweep(): Promise<DonePruneSummary> | undefined {
    // Coalesce slow scans; otherwise an interval can multiply backlog work.
    if (this.stopped || this.active) return this.active;
    const work = pruneDoneArtifacts(this.deps, { shouldStop: () => this.stopped });
    this.active = work;
    void work.then((summary) => {
      this.deps.logger.info(summary, "done-retention: sweep summary");
    }).finally(() => { this.active = undefined; });
    return work;
  }
}

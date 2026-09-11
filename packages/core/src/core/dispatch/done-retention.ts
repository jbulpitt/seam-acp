import { lstatSync, unlinkSync } from "node:fs";
import { opendir } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { Logger } from "../../lib/logger.js";
import { dispatchDirs } from "./types.js";

export interface DoneRetentionDeps {
  dataDir: string;
  logger: Logger;
  /** The delivery resolver's durable decision, never inferred from file age,
   * worker success, or a completed parent with an unresolved onward result. */
  isDeliveryResolved: (id: string) => boolean;
}

export interface DonePruneSummary {
  scanned: number;
  pruned: number;
  retained: number;
  failed: number;
  bytes: number;
  dryRun: boolean;
}

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
    if (!stat.isFile() || !deps.isDeliveryResolved(id)) return { state: "retained", bytes: 0 };
    if (!dryRun) unlinkSync(file);
    return { state: "pruned", bytes: stat.size };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing", bytes: 0 };
    throw err;
  }
}

/** Stream existing filenames, not prompt/output bodies or the lifetime SQL
 * ledger. Repeated sweeps are idempotent, so no maintenance cursor is needed.
 * Yield between small batches to keep backlog cleanup off the boot critical
 * path. Unknown/undelivered files remain in their recovery location. */
export async function pruneDoneArtifacts(
  deps: DoneRetentionDeps,
  opts: { dryRun?: boolean; shouldStop?: () => boolean } = {}
): Promise<DonePruneSummary> {
  const summary: DonePruneSummary = { scanned: 0, pruned: 0, retained: 0, failed: 0, bytes: 0, dryRun: opts.dryRun === true };
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

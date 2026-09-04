import { Cron } from "croner";
import type { Logger } from "../../lib/logger.js";
import { MODEL_METADATA_REFRESH_CRON } from "./artificial-analysis.js";
import { buildModelMetadataSnapshot } from "./catalog.js";
import type { ModelMetadataStore } from "./store.js";
import type { AgentModelAvailability, MetadataSource } from "./types.js";

export interface ModelMetadataManagerOptions {
  store: ModelMetadataStore;
  logger: Logger;
  source: MetadataSource;
  getCatalog: () => Promise<AgentModelAvailability[]>;
  now?: () => Date;
}

export class ModelMetadataManager {
  private job?: Cron;
  private inFlight?: Promise<void>;
  private stopped = false;

  constructor(private readonly options: ModelMetadataManagerOptions) {}

  start(): void {
    if (this.stopped || this.job) return;
    this.job = new Cron(
      MODEL_METADATA_REFRESH_CRON,
      { timezone: "UTC", name: "model-metadata" },
      () => this.onRefreshTick()
    );
    void this.refresh();
    this.options.logger.info(
      { nextRunUtc: this.job.nextRun()?.toISOString() },
      "model metadata refresh armed"
    );
  }

  stop(): void {
    this.stopped = true;
    this.job?.stop();
    this.job = undefined;
  }

  /** Await the in-flight refresh, if any. New refreshes cannot start after stop. */
  async drain(): Promise<void> {
    while (this.inFlight) {
      await this.inFlight;
    }
  }

  /** Cron entry: a tick queued before stop is a no-op once admission is closed. */
  private onRefreshTick(): void {
    if (this.stopped) return;
    void this.refresh();
  }

  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.stopped) return Promise.resolve();
    this.inFlight = this.refreshInner().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async refreshInner(): Promise<void> {
    try {
      const [sourceModels, catalog] = await Promise.all([
        this.options.source.fetch(),
        this.options.getCatalog(),
      ]);
      if (catalog.length === 0) throw new Error("agent model catalog is empty");
      const fetchedAt = (this.options.now?.() ?? new Date()).toISOString();
      const snapshot = buildModelMetadataSnapshot({
        catalog,
        sourceModels,
        source: this.options.source.name,
        fetchedAt,
      });
      const matches = snapshot.rows.filter((row) => row.slug !== null).length;
      const currentById = new Map(snapshot.rows.map((row) => [row.id, row]));
      const priorComparable = this.options.store.getAll().filter(
        (row) => row.slug !== null && currentById.has(row.id)
      );
      const retainedMatches = priorComparable.filter(
        (row) => currentById.get(row.id)?.slug !== null
      ).length;
      if (
        matches === 0 ||
        (priorComparable.length > 0 && retainedMatches < Math.ceil(priorComparable.length / 2))
      ) {
        throw new Error(
          `model metadata coverage collapsed (${matches} matches; retained ${retainedMatches}/${priorComparable.length} comparable prior matches)`
        );
      }
      for (const [field, covered] of [
        ["benchmarks", (row: typeof snapshot.rows[number]) => Object.keys(row.benchmarks).length > 0],
        ["creator", (row: typeof snapshot.rows[number]) => row.creator !== null],
        ["pricing", (row: typeof snapshot.rows[number]) => row.pricing !== null],
        ["release date", (row: typeof snapshot.rows[number]) => row.released_at !== null],
      ] as const) {
        const priorCovered = priorComparable.filter(covered).length;
        const retainedCovered = priorComparable.filter((row) => {
          const current = currentById.get(row.id);
          return current ? covered(current) : false;
        }).length;
        if (priorCovered > 0 && retainedCovered < Math.ceil(priorCovered / 2)) {
          throw new Error(
            `model metadata ${field} coverage collapsed (${retainedCovered}/${priorCovered} comparable prior rows)`
          );
        }
      }
      if (snapshot.unmatchedModels.length > 0) {
        this.options.logger.warn(
          { models: snapshot.unmatchedModels },
          "model metadata: agent models unmatched by source"
        );
      }
      if (snapshot.ignoredSourceVariants.length > 0) {
        this.options.logger.warn(
          { slugs: snapshot.ignoredSourceVariants },
          "model metadata: ignored source variants with unknown effort labels"
        );
      }
      this.options.store.replaceSnapshot(snapshot.rows);
      this.options.logger.info(
        { fetchedAt, models: snapshot.rows.length, matches, source: this.options.source.name },
        "model metadata snapshot refreshed"
      );
    } catch (err) {
      this.options.logger.error(
        { err },
        "model metadata refresh failed; keeping prior snapshot"
      );
    }
  }
}

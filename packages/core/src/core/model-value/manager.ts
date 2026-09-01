import { Cron } from "croner";
import type { Logger } from "../../lib/logger.js";
import { buildModelValueSnapshot } from "./ranking.js";
import { fetchAaModels, fetchCopilotModelMetadata, fetchCopilotPricing } from "./sources.js";
import { MODEL_METADATA_REFRESH_CRON } from "../model-metadata/artificial-analysis.js";
import type { ModelValueStore } from "./store.js";
import type { AaModel, CopilotModelMetadata, CopilotPricing } from "./types.js";

export interface ModelValueManagerOptions {
  store: ModelValueStore;
  logger: Logger;
  aaApiKey: string;
  inputTokens: number;
  outputTokens: number;
  copilotCliPath?: string;
  fetchAa?: () => Promise<AaModel[]>;
  fetchPricing?: () => Promise<CopilotPricing[]>;
  fetchCopilot?: () => Promise<CopilotModelMetadata[]>;
}

export class ModelValueManager {
  private readonly options: ModelValueManagerOptions;
  private job?: Cron;
  private inFlight?: Promise<void>;
  private onUpdate?: () => void;

  constructor(options: ModelValueManagerOptions) {
    this.options = options;
  }

  start(): void {
    if (this.job) return;
    this.job = new Cron(MODEL_METADATA_REFRESH_CRON, { timezone: "UTC", name: "model-value-ranking" }, () => {
      void this.refresh();
    });
    // Warm asynchronously: MCP remains cache-only and can serve the previous
    // durable snapshot while any network/CLI source is slow or unavailable.
    void this.refresh();
    this.options.logger.info(
      { nextRunUtc: this.job.nextRun()?.toISOString() },
      "model value ranking refresh armed"
    );
  }

  stop(): void {
    this.job?.stop();
    this.job = undefined;
  }

  /** Notify render-only consumers strictly after a new snapshot is durable. */
  setOnUpdate(onUpdate: (() => void) | undefined): void {
    this.onUpdate = onUpdate;
  }

  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.refreshInner().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async refreshInner(): Promise<void> {
    const fetchAa = this.options.fetchAa ?? (() => fetchAaModels(this.options.aaApiKey));
    const fetchPricing = this.options.fetchPricing ?? fetchCopilotPricing;
    const fetchCopilot =
      this.options.fetchCopilot ??
      (() =>
        fetchCopilotModelMetadata({
          ...(this.options.copilotCliPath ? { cliPath: this.options.copilotCliPath } : {}),
        }));
    try {
      const [aaModels, pricing, copilotModels] = await Promise.all([
        fetchAa(),
        fetchPricing(),
        fetchCopilot(),
      ]);
      const fetchedAt = new Date().toISOString();
      const snapshot = buildModelValueSnapshot({
        aaModels,
        pricing,
        copilotModels,
        inputTokens: this.options.inputTokens,
        outputTokens: this.options.outputTokens,
        fetchedAt,
      });
      const priceable = snapshot.rows.filter((row) => row.copilotModel !== "auto");
      const priced = priceable.filter((row) => row.inputRate !== null && row.outputRate !== null);
      if (priceable.length > 0 && priced.length / priceable.length < 0.5) {
        throw new Error(
          `Copilot pricing coverage collapsed (${priced.length}/${priceable.length}); page shape or aliases changed`
        );
      }
      for (const [kind, models] of [
        ["alias", snapshot.unmatchedCopilotModels],
        ["pricing", snapshot.unmatchedPricingModels],
        ["Artificial Analysis", snapshot.unmatchedAaModels],
      ] as const) {
        if (models.length > 0) {
          this.options.logger.warn({ models }, `model value ranking: unmatched ${kind} models`);
        }
      }
      if (snapshot.ignoredAaVariants.length > 0) {
        this.options.logger.warn(
          { aaSlugs: snapshot.ignoredAaVariants },
          "model value ranking: ignored AA variants with unknown effort labels"
        );
      }
      this.options.store.saveSnapshot(snapshot.rows);
      try {
        this.onUpdate?.();
      } catch (err) {
        this.options.logger.warn({ err }, "model value ranking update callback failed");
      }
      this.options.logger.info(
        {
          fetchedAt,
          models: snapshot.rows.length,
          benchmarkMatches: snapshot.rows.filter((row) => row.intelligenceIndex !== null).length,
          pricingMatches: priced.length,
        },
        "model value ranking snapshot refreshed"
      );
    } catch (err) {
      // This is the operational alert required by #130. Crucially, persistence
      // happens only after every source parses and coverage passes, so the last
      // known-good snapshot remains available to MCP.
      this.options.logger.error(
        { err },
        "model value ranking refresh failed; keeping prior snapshot"
      );
    }
  }
}

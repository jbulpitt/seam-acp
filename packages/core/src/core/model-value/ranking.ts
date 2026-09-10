import {
  DEFAULT_MODEL_VALUE_BENCHMARK,
  type AaModel,
  type CopilotModelMetadata,
  type CopilotPricing,
  type ModelValueRanking,
  type ModelValueSnapshotRow,
  type ModelValueTier,
} from "./types.js";
import { matchArtificialAnalysis, matchCopilotPricing, normalizeAaEffort, normalizeExternalModelName } from "../model-intelligence/matching.js";

export { normalizeAaEffort, normalizeExternalModelName as normalizeModelName };

export function creditsPerTask(
  inputTokens: number,
  outputTokens: number,
  inputRate: number,
  outputRate: number
): number {
  return (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000 / 0.01;
}

function tierThresholds(values: number[]): { balanced: number; flagship: number } | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    balanced: sorted[Math.floor((sorted.length - 1) / 3)]!,
    flagship: sorted[Math.floor(((sorted.length - 1) * 2) / 3)]!,
  };
}

function assignTier(value: number | null, thresholds: ReturnType<typeof tierThresholds>): ModelValueTier | null {
  if (value === null || !thresholds) return null;
  if (value >= thresholds.flagship) return "flagship";
  if (value >= thresholds.balanced) return "balanced";
  return "flash";
}

export interface BuildSnapshotResult {
  rows: ModelValueSnapshotRow[];
  unmatchedCopilotModels: string[];
  unmatchedPricingModels: string[];
  unmatchedAaModels: string[];
  ignoredAaVariants: string[];
}

export function buildModelValueSnapshot(input: {
  copilotModels: CopilotModelMetadata[];
  aaModels: AaModel[];
  pricing: CopilotPricing[];
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  longContextThresholdTokens?: number;
  fetchedAt: string;
}): BuildSnapshotResult {
  const intermediate = input.copilotModels.map((model) => {
    const matchable = {
      modelId: model.modelId, displayName: model.displayName, aliases: model.aliases,
      effortChoices: model.validEffortTiers, effortDefault: model.effortDefault,
      effortMechanism: model.effortMechanism,
    };
    const aa = matchArtificialAnalysis(matchable, input.aaModels);
    const totalInput = input.inputTokens + (input.cachedInputTokens ?? 0) + (input.cacheWriteTokens ?? 0);
    const priceTier = totalInput > (input.longContextThresholdTokens ?? 200_000) ? "long-context" : "default";
    const priceMatch = matchCopilotPricing(matchable, input.pricing, priceTier);
    return { model, aa, priceMatch, pricing: priceMatch.row };
  });
  const thresholds = tierThresholds(
    intermediate.flatMap((entry) =>
      entry.aa.row?.intelligenceIndex == null ? [] : [entry.aa.row.intelligenceIndex]
    )
  );
  const matchedAa = new Set(intermediate.flatMap((entry) => (entry.aa.row ? [entry.aa.row.slug] : [])));
  return {
    rows: intermediate.map(({ model, aa, pricing, priceMatch }) => {
      const cached = input.cachedInputTokens ?? 0;
      const writes = input.cacheWriteTokens ?? 0;
      const credits = pricing && (cached === 0 || pricing.cachedInputRate !== null) && (writes === 0 || pricing.cacheWriteRate !== null)
        ? (input.inputTokens * pricing.inputRate + cached * (pricing.cachedInputRate ?? 0) +
          writes * (pricing.cacheWriteRate ?? 0) + input.outputTokens * pricing.outputRate) / 1_000_000 / 0.01
        : null;
      const intelligence = aa.row?.intelligenceIndex ?? null;
      return {
        copilotModel: model.modelId,
        aaSlug: aa.row?.slug ?? null,
        tier: assignTier(intelligence, thresholds),
        intelligenceIndex: intelligence,
        benchmarks: aa.row?.benchmarks ?? {},
        inputRate: pricing?.inputRate ?? null,
        cachedInputRate: pricing?.cachedInputRate ?? null,
        cacheWriteRate: pricing?.cacheWriteRate ?? null,
        outputRate: pricing?.outputRate ?? null,
        creditsPerTask: credits,
        valueScore: intelligence !== null && credits && credits > 0 ? intelligence / credits : null,
        validEffortTiers: model.validEffortTiers,
        priceCategory: model.priceCategory,
        fetchedAt: input.fetchedAt,
        variantId: model.variantId ?? model.modelId,
        displayName: model.displayName,
        selectedBenchmarkEffort: aa.selectedEffort,
        benchmarkSourceName: aa.row?.name ?? null,
        benchmarkMatchStatus: aa.status === "matched" && intelligence === null
          ? "missing-benchmark" : aa.status,
        pricingMatchStatus: model.modelId === "auto" ? "intentionally-unrankable" : priceMatch.status,
        pricingMatchCandidates: priceMatch.candidates,
        pricingMatchRecordName: pricing?.modelName ?? null,
        pricingTier: pricing?.tier ?? null,
        scenario: {
          uncached_input_tokens: input.inputTokens,
          cached_input_tokens: cached,
          cache_write_tokens: writes,
          output_tokens: input.outputTokens,
          long_context_threshold_tokens: input.longContextThresholdTokens ?? 200_000,
        },
        effortDefault: model.effortDefault,
        effortMechanism: model.effortMechanism,
      };
    }),
    unmatchedCopilotModels: intermediate
      .filter((entry) => !entry.aa.row && !entry.pricing)
      .map((entry) => entry.model.modelId),
    unmatchedPricingModels: intermediate
      .filter((entry) => entry.model.modelId !== "auto" && !entry.pricing)
      .map((entry) => entry.model.modelId),
    unmatchedAaModels: intermediate
      .filter((entry) => !entry.aa.row)
      .map((entry) => entry.model.modelId),
    ignoredAaVariants: intermediate.flatMap((entry) => entry.aa.ignored),
  };
}

export function rankSnapshotRows(
  rows: ModelValueSnapshotRow[],
  benchmark = DEFAULT_MODEL_VALUE_BENCHMARK
): ModelValueRanking[] {
  const benchmarkKey = benchmark === "intelligence_index" ? DEFAULT_MODEL_VALUE_BENCHMARK : benchmark;
  const ranked = rows.map((row) => {
    const value =
      benchmarkKey === DEFAULT_MODEL_VALUE_BENCHMARK
        ? row.intelligenceIndex
        : row.benchmarks[benchmarkKey] ?? null;
    const score = value !== null && row.creditsPerTask && row.creditsPerTask > 0
      ? value / row.creditsPerTask
      : null;
    const result: ModelValueRanking = {
      model: row.copilotModel,
      tier: row.tier,
      value_score: score,
      benchmark: value === null ? null : { name: benchmarkKey, value },
      pricing:
        row.inputRate === null || row.outputRate === null || row.creditsPerTask === null
          ? null
          : {
              input_per_million: row.inputRate,
              cached_input_per_million: row.cachedInputRate,
              cache_write_per_million: row.cacheWriteRate,
              output_per_million: row.outputRate,
              credits_per_standard_task: row.creditsPerTask,
            },
      valid_effort_tiers: row.validEffortTiers,
      price_category: row.priceCategory,
      variant_id: row.variantId,
      display_name: row.displayName,
      bindings: row.bindings,
      catalog_generation: row.catalogGeneration,
      enrichment_generation: row.enrichmentGeneration,
      selected_benchmark_effort: row.selectedBenchmarkEffort,
      benchmark_source_name: row.benchmarkSourceName,
      diagnostics: {
        benchmark: row.benchmarkMatchStatus ?? "legacy-unknown",
        pricing: row.pricingMatchStatus ?? "legacy-unknown",
      },
      pricing_tier: row.pricingTier,
      source_snapshots: row.sourceSnapshots,
      source_fetched_at: row.sourceFetchedAt,
      source_status: row.sourceStatus,
      generation_diagnostics: row.generationDiagnostics,
      catalog_default: row.catalogDefault,
      effort_default: row.effortDefault,
      effort_mechanism: row.effortMechanism,
    };
    return result;
  });
  const tierOrder: Record<string, number> = { flagship: 0, balanced: 1, flash: 2 };
  ranked.sort((a, b) => {
    const tierDelta = (tierOrder[a.tier ?? ""] ?? 3) - (tierOrder[b.tier ?? ""] ?? 3);
    if (tierDelta !== 0) return tierDelta;
    if (a.value_score === null && b.value_score !== null) return 1;
    if (a.value_score !== null && b.value_score === null) return -1;
    return (b.value_score ?? 0) - (a.value_score ?? 0) || a.model.localeCompare(b.model) ||
      (a.variant_id ?? a.model).localeCompare(b.variant_id ?? b.model);
  });
  return ranked;
}

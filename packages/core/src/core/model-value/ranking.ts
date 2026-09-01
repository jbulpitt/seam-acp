import {
  DEFAULT_MODEL_VALUE_BENCHMARK,
  type AaModel,
  type CopilotModelMetadata,
  type CopilotPricing,
  type ModelValueRanking,
  type ModelValueSnapshotRow,
  type ModelValueTier,
} from "./types.js";
import {
  MODEL_METADATA_ALIASES,
  chooseAaVariant,
  normalizeAaEffort,
  normalizeModelName,
  type ModelAlias,
} from "../model-metadata/aliases.js";

export {
  MODEL_METADATA_ALIASES as COPILOT_MODEL_VALUE_ALIASES,
  normalizeAaEffort,
  normalizeModelName,
};

function choosePricing(alias: ModelAlias | undefined, pricing: CopilotPricing[]): CopilotPricing | null {
  if (!alias) return null;
  const wanted = new Set(alias.pricingNames.map(normalizeModelName));
  return pricing.find((row) => wanted.has(normalizeModelName(row.modelName))) ?? null;
}

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
  fetchedAt: string;
}): BuildSnapshotResult {
  const intermediate = input.copilotModels.map((model) => {
    const alias = MODEL_METADATA_ALIASES[model.modelId];
    const aa = chooseAaVariant(alias, input.aaModels, model.validEffortTiers);
    return { model, aa, pricing: choosePricing(alias, input.pricing), alias };
  });
  const thresholds = tierThresholds(
    intermediate.flatMap((entry) =>
      entry.aa.row?.intelligenceIndex == null ? [] : [entry.aa.row.intelligenceIndex]
    )
  );
  const matchedAa = new Set(intermediate.flatMap((entry) => (entry.aa.row ? [entry.aa.row.slug] : [])));
  return {
    rows: intermediate.map(({ model, aa, pricing }) => {
      const credits = pricing
        ? creditsPerTask(input.inputTokens, input.outputTokens, pricing.inputRate, pricing.outputRate)
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
      };
    }),
    unmatchedCopilotModels: intermediate.filter((entry) => !entry.alias).map((entry) => entry.model.modelId),
    unmatchedPricingModels: intermediate
      .filter((entry) => entry.model.modelId !== "auto" && !entry.pricing)
      .map((entry) => entry.model.modelId),
    unmatchedAaModels: intermediate
      .filter((entry) => entry.alias && entry.alias.aaSlugPrefixes.length > 0 && !entry.aa.row)
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
    };
    return result;
  });
  const tierOrder: Record<string, number> = { flagship: 0, balanced: 1, flash: 2 };
  ranked.sort((a, b) => {
    const tierDelta = (tierOrder[a.tier ?? ""] ?? 3) - (tierOrder[b.tier ?? ""] ?? 3);
    if (tierDelta !== 0) return tierDelta;
    if (a.value_score === null && b.value_score !== null) return 1;
    if (a.value_score !== null && b.value_score === null) return -1;
    return (b.value_score ?? 0) - (a.value_score ?? 0) || a.model.localeCompare(b.model);
  });
  return ranked;
}

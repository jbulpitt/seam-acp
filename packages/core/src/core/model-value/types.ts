export const DEFAULT_MODEL_VALUE_BENCHMARK = "artificial_analysis_intelligence_index";

export type ModelValueTier = "flagship" | "balanced" | "flash";

export interface AaModel {
  id: string;
  name: string;
  slug: string;
  intelligenceIndex: number | null;
  benchmarks: Record<string, number>;
}

export interface CopilotModelMetadata {
  modelId: string;
  displayName: string;
  validEffortTiers: string[];
  priceCategory: string | null;
}

export interface CopilotPricing {
  modelName: string;
  inputRate: number;
  cachedInputRate: number | null;
  cacheWriteRate: number | null;
  outputRate: number;
}

export interface ModelValueSnapshotRow {
  copilotModel: string;
  aaSlug: string | null;
  tier: ModelValueTier | null;
  intelligenceIndex: number | null;
  benchmarks: Record<string, number>;
  inputRate: number | null;
  cachedInputRate: number | null;
  cacheWriteRate: number | null;
  outputRate: number | null;
  creditsPerTask: number | null;
  valueScore: number | null;
  validEffortTiers: string[];
  priceCategory: string | null;
  fetchedAt: string;
}

export interface ModelValueRanking {
  model: string;
  tier: ModelValueTier | null;
  value_score: number | null;
  benchmark: { name: string; value: number } | null;
  pricing: {
    input_per_million: number;
    cached_input_per_million: number | null;
    cache_write_per_million: number | null;
    output_per_million: number;
    credits_per_standard_task: number;
  } | null;
  valid_effort_tiers: string[];
  price_category: string | null;
}

export interface ModelValueRankingsResult {
  benchmark: string;
  fetched_at: string | null;
  standard_task: { input_tokens: number; output_tokens: number };
  rankings: ModelValueRanking[];
}

export interface ModelValueRefreshDiagnostics {
  unmatchedCopilotModels: string[];
  unmatchedPricingModels: string[];
  unmatchedAaModels: string[];
  ignoredAaVariants: string[];
}

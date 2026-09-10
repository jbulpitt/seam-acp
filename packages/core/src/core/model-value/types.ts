import type { CatalogApplicationMode } from "@seam/adapters";
import type { ExternalMatchStatus } from "../model-metadata/types.js";

export const DEFAULT_MODEL_VALUE_BENCHMARK = "artificial_analysis_intelligence_index";

export type ModelValueTier = "flagship" | "balanced" | "flash";

export type { MetadataSourceModel as AaModel } from "../model-metadata/types.js";

export interface CopilotModelMetadata {
  modelId: string;
  displayName: string;
  validEffortTiers: string[];
  priceCategory: string | null;
  runtimeId?: string;
  aliases?: string[];
  effortDefault?: string;
  effortMechanism?: string;
  variantId?: string;
}

export interface CopilotPricing {
  modelName: string;
  inputRate: number;
  cachedInputRate: number | null;
  cacheWriteRate: number | null;
  outputRate: number;
  tier?: "default" | "long-context";
  thresholdTokens?: number | null;
}

export interface ModelValueScenario {
  uncached_input_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  long_context_threshold_tokens: number;
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
  variantId?: string;
  displayName?: string;
  bindings?: Array<{
    agent: string;
    location: string;
    scope: string;
    generation: number;
    state: "ready" | "stale";
    runtime_id?: string;
    aliases?: string[];
    application_mode?: CatalogApplicationMode;
    effort_choices?: string[];
    effort_default?: string;
    effort_mechanism?: string;
  }>;
  catalogGeneration?: number;
  enrichmentGeneration?: number;
  selectedBenchmarkEffort?: string | null;
  benchmarkSourceName?: string | null;
  benchmarkMatchStatus?: ExternalMatchStatus;
  pricingMatchStatus?: ExternalMatchStatus;
  pricingMatchCandidates?: string[];
  pricingMatchRecordName?: string | null;
  pricingTier?: "default" | "long-context" | null;
  sourceSnapshots?: Record<string, string | null>;
  sourceFetchedAt?: Record<string, string | null>;
  scenario?: ModelValueScenario;
  catalogDefault?: boolean;
  effortDefault?: string;
  effortMechanism?: string;
  sourceStatus?: Record<string, "fresh" | "stale">;
  generationDiagnostics?: string[];
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
  variant_id?: string;
  display_name?: string;
  bindings?: ModelValueSnapshotRow["bindings"];
  catalog_generation?: number;
  enrichment_generation?: number;
  selected_benchmark_effort?: string | null;
  benchmark_source_name?: string | null;
  diagnostics?: {
    benchmark: string;
    pricing: string;
  };
  pricing_tier?: "default" | "long-context" | null;
  source_snapshots?: Record<string, string | null>;
  source_fetched_at?: Record<string, string | null>;
  source_status?: Record<string, "fresh" | "stale">;
  generation_diagnostics?: string[];
  catalog_default?: boolean;
  effort_default?: string;
  effort_mechanism?: string;
}

export interface ModelValueRankingsResult {
  benchmark: string;
  fetched_at: string | null;
  standard_task: { input_tokens: number; output_tokens: number };
  rankings: ModelValueRanking[];
  generation?: number | null;
  matching_policy_version?: string | null;
  published_at?: string | null;
  source_snapshots?: Record<string, string | null>;
  source_fetched_at?: Record<string, string | null>;
  scenario?: ModelValueScenario;
  degraded?: boolean;
  diagnostics?: string[];
}

export interface ModelValueRefreshDiagnostics {
  unmatchedCopilotModels: string[];
  unmatchedPricingModels: string[];
  unmatchedAaModels: string[];
  ignoredAaVariants: string[];
}

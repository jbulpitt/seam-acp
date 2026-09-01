export const DEFAULT_METADATA_BENCHMARK = "artificial_analysis_intelligence_index";

export type ModelModality = "text" | "vision";

export interface ModelCreator {
  id: string;
  name: string;
  slug: string;
}

export interface ModelPricing {
  input_per_million: number | null;
  output_per_million: number | null;
  blended_per_million: number | null;
}

/** Provider-normalized row returned by a MetadataSource. */
export interface MetadataSourceModel {
  id: string;
  name: string;
  slug: string;
  creator: ModelCreator | null;
  releaseDate: string | null;
  intelligenceIndex: number | null;
  benchmarks: Record<string, number>;
  pricing: ModelPricing | null;
}

/** Swappable provider boundary. Accessor reads never receive this interface. */
export interface MetadataSource {
  readonly name: string;
  fetch(): Promise<MetadataSourceModel[]>;
}

export interface AgentModelAvailability {
  agentId: string;
  modelId: string;
  name: string;
  contextWindow: number | null;
  vision: boolean | null;
}

export interface CachedAgentModel {
  agent: string;
  id: string;
  name: string;
}

export interface ModelMetadata {
  id: string;
  name: string;
  aliases: string[];
  slug: string | null;
  source_id: string | null;
  source_name: string | null;
  provider: string | null;
  creator: ModelCreator | null;
  agents: string[];
  agent_models: CachedAgentModel[];
  modalities: ModelModality[];
  context_window: number | null;
  intelligence_index: number | null;
  benchmarks: Record<string, number>;
  pricing: ModelPricing | null;
  released_at: string | null;
  source: string;
  fetched_at: string;
}

export interface ModelMetadataGetResult {
  model: ModelMetadata | null;
}

export interface ModelMetadataFilters {
  provider?: string;
  creator?: string;
  agent?: string;
  modality?: ModelModality;
  minContextWindow?: number;
  benchmark?: { name?: string; min: number };
  maxPrice?: { input?: number; output?: number };
  releasedAfter?: string;
  nameContains?: string;
  hasBenchmark?: boolean;
}

export type ModelMetadataSortField =
  | "benchmark"
  | "price"
  | "inputPrice"
  | "outputPrice"
  | "contextWindow"
  | "releaseDate"
  | "name";

export interface ModelMetadataSort {
  field: ModelMetadataSortField;
  direction?: "asc" | "desc";
  benchmark?: string;
}

export interface ModelMetadataQuery {
  filters?: ModelMetadataFilters;
  sort?: ModelMetadataSort;
  limit?: number;
}

export interface ModelMetadataQueryResult {
  fetched_at: string | null;
  count: number;
  models: ModelMetadata[];
}

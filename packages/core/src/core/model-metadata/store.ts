import Database from "better-sqlite3";
import {
  DEFAULT_METADATA_BENCHMARK,
  type CachedAgentModel,
  type ModelCreator,
  type ModelMetadata,
  type ModelMetadataGetResult,
  type ModelMetadataQuery,
  type ModelMetadataQueryResult,
  type ModelMetadataSort,
  type ModelModality,
  type ModelPricing,
} from "./types.js";

interface DbRow {
  model_id: string;
  name: string;
  aliases_json: string;
  aa_slug: string | null;
  source_id: string | null;
  source_name: string | null;
  provider: string | null;
  creator_json: string | null;
  agents_json: string;
  agent_models_json: string;
  modalities_json: string;
  context_window: number | null;
  intelligence_index: number | null;
  benchmarks_json: string;
  pricing_json: string | null;
  released_at: string | null;
  source: string;
  fetched_at: string;
}

export class ModelMetadataStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS model_metadata (
        model_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        aliases_json TEXT NOT NULL,
        aa_slug TEXT,
        source_id TEXT,
        source_name TEXT,
        provider TEXT,
        creator_json TEXT,
        agents_json TEXT NOT NULL,
        agent_models_json TEXT NOT NULL,
        modalities_json TEXT NOT NULL,
        context_window INTEGER,
        intelligence_index REAL,
        benchmarks_json TEXT NOT NULL,
        pricing_json TEXT,
        released_at TEXT,
        source TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_model_metadata_aa_slug
        ON model_metadata(aa_slug) WHERE aa_slug IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_model_metadata_fetched_at
        ON model_metadata(fetched_at DESC);
    `);
  }

  replaceSnapshot(rows: ModelMetadata[]): void {
    if (rows.length === 0) throw new Error("refusing to persist an empty model metadata snapshot");
    const fetchedAt = rows[0]!.fetched_at;
    if (rows.some((row) => row.fetched_at !== fetchedAt)) {
      throw new Error("model metadata snapshot rows have inconsistent fetched_at values");
    }
    if (new Set(rows.map((row) => row.id)).size !== rows.length) {
      throw new Error("model metadata snapshot contains duplicate ids");
    }
    const insert = this.db.prepare(`
      INSERT INTO model_metadata (
        model_id, name, aliases_json, aa_slug, source_id, source_name, provider,
        creator_json, agents_json, agent_models_json, modalities_json,
        context_window, intelligence_index, benchmarks_json, pricing_json,
        released_at, source, fetched_at
      ) VALUES (
        @model_id, @name, @aliases_json, @aa_slug, @source_id, @source_name, @provider,
        @creator_json, @agents_json, @agent_models_json, @modalities_json,
        @context_window, @intelligence_index, @benchmarks_json, @pricing_json,
        @released_at, @source, @fetched_at
      )
    `);
    this.db.transaction((snapshot: ModelMetadata[]) => {
      this.db.prepare("DELETE FROM model_metadata").run();
      for (const row of snapshot) {
        insert.run({
          model_id: row.id,
          name: row.name,
          aliases_json: JSON.stringify(row.aliases),
          aa_slug: row.slug,
          source_id: row.source_id,
          source_name: row.source_name,
          provider: row.provider,
          creator_json: row.creator ? JSON.stringify(row.creator) : null,
          agents_json: JSON.stringify(row.agents),
          agent_models_json: JSON.stringify(row.agent_models),
          modalities_json: JSON.stringify(row.modalities),
          context_window: row.context_window,
          intelligence_index: row.intelligence_index,
          benchmarks_json: JSON.stringify(row.benchmarks),
          pricing_json: row.pricing ? JSON.stringify(row.pricing) : null,
          released_at: row.released_at,
          source: row.source,
          fetched_at: row.fetched_at,
        });
      }
    })(rows);
  }

  get(idOrSlug: string): ModelMetadataGetResult {
    const wanted = idOrSlug.trim().toLowerCase();
    if (!wanted) throw new Error("idOrSlug is required");
    const model = this.getAll().find(
      (row) =>
        row.id.toLowerCase() === wanted ||
        row.slug?.toLowerCase() === wanted ||
        row.aliases.some((alias) => alias.toLowerCase() === wanted)
    );
    return { model: model ?? null };
  }

  query(input: ModelMetadataQuery = {}): ModelMetadataQueryResult {
    validateQuery(input);
    const filters = input.filters ?? {};
    const allRows = this.getAll();
    let rows = allRows;
    if (filters.provider) {
      const provider = normalized(filters.provider);
      rows = rows.filter((row) => normalized(row.provider ?? "") === provider);
    }
    if (filters.creator) {
      const creator = normalized(filters.creator);
      rows = rows.filter(
        (row) =>
          normalized(row.creator?.name ?? "") === creator ||
          normalized(row.creator?.slug ?? "") === creator
      );
    }
    if (filters.agent) rows = rows.filter((row) => row.agents.includes(filters.agent!));
    if (filters.modality) rows = rows.filter((row) => row.modalities.includes(filters.modality!));
    if (filters.minContextWindow !== undefined) {
      rows = rows.filter(
        (row) => row.context_window !== null && row.context_window >= filters.minContextWindow!
      );
    }
    if (filters.benchmark) {
      const key = benchmarkKey(filters.benchmark.name);
      rows = rows.filter((row) => benchmarkValue(row, key) >= filters.benchmark!.min);
    }
    if (filters.maxPrice?.input !== undefined) {
      rows = rows.filter(
        (row) => row.pricing?.input_per_million != null && row.pricing.input_per_million <= filters.maxPrice!.input!
      );
    }
    if (filters.maxPrice?.output !== undefined) {
      rows = rows.filter(
        (row) => row.pricing?.output_per_million != null && row.pricing.output_per_million <= filters.maxPrice!.output!
      );
    }
    if (filters.releasedAfter) {
      rows = rows.filter((row) => row.released_at !== null && row.released_at > filters.releasedAfter!);
    }
    if (filters.nameContains) {
      const needle = normalized(filters.nameContains);
      rows = rows.filter((row) =>
        [row.id, row.name, row.slug ?? "", row.source_name ?? "", ...row.aliases]
          .some((value) => normalized(value).includes(needle))
      );
    }
    if (filters.hasBenchmark !== undefined) {
      rows = rows.filter((row) => (Object.keys(row.benchmarks).length > 0) === filters.hasBenchmark);
    }
    rows.sort(sorter(input.sort));
    if (input.limit !== undefined) rows = rows.slice(0, input.limit);
    return {
      fetched_at: allRows[0]?.fetched_at ?? null,
      count: rows.length,
      models: rows,
    };
  }

  getAll(): ModelMetadata[] {
    const rows = this.db.prepare("SELECT * FROM model_metadata ORDER BY model_id").all() as DbRow[];
    return rows.map(fromDbRow);
  }

  close(): void {
    this.db.close();
  }
}

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function benchmarkKey(value?: string): string {
  const trimmed = value?.trim();
  return !trimmed || trimmed === "intelligence_index" ? DEFAULT_METADATA_BENCHMARK : trimmed;
}

function benchmarkValue(row: ModelMetadata, key: string): number {
  const value = key === DEFAULT_METADATA_BENCHMARK ? row.intelligence_index : row.benchmarks[key];
  return value ?? Number.NEGATIVE_INFINITY;
}

function sorter(sort?: ModelMetadataSort): (a: ModelMetadata, b: ModelMetadata) => number {
  if (!sort) return (a, b) => a.id.localeCompare(b.id);
  const direction = sort.direction ?? (
    ["price", "inputPrice", "outputPrice", "name"].includes(sort.field) ? "asc" : "desc"
  );
  const multiplier = direction === "asc" ? 1 : -1;
  const value = (row: ModelMetadata): number | string | null => {
    switch (sort.field) {
      case "benchmark": {
        const benchmark = benchmarkValue(row, benchmarkKey(sort.benchmark));
        return Number.isFinite(benchmark) ? benchmark : null;
      }
      case "price": return row.pricing?.blended_per_million ?? null;
      case "inputPrice": return row.pricing?.input_per_million ?? null;
      case "outputPrice": return row.pricing?.output_per_million ?? null;
      case "contextWindow": return row.context_window;
      case "releaseDate": return row.released_at;
      case "name": return row.name.toLowerCase();
    }
  };
  return (a, b) => {
    const av = value(a);
    const bv = value(b);
    if (av === null && bv !== null) return 1;
    if (av !== null && bv === null) return -1;
    if (av === null || bv === null) return a.id.localeCompare(b.id);
    const compared = typeof av === "number" && typeof bv === "number"
      ? av - bv
      : String(av).localeCompare(String(bv));
    return compared * multiplier || a.id.localeCompare(b.id);
  };
}

function validateQuery(input: ModelMetadataQuery): void {
  const { filters = {}, sort, limit } = input;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
    throw new Error("limit must be an integer from 1 to 100");
  }
  if (filters.modality && !["text", "vision"].includes(filters.modality)) {
    throw new Error(`unknown modality: ${filters.modality}`);
  }
  if (filters.minContextWindow !== undefined && (!Number.isFinite(filters.minContextWindow) || filters.minContextWindow < 0)) {
    throw new Error("minContextWindow must be a non-negative number");
  }
  if (filters.benchmark && (!Number.isFinite(filters.benchmark.min) || filters.benchmark.min < 0)) {
    throw new Error("benchmark.min must be a non-negative number");
  }
  for (const price of [filters.maxPrice?.input, filters.maxPrice?.output]) {
    if (price !== undefined && (!Number.isFinite(price) || price < 0)) {
      throw new Error("maxPrice values must be non-negative numbers");
    }
  }
  if (filters.releasedAfter && !/^\d{4}-\d{2}-\d{2}$/.test(filters.releasedAfter)) {
    throw new Error("releasedAfter must be YYYY-MM-DD");
  }
  if (sort && !["benchmark", "price", "inputPrice", "outputPrice", "contextWindow", "releaseDate", "name"].includes(sort.field)) {
    throw new Error(`unknown model metadata sort field: ${sort.field}`);
  }
  if (sort?.direction && !["asc", "desc"].includes(sort.direction)) {
    throw new Error(`unknown sort direction: ${sort.direction}`);
  }
}

function fromDbRow(row: DbRow): ModelMetadata {
  return {
    id: row.model_id,
    name: row.name,
    aliases: parseStringArray(row.aliases_json),
    slug: row.aa_slug,
    source_id: row.source_id,
    source_name: row.source_name,
    provider: row.provider,
    creator: parseObject<ModelCreator>(row.creator_json),
    agents: parseStringArray(row.agents_json),
    agent_models: parseArray<CachedAgentModel>(row.agent_models_json),
    modalities: parseArray<ModelModality>(row.modalities_json).filter((value) => value === "text" || value === "vision"),
    context_window: row.context_window,
    intelligence_index: row.intelligence_index,
    benchmarks: parseNumberMap(row.benchmarks_json),
    pricing: parseObject<ModelPricing>(row.pricing_json),
    released_at: row.released_at,
    source: row.source,
    fetched_at: row.fetched_at,
  };
}

function parseArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function parseStringArray(value: string): string[] {
  return parseArray<unknown>(value).filter((item): item is string => typeof item === "string");
}

function parseObject<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as T : null;
  } catch {
    return null;
  }
}

function parseNumberMap(value: string): Record<string, number> {
  const parsed = parseObject<Record<string, unknown>>(value) ?? {};
  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, number] =>
      typeof entry[1] === "number" && Number.isFinite(entry[1])
    )
  );
}

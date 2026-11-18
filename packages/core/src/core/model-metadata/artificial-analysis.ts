import type { MetadataSource, MetadataSourceModel, ModelCreator, ModelPricing } from "./types.js";

export const AA_MODELS_URL = "https://artificialanalysis.ai/api/v2/language/models/free";
export const MODEL_METADATA_REFRESH_CRON = "0 */12 * * *";

type FetchLike = typeof fetch;

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseCreator(value: unknown): ModelCreator | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && typeof row.name === "string"
    ? { id: row.id, name: row.name, slug: typeof row.slug === "string" ? row.slug : null }
    : null;
}

function parsePricing(value: unknown): ModelPricing | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const pricing: ModelPricing = {
    input_per_million: finiteNumber(row.price_1m_input_tokens),
    output_per_million: finiteNumber(row.price_1m_output_tokens),
    blended_per_million: finiteNumber(row.price_1m_blended_3_to_1),
    ...(Object.hasOwn(row, "price_1m_cache_hit_tokens")
      ? { cached_input_per_million: finiteNumber(row.price_1m_cache_hit_tokens) } : {}),
    ...(Object.hasOwn(row, "price_1m_cache_write_tokens")
      ? { cache_write_per_million: finiteNumber(row.price_1m_cache_write_tokens) } : {}),
  };
  return Object.values(pricing).some((entry) => entry !== null) ? pricing : null;
}

function parseReleaseDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) ? null : value;
}

/** Defensive AA parser shared by metadata and the #130 value pipeline. */
export function parseAaModels(payload: unknown): MetadataSourceModel[] {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { data?: unknown }).data)) {
    throw new Error("Artificial Analysis response is missing the data array");
  }
  const rows: MetadataSourceModel[] = [];
  for (const raw of (payload as { data: unknown[] }).data) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.name !== "string" || typeof row.slug !== "string") {
      continue;
    }
    const evaluations =
      row.evaluations && typeof row.evaluations === "object"
        ? (row.evaluations as Record<string, unknown>)
        : {};
    const benchmarks: Record<string, number> = {};
    for (const [key, value] of Object.entries(evaluations)) {
      const numeric = finiteNumber(value);
      if (numeric !== null) benchmarks[key] = numeric;
    }
    const intelligenceIndex =
      finiteNumber(evaluations.artificial_analysis_intelligence_index) ??
      finiteNumber(evaluations.intelligence_index);
    if (intelligenceIndex !== null) {
      benchmarks.artificial_analysis_intelligence_index = intelligenceIndex;
    }
    rows.push({
      id: row.id,
      name: row.name,
      slug: row.slug,
      creator: parseCreator(row.model_creator),
      releaseDate: parseReleaseDate(row.release_date),
      intelligenceIndex,
      benchmarks,
      pricing: parsePricing(row.pricing),
    });
  }
  if (rows.length === 0) throw new Error("Artificial Analysis response contained no usable models");
  return rows;
}

/** One in-flight request is shared by #130 and #134 when their aligned jobs fire. */
export class ArtificialAnalysisMetadataSource implements MetadataSource {
  readonly name = "artificial-analysis";
  private inFlight?: Promise<MetadataSourceModel[]>;

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  fetch(signal?: AbortSignal): Promise<MetadataSourceModel[]> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchInner(signal).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async fetchInner(signal?: AbortSignal): Promise<MetadataSourceModel[]> {
    return parseAaModels({ data: await fetchAaModelData(this.apiKey, this.fetchImpl, signal) });
  }
}

/** Complete Free response, shared with the optional host MCP compatibility API. */
export async function fetchAaModelData(
  apiKey: string,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal
): Promise<unknown[]> {
  if (!apiKey.trim()) throw new Error("AA_API_KEY is not configured");
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  const data: unknown[] = [];
  let totalPages = 1;
  for (let page = 1; page <= totalPages; page++) {
    const response = await fetchImpl(page === 1 ? AA_MODELS_URL : `${AA_MODELS_URL}?page=${page}`, {
      headers: { "x-api-key": apiKey }, signal: requestSignal,
    });
    if (!response.ok) throw new Error(`Artificial Analysis request failed: HTTP ${response.status} (page ${page})`);
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || !Array.isArray((payload as { data?: unknown }).data)) {
      throw new Error(`Artificial Analysis response is missing the data array (page ${page})`);
    }
    const row = payload as { data: unknown[]; pagination?: { page?: unknown; total_pages?: unknown; has_more?: unknown } };
    const pagination = row.pagination;
    const pages = pagination?.total_pages;
    if (!Number.isSafeInteger(pages) || (pages as number) < page || pagination?.page !== page
      || pagination.has_more !== (page < (pages as number)) || (page > 1 && pages !== totalPages)) {
      throw new Error(`Artificial Analysis response has inconsistent pagination (page ${page})`);
    }
    totalPages = pages as number;
    data.push(...row.data);
  }
  return data;
}

export async function fetchAaModels(
  apiKey: string,
  fetchImpl: FetchLike = fetch
): Promise<MetadataSourceModel[]> {
  return new ArtificialAnalysisMetadataSource(apiKey, fetchImpl).fetch();
}

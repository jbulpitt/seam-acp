import type { MetadataSource, MetadataSourceModel, ModelCreator, ModelPricing } from "./types.js";

export const AA_MODELS_URL = "https://artificialanalysis.ai/api/v2/data/llms/models";
export const MODEL_METADATA_REFRESH_CRON = "0 */12 * * *";

type FetchLike = typeof fetch;

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseCreator(value: unknown): ModelCreator | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && typeof row.name === "string" && typeof row.slug === "string"
    ? { id: row.id, name: row.name, slug: row.slug }
    : null;
}

function parsePricing(value: unknown): ModelPricing | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const pricing: ModelPricing = {
    input_per_million: finiteNumber(row.price_1m_input_tokens),
    output_per_million: finiteNumber(row.price_1m_output_tokens),
    blended_per_million: finiteNumber(row.price_1m_blended_3_to_1),
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

  fetch(): Promise<MetadataSourceModel[]> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchInner().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async fetchInner(): Promise<MetadataSourceModel[]> {
    if (!this.apiKey.trim()) throw new Error("AA_API_KEY is not configured");
    const response = await this.fetchImpl(AA_MODELS_URL, {
      headers: { "x-api-key": this.apiKey },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Artificial Analysis request failed: HTTP ${response.status}`);
    return parseAaModels(await response.json());
  }
}

export async function fetchAaModels(
  apiKey: string,
  fetchImpl: FetchLike = fetch
): Promise<MetadataSourceModel[]> {
  return new ArtificialAnalysisMetadataSource(apiKey, fetchImpl).fetch();
}

// API-only compatibility for artificial-analysis-mcp@1.0.1; keep its MCP handlers.
// Copy the compiled shared reader beside this file as seam-aa-source.js.
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const benchmarkKeys = {
  intelligence_index: 'artificial_analysis_intelligence_index',
  coding_index: 'artificial_analysis_coding_index', math_index: 'artificial_analysis_math_index',
  mmlu_pro: 'mmlu_pro', gpqa: 'gpqa', hle: 'hle', livecodebench: 'livecodebench', scicode: 'scicode',
  math_500: 'math_500', aime: 'aime', aime_25: 'aime_25', ifbench: 'ifbench', lcr: 'lcr',
  terminalbench_hard: 'terminalbench_hard', tau2: 'tau2',
};

export class ArtificialAnalysisAPI {
  constructor(apiKey, fetchData) { this.apiKey = apiKey; this.fetchData = fetchData; }
  async fetchModels() {
    const fetchData = this.fetchData ?? (await import(new URL('./seam-aa-source.js', import.meta.url).href)).fetchAaModelData;
    return (await fetchData(this.apiKey)).map(transformModel);
  }
}

function transformModel(raw) {
  const pricing = raw.pricing ?? {};
  const evaluations = raw.evaluations ?? {};
  const performance = raw.performance ?? {};
  const v3 = raw.performance_v3;
  const seconds = number(performance.median_time_to_first_token_seconds);
  return {
    id: raw.id, name: raw.name, slug: raw.slug, release_date: raw.release_date ?? null,
    creator: { id: raw.model_creator.id, name: raw.model_creator.name, slug: raw.model_creator.slug ?? null },
    pricing: {
      input_per_1m: number(pricing.price_1m_input_tokens), output_per_1m: number(pricing.price_1m_output_tokens),
      blended_per_1m: number(pricing.price_1m_blended_3_to_1),
      cached_input_per_1m: number(pricing.price_1m_cache_hit_tokens), cache_write_per_1m: number(pricing.price_1m_cache_write_tokens),
    },
    // Existing speed fields retain their median meaning; v3 means are separate.
    speed: { tokens_per_second: number(performance.median_output_tokens_per_second),
      time_to_first_token_ms: seconds === null ? null : seconds * 1000 },
    performance_v3: v3 ? {
      mean_output_tokens_per_second: number(v3.mean_output_tokens_per_second),
      mean_time_to_first_token_seconds: number(v3.mean_time_to_first_token_seconds),
      mean_time_to_first_answer_token_seconds: number(v3.mean_time_to_first_answer_token_seconds),
    } : null,
    benchmarks: {
      ...Object.fromEntries(Object.entries(evaluations).map(([key, value]) => [key, number(value)])),
      ...Object.fromEntries(Object.entries(benchmarkKeys).map(([key, source]) => [key, number(evaluations[source])])),
    },
  };
}

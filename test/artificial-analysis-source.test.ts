import { describe, expect, it, vi } from "vitest";
import { ArtificialAnalysisMetadataSource, parseAaModels } from "../packages/core/src/core/model-metadata/artificial-analysis.js";
import { ModelIntelligenceManager, MODEL_INTELLIGENCE_PARSER_VERSION } from "../packages/core/src/core/model-intelligence/manager.js";
import { ModelIntelligenceStore } from "../packages/core/src/core/model-intelligence/store.js";
import { buildModelMetadataSnapshot } from "../packages/core/src/core/model-metadata/catalog.js";

const endpoint = "https://artificialanalysis.ai/api/v2/language/models/free";
// Synthetic rows with the documented Free response shape, not measured scores.
const model = (id: number) => ({
  id: `source-${id}`, name: `Fixture Model ${id}`, slug: `fixture-model-${id}`,
  release_date: "2026-11-01", model_creator: { id: "creator-id", name: "Fixture Creator" },
  evaluations: { artificial_analysis_intelligence_index: 42, artificial_analysis_coding_index: 0, gpqa: null },
  pricing: { price_1m_input_tokens: 0, price_1m_output_tokens: 2, price_1m_cache_hit_tokens: 0.1, price_1m_cache_write_tokens: null },
  performance: { median_output_tokens_per_second: 90, median_time_to_first_token_seconds: 0 },
  performance_v3: { mean_output_tokens_per_second: 75, mean_time_to_first_token_seconds: 1.5 },
});
const page = (number: number, total = 4) => ({ tier: "free", intelligence_index_version: 5,
  pagination: { page: number, page_size: 200, total_pages: total, has_more: number < total }, data: [model(number)] });
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
function fixture(serve: (page: number) => Response | Promise<Response> = number => response(page(number))) {
  return vi.fn(async (url: Parameters<typeof fetch>[0], options?: RequestInit) => {
    const requested = new URL(String(url));
    if (requested.origin + requested.pathname !== endpoint) return new Response("legacy endpoint retired", { status: 410 });
    expect(options?.headers).toEqual({ "x-api-key": "fixture-key" });
    return serve(Number(requested.searchParams.get("page") ?? "1"));
  }) as unknown as ReturnType<typeof vi.fn<typeof fetch>>;
}

describe("Artificial Analysis supported Free client", () => {
  it("reads every page in one shared refresh and enriches a model present only on page four", async () => {
    const fetcher = fixture();
    const source = new ArtificialAnalysisMetadataSource("fixture-key", fetcher);
    const first = source.fetch();
    expect(source.fetch()).toBe(first);
    const rows = await first;
    expect(rows.map(row => row.id)).toEqual(["source-1", "source-2", "source-3", "source-4"]);
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).searchParams.get("page") ?? "1"))
      .toEqual(["1", "2", "3", "4"]);
    const signals = fetcher.mock.calls.map(([, options]) => options?.signal);
    expect(signals.every(signal => signal === signals[0])).toBe(true);
    const snapshot = buildModelMetadataSnapshot({ source: "artificial-analysis", fetchedAt: "2026-11-17T00:00:00Z",
      catalog: [{ agentId: "copilot", modelId: "fixture-model-4", name: "Fixture Model 4", contextWindow: null, vision: null }],
      sourceModels: rows });
    expect(snapshot.rows[0]).toMatchObject({ source_id: "source-4", provider: "Fixture Creator",
      creator: { id: "creator-id", name: "Fixture Creator", slug: null }, intelligence_index: 42,
      pricing: { input_per_million: 0, output_per_million: 2, blended_per_million: null } });
    expect(snapshot.unmatchedModels).toEqual([]);
  });

  it("preserves creator identity without inventing a slug, prices and known benchmark zeros", () => {
    const row = parseAaModels(page(1))[0]!;
    expect(row.creator).toEqual({ id: "creator-id", name: "Fixture Creator", slug: null });
    expect(row.pricing).toMatchObject({ input_per_million: 0, output_per_million: 2, blended_per_million: null,
      cached_input_per_million: 0.1, cache_write_per_million: null });
    expect(row.benchmarks).toEqual({ artificial_analysis_intelligence_index: 42, artificial_analysis_coding_index: 0 });
    expect(row).not.toHaveProperty("contextWindow");
  });

  it("rejects an incomplete refresh with the real later-page HTTP cause and makes no retry", async () => {
    const fetcher = fixture(number => number === 3 ? new Response("rate limited", { status: 429 }) : response(page(number)));
    await expect(new ArtificialAnalysisMetadataSource("fixture-key", fetcher).fetch()).rejects.toThrow("HTTP 429");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["missing pagination", { data: [model(2)] }],
    ["repeated page", page(1)],
    ["inconsistent last page", { ...page(2), pagination: { ...page(2).pagination, has_more: false } }],
    ["changed total", page(2, 5)],
    ["missing data", { ...page(2), data: null }],
  ])("does not publish a partial response with %s", async (_name, invalid) => {
    const fetcher = fixture(number => response(number === 2 ? invalid : page(1)));
    await expect(new ArtificialAnalysisMetadataSource("fixture-key", fetcher).fetch()).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("passes cancellation through and starts a new whole refresh after failure", async () => {
    const cancelled = new AbortController();
    const fetcher = fixture(number => {
      if (number === 2 && !cancelled.signal.aborted) cancelled.abort(new Error("fixture cancellation"));
      if (cancelled.signal.aborted) throw cancelled.signal.reason;
      return response(page(number));
    });
    const source = new ArtificialAnalysisMetadataSource("fixture-key", fetcher);
    await expect(source.fetch(cancelled.signal)).rejects.toThrow("fixture cancellation");
    const fresh = fixture();
    // Same source instance, with the same injected boundary restored to success.
    fetcher.mockImplementation(fresh);
    await expect(source.fetch()).resolves.toHaveLength(4);
    expect(fresh).toHaveBeenCalledTimes(4);
  });

  it("records only a complete successful source snapshot and retains it after a later-page failure", async () => {
    const store = new ModelIntelligenceStore(":memory:");
    const fetcher = fixture();
    const manager = new ModelIntelligenceManager({ store, source: new ArtificialAnalysisMetadataSource("fixture-key", fetcher),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      fetchPricing: async () => [], getCatalog: () => [],
      scenario: { uncached_input_tokens: 8000, cached_input_tokens: 0, cache_write_tokens: 0,
        output_tokens: 2000, long_context_threshold_tokens: 200000 } });
    try {
      await manager.refresh({ forceSources: true });
      const complete = store.latestSourceSuccess("artificial-analysis")!;
      expect(complete).toMatchObject({ sourceUrl: endpoint, parserVersion: MODEL_INTELLIGENCE_PARSER_VERSION, status: "success" });
      expect(complete.records).toHaveLength(4);
      fetcher.mockImplementation(fixture(number => number === 2 ? new Response("upstream failed", { status: 502 }) : response(page(number))));
      await manager.refresh({ forceSources: true });
      expect(store.latestSourceSuccess("artificial-analysis")!.id).toBe(complete.id);
      expect(store.latestSourceAttempt("artificial-analysis")).toMatchObject({ status: "failure", records: [],
        error: "Artificial Analysis request failed: HTTP 502 (page 2)" });
    } finally { manager.stop(); await manager.drain(); store.close(); }
  });

  it("keeps the existing legacy pure-parser fields when they are present", () => {
    const input = model(1);
    const [row] = parseAaModels({ data: [{ ...input, model_creator: { ...input.model_creator, slug: "known-slug" },
      pricing: { price_1m_input_tokens: 1, price_1m_output_tokens: 3, price_1m_blended_3_to_1: 1.5 } }] });
    expect(row).toMatchObject({ creator: { slug: "known-slug" }, pricing: { blended_per_million: 1.5 } });
  });
});

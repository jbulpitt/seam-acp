import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import { buildModelMetadataSnapshot } from "../packages/core/src/core/model-metadata/catalog.js";
import { parseAaModels } from "../packages/core/src/core/model-metadata/artificial-analysis.js";
import { buildModelValueSnapshot } from "../packages/core/src/core/model-value/ranking.js";
import { parseCopilotPricingMarkdown } from "../packages/core/src/core/model-value/sources.js";
import { ModelMetadataStore } from "../packages/core/src/core/model-metadata/store.js";
import { ModelValueStore } from "../packages/core/src/core/model-value/store.js";
import { ModelIntelligenceStore } from "../packages/core/src/core/model-intelligence/store.js";
import { ModelIntelligenceManager } from "../packages/core/src/core/model-intelligence/manager.js";
import type { CatalogFleetBinding } from "../packages/core/src/core/model-catalog/service.js";
import type { CatalogModel } from "@seam/adapters";
import { matchArtificialAnalysis } from "../packages/core/src/core/model-intelligence/matching.js";
import { renderModelValueRankingsLayout } from "../packages/core/src/core/model-value/rankings-card.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Captured from the production AA v2 endpoint on 2026-09-20. Keep these
// literal source facts independent of the parser and matcher under test.
const astraAaPayload = {
  data: [
    {
      id: "2f339a97-9a0d-499a-9cb5-e0db665bfa25",
      name: "GPT-6 Astra (max)",
      slug: "gpt-6-astra",
      release_date: "2026-09-03",
      model_creator: { id: "e67e56e3-15cd-43db-b679-da4660a69f41", name: "OpenAI", slug: "openai" },
      evaluations: {
        artificial_analysis_intelligence_index: 52.7,
        artificial_analysis_coding_index: 76.9,
        gpqa: 0.961,
        hle: 0.547,
        scicode: 0.565,
      },
      pricing: {
        price_1m_input_tokens: 10,
        price_1m_output_tokens: 50,
        price_1m_blended_3_to_1: 20,
      },
    },
    {
      id: "1f541ef3-913f-4eb2-9d07-0e93c7a9a5e3",
      name: "GPT-6 Astra (xhigh)",
      slug: "gpt-6-astra-xhigh",
      evaluations: {
        artificial_analysis_intelligence_index: 52.4,
        artificial_analysis_coding_index: 75.9,
      },
    },
    {
      id: "e05a4828-0536-4876-870d-a235023f992b",
      name: "GPT-6 Astra (high)",
      slug: "gpt-6-astra-high",
      evaluations: {
        artificial_analysis_intelligence_index: 50.9,
        artificial_analysis_coding_index: 77.1,
      },
    },
    {
      id: "e97a4ef5-e817-480e-9595-12f81dc4974f",
      name: "GPT-6 Astra (medium)",
      slug: "gpt-6-astra-medium",
      evaluations: { artificial_analysis_intelligence_index: 49.6 },
    },
    {
      id: "a3f8100d-e38f-408b-b0fa-0085dae18dc1",
      name: "GPT-6 Astra (low)",
      slug: "gpt-6-astra-low",
      evaluations: { artificial_analysis_intelligence_index: 45.8 },
    },
  ],
};

// Captured through the Artificial Analysis MCP on 2026-09-21. These names and
// slugs are source-owned facts: the matcher under test must not derive its own
// expectations from them.
const claudeAaPayload = {
  data: [
    {
      id: "cd55210d-358e-4df1-ba9c-9acb5f186cc9",
      name: "Claude Fable 5 (Adaptive Reasoning, Max Effort, Opus 4.8 Fallback)",
      slug: "claude-fable-5",
      model_creator: { id: "anthropic", name: "Anthropic", slug: "anthropic" },
      evaluations: { artificial_analysis_intelligence_index: 49.6 },
    },
    {
      id: "992b7b84-5069-4c6a-9295-834252553d50",
      name: "Claude Opus 4.8 (Adaptive Reasoning, Max Effort)",
      slug: "claude-opus-4-8",
      model_creator: { id: "anthropic", name: "Anthropic", slug: "anthropic" },
      evaluations: { artificial_analysis_intelligence_index: 41.8, artificial_analysis_coding_index: 74.3 },
    },
    {
      id: "53c98840-47af-49aa-94e6-469fb17e9a1b",
      name: "Claude Opus 4.6 (Adaptive Reasoning, Max Effort)",
      slug: "claude-opus-4-6-adaptive",
      model_creator: { id: "anthropic", name: "Anthropic", slug: "anthropic" },
      evaluations: { artificial_analysis_intelligence_index: 31.9 },
    },
    {
      id: "4386585e-71b4-4a0c-8a63-afb333419cd6",
      name: "Claude Opus 4.6 (Non-reasoning, High Effort)",
      slug: "claude-opus-4-6",
      model_creator: { id: "anthropic", name: "Anthropic", slug: "anthropic" },
      evaluations: { artificial_analysis_intelligence_index: 26.4 },
    },
    {
      id: "df8d14e0-3997-4e4d-b4ad-9c047acc9c69",
      name: "Claude Sonnet 4.6 (Adaptive Reasoning, Max Effort)",
      slug: "claude-sonnet-4-6-adaptive",
      evaluations: { artificial_analysis_intelligence_index: 30.1 },
    },
    {
      id: "2e40e695-3cec-43da-83f9-615af30b8e91",
      name: "Claude Sonnet 4.6 (Non-reasoning, High Effort)",
      slug: "claude-sonnet-4-6",
      evaluations: { artificial_analysis_intelligence_index: 24.7, gpqa: 0.799 },
    },
    {
      id: "f2e21112-192e-4aed-ae82-68ca3b38e667",
      name: "Claude Sonnet 4.6 (Non-reasoning, Low Effort)",
      slug: "claude-sonnet-4-6-non-reasoning-low-effort",
      evaluations: { artificial_analysis_intelligence_index: 23.3 },
    },
  ],
};

describe("automatic model-intelligence matching (#249)", () => {
  it("enriches newly advertised Astra and Gemini models without registrations", () => {
    const aa = parseAaModels({
      data: [
        ...astraAaPayload.data,
        {
          id: "aa-gemini-high",
          name: "Gemini 3.8 Flash (high)",
          slug: "gemini-3-8-flash-high",
          model_creator: { id: "google", name: "Google", slug: "google" },
          evaluations: { artificial_analysis_intelligence_index: 41.2 },
        },
      ],
    });
    const metadata = buildModelMetadataSnapshot({
      catalog: [
        { agentId: "copilot", modelId: "gpt-6-astra", name: "GPT-6 Astra", contextWindow: 1_050_000, vision: false },
        { agentId: "copilot", modelId: "gemini-3.8-flash", name: "Gemini 3.8 Flash", contextWindow: 1_000_000, vision: true },
      ],
      sourceModels: aa,
      source: "artificial-analysis",
      fetchedAt: "2026-09-09T12:00:00.000Z",
    });
    expect(metadata.rows.find((row) => row.id === "gpt-6-astra")).toMatchObject({
      slug: "gpt-6-astra",
      provider: "OpenAI",
      released_at: "2026-09-03",
      intelligence_index: 52.7,
      benchmarks: {
        artificial_analysis_intelligence_index: 52.7,
        artificial_analysis_coding_index: 76.9,
        gpqa: 0.961,
        hle: 0.547,
      },
      pricing: { input_per_million: 10, output_per_million: 50, blended_per_million: 20 },
      matching: { artificial_analysis: { selected_effort: "max" } },
    });
    expect(metadata.rows.find((row) => row.id === "gpt-6-astra")?.benchmark_variants
      ?.map((row) => [row.effort, row.intelligence_index])
      .sort(([left], [right]) => String(left).localeCompare(String(right)))).toEqual([
      ["high", 50.9],
      ["low", 45.8],
      ["max", 52.7],
      ["medium", 49.6],
      ["xhigh", 52.4],
    ]);
    expect(metadata.rows.find((row) => row.id === "gemini-3.8-flash")?.slug).toBe("gemini-3-8-flash-high");

    const value = buildModelValueSnapshot({
      copilotModels: [
        { modelId: "gpt-6-astra", displayName: "GPT-6 Astra", validEffortTiers: ["low", "medium", "high", "xhigh", "max"], priceCategory: "very_high" },
        { modelId: "gemini-3.8-flash", displayName: "Gemini 3.8 Flash", validEffortTiers: ["low", "medium", "high"], priceCategory: "low" },
      ],
      aaModels: aa,
      pricing: parseCopilotPricingMarkdown(`
| Model | Input | Cached input | Cache write | Output |
| --- | ---: | ---: | ---: | ---: |
| GPT-6 Astra | $10.00 | $1.00 | $12.50 | $50.00 |
| Gemini 3.8 Flash | $0.75 | $0.075 | Not applicable | $3.75 |
`),
      inputTokens: 8_000,
      outputTokens: 2_000,
      fetchedAt: "2026-09-09T12:00:00.000Z",
    });
    expect(value.rows.find((row) => row.copilotModel === "gpt-6-astra")).toMatchObject({
      aaSlug: "gpt-6-astra",
      intelligenceIndex: 52.7,
      inputRate: 10,
      outputRate: 50,
      creditsPerTask: 18,
      valueScore: 52.7 / 18,
    });
    expect(value.rows.find((row) => row.copilotModel === "gemini-3.8-flash")).toMatchObject({
      aaSlug: "gemini-3-8-flash-high",
      intelligenceIndex: 41.2,
      inputRate: 0.75,
      outputRate: 3.75,
    });
  });

  it("enriches Claude composite qualifiers while keeping dotted and dashed ids opaque", () => {
    const metadata = buildModelMetadataSnapshot({
      catalog: [
        {
          agentId: "claude", location: "one", modelId: "claude-fable-5", name: "Fable 5",
          contextWindow: 1_000_000, vision: false, effortChoices: ["default", "low", "medium", "high", "xhigh", "max"],
          effortDefault: "default", effortMechanism: "meta", catalogScope: "binding:claude@one",
        },
        {
          agentId: "claude", location: "one", modelId: "claude-opus-4-8", name: "Opus 4.8",
          contextWindow: 1_000_000, vision: false, effortChoices: ["default", "low", "medium", "high", "xhigh", "max"],
          effortDefault: "default", effortMechanism: "meta", catalogScope: "binding:claude@one",
        },
        {
          agentId: "agy", location: "one", modelId: "claude-opus-4-6-thinking", name: "Claude Opus 4.6",
          contextWindow: 250_000, vision: false, effortChoices: ["default"], effortDefault: "default",
          effortMechanism: "modelBaked", catalogScope: "binding:agy@one",
        },
        {
          agentId: "agy", location: "one", modelId: "claude-sonnet-4-6", name: "Claude Sonnet 4.6",
          contextWindow: 250_000, vision: false, effortChoices: ["default"], effortDefault: "default",
          effortMechanism: "modelBaked", catalogScope: "binding:agy@one",
        },
        {
          agentId: "legacy", location: "one", modelId: "claude-sonnet-4.6", name: "Claude Sonnet 4.6",
          contextWindow: 200_000, vision: false, effortChoices: ["default"], effortDefault: "default",
          effortMechanism: "modelBaked", catalogScope: "binding:legacy@one",
        },
      ],
      sourceModels: parseAaModels(claudeAaPayload),
      source: "artificial-analysis",
      fetchedAt: "2026-09-21T00:00:00.000Z",
    });
    const byVariant = new Map(metadata.rows.map((row) => [row.variant_id, row]));

    expect(byVariant.get("binding:claude@one::claude-fable-5")).toMatchObject({
      id: "claude-fable-5", slug: "claude-fable-5", intelligence_index: 49.6,
      matching: { artificial_analysis: { status: "matched", selected_effort: "max" } },
    });
    expect(byVariant.get("binding:claude@one::claude-opus-4-8")).toMatchObject({
      id: "claude-opus-4-8", slug: "claude-opus-4-8", intelligence_index: 41.8,
      benchmarks: { artificial_analysis_coding_index: 74.3 },
      matching: { artificial_analysis: { status: "matched", selected_effort: "max" } },
    });
    for (const variant of [
      "binding:agy@one::claude-sonnet-4-6",
      "binding:legacy@one::claude-sonnet-4.6",
    ]) {
      expect(byVariant.get(variant)).toMatchObject({
        slug: "claude-sonnet-4-6", intelligence_index: 24.7,
        benchmarks: { gpqa: 0.799 },
        matching: { artificial_analysis: { status: "matched", selected_effort: "high" } },
      });
    }
    expect(byVariant.get("binding:agy@one::claude-opus-4-6-thinking")).toMatchObject({
      id: "claude-opus-4-6-thinking", slug: "claude-opus-4-6-adaptive", intelligence_index: 31.9,
      matching: { artificial_analysis: { status: "matched", selected_effort: "max" } },
    });
    expect(metadata.rows.map((row) => row.id)).toEqual([
      "claude-fable-5", "claude-opus-4-6-thinking", "claude-opus-4-8",
      "claude-sonnet-4-6", "claude-sonnet-4.6",
    ]);
    expect(byVariant.get("binding:agy@one::claude-sonnet-4-6")?.benchmark_variants
      ?.map((row) => [row.slug, row.effort])).toEqual([
      ["claude-sonnet-4-6-adaptive", "max"],
      ["claude-sonnet-4-6", "high"],
      ["claude-sonnet-4-6-non-reasoning-low-effort", "low"],
    ]);
  });

  it("is order-invariant and leaves ambiguous or unknown-effort rows unresolved", () => {
    const rows = parseAaModels({ data: [
      { id: "one", name: "Nebula 7 (high)", slug: "nebula-7-high", evaluations: { intelligence_index: 4 } },
      { id: "two", name: "Nebula 7 high", slug: "nebula-7-high-copy", evaluations: { intelligence_index: 5 } },
      { id: "future", name: "Nebula 7 (extreme)", slug: "nebula-7-extreme", evaluations: { intelligence_index: 9 } },
    ] });
    const model = { modelId: "nebula-7", displayName: "Nebula 7", effortChoices: ["low", "high"] };
    const forward = matchArtificialAnalysis(model, rows);
    const reverse = matchArtificialAnalysis(model, [...rows].reverse());
    expect(forward).toEqual(reverse);
    expect(forward).toMatchObject({ status: "ambiguous", row: null });

    const unknown = matchArtificialAnalysis(
      { modelId: "nebula-7", displayName: "Nebula 7", effortChoices: ["extreme"] },
      [rows[0]!],
    );
    expect(unknown.status).toBe("unresolved-effort");
    expect(unknown.row).toBeNull();
    const futureOnly = matchArtificialAnalysis(
      { modelId: "nebula-7", displayName: "Nebula 7", effortChoices: ["low", "high"] },
      [rows[2]!],
    );
    expect(futureOnly).toEqual({
      status: "unresolved-effort",
      row: null,
      selectedEffort: null,
      candidates: ["nebula-7-extreme"],
      ignored: ["nebula-7-extreme"],
    });
    const compositeFuture = matchArtificialAnalysis(model, parseAaModels({ data: [{
      id: "future-composite", name: "Nebula 7 (Adaptive Reasoning, Extreme Effort)",
      slug: "nebula-7", evaluations: { intelligence_index: 10 },
    }] }));
    expect(compositeFuture).toEqual({
      status: "unresolved-effort",
      row: null,
      selectedEffort: null,
      candidates: ["nebula-7"],
      ignored: ["nebula-7"],
    });
    expect(matchArtificialAnalysis(model, [{
      id: "different-version", name: "Nebula 70 (extreme)", slug: "nebula-70-extreme",
      creator: null, releaseDate: null, intelligenceIndex: 9, benchmarks: {}, pricing: null,
    }, {
      id: "mini", name: "Nebula 7 Mini (extreme)", slug: "nebula-7-mini-extreme",
      creator: null, releaseDate: null, intelligenceIndex: 9, benchmarks: {}, pricing: null,
    }])).toEqual({ status: "no-source-record", row: null, selectedEffort: null, candidates: [], ignored: [] });
  });

  it("selects explicit long-context pricing and never substitutes a missing cache rate", () => {
    const pricing = parseCopilotPricingMarkdown(`
| Model | Tier | Input | Cached input | Cache write | Output |
| --- | --- | ---: | ---: | ---: | ---: |
| GPT-6 Astra | Default | $10 | $1 | Not applicable | $50 |
| GPT-6 Astra | Long context >200k | $20 | $2 | Not applicable | $100 |
`);
    expect(pricing).toHaveLength(2);
    expect(pricing[1]).toMatchObject({ tier: "long-context", thresholdTokens: 200_000 });
    const value = buildModelValueSnapshot({
      copilotModels: [{ modelId: "gpt-6-astra", displayName: "GPT-6 Astra",
        validEffortTiers: ["max"], priceCategory: "high" }],
      aaModels: parseAaModels({ data: [{ id: "aa", name: "GPT-6 Astra (max)",
        slug: "gpt-6-astra-max", evaluations: { intelligence_index: 50 } }] }),
      pricing, inputTokens: 200_001, cachedInputTokens: 1, outputTokens: 2_000,
      longContextThresholdTokens: 200_000, fetchedAt: "2026-09-09T12:00:00.000Z",
    });
    expect(value.rows[0]).toMatchObject({ pricingTier: "long-context", inputRate: 20, creditsPerTask: expect.any(Number) });
    const atBoundary = buildModelValueSnapshot({
      copilotModels: [{ modelId: "gpt-6-astra", displayName: "GPT-6 Astra",
        validEffortTiers: ["max"], priceCategory: "high" }],
      aaModels: [], pricing, inputTokens: 200_000, outputTokens: 2_000,
      longContextThresholdTokens: 200_000, fetchedAt: "2026-09-09T12:00:00.000Z",
    });
    expect(atBoundary.rows[0]).toMatchObject({ pricingTier: "default", inputRate: 10 });
    const cacheWrite = buildModelValueSnapshot({
      copilotModels: [{ modelId: "gpt-6-astra", displayName: "GPT-6 Astra",
        validEffortTiers: ["max"], priceCategory: "high" }],
      aaModels: [], pricing, inputTokens: 8_000, cacheWriteTokens: 1, outputTokens: 2_000,
      fetchedAt: "2026-09-09T12:00:00.000Z",
    });
    expect(cacheWrite.rows[0]?.creditsPerTask).toBeNull();
  });

  it("preserves identity-bearing preview, mini, and fast distinctions", () => {
    const aa = parseAaModels({ data: [
      { id: "base", name: "Orbit 2 (high)", slug: "orbit-2-high", evaluations: { intelligence_index: 10 } },
      { id: "preview", name: "Orbit 2 Preview (high)", slug: "orbit-2-preview-high", evaluations: { intelligence_index: 20 } },
      { id: "mini", name: "Orbit 2 Mini (high)", slug: "orbit-2-mini-high", evaluations: { intelligence_index: 5 } },
    ] });
    expect(matchArtificialAnalysis({ modelId: "orbit-2-preview", displayName: "Orbit 2 Preview",
      effortChoices: ["high"] }, aa).row?.id).toBe("preview");
    expect(matchArtificialAnalysis({ modelId: "orbit-2-mini", displayName: "Orbit 2 Mini",
      effortChoices: ["high"] }, aa).row?.id).toBe("mini");
    const prices = parseCopilotPricingMarkdown(`
| Model | Input | Output |
| --- | ---: | ---: |
| Orbit 2 | $1 | $2 |
| Orbit 2 Fast | $3 | $4 |
| Orbit 2 Preview | $5 | $6 |
`);
    const ranked = buildModelValueSnapshot({
      copilotModels: [
        { modelId: "orbit-2", displayName: "Orbit 2", validEffortTiers: ["high"], priceCategory: null },
        { modelId: "orbit-2-fast", displayName: "Orbit 2 Fast", validEffortTiers: ["high"], priceCategory: null },
        { modelId: "orbit-2-preview", displayName: "Orbit 2 Preview", validEffortTiers: ["high"], priceCategory: null },
      ],
      aaModels: aa, pricing: prices, inputTokens: 8_000, outputTokens: 2_000,
      fetchedAt: "2026-09-09T12:00:00.000Z",
    });
    expect(ranked.rows.map((row) => [row.copilotModel, row.inputRate])).toEqual([
      ["orbit-2", 1], ["orbit-2-fast", 3], ["orbit-2-preview", 5],
    ]);
  });
});

function catalogModel(id: string, efforts = ["low", "medium", "high", "xhigh", "max"]): CatalogModel {
  return {
    id, runtimeId: id, displayName: id.replaceAll("-", " "), aliases: [], default: false,
    context: { native: 1_000_000, maximum: 1_000_000, effective: 1_000_000 },
    modalities: { input: ["text"], output: ["text"] }, visionMode: "none",
    availability: "available", lifecycle: "stable", serviceTiers: [],
    effort: {
      mechanism: "configOption", configId: "reasoning_effort",
      choices: efforts.map((effort) => ({ id: effort, raw: effort })),
      selectionDefault: efforts.includes("medium") ? "medium" : efforts[0]!,
    },
    pricingCategory: "medium", compatibility: null, applicationMode: "live",
    bindings: efforts.map((effort) => ({ model: id, effort, rawModel: id, rawEffort: effort })),
  };
}

function fleet(models: CatalogModel[], generation = 1, state: "ready" | "stale" | "drift" = "ready"): CatalogFleetBinding[] {
  return [{
    binding: { agentId: "copilot", location: "local" }, state,
    snapshot: {
      scopeKey: "scope:copilot-test", generation, checksum: `checksum-${generation}`,
      publishedAt: "2026-09-09T12:00:00.000Z",
      candidate: {
        schemaVersion: 1, scope: { provider: "github-copilot", fingerprint: "a".repeat(64) },
        models, source: "test", adapterVersion: 1, fetchedAt: "2026-09-09T12:00:00.000Z",
      },
    },
  }];
}

describe("coordinated model-intelligence generations (#249)", () => {
  it("migrates legacy caches non-destructively and serves them until first coordinated publish", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "seam-intelligence-migration-"));
    dirs.push(dir);
    const db = path.join(dir, "seam.db");
    const metadata = new ModelMetadataStore(db);
    const values = new ModelValueStore(db, { inputTokens: 8_000, outputTokens: 2_000 });
    const legacyMetadata = buildModelMetadataSnapshot({
      catalog: [{ agentId: "copilot", modelId: "gpt-6-astra", name: "GPT-6 Astra",
        contextWindow: 1_000_000, vision: false }],
      sourceModels: parseAaModels({ data: [{ id: "aa", name: "GPT-6 Astra (max)",
        slug: "gpt-6-astra-max", evaluations: { intelligence_index: 50 } }] }),
      source: "legacy-aa", fetchedAt: "2026-09-08T00:00:00.000Z",
    });
    metadata.replaceSnapshot(legacyMetadata.rows);
    values.saveSnapshot(buildModelValueSnapshot({
      copilotModels: [{ modelId: "gpt-6-astra", displayName: "GPT-6 Astra",
        validEffortTiers: ["max"], priceCategory: "high" }],
      aaModels: [], pricing: [], inputTokens: 8_000, outputTokens: 2_000,
      fetchedAt: "2026-09-08T00:00:00.000Z",
    }).rows);
    const coordinated = new ModelIntelligenceStore(db);
    expect(coordinated.active()).toMatchObject({
      generation: 1, catalogSignature: "legacy-unknown",
    });
    expect(metadata.get("gpt-6-astra").model?.source).toBe("legacy-aa");
    expect(values.getLatestRows()).toHaveLength(1);
    coordinated.close();
    metadata.close();
    values.close();
  });

  it("publishes metadata and value from one captured catalog/source generation", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "seam-intelligence-"));
    dirs.push(dir);
    const db = path.join(dir, "seam.db");
    const metadata = new ModelMetadataStore(db);
    const values = new ModelValueStore(db, { inputTokens: 8_000, outputTokens: 2_000 });
    const store = new ModelIntelligenceStore(db);
    const aaRows = parseAaModels({ data: [
      ...astraAaPayload.data,
      { id: "aa-gemini", name: "Gemini 3.8 Flash (high)", slug: "gemini-3-8-flash-high",
        evaluations: { artificial_analysis_intelligence_index: 41.2 } },
    ] });
    const pricingRows = parseCopilotPricingMarkdown(`
| Model | Input | Cached input | Cache write | Output |
| --- | ---: | ---: | ---: | ---: |
| GPT 6 Astra | $10 | $1 | $12.50 | $50 |
| Gemini 3.8 Flash | $0.75 | $0.075 | Not applicable | $3.75 |
`);
    const manager = new ModelIntelligenceManager({
      store, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      source: { name: "artificial-analysis", fetch: vi.fn(async () => aaRows) },
      fetchPricing: vi.fn(async () => pricingRows),
      getCatalog: () => fleet([
        catalogModel("gpt-6-astra"),
        catalogModel("gemini-3.8-flash", ["low", "medium", "high"]),
      ]),
      scenario: { uncached_input_tokens: 8_000, cached_input_tokens: 0, cache_write_tokens: 0,
      output_tokens: 2_000, long_context_threshold_tokens: 200_000 },
    });
    metadata.replaceSnapshot(buildModelMetadataSnapshot({
      catalog: [
        { agentId: "copilot", modelId: "gpt-6-astra", name: "GPT-6 Astra", contextWindow: 1_000_000, vision: false },
        { agentId: "copilot", modelId: "gemini-3.8-flash", name: "Gemini 3.8 Flash", contextWindow: 1_000_000, vision: true },
      ],
      sourceModels: [],
      source: "stale-pre-coordinator-cache",
      fetchedAt: "2026-09-10T06:17:05.977Z",
    }).rows);
    const result = await manager.refresh({ forceSources: true });
    expect(result).toMatchObject({ ok: true, result: "published", generation: 1 });
    expect(store.active()).toMatchObject({
      generation: 1,
      sourceSnapshots: { "artificial-analysis": 1, "github-copilot-pricing": 2 },
    });
    expect(metadata.get("gpt-6-astra").model).toMatchObject({
      slug: "gpt-6-astra", intelligence_index: 52.7, enrichment_generation: 1,
      benchmarks: { artificial_analysis_coding_index: 76.9, gpqa: 0.961, hle: 0.547 },
      matching: { artificial_analysis: { selected_effort: "max" } },
    });
    expect(values.getLatestRows()[0]).toMatchObject({
      aaSlug: "gpt-6-astra", selectedBenchmarkEffort: "max", creditsPerTask: 18,
    });
    expect(metadata.query().models.find((row) => row.id === "gemini-3.8-flash")).toMatchObject({
      slug: "gemini-3-8-flash-high", intelligence_index: 41.2, enrichment_generation: 1,
    });
    expect(values.getLatestRows().find((row) => row.copilotModel === "gemini-3.8-flash")).toMatchObject({
      inputRate: 0.75, outputRate: 3.75, selectedBenchmarkEffort: "high",
    });
    const rendered = JSON.stringify(renderModelValueRankingsLayout(values.getLatestRows()));
    expect(rendered).toContain("gpt-6-astra");
    expect(rendered).toContain("gemini-3.8-flash");
    expect(rendered).toContain("generation 1");
    expect(rendered).toContain("AA <t:");
    expect(rendered).toContain("GitHub <t:");
    const projection = new Database(db);
    const projectedAstra = projection.prepare(`
      SELECT aa_slug, provider, context_window, intelligence_index, benchmarks_json,
             pricing_json, released_at, source, fetched_at
      FROM model_metadata WHERE model_id = 'gpt-6-astra'
    `).get() as Record<string, unknown>;
    expect(projectedAstra).toMatchObject({
      aa_slug: "gpt-6-astra",
      provider: "OpenAI",
      context_window: 1_000_000,
      intelligence_index: 52.7,
      released_at: "2026-09-03",
      source: "artificial-analysis",
    });
    expect(JSON.parse(String(projectedAstra.benchmarks_json))).toMatchObject({
      artificial_analysis_intelligence_index: 52.7,
      artificial_analysis_coding_index: 76.9,
      gpqa: 0.961,
      hle: 0.547,
    });
    expect(JSON.parse(String(projectedAstra.pricing_json))).toEqual({
      input_per_million: 10,
      output_per_million: 50,
      blended_per_million: 20,
    });

    // Reproduce the deployed shape: an authoritative coordinated generation
    // exists, but the compatibility row is stale. An unchanged refresh must
    // still backfill it; requiring a new AA/catalog generation would strand it.
    projection.prepare(`
      UPDATE model_metadata
      SET aa_slug = NULL, provider = NULL, intelligence_index = NULL,
          benchmarks_json = '{}', pricing_json = NULL, released_at = NULL
      WHERE model_id = 'gpt-6-astra'
    `).run();
    expect(await manager.refresh({ forceSources: false })).toMatchObject({ result: "unchanged", generation: 1 });
    expect(projection.prepare(`
      SELECT aa_slug, provider, intelligence_index, benchmarks_json
      FROM model_metadata WHERE model_id = 'gpt-6-astra'
    `).get()).toMatchObject({
      aa_slug: "gpt-6-astra",
      provider: "OpenAI",
      intelligence_index: 52.7,
      benchmarks_json: expect.stringContaining("artificial_analysis_coding_index"),
    });
    projection.close();
    const active = store.active()!;
    const sabotage = new Database(db);
    sabotage.exec(`
      CREATE TRIGGER fail_model_intelligence_publish
      BEFORE INSERT ON model_intelligence_generations
      BEGIN SELECT RAISE(ABORT, 'synthetic publication failure'); END;
    `);
    expect(() => store.publish({
      publishedAt: "2026-09-09T12:01:00.000Z", catalogSignature: "must-not-publish",
      matchingPolicyVersion: "test",
      sourceSnapshots: active.sourceSnapshots, scenario: active.scenario, diagnostics: [],
      metadata: active.metadata, values: active.values,
    })).toThrow(/synthetic publication failure/);
    expect(store.active()?.generation).toBe(1);
    sabotage.exec("DROP TRIGGER fail_model_intelligence_publish");
    sabotage.close();
    manager.stop();
    store.close();
    metadata.close();
    values.close();
  });

  it("merges covered opaque ids without deleting an omitted dotted id", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "seam-intelligence-projection-merge-"));
    dirs.push(dir);
    const db = path.join(dir, "seam.db");
    const metadata = new ModelMetadataStore(db);
    const dotted = buildModelMetadataSnapshot({
      catalog: [{
        agentId: "claude", modelId: "claude-sonnet-4.6", name: "Claude Sonnet 4.6",
        contextWindow: 200_000, vision: true,
      }],
      sourceModels: [], source: "legacy-catalog", fetchedAt: "2026-09-10T00:00:00.000Z",
    }).rows;
    metadata.replaceSnapshot(dotted);
    const inspection = new Database(db);
    const dottedBefore = inspection.prepare(
      "SELECT * FROM model_metadata WHERE model_id = 'claude-sonnet-4.6'"
    ).get();

    const coordinated = buildModelMetadataSnapshot({
      catalog: [{
        agentId: "claude", modelId: "claude-sonnet-4-6", name: "Claude Sonnet 4-6",
        contextWindow: 1_000_000, vision: true,
      }],
      sourceModels: [], source: "coordinated-catalog", fetchedAt: "2026-09-21T00:00:00.000Z",
    }).rows;
    const store = new ModelIntelligenceStore(db);
    store.publish({
      publishedAt: "2026-09-21T00:00:00.000Z", catalogSignature: "dashed-only",
      matchingPolicyVersion: "test",
      sourceSnapshots: { "artificial-analysis": null, "github-copilot-pricing": null },
      scenario: { uncached_input_tokens: 8_000, cached_input_tokens: 0, cache_write_tokens: 0,
        output_tokens: 2_000, long_context_threshold_tokens: 200_000 },
      diagnostics: [], metadata: coordinated, values: [],
    });

    // Removing merge semantics deletes the dotted row observed in live
    // sessions. Treating punctuation-normalized ids as storage identity instead
    // silently updates it. Neither is valid without an explicit migration.
    expect(inspection.prepare(
      "SELECT * FROM model_metadata WHERE model_id = 'claude-sonnet-4.6'"
    ).get()).toEqual(dottedBefore);
    expect(inspection.prepare(
      "SELECT model_id, context_window, source FROM model_metadata ORDER BY model_id"
    ).all()).toEqual([
      { model_id: "claude-sonnet-4-6", context_window: 1_000_000, source: "coordinated-catalog" },
      { model_id: "claude-sonnet-4.6", context_window: 200_000, source: "legacy-catalog" },
    ]);
    inspection.close();
    store.close();
    metadata.close();
  });

  it("does not invent one benchmark or context when scoped variants disagree", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "seam-intelligence-projection-conflict-"));
    dirs.push(dir);
    const db = path.join(dir, "seam.db");
    const metadata = new ModelMetadataStore(db);
    const store = new ModelIntelligenceStore(db);
    const built = buildModelMetadataSnapshot({
      catalog: [
        {
          agentId: "codex", location: "one", modelId: "nebula-7", name: "Nebula 7",
          contextWindow: 1_000_000, vision: false, effortChoices: ["high"], effortDefault: "high",
          effortMechanism: "configOption", catalogScope: "binding:codex@one", catalogGeneration: 1,
          catalogState: "ready", catalogFetchedAt: "2026-09-20T00:00:00.000Z",
        },
        {
          agentId: "codex", location: "two", modelId: "nebula-7", name: "Nebula 7",
          contextWindow: null, vision: false, effortChoices: ["max"], effortDefault: "max",
          effortMechanism: "configOption", catalogScope: "binding:codex@two", catalogGeneration: 1,
          catalogState: "ready", catalogFetchedAt: "2026-09-20T00:00:00.000Z",
        },
      ],
      sourceModels: parseAaModels({ data: [
        { id: "nebula-high", name: "Nebula 7 (high)", slug: "nebula-7-high",
          evaluations: { artificial_analysis_intelligence_index: 40 } },
        { id: "nebula-max", name: "Nebula 7 (max)", slug: "nebula-7",
          evaluations: { artificial_analysis_intelligence_index: 50 } },
      ] }),
      source: "artificial-analysis",
      fetchedAt: "2026-09-20T00:00:00.000Z",
    });
    expect(built.rows.map((row) => [row.variant_id, row.intelligence_index])).toEqual([
      ["binding:codex@one::nebula-7", 40],
      ["binding:codex@two::nebula-7", 50],
    ]);
    store.publish({
      publishedAt: "2026-09-20T00:00:00.000Z",
      catalogSignature: "scope-conflict",
      matchingPolicyVersion: "test",
      sourceSnapshots: { "artificial-analysis": null, "github-copilot-pricing": null },
      scenario: { uncached_input_tokens: 8_000, cached_input_tokens: 0, cache_write_tokens: 0,
        output_tokens: 2_000, long_context_threshold_tokens: 200_000 },
      diagnostics: [], metadata: built.rows, values: [],
    });
    const inspection = new Database(db, { readonly: true });
    expect(inspection.prepare(`
      SELECT source, aa_slug, intelligence_index, context_window
      FROM model_metadata WHERE model_id = 'nebula-7'
    `).get()).toEqual({
      source: "model-intelligence:scope-enrichment-conflict",
      aa_slug: null,
      intelligence_index: null,
      context_window: null,
    });
    inspection.close();
    store.close();
    metadata.close();
  });

  it("uses source-specific LKG after one source fails and republishes a newer catalog", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "seam-intelligence-lkg-"));
    dirs.push(dir);
    const db = path.join(dir, "seam.db");
    const store = new ModelIntelligenceStore(db);
    let aaRows = parseAaModels({ data: [{
      id: "aa-astra", name: "GPT-6 Astra (max)", slug: "gpt-6-astra-max",
      evaluations: { artificial_analysis_intelligence_index: 54 },
    }] });
    const pricingRows = parseCopilotPricingMarkdown(`
| Model | Input | Output |
| --- | ---: | ---: |
| GPT 6 Astra | $10 | $50 |
`);
    let generation = 1;
    let failAa = false;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const manager = new ModelIntelligenceManager({
      store, logger: logger as never,
      source: { name: "artificial-analysis", fetch: vi.fn(async () => {
        if (failAa) throw new Error("AA offline");
        return aaRows;
      }) },
      fetchPricing: vi.fn(async () => pricingRows),
      getCatalog: () => fleet([catalogModel("gpt-6-astra")], generation),
      scenario: { uncached_input_tokens: 8_000, cached_input_tokens: 0, cache_write_tokens: 0,
        output_tokens: 2_000, long_context_threshold_tokens: 200_000 },
    });
    expect((await manager.refresh()).result).toBe("published");
    const retainedAaFetchedAt = store.latestSourceSuccess("artificial-analysis")?.fetchedAt;
    generation = 2;
    failAa = true;
    const second = await manager.refresh({ forceSources: true });
    expect(second).toMatchObject({
      result: "published",
      sources: { "artificial-analysis": { snapshot: 1, status: "stale" } },
    });
    expect(store.active()).toMatchObject({
      generation: 2,
      catalogSignature: expect.any(String),
      sourceSnapshots: { "artificial-analysis": 1, "github-copilot-pricing": 4 },
    });
    expect(store.active()?.metadata[0]?.source_fetched_at?.["artificial-analysis"]).toBe(retainedAaFetchedAt);
    failAa = false;
    aaRows = parseAaModels({ data: [{
      id: "aa-other", name: "Different Model (max)", slug: "different-model-max",
      evaluations: { artificial_analysis_intelligence_index: 60 },
    }] });
    const held = await manager.refresh({ forceSources: true });
    expect(held.result).toBe("retained");
    expect(held.diagnostics).toContain("matching regression: scope:copilot-test::gpt-6-astra lost its Artificial Analysis benchmark");
    expect(store.latestRefreshAttempt()).toMatchObject({ result: "retained", diagnostics: expect.arrayContaining([
      "matching regression: scope:copilot-test::gpt-6-astra lost its Artificial Analysis benchmark",
    ]) });
    aaRows = parseAaModels({ data: [{
      id: "aa-astra", name: "GPT-6 Astra (max)", slug: "gpt-6-astra-max",
      evaluations: { artificial_analysis_intelligence_index: 54 },
    }] });
    expect((await manager.refresh({ forceSources: true })).result).toBe("published");
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ recovered: expect.arrayContaining([
        "matching regression: scope:copilot-test::gpt-6-astra lost its Artificial Analysis benchmark",
      ]) }),
      "model intelligence matching coverage recovered",
    );
    manager.stop();
    store.close();
  });

  it.each(["artificial-analysis", "github-copilot-pricing"] as const)(
    "publishes cold partial enrichment and later retains the recovered %s LKG",
    async (outage) => {
      const dir = mkdtempSync(path.join(tmpdir(), `seam-intelligence-cold-${outage}-`));
      dirs.push(dir);
      const store = new ModelIntelligenceStore(path.join(dir, "seam.db"));
      const aaRows = parseAaModels({ data: [{
        id: "aa-astra", name: "GPT-6 Astra (max)", slug: "gpt-6-astra-max",
        evaluations: { artificial_analysis_intelligence_index: 54 },
      }] });
      const pricingRows = parseCopilotPricingMarkdown(`
| Model | Input | Output |
| --- | ---: | ---: |
| GPT 6 Astra | $10 | $50 |
`);
      let failAa = outage === "artificial-analysis";
      let failPricing = outage === "github-copilot-pricing";
      const manager = new ModelIntelligenceManager({
        store, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
        source: { name: "artificial-analysis", fetch: vi.fn(async () => {
          if (failAa) throw new Error("AA offline");
          return aaRows;
        }) },
        fetchPricing: vi.fn(async () => {
          if (failPricing) throw new Error("GitHub pricing offline");
          return pricingRows;
        }),
        getCatalog: () => fleet([catalogModel("gpt-6-astra")]),
        scenario: { uncached_input_tokens: 8_000, cached_input_tokens: 0, cache_write_tokens: 0,
          output_tokens: 2_000, long_context_threshold_tokens: 200_000 },
      });

      const cold = await manager.refresh({ forceSources: true });
      expect(cold).toMatchObject({
        ok: true,
        result: "published",
        generation: 1,
        sources: { [outage]: { snapshot: null, status: "missing" } },
      });
      const coldActive = store.active()!;
      expect(coldActive.sourceSnapshots[outage]).toBeNull();
      expect(coldActive.metadata.map((row) => row.id)).toEqual(["gpt-6-astra"]);
      expect(coldActive.values.map((row) => row.copilotModel)).toEqual(["gpt-6-astra"]);
      expect(coldActive.diagnostics).toContain(outage === "artificial-analysis"
        ? "Artificial Analysis source unavailable; no validated snapshot"
        : "GitHub pricing source unavailable; no validated snapshot");
      expect(coldActive.metadata[0]?.matching?.artificial_analysis.status).toBe(
        outage === "artificial-analysis" ? "source-unavailable" : "matched",
      );
      expect(coldActive.metadata[0]?.matching?.github_copilot_pricing?.status).toBe(
        outage === "github-copilot-pricing" ? "source-unavailable" : "matched",
      );
      expect(coldActive.values[0]).toMatchObject(outage === "artificial-analysis"
        ? {
            intelligenceIndex: null,
            inputRate: 10,
            benchmarkMatchStatus: "source-unavailable",
            pricingMatchStatus: "matched",
            sourceStatus: { "artificial-analysis": "unavailable", "github-copilot-pricing": "fresh" },
          }
        : {
            intelligenceIndex: 54,
            inputRate: null,
            benchmarkMatchStatus: "matched",
            pricingMatchStatus: "source-unavailable",
            sourceStatus: { "artificial-analysis": "fresh", "github-copilot-pricing": "unavailable" },
          });
      expect(JSON.stringify(renderModelValueRankingsLayout(coldActive.values))).toContain("degraded");

      failAa = false;
      failPricing = false;
      expect(await manager.refresh({ forceSources: true })).toMatchObject({ result: "published", generation: 2 });
      const recovered = store.active()!;
      const recoveredSnapshot = recovered.sourceSnapshots[outage];
      expect(recoveredSnapshot).toEqual(expect.any(Number));
      const recoveredFetchedAt = store.sourceSnapshot(recoveredSnapshot!)?.fetchedAt;
      expect(recovered.metadata[0]?.matching?.artificial_analysis.status).toBe("matched");
      expect(recovered.metadata[0]?.matching?.github_copilot_pricing?.status).toBe("matched");

      failAa = outage === "artificial-analysis";
      failPricing = outage === "github-copilot-pricing";
      const warm = await manager.refresh({ forceSources: true });
      expect(warm).toMatchObject({
        result: "published",
        generation: 3,
        sources: { [outage]: { snapshot: recoveredSnapshot, status: "stale", lastSuccessAt: recoveredFetchedAt } },
      });
      const warmActive = store.active()!;
      expect(warmActive.sourceSnapshots[outage]).toBe(recoveredSnapshot);
      expect(warmActive.values[0]?.sourceStatus?.[outage]).toBe("stale");
      expect(outage === "artificial-analysis"
        ? warmActive.metadata[0]?.source_fetched_at?.[outage]
        : warmActive.values[0]?.sourceFetchedAt?.[outage]).toBe(recoveredFetchedAt);
      manager.stop();
      store.close();
    },
  );

  it("publishes exact unknown-effort evidence without borrowing a nearby identity", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "seam-intelligence-future-effort-"));
    dirs.push(dir);
    const store = new ModelIntelligenceStore(path.join(dir, "seam.db"));
    const manager = new ModelIntelligenceManager({
      store, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      source: { name: "artificial-analysis", fetch: vi.fn(async () => parseAaModels({ data: [{
        id: "nebula-extreme", name: "Nebula 7 (extreme)", slug: "nebula-7-extreme",
        evaluations: { artificial_analysis_intelligence_index: 70 },
      }, {
        id: "nebula-mini", name: "Nebula 7 Mini (extreme)", slug: "nebula-7-mini-extreme",
        evaluations: { artificial_analysis_intelligence_index: 80 },
      }, {
        id: "nebula-70", name: "Nebula 70 (extreme)", slug: "nebula-70-extreme",
        evaluations: { artificial_analysis_intelligence_index: 90 },
      }] })) },
      fetchPricing: vi.fn(async () => parseCopilotPricingMarkdown(`
| Model | Input | Output |
| --- | ---: | ---: |
| Nebula 7 | $1 | $5 |
`)),
      getCatalog: () => fleet([catalogModel("nebula-7", ["low", "high"])]),
      scenario: { uncached_input_tokens: 8_000, cached_input_tokens: 0, cache_write_tokens: 0,
        output_tokens: 2_000, long_context_threshold_tokens: 200_000 },
    });

    expect(await manager.refresh({ forceSources: true })).toMatchObject({
      result: "published",
      matchingPolicyVersion: "249.3",
    });
    expect(store.active()?.metadata[0]).toMatchObject({
      id: "nebula-7",
      intelligence_index: null,
      matching: {
        artificial_analysis: {
          status: "unresolved-effort",
          selected_effort: null,
          candidates: ["nebula-7-extreme"],
        },
      },
      benchmark_variants: [{ slug: "nebula-7-extreme", effort: null, intelligence_index: 70 }],
    });
    expect(store.active()?.values[0]).toMatchObject({
      copilotModel: "nebula-7",
      aaSlug: null,
      intelligenceIndex: null,
      benchmarkMatchStatus: "unresolved-effort",
      inputRate: 1,
    });
    manager.stop();
    store.close();
  });

  it("joins catalog additions from cached sources and source additions without another catalog generation", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "seam-intelligence-bidirectional-"));
    dirs.push(dir);
    const store = new ModelIntelligenceStore(path.join(dir, "seam.db"));
    let aaRows = parseAaModels({ data: [
      { id: "aa-astra", name: "GPT-6 Astra (max)", slug: "gpt-6-astra-max",
        evaluations: { artificial_analysis_intelligence_index: 54 } },
      { id: "aa-gemini", name: "Gemini 3.8 Flash (high)", slug: "gemini-3-8-flash-high",
        evaluations: { artificial_analysis_intelligence_index: 41.2 } },
    ] });
    let pricingRows = parseCopilotPricingMarkdown(`
| Model | Input | Output |
| --- | ---: | ---: |
| GPT 6 Astra | $10 | $50 |
| Gemini 3.8 Flash | $0.75 | $3.75 |
`);
    const fetchAa = vi.fn(async () => aaRows);
    const fetchPricing = vi.fn(async () => pricingRows);
    let catalogGeneration = 1;
    let catalogModels = [catalogModel("gpt-6-astra"), catalogModel("nova-1", ["high"])];
    const manager = new ModelIntelligenceManager({
      store, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      source: { name: "artificial-analysis", fetch: fetchAa }, fetchPricing,
      getCatalog: () => fleet(catalogModels, catalogGeneration),
      scenario: { uncached_input_tokens: 8_000, cached_input_tokens: 0, cache_write_tokens: 0,
        output_tokens: 2_000, long_context_threshold_tokens: 200_000 },
    });
    await manager.refresh({ forceSources: true });
    expect(store.active()?.metadata.find((row) => row.id === "nova-1")?.slug).toBeNull();

    catalogGeneration = 2;
    catalogModels = [...catalogModels, catalogModel("gemini-3.8-flash", ["low", "medium", "high"])];
    await manager.refresh({ forceSources: false });
    expect(fetchAa).toHaveBeenCalledTimes(1);
    expect(fetchPricing).toHaveBeenCalledTimes(1);
    expect(store.active()?.metadata.find((row) => row.id === "gemini-3.8-flash")?.slug)
      .toBe("gemini-3-8-flash-high");

    aaRows = [...aaRows, ...parseAaModels({ data: [{ id: "aa-nova", name: "Nova 1 (high)",
      slug: "nova-1-high", evaluations: { artificial_analysis_intelligence_index: 39 } }] })];
    pricingRows = [...pricingRows, ...parseCopilotPricingMarkdown(`
| Model | Input | Output |
| --- | ---: | ---: |
| Nova 1 | $2 | $8 |
`)];
    await manager.refresh({ forceSources: true });
    expect(store.active()?.metadata.find((row) => row.id === "nova-1")?.slug).toBe("nova-1-high");
    expect(store.active()?.values.find((row) => row.copilotModel === "nova-1")?.inputRate).toBe(2);
    manager.stop();
    store.close();
  });

  it("keeps scope-distinct variants and excludes drift while admitting stale LKG", async () => {
    const models = Array.from({ length: 30 }, (_, index) => catalogModel(`future-${index}`, ["medium"]));
    const one = fleet(models, 1, "stale")[0]!;
    const two = {
      ...fleet([catalogModel("future-0", ["high"])], 2, "ready")[0]!,
      binding: { agentId: "copilot-team", location: "remote" },
      snapshot: {
        ...fleet([catalogModel("future-0", ["high"])], 2)[0]!.snapshot!,
        scopeKey: "scope:copilot-team",
        candidate: {
          ...fleet([catalogModel("future-0", ["high"])], 2)[0]!.snapshot!.candidate,
          scope: { provider: "github-copilot", fingerprint: "b".repeat(64) },
        },
      },
    } satisfies CatalogFleetBinding;
    const drift = { ...fleet([catalogModel("ignored")], 3, "drift")[0]!,
      binding: { agentId: "copilot", location: "drifted" } } satisfies CatalogFleetBinding;
    const aa = parseAaModels({ data: Array.from({ length: 30 }, (_, index) => ({
      id: `aa-${index}`, name: `Future ${index} (medium)`, slug: `future-${index}-medium`,
      evaluations: { artificial_analysis_intelligence_index: index + 1 },
    })) });
    const snapshot = buildModelMetadataSnapshot({
      catalog: [one, two, drift].flatMap((entry) =>
        entry.state === "drift" ? [] : entry.snapshot!.candidate.models.map((model) => ({
          agentId: entry.binding.agentId, location: entry.binding.location, modelId: model.id,
          runtimeId: model.runtimeId, name: model.displayName, aliases: model.aliases,
          contextWindow: model.context.effective, vision: false,
          effortChoices: model.effort.choices.map((choice) => choice.id),
          effortDefault: model.effort.selectionDefault, effortMechanism: model.effort.mechanism,
          catalogScope: entry.snapshot!.scopeKey, catalogGeneration: entry.snapshot!.generation,
          catalogState: entry.state, catalogFetchedAt: entry.snapshot!.candidate.fetchedAt,
        }))
      ),
      sourceModels: aa, source: "fixture", fetchedAt: "2026-09-09T12:00:00.000Z",
    });
    expect(snapshot.rows).toHaveLength(31);
    expect(snapshot.rows.filter((row) => row.id === "future-0")).toHaveLength(2);
    expect(snapshot.rows.some((row) => row.id === "ignored")).toBe(false);
  });

  it("coalesces catalog publication and makes a concurrent forced refresh await fresh sources", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "seam-intelligence-coalesce-"));
    dirs.push(dir);
    const store = new ModelIntelligenceStore(path.join(dir, "seam.db"));
    const aaRows = parseAaModels({ data: [
      { id: "aa-astra", name: "GPT-6 Astra (max)", slug: "gpt-6-astra-max",
        evaluations: { artificial_analysis_intelligence_index: 54 } },
      { id: "aa-gemini", name: "Gemini 3.8 Flash (high)", slug: "gemini-3-8-flash-high",
        evaluations: { artificial_analysis_intelligence_index: 41.2 } },
    ] });
    const pricingRows = parseCopilotPricingMarkdown(`
| Model | Input | Output |
| --- | ---: | ---: |
| GPT 6 Astra | $10 | $50 |
| Gemini 3.8 Flash | $0.75 | $3.75 |
`);
    const fetchAa = vi.fn(async () => aaRows);
    const fetchPricing = vi.fn(async () => pricingRows);
    let catalogGeneration = 1;
    let releaseCatalog: (() => void) | undefined;
    let blockCatalog = false;
    const manager = new ModelIntelligenceManager({
      store, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      source: { name: "artificial-analysis", fetch: fetchAa }, fetchPricing,
      getCatalog: async () => {
        if (blockCatalog) await new Promise<void>((resolve) => { releaseCatalog = resolve; });
        const models = [catalogModel("gpt-6-astra")];
        if (catalogGeneration > 1) models.push(catalogModel("gemini-3.8-flash", ["low", "medium", "high"]));
        return fleet(models, catalogGeneration);
      },
      scenario: { uncached_input_tokens: 8_000, cached_input_tokens: 0, cache_write_tokens: 0,
        output_tokens: 2_000, long_context_threshold_tokens: 200_000 },
    });
    expect((await manager.refresh()).generation).toBe(1);
    catalogGeneration = 2;
    blockCatalog = true;
    const catalogOnly = manager.refresh({ forceSources: false });
    const forced = manager.refresh({ forceSources: true });
    await vi.waitFor(() => expect(releaseCatalog).toBeTypeOf("function"));
    blockCatalog = false;
    releaseCatalog!();
    expect((await catalogOnly).generation).toBe(2);
    expect(store.active()?.metadata.some((row) => row.id === "gemini-3.8-flash")).toBe(true);
    expect(await forced).toMatchObject({ result: "published", generation: 3 });
    expect(fetchAa).toHaveBeenCalledTimes(2);
    expect(fetchPricing).toHaveBeenCalledTimes(2);
    expect(store.active()?.sourceSnapshots).toEqual({
      "artificial-analysis": 3,
      "github-copilot-pricing": 4,
    });
    manager.stop();
    store.close();
  });

  it("does not persist source attempts or a generation after stop aborts a refresh", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "seam-intelligence-stop-"));
    dirs.push(dir);
    const store = new ModelIntelligenceStore(path.join(dir, "seam.db"));
    let releaseAa: ((rows: ReturnType<typeof parseAaModels>) => void) | undefined;
    let releasePricing: ((rows: ReturnType<typeof parseCopilotPricingMarkdown>) => void) | undefined;
    const manager = new ModelIntelligenceManager({
      store, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      source: { name: "artificial-analysis", fetch: vi.fn(() =>
        new Promise<ReturnType<typeof parseAaModels>>((resolve) => { releaseAa = resolve; })) },
      fetchPricing: vi.fn(() => new Promise<ReturnType<typeof parseCopilotPricingMarkdown>>((resolve) => {
        releasePricing = resolve;
      })),
      getCatalog: () => fleet([catalogModel("gpt-6-astra")]),
      scenario: { uncached_input_tokens: 8_000, cached_input_tokens: 0, cache_write_tokens: 0,
        output_tokens: 2_000, long_context_threshold_tokens: 200_000 },
    });
    const refresh = manager.refresh();
    await vi.waitFor(() => {
      expect(releaseAa).toBeTypeOf("function");
      expect(releasePricing).toBeTypeOf("function");
    });
    manager.stop();
    releaseAa!([]);
    releasePricing!([]);
    expect(await refresh).toMatchObject({ result: "stopped", generation: null });
    expect(store.latestSourceAttempt("artificial-analysis")).toBeNull();
    expect(store.latestSourceAttempt("github-copilot-pricing")).toBeNull();
    expect(store.active()).toBeNull();
    store.close();
  });

  it("bounds durable source and refresh-attempt history", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "seam-intelligence-retention-"));
    dirs.push(dir);
    const dbPath = path.join(dir, "seam.db");
    const store = new ModelIntelligenceStore(dbPath);
    for (let index = 0; index < 110; index += 1) {
      store.recordSourceFailure({
        source: "artificial-analysis", sourceUrl: "https://example.test/aa", parserVersion: "test",
        attemptedAt: new Date(index).toISOString(), error: `failure ${index}`,
      });
      store.recordRefreshAttempt({
        attemptedAt: new Date(index).toISOString(), completedAt: new Date(index + 1).toISOString(),
        forceSources: true, result: "retained", generation: null, diagnostics: [`failure ${index}`],
      });
    }
    const inspection = new Database(dbPath, { readonly: true });
    const sources = inspection.prepare("SELECT COUNT(*) AS count FROM model_intelligence_source_snapshots")
      .get() as { count: number };
    const attempts = inspection.prepare("SELECT COUNT(*) AS count FROM model_intelligence_refresh_attempts")
      .get() as { count: number };
    expect(sources.count).toBe(96);
    expect(attempts.count).toBe(96);
    expect(store.latestRefreshAttempt()).toMatchObject({ diagnostics: ["failure 109"] });
    inspection.close();
    store.close();
  });
});

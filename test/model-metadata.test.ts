import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ArtificialAnalysisMetadataSource,
  parseAaModels,
} from "../packages/core/src/core/model-metadata/artificial-analysis.js";
import { buildModelMetadataSnapshot } from "../packages/core/src/core/model-metadata/catalog.js";
import { ModelMetadataManager } from "../packages/core/src/core/model-metadata/manager.js";
import { ModelMetadataStore } from "../packages/core/src/core/model-metadata/store.js";
import { SeamMcpServer } from "../packages/core/src/core/mcp/seam-mcp-server.js";
import type { AgentModelAvailability } from "../packages/core/src/core/model-metadata/types.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempStore(): ModelMetadataStore {
  const dir = mkdtempSync(path.join(tmpdir(), "seam-model-metadata-"));
  tempDirs.push(dir);
  return new ModelMetadataStore(path.join(dir, "seam.db"));
}

const aaPayload = {
  data: [
    {
      id: "aa-sol",
      name: "GPT-5.6 Sol (max)",
      slug: "gpt-5-6-sol",
      release_date: "2026-03-01",
      model_creator: { id: "openai-id", name: "OpenAI", slug: "openai" },
      evaluations: {
        artificial_analysis_intelligence_index: 60,
        coding_index: 90,
      },
      pricing: {
        price_1m_input_tokens: 1,
        price_1m_output_tokens: 4,
        price_1m_blended_3_to_1: 1.75,
      },
    },
    {
      id: "aa-terra",
      name: "GPT-5.6 Terra (high)",
      slug: "gpt-5-6-terra-high",
      release_date: "2026-01-01",
      model_creator: { id: "openai-id", name: "OpenAI", slug: "openai" },
      evaluations: {
        artificial_analysis_intelligence_index: 50,
        coding_index: 70,
      },
      pricing: {
        price_1m_input_tokens: 0.5,
        price_1m_output_tokens: 2,
        price_1m_blended_3_to_1: 0.875,
      },
    },
    {
      id: "aa-luna",
      name: "GPT-5.6 Luna (high)",
      slug: "gpt-5-6-luna-high",
      release_date: "2025-12-01",
      model_creator: { id: "openai-id", name: "OpenAI", slug: "openai" },
      evaluations: {
        artificial_analysis_intelligence_index: 30,
        coding_index: 55,
      },
      pricing: {
        price_1m_input_tokens: 0.2,
        price_1m_output_tokens: 1,
        price_1m_blended_3_to_1: 0.4,
      },
    },
  ],
};

const catalog: AgentModelAvailability[] = [
  {
    agentId: "copilot",
    modelId: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    contextWindow: 1_000_000,
    vision: false,
  },
  {
    agentId: "codex",
    modelId: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    contextWindow: 800_000,
    vision: true,
  },
  {
    agentId: "copilot",
    modelId: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    contextWindow: 500_000,
    vision: false,
  },
  {
    agentId: "agy",
    modelId: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    contextWindow: 200_000,
    vision: null,
  },
  {
    agentId: "opencode",
    modelId: "local-future-model",
    name: "Local Future Model",
    contextWindow: null,
    vision: null,
  },
];

function fixtureSnapshot(fetchedAt = "2026-09-01T12:00:00.000Z") {
  return buildModelMetadataSnapshot({
    catalog,
    sourceModels: parseAaModels(aaPayload),
    source: "artificial-analysis",
    fetchedAt,
  });
}

describe("model metadata source and catalog", () => {
  it("defensively parses AA creator, benchmarks, pricing, and release metadata", () => {
    const rows = parseAaModels(aaPayload);
    expect(rows[0]).toMatchObject({
      id: "aa-sol",
      slug: "gpt-5-6-sol",
      creator: { name: "OpenAI", slug: "openai" },
      releaseDate: "2026-03-01",
      intelligenceIndex: 60,
      benchmarks: { coding_index: 90 },
      pricing: {
        input_per_million: 1,
        output_per_million: 4,
        blended_per_million: 1.75,
      },
    });
    expect(() => parseAaModels({ rows: [] })).toThrow(/data array/);
    expect(() => parseAaModels({ data: [{ id: 1 }] })).toThrow(/no usable models/);
  });

  it("shares one in-flight AA request across aligned refresh consumers", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify(aaPayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const source = new ArtificialAnalysisMetadataSource("test", fetchImpl);
    const first = source.fetch();
    const second = source.fetch();
    expect(first).toBe(second);
    release();
    await expect(first).resolves.toHaveLength(3);
    await second;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("unions per-agent availability and keeps unmatched models visible", () => {
    const snapshot = fixtureSnapshot();
    expect(snapshot.rows.find((row) => row.id === "gpt-5.6-sol")).toMatchObject({
      agents: ["codex", "copilot"],
      context_window: 1_000_000,
      modalities: ["text", "vision"],
      provider: "OpenAI",
      slug: "gpt-5-6-sol",
    });
    expect(snapshot.rows.find((row) => row.id === "local-future-model")).toMatchObject({
      slug: null,
      provider: null,
      intelligence_index: null,
      pricing: null,
      benchmarks: {},
      agents: ["opencode"],
    });
    expect(snapshot.unmatchedModels).toEqual(["local-future-model"]);
  });

  it("canonicalizes explicit cross-agent spellings without fuzzy joins", () => {
    const snapshot = buildModelMetadataSnapshot({
      catalog: [
        { agentId: "copilot", modelId: "claude-opus-4.8", name: "Opus", contextWindow: null, vision: null },
        { agentId: "claude", modelId: "claude-opus-4-8", name: "Opus", contextWindow: 1_000_000, vision: true },
      ],
      sourceModels: parseAaModels({
        data: [{
          id: "aa-opus", name: "Claude Opus 4.8 (max)", slug: "claude-opus-4-8",
          evaluations: { artificial_analysis_intelligence_index: 70 },
        }],
      }),
      source: "fixture",
      fetchedAt: "2026-09-01T12:00:00.000Z",
    });
    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0]).toMatchObject({
      id: "claude-opus-4.8",
      aliases: ["claude-opus-4-8", "claude-opus-4.8"],
      agents: ["claude", "copilot"],
    });
  });

  it("keeps model-baked effort variants distinct and selects their exact AA rows", () => {
    const snapshot = buildModelMetadataSnapshot({
      catalog: [
        { agentId: "agy", modelId: "gemini-3.7-flash-high", name: "Gemini high", contextWindow: 1_000_000, vision: true },
        { agentId: "agy", modelId: "gemini-3.7-flash-low", name: "Gemini low", contextWindow: 1_000_000, vision: true },
      ],
      sourceModels: parseAaModels({ data: [
        { id: "aa-high", name: "Gemini 3.7 Flash (high)", slug: "gemini-3-7-flash", evaluations: { artificial_analysis_intelligence_index: 50 } },
        { id: "aa-low", name: "Gemini 3.7 Flash (low)", slug: "gemini-3-7-flash-low", evaluations: { artificial_analysis_intelligence_index: 40 } },
      ] }),
      source: "fixture",
      fetchedAt: "2026-09-01T12:00:00.000Z",
    });
    expect(snapshot.rows.map((row) => [row.id, row.slug, row.intelligence_index])).toEqual([
      ["gemini-3.7-flash-high", "gemini-3-7-flash", 50],
      ["gemini-3.7-flash-low", "gemini-3-7-flash-low", 40],
    ]);
  });
});

describe("model metadata durable cache", () => {
  it("gets by canonical id, agent alias, or AA slug", () => {
    const store = tempStore();
    store.replaceSnapshot(fixtureSnapshot().rows);
    expect(store.get("gpt-5.6-sol").model?.source_id).toBe("aa-sol");
    expect(store.get("gpt-5-6-sol").model?.id).toBe("gpt-5.6-sol");
    expect(store.get("missing")).toEqual({ model: null });
    store.close();
  });

  it("implements every v1 filter plus deterministic sort and limit", () => {
    const store = tempStore();
    store.replaceSnapshot(fixtureSnapshot().rows);
    expect(store.query({ filters: { provider: "openai" } }).count).toBe(3);
    expect(store.query({ filters: { creator: "openai" } }).count).toBe(3);
    expect(store.query({ filters: { agent: "codex" } }).models.map((row) => row.id)).toEqual(["gpt-5.6-sol"]);
    expect(store.query({ filters: { modality: "vision" } }).models.map((row) => row.id)).toEqual(["gpt-5.6-sol"]);
    expect(store.query({ filters: { minContextWindow: 600_000 } }).models.map((row) => row.id)).toEqual(["gpt-5.6-sol"]);
    expect(store.query({ filters: { benchmark: { min: 55 } } }).models.map((row) => row.id)).toEqual(["gpt-5.6-sol"]);
    expect(store.query({ filters: { benchmark: { name: "coding_index", min: 70 } } }).models.map((row) => row.id)).toEqual(["gpt-5.6-sol", "gpt-5.6-terra"]);
    expect(store.query({ filters: { maxPrice: { input: 0.6, output: 2 } } }).models.map((row) => row.id)).toEqual(["gpt-5.6-luna", "gpt-5.6-terra"]);
    expect(store.query({ filters: { releasedAfter: "2026-02-01" } }).models.map((row) => row.id)).toEqual(["gpt-5.6-sol"]);
    expect(store.query({ filters: { nameContains: "terra" } }).models.map((row) => row.id)).toEqual(["gpt-5.6-terra"]);
    expect(store.query({ filters: { hasBenchmark: false } }).models.map((row) => row.id)).toEqual(["local-future-model"]);
    expect(store.query({ sort: { field: "benchmark" }, limit: 2 }).models.map((row) => row.id)).toEqual(["gpt-5.6-sol", "gpt-5.6-terra"]);
    expect(store.query({ sort: { field: "price" } }).models.slice(0, 3).map((row) => row.id)).toEqual(["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]);
    expect(store.query({ sort: { field: "contextWindow" } }).models.slice(0, 3).map((row) => row.id)).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    expect(store.query({ sort: { field: "releaseDate" } }).models.slice(0, 3).map((row) => row.id)).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    expect(() => store.query({ limit: 0 })).toThrow(/limit/);
    store.close();
  });

  it("preserves the prior cache on source parse/fetch and coverage failures", async () => {
    const store = tempStore();
    store.replaceSnapshot(fixtureSnapshot().rows);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
    const failedSource = {
      name: "swappable-fixture",
      fetch: vi.fn(async () => { throw new Error("provider shape changed"); }),
    };
    const failed = new ModelMetadataManager({
      store,
      logger,
      source: failedSource,
      getCatalog: async () => catalog,
    });
    await failed.refresh();
    expect(store.getAll()[0]?.fetched_at).toBe("2026-09-01T12:00:00.000Z");

    const collapsed = new ModelMetadataManager({
      store,
      logger,
      source: {
        name: "swappable-fixture",
        fetch: async () => parseAaModels({
          data: [{ id: "unrelated", name: "Unrelated", slug: "unrelated", evaluations: {} }],
        }),
      },
      getCatalog: async () => catalog,
    });
    await collapsed.refresh();
    expect(store.getAll()[0]?.fetched_at).toBe("2026-09-01T12:00:00.000Z");

    const shapeCollapsed = new ModelMetadataManager({
      store,
      logger,
      source: {
        name: "swappable-fixture",
        fetch: async () => parseAaModels({
          data: aaPayload.data.map((row) => ({
            id: row.id,
            name: row.name,
            slug: row.slug,
            evaluations: row.evaluations,
          })),
        }),
      },
      getCatalog: async () => catalog,
    });
    await shapeCollapsed.refresh();
    expect(store.get("gpt-5.6-sol").model?.pricing?.input_per_million).toBe(1);
    expect(logger.error).toHaveBeenCalledTimes(3);
    expect(logger.error).toHaveBeenLastCalledWith(
      expect.any(Object),
      "model metadata refresh failed; keeping prior snapshot"
    );
    store.close();
  });

  it("refreshes through an injected MetadataSource implementation", async () => {
    const store = tempStore();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
    const source = { name: "fixture-provider", fetch: vi.fn(async () => parseAaModels(aaPayload)) };
    const manager = new ModelMetadataManager({
      store,
      logger,
      source,
      getCatalog: async () => catalog,
      now: () => new Date("2026-09-01T14:00:00.000Z"),
    });
    await manager.refresh();
    expect(source.fetch).toHaveBeenCalledTimes(1);
    expect(store.get("gpt-5.6-sol").model).toMatchObject({
      source: "fixture-provider",
      fetched_at: "2026-09-01T14:00:00.000Z",
    });
    expect(store.get("local-future-model").model?.slug).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      { models: ["local-future-model"] },
      "model metadata: agent models unmatched by source"
    );
    store.close();
  });

  it("allows a legitimate configured-catalog shrink without retaining stale rows", async () => {
    const store = tempStore();
    store.replaceSnapshot(fixtureSnapshot().rows);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
    const manager = new ModelMetadataManager({
      store,
      logger,
      source: { name: "fixture", fetch: async () => [parseAaModels(aaPayload)[0]!] },
      getCatalog: async () => [catalog[0]!],
      now: () => new Date("2026-09-01T15:00:00.000Z"),
    });
    await manager.refresh();
    expect(store.getAll().map((row) => row.id)).toEqual(["gpt-5.6-sol"]);
    expect(store.getAll()[0]?.fetched_at).toBe("2026-09-01T15:00:00.000Z");
    expect(logger.error).not.toHaveBeenCalled();
    store.close();
  });
});

describe("model metadata MCP cache-only accessors", () => {
  it("returns structured content plus identical JSON text without a source dependency", async () => {
    const store = tempStore();
    store.replaceSnapshot(fixtureSnapshot().rows);
    const logger = { child: () => logger, info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
    const server = new SeamMcpServer({
      logger,
      resolveSession: (token) => token === "ok" ? {} as SessionRecord : undefined,
      enqueueDispatch: async () => undefined,
      getModelMetadata: (idOrSlug) => store.get(idOrSlug),
      queryModelMetadata: (options) => store.query(options),
    });
    await server.start();
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-seam-session": "ok" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      });
      return response.json() as Promise<any>;
    };
    try {
      const get = await call("model_metadata_get", { idOrSlug: "gpt-5-6-sol" });
      expect(get.result.structuredContent.model.id).toBe("gpt-5.6-sol");
      expect(JSON.parse(get.result.content[0].text)).toEqual(get.result.structuredContent);
      const query = await call("model_metadata_query", {
        filters: { agent: "copilot", hasBenchmark: true },
        sort: { field: "benchmark" },
        limit: 1,
      });
      expect(query.result.structuredContent.models.map((row: any) => row.id)).toEqual(["gpt-5.6-sol"]);
      expect(JSON.parse(query.result.content[0].text)).toEqual(query.result.structuredContent);
    } finally {
      await server.stop();
      store.close();
    }
  });
});

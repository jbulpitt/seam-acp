import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildModelValueSnapshot } from "../packages/core/src/core/model-value/ranking.js";
import {
  parseAaModels,
  parseCopilotPricingMarkdown,
} from "../packages/core/src/core/model-value/sources.js";
import { ModelValueStore } from "../packages/core/src/core/model-value/store.js";
import { ModelValueManager } from "../packages/core/src/core/model-value/manager.js";
import { SeamMcpServer } from "../packages/core/src/core/mcp/seam-mcp-server.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempStore(): ModelValueStore {
  const dir = mkdtempSync(path.join(tmpdir(), "seam-model-value-"));
  tempDirs.push(dir);
  return new ModelValueStore(path.join(dir, "seam.db"), {
    inputTokens: 8000,
    outputTokens: 2000,
  });
}

const aaPayload = {
  data: [
    {
      id: "aa-sol",
      name: "GPT-5.6 Sol (high)",
      slug: "gpt-5-6-sol-high",
      evaluations: {
        artificial_analysis_intelligence_index: 60,
        coding_index: 90,
      },
    },
    {
      id: "aa-sol-low",
      name: "GPT-5.6 Sol (low)",
      slug: "gpt-5-6-sol-low",
      evaluations: {
        artificial_analysis_intelligence_index: 45,
        coding_index: 50,
      },
    },
    {
      id: "aa-terra",
      name: "GPT-5.6 Terra (high)",
      slug: "gpt-5-6-terra-high",
      evaluations: {
        artificial_analysis_intelligence_index: 50,
        coding_index: 70,
      },
    },
    {
      id: "aa-luna",
      name: "GPT-5.6 Luna (high)",
      slug: "gpt-5-6-luna-high",
      evaluations: {
        artificial_analysis_intelligence_index: 30,
        coding_index: 55,
      },
    },
  ],
};

const pricingMarkdown = `
## OpenAI

| Model | Release status | Category | Input | Cached input | Output |
| --- | --- | --- | ---: | ---: | ---: |
| GPT-5.6 Sol[^promo] | GA | Standard | $1.00 | $0.10 | $4.00 |
| GPT-5.6 Terra | GA | Standard | $0.50 | $0.05 | $2.00 |
| GPT-5.6 Luna | GA | Standard | $0.20 | $0.02 | $1.00 |
| MAI-Code 1.1 Flash | GA | Standard | $0.10 | Not applicable | $0.50 |
`;

function fixtureSnapshot(fetchedAt = "2026-09-01T12:00:00.000Z") {
  return buildModelValueSnapshot({
    aaModels: parseAaModels(aaPayload),
    pricing: parseCopilotPricingMarkdown(pricingMarkdown),
    copilotModels: [
      {
        modelId: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol",
        validEffortTiers: ["low", "high"],
        priceCategory: "medium",
      },
      {
        modelId: "gpt-5.6-terra",
        displayName: "GPT-5.6 Terra",
        validEffortTiers: ["low", "high"],
        priceCategory: "medium",
      },
      {
        modelId: "gpt-5.6-luna",
        displayName: "GPT-5.6 Luna",
        validEffortTiers: ["low", "high"],
        priceCategory: "low",
      },
      {
        modelId: "mai-code-1.1-flash",
        displayName: "MAI-Code 1.1 Flash",
        validEffortTiers: ["low", "medium", "high"],
        priceCategory: "low",
      },
      {
        modelId: "future-model",
        displayName: "Future Model",
        validEffortTiers: [],
        priceCategory: null,
      },
    ],
    inputTokens: 8000,
    outputTokens: 2000,
    fetchedAt,
  });
}

describe("model value sources and ranking", () => {
  it("parses AA evaluations and rejects a missing data envelope", () => {
    const rows = parseAaModels(aaPayload);
    expect(rows[0]).toMatchObject({
      slug: "gpt-5-6-sol-high",
      intelligenceIndex: 60,
      benchmarks: { coding_index: 90 },
    });
    expect(() => parseAaModels({ rows: [] })).toThrow(/data array/);
  });

  it("parses current GitHub Markdown pricing and alerts on table shape drift", () => {
    expect(parseCopilotPricingMarkdown(pricingMarkdown)[0]).toEqual({
      modelName: "GPT-5.6 Sol",
      inputRate: 1,
      cachedInputRate: 0.1,
      cacheWriteRate: null,
      outputRate: 4,
    });
    expect(() =>
      parseCopilotPricingMarkdown(`
| Model | Input | Output |
| --- | ---: | ---: |
| GPT-5.6 Sol | $1.00 |
`)
    ).toThrow(/shape changed/);
  });

  it("joins aliases, keeps uncovered models, and treats effort as metadata", () => {
    const snapshot = fixtureSnapshot();
    const sol = snapshot.rows.find((row) => row.copilotModel === "gpt-5.6-sol")!;
    expect(sol.aaSlug).toBe("gpt-5-6-sol-high");
    expect(sol.validEffortTiers).toEqual(["low", "high"]);
    expect(sol.creditsPerTask).toBe(1.6);
    expect(sol.valueScore).toBe(37.5);
    expect(snapshot.rows.find((row) => row.copilotModel === "mai-code-1.1-flash")).toMatchObject({
      intelligenceIndex: null,
      inputRate: 0.1,
    });
    expect(snapshot.rows.find((row) => row.copilotModel === "future-model")).toMatchObject({
      intelligenceIndex: null,
      inputRate: null,
    });
    expect(snapshot.unmatchedCopilotModels).toEqual(["future-model"]);
  });

  it("persists history and re-ranks the latest cache by a requested benchmark", () => {
    const store = tempStore();
    store.saveSnapshot(fixtureSnapshot().rows);
    const later = fixtureSnapshot("2026-09-01T13:00:00.000Z");
    later.rows.find((row) => row.copilotModel === "gpt-5.6-sol")!.benchmarks.coding_index = 10;
    store.saveSnapshot(later.rows);
    const baseline = store.getRankings({ tier: "flagship" });
    expect(baseline.fetched_at).toBe("2026-09-01T13:00:00.000Z");
    expect(baseline.rankings.every((row) => row.tier === "flagship")).toBe(true);
    const coding = store.getRankings({ benchmark: "coding_index" });
    expect(coding.benchmark).toBe("coding_index");
    expect(coding.rankings.find((row) => row.model === "gpt-5.6-sol")?.benchmark).toEqual({
      name: "coding_index",
      value: 10,
    });
    expect(
      coding.rankings
        .filter((row) => row.benchmark === null)
        .map((row) => row.model)
        .sort()
    ).toEqual(["future-model", "mai-code-1.1-flash"]);
    store.close();
  });
});

describe("model value refresh and MCP cache surface", () => {
  it("notifies render consumers only after a successful snapshot is durable", async () => {
    const store = tempStore();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as any;
    const onUpdate = vi.fn(() => {
      expect(store.getRankings().fetched_at).not.toBeNull();
    });
    const manager = new ModelValueManager({
      store,
      logger,
      aaApiKey: "test",
      inputTokens: 8000,
      outputTokens: 2000,
      fetchAa: async () => parseAaModels(aaPayload),
      fetchPricing: async () => parseCopilotPricingMarkdown(pricingMarkdown),
      fetchCopilot: async () => [{
        modelId: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol",
        validEffortTiers: ["low", "high"],
        priceCategory: "medium",
      }],
    });
    manager.setOnUpdate(onUpdate);
    await manager.refresh();
    expect(onUpdate).toHaveBeenCalledOnce();
    store.close();
  });

  it("keeps a prior snapshot when a source parse/fetch fails", async () => {
    const store = tempStore();
    store.saveSnapshot(fixtureSnapshot().rows);
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as any;
    const manager = new ModelValueManager({
      store,
      logger,
      aaApiKey: "test",
      inputTokens: 8000,
      outputTokens: 2000,
      fetchAa: async () => parseAaModels(aaPayload),
      fetchPricing: async () => {
        throw new Error("pricing shape changed");
      },
      fetchCopilot: async () => [],
    });
    const onUpdate = vi.fn();
    manager.setOnUpdate(onUpdate);
    await manager.refresh();
    expect(store.getRankings().fetched_at).toBe("2026-09-01T12:00:00.000Z");
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(Object),
      "model value ranking refresh failed; keeping prior snapshot"
    );
    expect(onUpdate).not.toHaveBeenCalled();
    store.close();
  });

  it("exposes structured model_value_rankings from cache only", async () => {
    const store = tempStore();
    store.saveSnapshot(fixtureSnapshot().rows);
    const logger = { child: () => logger, info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
    const server = new SeamMcpServer({
      logger,
      resolveSession: (token) => (token === "ok" ? ({} as SessionRecord) : undefined),
      enqueueDispatch: async () => undefined,
      getModelValueRankings: (options) => store.getRankings(options),
    });
    await server.start();
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-seam-session": "ok" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "model_value_rankings", arguments: { tier: "flash" } },
        }),
      });
      const body = (await response.json()) as any;
      expect(body.result.structuredContent.rankings.every((row: any) => row.tier === "flash")).toBe(true);
      expect(JSON.parse(body.result.content[0].text)).toEqual(body.result.structuredContent);
    } finally {
      await server.stop();
      store.close();
    }
  });
});

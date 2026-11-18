import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const directories: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function installedApi() {
  const dir = await mkdtemp(path.join(tmpdir(), "seam-aa-api-")); directories.push(dir);
  const source = await readFile(new URL("../packages/core/src/core/model-metadata/artificial-analysis.ts", import.meta.url), "utf8");
  // Only this pure client is emitted, as for the documented two-file backend install.
  await writeFile(path.join(dir, "seam-aa-source.js"), ts.transpileModule(source,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText);
  await writeFile(path.join(dir, "api.js"), await readFile(new URL("../ops/artificial-analysis-mcp/api.mjs", import.meta.url)));
  await writeFile(path.join(dir, "package.json"), '{"type":"module"}');
  return (await import(pathToFileURL(path.join(dir, "api.js")).href)).ArtificialAnalysisAPI;
}
const raw = { id: "id", name: "Fixture", slug: "fixture", model_creator: { id: "creator-id", name: "Creator" },
  pricing: { price_1m_input_tokens: 1, price_1m_output_tokens: 3, price_1m_cache_hit_tokens: 0.25 },
  evaluations: { artificial_analysis_intelligence_index: 0, artificial_analysis_agentic_index: 45 },
  performance: { median_output_tokens_per_second: 100, median_time_to_first_token_seconds: 0 },
  performance_v3: { mean_output_tokens_per_second: 70, mean_time_to_first_token_seconds: 2 } };

describe("API-only compatibility with the existing host MCP handlers", () => {
  it("loads the copied shared client without Seam dependencies and returns the existing model contract from all pages", async () => {
    const API = await installedApi();
    const fetcher = vi.fn(async (url: string, options: RequestInit) => {
      const number = Number(new URL(url).searchParams.get("page") ?? "1");
      expect(new URL(url).pathname).toBe("/api/v2/language/models/free");
      expect(options.headers).toEqual({ "x-api-key": "fixture-key" });
      return new Response(JSON.stringify({ tier: "free", pagination: { page: number, total_pages: 2, has_more: number < 2 },
        data: [{ ...raw, id: `id-${number}`, slug: `fixture-${number}` }] }));
    });
    vi.stubGlobal("fetch", fetcher);
    const models = await new API("fixture-key").fetchModels();
    expect(models).toHaveLength(2); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(models[1]).toMatchObject({ slug: "fixture-2", creator: { id: "creator-id", name: "Creator", slug: null },
      pricing: { input_per_1m: 1, output_per_1m: 3, blended_per_1m: null, cached_input_per_1m: 0.25 },
      speed: { tokens_per_second: 100, time_to_first_token_ms: 0 },
      benchmarks: { intelligence_index: 0, coding_index: null, gpqa: null, artificial_analysis_agentic_index: 45 },
      performance_v3: { mean_output_tokens_per_second: 70, mean_time_to_first_token_seconds: 2 } });
  });

  it("does not relabel v3 means as absent legacy medians", async () => {
    const API = await installedApi();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ pagination: { page: 1, total_pages: 1, has_more: false },
      data: [{ ...raw, performance: null }] }))));
    const [model] = await new API("fixture-key").fetchModels();
    expect(model.speed).toEqual({ tokens_per_second: null, time_to_first_token_ms: null });
    expect(model.performance_v3.mean_output_tokens_per_second).toBe(70);
  });

  it("passes through the real HTTP failure to the existing MCP error handler", async () => {
    const API = await installedApi();
    const fetcher = vi.fn(async () => new Response("upstream error", { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(new API("fixture-key").fetchModels()).rejects.toThrow("HTTP 503 (page 1)");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

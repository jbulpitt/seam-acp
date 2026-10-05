import type { ModelValueSnapshotRow, ModelValueTier } from "../../packages/core/src/core/model-value/types.js";

const max = ["low", "medium", "high", "xhigh", "max"];
const noneMax = ["none", ...max];
const xhigh = ["low", "medium", "high", "xhigh"];
const high = ["low", "medium", "high"];

// Render-relevant fields from the two-binding live catalog; host identities are neutral.
const models: Array<[string, ModelValueTier | null, number | null, number | null, string[], string | null]> = [
  ["auto", null, null, null, ["default"], null],
  ["claude-sonnet-5", "flash", 38.2, 3.6, max, "max"],
  ["claude-fable-5.1", "flagship", 53.4, 18, max, "max"],
  ["claude-fable-5", "flagship", 49.6, 18, max, "max"],
  ["claude-opus-5.5", "flagship", 57.6, 7.2, max, "max"],
  ["claude-opus-5", "flagship", 50.8, 9, max, "max"],
  ["claude-opus-4.8", "balanced", 41.8, 9, max, "max"],
  ["claude-opus-4.8-fast", null, null, null, max, null],
  ["claude-haiku-4.5", null, null, 1.8, ["default"], null],
  ["gpt-6.1-sol", "flagship", 51.8, 3.6, noneMax, "max"],
  ["gpt-6-sol", "flagship", 47.6, 3.6, noneMax, "max"],
  ["gpt-6-luna", "flash", 38.1, 0.18, noneMax, "max"],
  ["gpt-6-astra", "flagship", 52.7, 18, max, "max"],
  ["gpt-5.6-sol", "flagship", 47, 7.2, noneMax, "max"],
  ["gpt-5.6-terra", "balanced", 42.1, 4, noneMax, "max"],
  ["gpt-5.6-luna", "flash", 37.3, 0.4, noneMax, "max"],
  ["gpt-5.5", "flash", 38.4, 10, ["none", ...xhigh], "xhigh"],
  ["gpt-5.4", "balanced", 39, 5, ["none", ...xhigh], "xhigh"],
  ["gpt-5.4-mini", "flash", 24.1, 1.5, ["none", ...xhigh], "xhigh"],
  ["gpt-5.3-codex", "flash", 32.5, 4.2, xhigh, "xhigh"],
  ["gpt-5-mini", "flash", 16.8, 0.6, high, "high"],
  ["mai-code-1.1-flash", null, null, 0.4, high, null],
  ["gemini-3.8-flash", "balanced", 40.9, 1.35, high, "high"],
  ["gemini-3.7-flash", "balanced", 39.1, 1.35, high, "high"],
  ["grok-4.5", "flash", 38.8, 2.8, high, "high"],
  ["kimi-k3", "balanced", 43.6, 5.4, ["low", "high", "max"], "max"],
  ["claude-sonnet-5.5", "flagship", 56, 3.6, max, "max"],
  ["grok-4.6", "balanced", 44.2, 2.8, xhigh, "xhigh"],
  ["grok-4.7", "balanced", 46.4, 2.8, xhigh, "xhigh"],
];

export function twoBindingCopilotRankings(): ModelValueSnapshotRow[] {
  return models.flatMap(([copilotModel, tier, intelligenceIndex, creditsPerTask, efforts, selectedBenchmarkEffort]) =>
    ["host-a", "host-b"].map(location => ({
      copilotModel,
      tier,
      intelligenceIndex,
      creditsPerTask,
      valueScore: intelligenceIndex !== null && creditsPerTask ? intelligenceIndex / creditsPerTask : null,
      aaSlug: null,
      benchmarks: {},
      inputRate: creditsPerTask === null ? null : 1,
      cachedInputRate: null,
      cacheWriteRate: null,
      outputRate: creditsPerTask === null ? null : 4,
      validEffortTiers: [...efforts],
      selectedBenchmarkEffort,
      priceCategory: null,
      fetchedAt: "2026-10-04T20:00:00.000Z",
      enrichmentGeneration: 123,
      variantId: `copilot@${location}::${copilotModel}`,
      bindings: [{ agent: "copilot", location, scope: `copilot@${location}`, generation: 123, state: "ready" as const }],
      scenario: { uncached_input_tokens: 8000, cached_input_tokens: 0, cache_write_tokens: 0, output_tokens: 2000, long_context_threshold_tokens: 200000 },
      sourceSnapshots: { "artificial-analysis": "1", "github-copilot-pricing": "2" },
      sourceFetchedAt: { "artificial-analysis": "2026-10-04T19:00:00.000Z", "github-copilot-pricing": "2026-10-04T19:00:00.000Z" },
    }))
  );
}

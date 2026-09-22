import { describe, expect, it } from "vitest";
import { planModelFallbacks } from "../packages/core/src/core/model-fallback.js";
import type { CatalogModel } from "@seam/adapters";
import type { ModelMetadata } from "../packages/core/src/core/model-metadata/types.js";

export function catalogModel(id: string, overrides: Partial<CatalogModel> = {}): CatalogModel {
  return { id, runtimeId: id, displayName: id, aliases: [], default: id === "original",
    context: { native: 1_000_000, effective: 1_000_000, maximum: 1_000_000 },
    modalities: { input: ["text"], output: ["text"] }, visionMode: "none",
    availability: "available", lifecycle: "stable", serviceTiers: [], pricingCategory: null,
    compatibility: null, applicationMode: "live",
    effort: { mechanism: "none", choices: [{ id: "default" }], selectionDefault: "default" },
    bindings: [{ model: id, effort: "default", rawModel: id }], ...overrides };
}

export function metadata(id: string, overrides: Partial<ModelMetadata> = {}): ModelMetadata {
  return { id, name: id, aliases: [], slug: null, source_id: null, source_name: null,
    provider: "Vendor", creator: { id: "vendor", name: "Vendor", slug: "vendor" },
    agents: ["codex"], agent_models: [{ agent: "codex", id, name: id, location: "remote" }],
    context_window: 1_000_000, intelligence_index: 60, benchmarks: {},
    pricing: { input_per_million: 1, output_per_million: 4, blended_per_million: 2 },
    released_at: "2026-01-01", description: null, evidence: [], source: "fixture", fetched_at: "2026-09-21",
    ...overrides };
}

const request = { agentId: "codex", location: "remote", model: "original", requiredContextTokens: 400_000 };
const plan = (rows = [metadata("original"), metadata("sibling")], catalog = [catalogModel("original"), catalogModel("sibling")]) =>
  planModelFallbacks({ ...request, metadata: rows, catalog });

describe("metadata model fallback policy (#449)", () => {
  it("prevalidates and serializes a same-vendor sibling with capability/price deltas", () => {
    const result = plan();
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(result.alternatives).toEqual([expect.objectContaining({ model: "sibling", applicationMode: "live",
      notice: "Model fallback: original → sibling; intelligence index +0; price 1× ($2 → $2/M blended tokens); context 1000000 tokens." })]);
  });

  it.each<[string, Partial<ModelMetadata>]>([
    ["wrong agent", { agents: ["claude"] }],
    ["other vendor", { provider: "Other", creator: { id: "other", name: "Other", slug: "other" } }],
    ["creator conflict", { creator: { id: "other", name: "Other", slug: "other" } }],
    ["unverified creator", { creator: null }],
    ["200k window for 400k history", { context_window: 200_000 }],
    ["unknown window", { context_window: null }],
  ])("refuses only substitution: %s", (_reason, changes) => {
    expect(plan([metadata("original"), metadata("sibling", changes)])).toMatchObject({ requestedModel: "original", alternatives: [] });
  });

  it.each<[string, Partial<CatalogModel>]>([
    ["retired", { lifecycle: "retired" }], ["unavailable", { availability: "unavailable" }],
    ["smaller exact binding window", { context: { native: 200_000, effective: 200_000, maximum: 200_000 } }],
    ["missing effort codec", { bindings: [] }],
    ["unsupported effort", { effort: { mechanism: "none", choices: [], selectionDefault: "default" } }],
  ])("does not guess past binding validation: %s", (_reason, changes) => {
    expect(plan(undefined, [catalogModel("original"), catalogModel("sibling", changes)]).alternatives).toEqual([]);
  });

  it("uses metadata aliases, not string similarity; ambiguous aliases refuse only substitution", () => {
    const alias = metadata("opaque-provider-id", { aliases: ["sibling"], agent_models: [] });
    expect(plan([metadata("original"), alias]).alternatives[0]?.model).toBe("sibling");
    expect(plan([metadata("original"), alias, { ...alias, id: "other-id" }]).alternatives).toEqual([]);
    expect(plan([metadata("original"), metadata("sibling-v2", { agent_models: [] })]).alternatives).toEqual([]);
    const result = planModelFallbacks({ ...request, model: "provider-original-alias",
      metadata: [metadata("original", { aliases: ["provider-original-alias"] }), metadata("sibling")],
      catalog: [catalogModel("original"), catalogModel("sibling")] });
    expect(result.requestedModel).toBe("provider-original-alias");
    expect(result.alternatives[0]?.model).toBe("sibling");
  });

  it("cold caches, ambiguous source and unknown context leave requested id untouched", () => {
    expect(plan([], []).alternatives).toEqual([]);
    expect(planModelFallbacks({ ...request, requiredContextTokens: null,
      metadata: [metadata("original"), metadata("sibling")], catalog: [catalogModel("original"), catalogModel("sibling")] }).alternatives).toEqual([]);
    expect(plan([metadata("original"), metadata("duplicate", { aliases: ["original"] }), metadata("sibling")]).alternatives).toEqual([]);
  });

  it("orders nearest intelligence, nearest price, newest release, stable opaque id", () => {
    const rows = [metadata("original"), metadata("downgrade", { intelligence_index: 40 }),
      metadata("expensive", { pricing: { input_per_million: 5, output_per_million: 20, blended_per_million: 10 } }),
      metadata("newer", { released_at: "2026-09-01" }), metadata("older"), metadata("a-tie")];
    expect(plan(rows, rows.map(r => catalogModel(r.id))).alternatives.map(c => c.model))
      .toEqual(["newer", "a-tie", "older", "expensive", "downgrade"]);
    expect(plan(rows, rows.map(r => catalogModel(r.id))).alternatives.find(c => c.model === "expensive")?.notice).toContain("price 5×");
    expect(plan(rows, rows.map(r => catalogModel(r.id))).alternatives.find(c => c.model === "downgrade")?.notice).toContain("intelligence index -20");
  });

  it("labels unknown prices instead of inventing a saving", () => {
    expect(plan([metadata("original"), metadata("sibling", { pricing: null })]).alternatives[0]?.notice).toContain("price delta unknown");
  });

  it("unknown capability labels the substitution instead of removing a safe choice", () => {
    for (const rows of [
      [metadata("original"), metadata("sibling", { intelligence_index: null })],
      [metadata("original", { intelligence_index: null }), metadata("sibling")],
    ]) {
      expect(plan(rows).alternatives[0]?.notice).toContain("capability delta unknown");
    }
    const rows = [metadata("original"), metadata("unknown", { intelligence_index: null }),
      metadata("known", { intelligence_index: 20 })];
    expect(plan(rows, rows.map(r => catalogModel(r.id))).alternatives.map(c => c.model)).toEqual(["known", "unknown"]);
  });

  it("uses an exact effort benchmark variant, not another effort's headline score", () => {
    const row = (id: string, score: number) => metadata(id, {
      intelligence_index: 90,
      matching: { artificial_analysis: { status: "matched", source: "fixture", snapshot_id: null, record_id: null,
        record_name: null, selected_effort: "max", policy: "fixture", candidates: [], stale: false, detail: null },
      github_copilot_pricing: null },
      benchmark_variants: [{ source_id: id, slug: id, name: id, effort: "high", intelligence_index: score, benchmarks: {} }],
    });
    const catalog = ["original", "sibling"].map(id => catalogModel(id, {
      effort: { mechanism: "configOption", configId: "effort", choices: [{ id: "high", raw: "high" }], selectionDefault: "high" },
      bindings: [{ model: id, effort: "high", rawModel: id, rawEffort: "high" }],
    }));
    const result = planModelFallbacks({ ...request, effort: "high", catalog, metadata: [row("original", 60), row("sibling", 59)] });
    expect(result.alternatives[0]).toMatchObject({ effort: "high", notice: expect.stringContaining("intelligence index -1") });
  });

  it("does not erase candidates that require reload; the executor decides its supported mode", () => {
    expect(plan(undefined, [catalogModel("original"), catalogModel("sibling", { applicationMode: "reload" })]).alternatives[0]?.applicationMode).toBe("reload");
  });
});

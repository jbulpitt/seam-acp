import { encodeCatalogSelection, type ModelFallbackPlan, type CatalogModel } from "@seam/adapters";
export type { ModelFallbackPlan } from "@seam/adapters";
import type { ModelMetadata } from "./model-metadata/types.js";

const key = (value: string) => value.toLowerCase();
const finite = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** #449/#307: deleting these filters can send a 400k conversation to a 200k
 * model or another vendor. Missing evidence refuses ONLY an automatic
 * substitution; the requested model still goes to its provider (#366).
 * Input is cached metadata plus the exact execution binding's catalog. */
export function planModelFallbacks(input: {
  agentId: string;
  location: string;
  model: string;
  effort?: string;
  requiredContextTokens: number | null;
  metadata: readonly ModelMetadata[];
  catalog: readonly CatalogModel[];
}): ModelFallbackPlan {
  const plan: ModelFallbackPlan = {
    version: 1, agentId: input.agentId, location: input.location,
    requestedModel: input.model, requiredContextTokens: input.requiredContextTokens,
    alternatives: [],
  };
  let sourceCatalog = input.catalog.filter(model =>
    key(model.id) === key(input.model) || model.aliases.some(a => key(a) === key(input.model)) ||
    (input.model === "default" && model.default) ||
    model.bindings.some(b => b.rawModel === input.model && b.rawEffort === input.effort));
  if (sourceCatalog.length === 0) {
    const aliases = input.metadata.filter(row => row.agents.includes(input.agentId) &&
      (key(row.id) === key(input.model) || row.aliases.some(alias => key(alias) === key(input.model))));
    if (aliases.length === 1) {
      const row = aliases[0]!;
      sourceCatalog = input.catalog.filter(model => row.id === model.id ||
        row.aliases.some(alias => key(alias) === key(model.id)) ||
        row.agent_models.some(binding => binding.agent === input.agentId && binding.id === model.id &&
          (binding.location === undefined || binding.location === input.location)));
    }
  }
  if (sourceCatalog.length !== 1 || !finite(input.requiredContextTokens)) return plan;
  const source = sourceCatalog[0]!;
  const effort = input.effort === undefined ? source.effort.selectionDefault :
    source.effort.choices.find(c => c.id === input.effort || c.raw === input.effort)?.id;
  if (effort === undefined) return plan;

  const metadataFor = (model: CatalogModel): ModelMetadata | undefined => {
    const matches = input.metadata.filter(row => {
      if (!row.agents.includes(input.agentId)) return false;
      if (row.bindings?.length) {
        return row.bindings.some(b => b.agent === input.agentId && b.location === input.location &&
          b.model_id === model.id && b.execution_bindings.some(e => e.effort === effort));
      }
      return row.id === model.id || row.aliases.some(a => key(a) === key(model.id)) ||
        row.agent_models.some(b => b.agent === input.agentId && b.id === model.id &&
          (b.location === undefined || b.location === input.location));
    });
    // Ambiguous aliases/effort variants are not permission to pick a benchmark.
    if (matches.length !== 1) return undefined;
    const row = matches[0]!;
    if (row.matching?.artificial_analysis.selected_effort && row.matching.artificial_analysis.selected_effort !== effort) {
      const variants = row.benchmark_variants?.filter(v => v.effort === effort) ?? [];
      // A benchmark for another effort is not this selection's capability.
      // Unknown capability is a labeled ranking caveat, NOT a fourth hard filter.
      return { ...row, intelligence_index: variants.length === 1 ? variants[0]!.intelligence_index : null };
    }
    return row;
  };
  const baseline = metadataFor(source);
  if (!baseline) return plan;
  const sameVendor = (row: ModelMetadata) => {
    if (baseline.creator?.id || row.creator?.id) {
      return !!baseline.creator?.id && baseline.creator.id === row.creator?.id &&
        (!baseline.provider || !row.provider || key(baseline.provider) === key(row.provider));
    }
    return !!baseline.provider && !!row.provider && key(baseline.provider) === key(row.provider);
  };
  const rows = input.catalog.flatMap(model => {
    if (model.id === source.id || model.lifecycle === "retired" || model.availability !== "available") return [];
    const row = metadataFor(model);
    if (!row || !sameVendor(row) ||
        !finite(row.context_window) || row.context_window < input.requiredContextTokens!) return [];
    // Catalog and metadata disagreement narrows substitution, not availability
    // of the original selection. Neither source may overstate the window.
    const window = Math.min(row.context_window, model.context.effective ?? row.context_window);
    if (window < input.requiredContextTokens! || !model.effort.choices.some(c => c.id === effort)) return [];
    const binding = model.bindings.find(b => b.model === model.id && b.effort === effort);
    if (!binding) return [];
    const raw = encodeCatalogSelection(model, { model: model.id, effort });
    if (raw.model === input.model || raw.effort !== input.effort) return [];
    return [{ model, row, raw, window }];
  });
  const price = (row: ModelMetadata) => row.pricing?.blended_per_million;
  const distance = (row: ModelMetadata) => finite(row.intelligence_index) && finite(baseline.intelligence_index)
    ? Math.abs(row.intelligence_index - baseline.intelligence_index) : Infinity;
  const priceDistance = (row: ModelMetadata) => finite(price(row)) && finite(price(baseline))
    ? Math.abs(price(row)! - price(baseline)!) : Infinity;
  rows.sort((a, b) => (distance(a.row) === distance(b.row) ? 0 : distance(a.row) < distance(b.row) ? -1 : 1) ||
    (priceDistance(a.row) === priceDistance(b.row) ? 0 : priceDistance(a.row) < priceDistance(b.row) ? -1 : 1) ||
    (b.row.released_at ?? "").localeCompare(a.row.released_at ?? "") || a.model.id.localeCompare(b.model.id));
  const seen = new Set<string>();
  for (const { model, row, raw, window } of rows) {
    if (seen.has(raw.model)) continue;
    seen.add(raw.model);
    const delta = finite(row.intelligence_index) && finite(baseline.intelligence_index)
      ? row.intelligence_index - baseline.intelligence_index : null;
    const capability = delta === null ? "capability delta unknown" :
      `intelligence index ${delta >= 0 ? "+" : ""}${Number(delta.toFixed(2))}`;
    const pricing = finite(price(row)) && finite(price(baseline)) && price(baseline)! > 0
      ? `price ${Number((price(row)! / price(baseline)!).toFixed(2))}× ($${price(baseline)} → $${price(row)}/M blended tokens)`
      : "price delta unknown";
    plan.alternatives.push({ ...raw, normalizedModel: model.id, applicationMode: model.applicationMode,
      contextWindow: window,
      notice: `Model fallback: ${source.id} → ${model.id}; ${capability}; ${pricing}; context ${window} tokens.`,
    });
  }
  return plan;
}

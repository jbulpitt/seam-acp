import {
  canonicalJson,
  sortCatalogEvidence,
  CATALOG_EVIDENCE_MAX_RECORDS,
  type CatalogModelEvidence,
} from "@seam/adapters";
import { matchArtificialAnalysis, normalizeAaEffort, normalizeExternalModelName } from "../model-intelligence/matching.js";
import type {
  AgentModelAvailability,
  CachedAgentModel,
  MetadataSourceModel,
  ModelMetadata,
} from "./types.js";

export interface BuildModelMetadataResult {
  rows: ModelMetadata[];
  unmatchedModels: string[];
  ignoredSourceVariants: string[];
}

export function buildModelMetadataSnapshot(input: {
  catalog: AgentModelAvailability[];
  sourceModels: MetadataSourceModel[];
  source: string;
  fetchedAt: string;
}): BuildModelMetadataResult {
  const grouped = new Map<string, AgentModelAvailability[]>();
  for (const item of input.catalog) {
    // Punctuation-only spelling differences are safe to group for metadata;
    // each opaque runtime id remains intact in agent_models/bindings.
    const semantic = normalizeExternalModelName(item.modelId);
    const canonical = item.catalogScope
      ? `${item.catalogScope}\u0000${semantic}\u0000${(item.effortChoices ?? []).join(",")}\u0000${item.effortDefault ?? ""}`
      : semantic;
    const group = grouped.get(canonical) ?? [];
    if (!group.some((row) => row.agentId === item.agentId && row.modelId === item.modelId)) {
      group.push(item);
    }
    grouped.set(canonical, group);
  }
  const unmatchedModels: string[] = [];
  const ignoredSourceVariants: string[] = [];
  const rows = [...grouped.values()].map((availability) => {
    const representative = availability[0]!;
    const id = representative.modelId;
    const match = matchArtificialAnalysis({
      modelId: representative.modelId,
      displayName: representative.name,
      aliases: representative.aliases,
      effortChoices: representative.effortChoices,
      effortDefault: representative.effortDefault,
      effortMechanism: representative.effortMechanism,
    }, input.sourceModels);
    ignoredSourceVariants.push(...match.ignored);
    if (!match.row) unmatchedModels.push(id);
    const contextWindows = availability.flatMap((row) =>
      row.contextWindow === null ? [] : [row.contextWindow]
    );
    const agentModels: CachedAgentModel[] = availability
      .map((row) => ({
        agent: row.agentId, id: row.modelId, name: row.name,
        ...(row.location ? { location: row.location } : {}),
        ...(row.runtimeId ? { runtime_id: row.runtimeId } : {}),
        ...(row.catalogGeneration !== undefined ? { catalog_generation: row.catalogGeneration } : {}),
        ...(row.catalogScope ? { catalog_scope: row.catalogScope } : {}),
        ...(row.catalogState ? { catalog_state: row.catalogState } : {}),
      }))
      .sort((a, b) => a.agent.localeCompare(b.agent) || (a.location ?? "").localeCompare(b.location ?? "") || a.id.localeCompare(b.id));
    const source = match.row;
    return {
      id,
      name: availability[0]?.name ?? source?.name ?? id,
      aliases: [...new Set(availability.flatMap((row) => [row.modelId, ...(row.aliases ?? [])]))].sort(),
      slug: source?.slug ?? null,
      source_id: source?.id ?? null,
      source_name: source?.name ?? null,
      provider: source?.creator?.name ?? null,
      creator: source?.creator ?? null,
      agents: [...new Set(availability.map((row) => row.agentId))].sort(),
      agent_models: agentModels,
      context_window: contextWindows.length > 0 ? Math.max(...contextWindows) : null,
      intelligence_index: source?.intelligenceIndex ?? null,
      benchmarks: source?.benchmarks ?? {},
      pricing: source?.pricing ?? null,
      released_at: source?.releaseDate ?? null,
      // The catalog owns this: prefer any published description over nothing,
      // and never let the external source overwrite an operational one.
      description: availability.find((row) => row.description)?.description ?? null,
      // Structured provenance in its validated bounded form. Deduped by
      // canonical identity so several agents advertising the same model do not
      // multiply identical records, and capped so the row stays bounded.
      evidence: dedupeEvidence(availability.flatMap((row) => row.evidence ?? [])),
      source: input.source,
      fetched_at: input.fetchedAt,
      variant_id: representative.catalogScope ? `${representative.catalogScope}::${id}` : id,
      runtime_id: representative.runtimeId ?? representative.modelId,
      bindings: availability.flatMap((entry) =>
        entry.location && entry.catalogGeneration !== undefined && entry.catalogScope && entry.catalogState && entry.catalogFetchedAt
          ? [{
              agent: entry.agentId,
              location: entry.location,
              model_id: entry.modelId,
              runtime_id: entry.runtimeId ?? entry.modelId,
              catalog_generation: entry.catalogGeneration,
              catalog_scope: entry.catalogScope,
              catalog_state: entry.catalogState,
              catalog_fetched_at: entry.catalogFetchedAt,
              model_default: entry.modelDefault ?? false,
              aliases: [...(entry.aliases ?? [])],
              application_mode: entry.applicationMode ?? "freshSession",
              effort_choices: [...(entry.effortChoices ?? [])],
              effort_default: entry.effortDefault ?? "default",
              effort_mechanism: entry.effortMechanism ?? "none",
              execution_bindings: [...(entry.executionBindings ?? [])],
            }]
          : []
      ),
      catalog_state: representative.catalogState,
      catalog_generation: representative.catalogGeneration,
      catalog_scope: representative.catalogScope,
      catalog_fetched_at: representative.catalogFetchedAt,
      benchmark_variants: input.sourceModels
        .filter((row) => match.candidates.includes(row.slug))
        .map((row) => ({
          source_id: row.id, slug: row.slug, name: row.name,
          effort: normalizeAaEffort(row.name) ?? normalizeAaEffort(row.slug),
          intelligence_index: row.intelligenceIndex,
          benchmarks: row.benchmarks,
        })),
      matching: {
        artificial_analysis: {
          status: match.status === "matched" && source?.intelligenceIndex === null
            ? "missing-benchmark" : match.status,
          source: input.source,
          snapshot_id: null,
          record_id: source?.id ?? null,
          record_name: source?.name ?? null,
          selected_effort: match.selectedEffort,
          policy: "automatic-exact-normalized-highest-supported-effort",
          candidates: match.candidates,
          stale: false,
          detail: null,
        },
        github_copilot_pricing: null,
      },
    } satisfies ModelMetadata;
  });
  rows.sort((a, b) => a.id.localeCompare(b.id) ||
    (a.variant_id ?? a.id).localeCompare(b.variant_id ?? b.id));
  return {
    rows,
    unmatchedModels: unmatchedModels.sort(),
    ignoredSourceVariants: [...new Set(ignoredSourceVariants)].sort(),
  };
}

/** Stable de-duplication for evidence merged across agents advertising one model. */
function dedupeEvidence(
  records: ReadonlyArray<CatalogModelEvidence>
): CatalogModelEvidence[] {
  const seen = new Map<string, CatalogModelEvidence>();
  for (const record of sortCatalogEvidence(records)) {
    const key = canonicalJson(record);
    if (!seen.has(key)) seen.set(key, record);
  }
  return [...seen.values()].slice(0, CATALOG_EVIDENCE_MAX_RECORDS);
}

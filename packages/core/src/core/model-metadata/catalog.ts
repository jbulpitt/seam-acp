import type { AgentProfile } from "@seam/adapters";
import { canonicalModelId, chooseAaVariant, modelAliasForId } from "./aliases.js";
import type {
  AgentModelAvailability,
  CachedAgentModel,
  MetadataSourceModel,
  ModelMetadata,
} from "./types.js";

export async function collectAgentModelCatalog(
  profiles: ReadonlyArray<AgentProfile>
): Promise<AgentModelAvailability[]> {
  const rows: AgentModelAvailability[] = [];
  for (const profile of profiles) {
    let models = profile.describe().models;
    if ((!profile.staticModels || profile.staticModels.length === 0) && profile.listPickerModels) {
      models = await profile.listPickerModels();
    }
    for (const model of models) {
      rows.push({
        agentId: profile.id,
        modelId: model.modelId,
        name: model.name,
        contextWindow: model.contextLimit ?? null,
        vision: model.visionMode ? model.visionMode === "native" : null,
      });
    }
  }
  return rows;
}

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
    const canonical = canonicalModelId(item.modelId);
    const group = grouped.get(canonical) ?? [];
    if (!group.some((row) => row.agentId === item.agentId && row.modelId === item.modelId)) {
      group.push(item);
    }
    grouped.set(canonical, group);
  }
  const unmatchedModels: string[] = [];
  const ignoredSourceVariants: string[] = [];
  const rows = [...grouped.entries()].map(([id, availability]) => {
    const aliasEntry = modelAliasForId(id);
    const match = chooseAaVariant(
      aliasEntry?.alias,
      input.sourceModels,
      aliasEntry?.alias.metadataEfforts ?? [],
      Boolean(aliasEntry?.alias.metadataEfforts)
    );
    ignoredSourceVariants.push(...match.ignored);
    if (!match.row) unmatchedModels.push(id);
    const contextWindows = availability.flatMap((row) =>
      row.contextWindow === null ? [] : [row.contextWindow]
    );
    const agentModels: CachedAgentModel[] = availability
      .map((row) => ({ agent: row.agentId, id: row.modelId, name: row.name }))
      .sort((a, b) => a.agent.localeCompare(b.agent) || a.id.localeCompare(b.id));
    const source = match.row;
    return {
      id,
      name: availability[0]?.name ?? source?.name ?? id,
      aliases: [...new Set(availability.map((row) => row.modelId))].sort(),
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
      source: input.source,
      fetched_at: input.fetchedAt,
    } satisfies ModelMetadata;
  });
  rows.sort((a, b) => a.id.localeCompare(b.id));
  return {
    rows,
    unmatchedModels: unmatchedModels.sort(),
    ignoredSourceVariants: [...new Set(ignoredSourceVariants)].sort(),
  };
}

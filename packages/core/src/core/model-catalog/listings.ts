import type { ModelMetadata } from "../model-metadata/types.js";
import type { ModelValueRankingsResult } from "../model-value/types.js";
import type { CatalogBinding, ModelCatalogService } from "./service.js";

type CurrentModel = CatalogBinding & { model: string };
type Visibility = Pick<ModelCatalogService, "isHidden">;

function isCurrent(current: CurrentModel | undefined, agent: string, location: string, model: string): boolean {
  return current?.agentId === agent && current.location === location && current.model === model;
}

export function visibleModelRankings(catalog: Visibility, result: ModelValueRankingsResult, current?: CurrentModel): ModelValueRankingsResult {
  return { ...result, rankings: result.rankings.flatMap((row) => {
    const bindings = row.bindings?.filter((binding) =>
      !catalog.isHidden({ agentId: binding.agent, location: binding.location }, row.model) ||
      isCurrent(current, binding.agent, binding.location, row.model));
    const fallback = { agentId: "copilot", location: "local" };
    if (row.bindings?.length ? !bindings?.length : catalog.isHidden(fallback, row.model) && !isCurrent(current, fallback.agentId, fallback.location, row.model)) return [];
    const hiddenCurrent = current?.model === row.model && catalog.isHidden(current, row.model);
    return [{ ...row, ...(bindings ? { bindings } : {}),
      ...(hiddenCurrent ? { display_name: `${row.display_name ?? row.model} (hidden)` } : {}) }];
  }) };
}

export function visibleModelMetadata(catalog: Visibility, rows: ModelMetadata[], current?: CurrentModel): ModelMetadata[] {
  return rows.flatMap((row) => {
    const visible = (agent: string, location = "local", model = row.id) =>
      !catalog.isHidden({ agentId: agent, location }, model) || isCurrent(current, agent, location, model);
    const bindings = row.bindings?.filter((binding) => visible(binding.agent, binding.location, binding.model_id));
    const agentModels = row.agent_models.filter((model) => visible(model.agent, model.location, model.id));
    const available = row.bindings?.length ? Boolean(bindings?.length)
      : row.agent_models.length ? agentModels.length > 0
      : row.agents.length ? row.agents.some((agent) => visible(agent))
      : visible("");
    if (!available) return [];
    const hiddenCurrent = current?.model === row.id && catalog.isHidden(current, row.id);
    return [{ ...row, ...(bindings ? { bindings } : {}), agent_models: agentModels,
      agents: row.agents.filter((agent) => bindings?.some((binding) => binding.agent === agent) || agentModels.some((model) => model.agent === agent) || (!row.bindings?.length && !row.agent_models.length && visible(agent))),
      ...(hiddenCurrent ? { name: `${row.name} (hidden)` } : {}) }];
  });
}

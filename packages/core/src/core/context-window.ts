/**
 * Authoritative, agent-agnostic context-window resolution (#209).
 *
 * Rebuild (and any other context-budget consumer) must use this instead of
 * reading raw session columns or adapter/UI inventories. A cosmetic
 * picker label is never parsed for a token count, and a missing exact-model
 * match never borrows another model's window or a generic 200K default.
 */
import {
  ReconstructionUnavailableError,
  reconstructionBudgetTokens,
} from "./reconstruction/types.js";

export type ContextWindowSourceId =
  | "live-usage"
  | "operational-catalog"
  | "model-metadata";

const SOURCE_ORDER: readonly ContextWindowSourceId[] = [
  "live-usage",
  "operational-catalog",
  "model-metadata",
];

export interface ContextWindowModel {
  modelId: string;
  name?: string;
  contextLimit?: number;
}

export interface ContextWindowResolution {
  window: number;
  budgetTokens: number;
  agentId: string;
  model: string;
  source: ContextWindowSourceId;
  sourcesChecked: ContextWindowSourceId[];
}

export interface ContextWindowResolveInput {
  agentId: string;
  model: string;
  /** Profile default, used only to look up catalogs when `model` is `"default"`. */
  defaultModel?: string;
  lastContextUsage?: { model: string; size: number };
  catalogModels?: ReadonlyArray<ContextWindowModel>;
  /** Exact-id window from the durable model-metadata catalog. */
  metadataWindow?: number | null;
}

export function enrichModelListWithKnownLimits<T extends ContextWindowModel>(
  override: ReadonlyArray<T> | undefined,
  known: ReadonlyArray<ContextWindowModel>
): T[] | undefined {
  if (!override || override.length === 0) return undefined;
  const byId = new Map<string, number>();
  for (const entry of known) {
    if (entry.contextLimit && entry.contextLimit > 0) byId.set(entry.modelId, entry.contextLimit);
  }
  return override.map((model) => {
    if (model.contextLimit && model.contextLimit > 0) return model;
    const limit = byId.get(model.modelId);
    return limit ? { ...model, contextLimit: limit } : model;
  });
}

function exactLimit(
  modelId: string,
  models: ReadonlyArray<ContextWindowModel> | undefined
): number | undefined {
  if (!models) return undefined;
  const hit = models.find((model) => model.modelId === modelId);
  if (hit?.contextLimit && Number.isFinite(hit.contextLimit) && hit.contextLimit > 0) {
    return Math.floor(hit.contextLimit);
  }
  return undefined;
}

function catalogLookupIds(model: string, defaultModel?: string): string[] {
  const ids = [model];
  if (model === "default" && defaultModel && defaultModel !== "default" && defaultModel !== model) {
    ids.push(defaultModel);
  }
  return ids;
}

export function resolveContextWindow(input: ContextWindowResolveInput): ContextWindowResolution {
  const agentId = input.agentId;
  const model = input.model;
  if (!agentId || !model) {
    throw new ReconstructionUnavailableError(
      `Rebuild cannot resolve a context window: missing effective agent or model.`
    );
  }

  const sourcesChecked: ContextWindowSourceId[] = [];
  const lookupIds = catalogLookupIds(model, input.defaultModel);

  const take = (source: ContextWindowSourceId, window: number | undefined): ContextWindowResolution | undefined => {
    sourcesChecked.push(source);
    if (window && window > 0) {
      return {
        window,
        budgetTokens: reconstructionBudgetTokens(window),
        agentId,
        model,
        source,
        sourcesChecked: [...sourcesChecked],
      };
    }
    return undefined;
  };

  const usage = input.lastContextUsage;
  const live =
    usage &&
    usage.model === model &&
    Number.isFinite(usage.size) &&
    usage.size > 0
      ? Math.floor(usage.size)
      : undefined;
  const fromLive = take("live-usage", live);
  if (fromLive) return fromLive;

  const firstHit = (
    source: ContextWindowSourceId,
    read: (id: string) => number | undefined
  ): ContextWindowResolution | undefined => {
    let window: number | undefined;
    for (const id of lookupIds) {
      window = read(id);
      if (window) break;
    }
    return take(source, window);
  };

  const fromCatalog = firstHit("operational-catalog", (id) => exactLimit(id, input.catalogModels));
  if (fromCatalog) return fromCatalog;

  const meta =
    input.metadataWindow && Number.isFinite(input.metadataWindow) && input.metadataWindow > 0
      ? Math.floor(input.metadataWindow)
      : undefined;
  const fromMeta = take("model-metadata", meta);
  if (fromMeta) return fromMeta;

  throw new ReconstructionUnavailableError(
    `Rebuild cannot resolve a context window for agent \`${agentId}\` model \`${model}\`. ` +
      `Checked: ${SOURCE_ORDER.join(", ")}.`
  );
}

/** Compatibility wrapper used by older reconstruction unit tests. */
export function resolveDestinationContextWindow(opts: {
  destinationModel: string;
  lastContextUsage?: { model: string; size: number };
  staticContextLimit?: number;
}): number {
  return resolveContextWindow({
    agentId: "unknown",
    model: opts.destinationModel,
    lastContextUsage: opts.lastContextUsage,
    catalogModels: opts.staticContextLimit
      ? [{ modelId: opts.destinationModel, contextLimit: opts.staticContextLimit }]
      : [],
  }).window;
}

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
import { matchesContextBudget, type ContextBudgetIdentity, type ContextBudgetObservation } from "./context-budget.js";

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
  identity?: ContextBudgetIdentity;
  lastContextUsage?: { model: string; size: number; budget?: ContextBudgetObservation };
  catalogModels?: ReadonlyArray<ContextWindowModel>;
  /** Explicit prompt budget from a binding-qualified source, never a total window. */
  metadataBudget?: Omit<ContextBudgetIdentity, "acpSessionId"> & { promptBudget: number };
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
    input.identity && matchesContextBudget(usage?.budget, { ...input.identity, agentId, model }) &&
    usage?.budget && Number.isFinite(usage.budget.promptBudget) && usage.budget.promptBudget > 0
      ? Math.floor(usage.budget.promptBudget)
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

  const metadata = input.metadataBudget;
  // Metadata must name this binding and tier and explicitly describe input capacity.
  // Removing this gate reintroduces bare-model cross-provider and total-window leakage.
  const meta =
    input.identity && metadata &&
    metadata.agentId === agentId && metadata.location === input.identity.location &&
    metadata.model === model && metadata.requestedTier === input.identity.requestedTier &&
    Number.isFinite(metadata.promptBudget) && metadata.promptBudget > 0
      ? Math.floor(metadata.promptBudget)
      : undefined;
  const fromMeta = take("model-metadata", meta);
  if (fromMeta) return fromMeta;

  throw new ReconstructionUnavailableError(
    `Rebuild cannot resolve a context window for agent \`${agentId}\` model \`${model}\`. ` +
      `Checked: ${SOURCE_ORDER.join(", ")}.`
  );
}

/** Compatibility wrapper for destination-only callers; observations still require full attribution. */
export function resolveDestinationContextWindow(opts: {
  destinationModel: string;
  identity?: ContextBudgetIdentity;
  lastContextUsage?: ContextWindowResolveInput["lastContextUsage"];
  staticContextLimit?: number;
}): number {
  return resolveContextWindow({
    agentId: opts.identity?.agentId ?? "unknown",
    model: opts.destinationModel,
    identity: opts.identity,
    lastContextUsage: opts.lastContextUsage,
    catalogModels: opts.staticContextLimit
      ? [{ modelId: opts.destinationModel, contextLimit: opts.staticContextLimit }]
      : [],
  }).window;
}

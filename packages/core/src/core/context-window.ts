/**
 * Authoritative, agent-agnostic context-window resolution (#209).
 *
 * Rebuild (and any other context-budget consumer) must use this instead of
 * reading raw session columns or a single staticModels entry. A cosmetic
 * picker label is never parsed for a token count, and a missing exact-model
 * match never borrows another model's window or a generic 200K default.
 */
import { lookupClaudeNativeContextWindow } from "@seam/adapters";
import {
  GROK_STATIC_MODELS,
  OLLAMA_CLOUD_STATIC_MODELS,
  ZAI_STATIC_MODELS,
} from "../config.js";
import {
  ReconstructionUnavailableError,
  reconstructionBudgetTokens,
} from "./reconstruction/types.js";

export type ContextWindowSourceId =
  | "live-usage"
  | "static-profile"
  | "adapter-descriptor"
  | "picker-catalog"
  | "curated-catalog"
  | "model-metadata";

const SOURCE_ORDER: readonly ContextWindowSourceId[] = [
  "live-usage",
  "static-profile",
  "adapter-descriptor",
  "picker-catalog",
  "curated-catalog",
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
  staticModels?: ReadonlyArray<ContextWindowModel>;
  adapterModels?: ReadonlyArray<ContextWindowModel>;
  pickerModels?: ReadonlyArray<ContextWindowModel>;
  /** Exact-id window from the durable model-metadata catalog. */
  metadataWindow?: number | null;
  /**
   * Extra curated exact-id tables. Combined with the built-in Grok / Z.ai /
   * Ollama Cloud / Claude native tables unless `includeBuiltInCurated` is false.
   */
  curatedLimits?: ReadonlyArray<ContextWindowModel>;
  includeBuiltInCurated?: boolean;
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

export function builtInCuratedContextLimits(): ContextWindowModel[] {
  return [
    ...GROK_STATIC_MODELS,
    ...ZAI_STATIC_MODELS,
    ...OLLAMA_CLOUD_STATIC_MODELS,
  ].filter((model) => model.contextLimit && model.contextLimit > 0);
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

function isClaudeFamily(agentId: string): boolean {
  return agentId === "claude" || agentId.startsWith("claude-");
}

function curatedLimitFor(
  agentId: string,
  modelId: string,
  tables: ReadonlyArray<ContextWindowModel>
): number | undefined {
  const fromTable = exactLimit(modelId, tables);
  if (fromTable) return fromTable;
  if (modelId === "default" && !isClaudeFamily(agentId)) return undefined;
  if (isClaudeFamily(agentId) || modelId.startsWith("claude-") || modelId === "default") {
    return lookupClaudeNativeContextWindow(modelId);
  }
  return undefined;
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
  const includeCurated = input.includeBuiltInCurated !== false;
  const curated = includeCurated
    ? [...builtInCuratedContextLimits(), ...(input.curatedLimits ?? [])]
    : (input.curatedLimits ?? []);

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

  const fromStatic = firstHit("static-profile", (id) => exactLimit(id, input.staticModels));
  if (fromStatic) return fromStatic;
  const fromAdapter = firstHit("adapter-descriptor", (id) => exactLimit(id, input.adapterModels));
  if (fromAdapter) return fromAdapter;
  const fromPicker = firstHit("picker-catalog", (id) => exactLimit(id, input.pickerModels));
  if (fromPicker) return fromPicker;
  const fromCurated = firstHit("curated-catalog", (id) => curatedLimitFor(agentId, id, curated));
  if (fromCurated) return fromCurated;

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
    staticModels: opts.staticContextLimit
      ? [{ modelId: opts.destinationModel, contextLimit: opts.staticContextLimit }]
      : [],
  }).window;
}

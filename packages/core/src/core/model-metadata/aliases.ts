import type { MetadataSourceModel } from "./types.js";

export interface ModelAlias {
  aaSlugPrefixes: string[];
  pricingNames: string[];
  modelIds?: string[];
  metadataEfforts?: string[];
}

/** Explicit joins only: vendor naming drift must surface as an unmatched row,
 * never as a fuzzy match to another SKU. Shared by #130 and #134. */
export const MODEL_METADATA_ALIASES: Readonly<Record<string, ModelAlias>> = {
  "claude-fable-5-1": {
    aaSlugPrefixes: ["claude-fable-5-1"], pricingNames: ["Claude Fable 5.1"],
  },
  "claude-sonnet-5": { aaSlugPrefixes: ["claude-sonnet-5"], pricingNames: ["Claude Sonnet 5"] },
  "claude-opus-5": { aaSlugPrefixes: ["claude-opus-5"], pricingNames: ["Claude Opus 5"] },
  "claude-opus-4.8": {
    aaSlugPrefixes: ["claude-opus-4-8"], pricingNames: ["Claude Opus 4.8"], modelIds: ["claude-opus-4-8"],
  },
  "claude-opus-4.8-fast": {
    aaSlugPrefixes: ["claude-opus-4-8"],
    pricingNames: ["Claude Opus 4.8 (fast mode)", "Claude Opus 4.8 Fast"],
  },
  "claude-opus-4.7": {
    aaSlugPrefixes: ["claude-opus-4-7"], pricingNames: ["Claude Opus 4.7"], modelIds: ["claude-opus-4-7"],
  },
  "claude-sonnet-4.6": {
    aaSlugPrefixes: ["claude-sonnet-4-6"], pricingNames: ["Claude Sonnet 4.6"], modelIds: ["claude-sonnet-4-6"],
  },
  "claude-opus-4.6": {
    aaSlugPrefixes: ["claude-opus-4-6"], pricingNames: ["Claude Opus 4.6"], modelIds: ["claude-opus-4-6"],
  },
  "claude-opus-4-6-thinking": {
    aaSlugPrefixes: ["claude-opus-4-6"], pricingNames: [], metadataEfforts: ["max"],
  },
  "claude-sonnet-4.5": { aaSlugPrefixes: ["claude-4-5-sonnet"], pricingNames: ["Claude Sonnet 4.5"] },
  "claude-opus-4.5": {
    aaSlugPrefixes: ["claude-opus-4-5"], pricingNames: ["Claude Opus 4.5"], modelIds: ["claude-opus-4-5"],
  },
  "claude-haiku-4.5": {
    aaSlugPrefixes: ["claude-4-5-haiku", "claude-haiku-4-5"],
    pricingNames: ["Claude Haiku 4.5"],
    modelIds: ["claude-haiku-4-5"],
  },
  "claude-fable-5": { aaSlugPrefixes: ["claude-fable-5"], pricingNames: ["Claude Fable 5"] },
  "gpt-5.6-sol": { aaSlugPrefixes: ["gpt-5-6-sol"], pricingNames: ["GPT-5.6 Sol"] },
  "gpt-5.6-terra": { aaSlugPrefixes: ["gpt-5-6-terra"], pricingNames: ["GPT-5.6 Terra"] },
  "gpt-5.6-luna": { aaSlugPrefixes: ["gpt-5-6-luna"], pricingNames: ["GPT-5.6 Luna"] },
  "gpt-5.5": { aaSlugPrefixes: ["gpt-5-5"], pricingNames: ["GPT-5.5"] },
  "gpt-5.4": { aaSlugPrefixes: ["gpt-5-4"], pricingNames: ["GPT-5.4"] },
  "gpt-5.4-mini": { aaSlugPrefixes: ["gpt-5-4-mini"], pricingNames: ["GPT-5.4 mini"] },
  "gpt-5.4-nano": { aaSlugPrefixes: ["gpt-5-4-nano"], pricingNames: ["GPT-5.4 nano"] },
  "gpt-5.3-codex": { aaSlugPrefixes: ["gpt-5-3-codex"], pricingNames: ["GPT-5.3-Codex"] },
  "gpt-5-mini": { aaSlugPrefixes: ["gpt-5-mini"], pricingNames: ["GPT-5 mini"] },
  "gemini-3.7-flash": { aaSlugPrefixes: ["gemini-3-7-flash"], pricingNames: ["Gemini 3.7 Flash"] },
  "gemini-3.7-flash-high": {
    aaSlugPrefixes: ["gemini-3-7-flash"], pricingNames: [], metadataEfforts: ["high"],
  },
  "gemini-3.7-flash-medium": {
    aaSlugPrefixes: ["gemini-3-7-flash"], pricingNames: [], metadataEfforts: ["medium"],
  },
  "gemini-3.7-flash-low": {
    aaSlugPrefixes: ["gemini-3-7-flash"], pricingNames: [], metadataEfforts: ["low"],
  },
  "gemini-3.6-flash": { aaSlugPrefixes: ["gemini-3-6-flash"], pricingNames: ["Gemini 3.6 Flash"] },
  "gemini-3.6-flash-high": {
    aaSlugPrefixes: ["gemini-3-6-flash"], pricingNames: [], metadataEfforts: ["high"],
  },
  "gemini-3.6-flash-medium": {
    aaSlugPrefixes: ["gemini-3-6-flash"], pricingNames: [], metadataEfforts: ["medium"],
  },
  "gemini-3.6-flash-low": {
    aaSlugPrefixes: ["gemini-3-6-flash"], pricingNames: [], metadataEfforts: ["low"],
  },
  "gemini-3.5-flash": { aaSlugPrefixes: ["gemini-3-5-flash"], pricingNames: ["Gemini 3.5 Flash"] },
  "gemini-3.1-pro-preview": { aaSlugPrefixes: ["gemini-3-1-pro-preview"], pricingNames: ["Gemini 3.1 Pro"] },
  "gemini-3.1-pro-high": {
    aaSlugPrefixes: ["gemini-3-1-pro-preview"], pricingNames: [], metadataEfforts: ["high"],
  },
  "gemini-3.1-pro-low": {
    aaSlugPrefixes: ["gemini-3-1-pro-preview"], pricingNames: [], metadataEfforts: ["low"],
  },
  "grok-4.5": { aaSlugPrefixes: ["grok-4-5"], pricingNames: ["Grok 4.5"] },
  "grok-4.6": { aaSlugPrefixes: ["grok-4-6"], pricingNames: ["Grok 4.6"] },
  "kimi-k3": { aaSlugPrefixes: ["kimi-k3"], pricingNames: ["Kimi K3"], modelIds: ["kimi-k3:cloud"] },
  "kimi-k2.7-code": { aaSlugPrefixes: ["kimi-k2-7-code"], pricingNames: ["Kimi K2.7 Code"] },
  "glm-5.3": { aaSlugPrefixes: ["glm-5-3"], pricingNames: [], modelIds: ["glm-5.3:cloud"] },
  "glm-5.3-flash": { aaSlugPrefixes: ["glm-5-3-flash"], pricingNames: [], modelIds: ["glm-5.3-flash:cloud"] },
  "glm-5.2": { aaSlugPrefixes: ["glm-5-2"], pricingNames: [] },
  "glm-5": { aaSlugPrefixes: ["glm-5"], pricingNames: [] },
  "glm-5v-turbo": { aaSlugPrefixes: ["glm-5v-turbo"], pricingNames: [] },
  "deepseek-v4-pro": { aaSlugPrefixes: ["deepseek-v4-pro"], pricingNames: [], modelIds: ["deepseek-v4-pro:cloud"] },
  "deepseek-v4-flash": { aaSlugPrefixes: ["deepseek-v4-flash"], pricingNames: [], modelIds: ["deepseek-v4-flash:cloud"] },
  "minimax-m3": { aaSlugPrefixes: ["minimax-m3"], pricingNames: [], modelIds: ["minimax-m3:cloud"] },
  "gemma-4-26b-a4b": {
    aaSlugPrefixes: ["gemma-4-26b-a4b"],
    pricingNames: [],
    modelIds: ["lmstudio-remote/google/gemma-4-26b-a4b"],
  },
  "raptor-mini": { aaSlugPrefixes: [], pricingNames: ["Raptor mini"] },
  "mai-code-1.1-flash": { aaSlugPrefixes: [], pricingNames: ["MAI-Code 1.1 Flash"] },
  "mai-code-1-flash-picker": { aaSlugPrefixes: [], pricingNames: ["MAI-Code 1 Flash"] },
  auto: { aaSlugPrefixes: [], pricingNames: [] },
  default: { aaSlugPrefixes: [], pricingNames: [] },
};

export function normalizeModelName(value: string): string {
  return value.toLowerCase().replace(/\([^)]*(?:preview|retired)[^)]*\)/g, "").replace(/[^a-z0-9]+/g, "");
}

export function modelAliasForId(modelId: string): { canonicalId: string; alias: ModelAlias } | null {
  const direct = MODEL_METADATA_ALIASES[modelId];
  if (direct) return { canonicalId: modelId, alias: direct };
  for (const [canonicalId, alias] of Object.entries(MODEL_METADATA_ALIASES)) {
    if (alias.modelIds?.includes(modelId)) return { canonicalId, alias };
  }
  return null;
}

export function canonicalModelId(modelId: string): string {
  return modelAliasForId(modelId)?.canonicalId ?? modelId;
}

export function normalizeAaEffort(name: string): string | null {
  const suffix = name.match(/\(([^)]+)\)\s*$/)?.[1]?.toLowerCase().trim();
  if (!suffix) return "medium";
  if (/non[- ]reasoning|none|minimal/.test(suffix)) return "minimal";
  if (/ultra/.test(suffix)) return "ultra";
  if (/max(?:imum)?/.test(suffix)) return "max";
  if (/x[- ]?high|extra high/.test(suffix)) return "xhigh";
  if (/high|reasoning|adaptive/.test(suffix)) return "high";
  if (/medium|default/.test(suffix)) return "medium";
  if (/low/.test(suffix)) return "low";
  return null;
}

const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

export function chooseAaVariant(
  alias: ModelAlias | undefined,
  aaModels: MetadataSourceModel[],
  validEfforts: string[],
  requireEffortMatch = false
): { row: MetadataSourceModel | null; ignored: string[] } {
  if (!alias || alias.aaSlugPrefixes.length === 0) return { row: null, ignored: [] };
  const candidates = aaModels.filter((row) =>
    alias.aaSlugPrefixes.some((prefix) => {
      if (row.slug === prefix) return true;
      if (!row.slug.startsWith(`${prefix}-`)) return false;
      const suffix = row.slug.slice(prefix.length + 1);
      return /^(?:minimal|low|medium|high|xhigh|max|ultra|adaptive|reasoning|non-reasoning)(?:-|$)/.test(suffix);
    })
  );
  const mapped = candidates
    .map((row) => ({ row, effort: normalizeAaEffort(row.name) }))
    .filter((entry): entry is { row: MetadataSourceModel; effort: string } => entry.effort !== null);
  const ignored = candidates.filter((row) => normalizeAaEffort(row.name) === null).map((row) => row.slug);
  if (mapped.length === 0) return { row: null, ignored };
  const valid = new Set(validEfforts);
  const available = mapped.filter((entry) => valid.size === 0 || valid.has(entry.effort));
  if (requireEffortMatch && valid.size > 0 && available.length === 0) {
    return { row: null, ignored };
  }
  const pool = available.length > 0 ? available : mapped;
  pool.sort(
    (a, b) =>
      EFFORT_ORDER.indexOf(b.effort as (typeof EFFORT_ORDER)[number]) -
      EFFORT_ORDER.indexOf(a.effort as (typeof EFFORT_ORDER)[number])
  );
  return { row: pool[0]!.row, ignored };
}

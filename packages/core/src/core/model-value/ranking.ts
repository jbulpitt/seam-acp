import {
  DEFAULT_MODEL_VALUE_BENCHMARK,
  type AaModel,
  type CopilotModelMetadata,
  type CopilotPricing,
  type ModelValueRanking,
  type ModelValueSnapshotRow,
  type ModelValueTier,
} from "./types.js";

interface ModelAlias {
  aaSlugPrefixes: string[];
  pricingNames: string[];
}

/** The join is deliberately explicit: vendor display-name drift must become a
 * visible unmatched model, never an accidental fuzzy match to another SKU. */
export const COPILOT_MODEL_VALUE_ALIASES: Readonly<Record<string, ModelAlias>> = {
  "claude-sonnet-5": { aaSlugPrefixes: ["claude-sonnet-5"], pricingNames: ["Claude Sonnet 5"] },
  "claude-opus-5": { aaSlugPrefixes: ["claude-opus-5"], pricingNames: ["Claude Opus 5"] },
  "claude-opus-4.8": { aaSlugPrefixes: ["claude-opus-4-8"], pricingNames: ["Claude Opus 4.8"] },
  "claude-opus-4.8-fast": {
    aaSlugPrefixes: ["claude-opus-4-8"],
    pricingNames: ["Claude Opus 4.8 (fast mode)", "Claude Opus 4.8 Fast"],
  },
  "claude-opus-4.7": { aaSlugPrefixes: ["claude-opus-4-7"], pricingNames: ["Claude Opus 4.7"] },
  "claude-sonnet-4.6": {
    aaSlugPrefixes: ["claude-sonnet-4-6"],
    pricingNames: ["Claude Sonnet 4.6"],
  },
  "claude-opus-4.6": { aaSlugPrefixes: ["claude-opus-4-6"], pricingNames: ["Claude Opus 4.6"] },
  "claude-sonnet-4.5": {
    aaSlugPrefixes: ["claude-4-5-sonnet"],
    pricingNames: ["Claude Sonnet 4.5"],
  },
  "claude-opus-4.5": { aaSlugPrefixes: ["claude-opus-4-5"], pricingNames: ["Claude Opus 4.5"] },
  "claude-haiku-4.5": {
    aaSlugPrefixes: ["claude-4-5-haiku", "claude-haiku-4-5"],
    pricingNames: ["Claude Haiku 4.5"],
  },
  "gpt-5.6-sol": { aaSlugPrefixes: ["gpt-5-6-sol"], pricingNames: ["GPT-5.6 Sol"] },
  "gpt-5.6-terra": { aaSlugPrefixes: ["gpt-5-6-terra"], pricingNames: ["GPT-5.6 Terra"] },
  "gpt-5.6-luna": { aaSlugPrefixes: ["gpt-5-6-luna"], pricingNames: ["GPT-5.6 Luna"] },
  "gpt-5.5": { aaSlugPrefixes: ["gpt-5-5"], pricingNames: ["GPT-5.5"] },
  "gpt-5.4": { aaSlugPrefixes: ["gpt-5-4"], pricingNames: ["GPT-5.4"] },
  "gpt-5.4-mini": { aaSlugPrefixes: ["gpt-5-4-mini"], pricingNames: ["GPT-5.4 mini"] },
  "gpt-5.4-nano": { aaSlugPrefixes: ["gpt-5-4-nano"], pricingNames: ["GPT-5.4 nano"] },
  "gpt-5.3-codex": { aaSlugPrefixes: ["gpt-5-3-codex"], pricingNames: ["GPT-5.3-Codex"] },
  "gpt-5-mini": { aaSlugPrefixes: ["gpt-5-mini"], pricingNames: ["GPT-5 mini"] },
  "gemini-3.7-flash": {
    aaSlugPrefixes: ["gemini-3-7-flash"],
    pricingNames: ["Gemini 3.7 Flash"],
  },
  "gemini-3.6-flash": {
    aaSlugPrefixes: ["gemini-3-6-flash"],
    pricingNames: ["Gemini 3.6 Flash"],
  },
  "gemini-3.5-flash": {
    aaSlugPrefixes: ["gemini-3-5-flash"],
    pricingNames: ["Gemini 3.5 Flash"],
  },
  "gemini-3.1-pro-preview": {
    aaSlugPrefixes: ["gemini-3-1-pro-preview"],
    pricingNames: ["Gemini 3.1 Pro"],
  },
  "claude-fable-5": { aaSlugPrefixes: ["claude-fable-5"], pricingNames: ["Claude Fable 5"] },
  "grok-4.5": { aaSlugPrefixes: ["grok-4-5"], pricingNames: ["Grok 4.5"] },
  "grok-4.6": { aaSlugPrefixes: ["grok-4-6"], pricingNames: ["Grok 4.6"] },
  "kimi-k3": { aaSlugPrefixes: ["kimi-k3"], pricingNames: ["Kimi K3"] },
  "kimi-k2.7-code": { aaSlugPrefixes: ["kimi-k2-7-code"], pricingNames: ["Kimi K2.7 Code"] },
  "raptor-mini": { aaSlugPrefixes: [], pricingNames: ["Raptor mini"] },
  "mai-code-1.1-flash": { aaSlugPrefixes: [], pricingNames: ["MAI-Code 1.1 Flash"] },
  "mai-code-1-flash-picker": { aaSlugPrefixes: [], pricingNames: ["MAI-Code 1 Flash"] },
  auto: { aaSlugPrefixes: [], pricingNames: [] },
};

export function normalizeModelName(value: string): string {
  return value.toLowerCase().replace(/\([^)]*(?:preview|retired)[^)]*\)/g, "").replace(/[^a-z0-9]+/g, "");
}

const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

export function normalizeAaEffort(name: string): string | null {
  const suffix = name.match(/\(([^)]+)\)\s*$/)?.[1]?.toLowerCase().trim();
  if (!suffix) return "medium";
  if (/non[- ]reasoning|none|minimal/.test(suffix)) return "minimal";
  if (/max(?:imum)?/.test(suffix)) return "max";
  if (/x[- ]?high|extra high/.test(suffix)) return "xhigh";
  if (/high|reasoning|adaptive/.test(suffix)) return "high";
  if (/medium|default/.test(suffix)) return "medium";
  if (/low/.test(suffix)) return "low";
  if (/ultra/.test(suffix)) return "ultra";
  return null;
}

function chooseAaVariant(
  alias: ModelAlias | undefined,
  aaModels: AaModel[],
  validEfforts: string[]
): { row: AaModel | null; ignored: string[] } {
  if (!alias || alias.aaSlugPrefixes.length === 0) return { row: null, ignored: [] };
  const candidates = aaModels.filter((row) =>
    alias.aaSlugPrefixes.some((prefix) => {
      if (row.slug === prefix) return true;
      if (!row.slug.startsWith(`${prefix}-`)) return false;
      const suffix = row.slug.slice(prefix.length + 1);
      return /^(?:minimal|low|medium|high|xhigh|max|ultra|adaptive|reasoning|non-reasoning)(?:-|$)/.test(
        suffix
      );
    })
  );
  const mapped = candidates
    .map((row) => ({ row, effort: normalizeAaEffort(row.name) }))
    .filter((entry): entry is { row: AaModel; effort: string } => entry.effort !== null);
  const ignored = candidates.filter((row) => normalizeAaEffort(row.name) === null).map((row) => row.slug);
  if (mapped.length === 0) return { row: null, ignored };
  const valid = new Set(validEfforts);
  const available = mapped.filter((entry) => valid.size === 0 || valid.has(entry.effort));
  const pool = available.length > 0 ? available : mapped;
  // This only makes duplicate AA variants deterministic. It does not rank effort
  // or alter token cost; the CLI's effort options remain metadata in the result.
  pool.sort(
    (a, b) =>
      EFFORT_ORDER.indexOf(b.effort as (typeof EFFORT_ORDER)[number]) -
      EFFORT_ORDER.indexOf(a.effort as (typeof EFFORT_ORDER)[number])
  );
  return { row: pool[0]!.row, ignored };
}

function choosePricing(alias: ModelAlias | undefined, pricing: CopilotPricing[]): CopilotPricing | null {
  if (!alias) return null;
  const wanted = new Set(alias.pricingNames.map(normalizeModelName));
  return pricing.find((row) => wanted.has(normalizeModelName(row.modelName))) ?? null;
}

export function creditsPerTask(
  inputTokens: number,
  outputTokens: number,
  inputRate: number,
  outputRate: number
): number {
  return (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000 / 0.01;
}

function tierThresholds(values: number[]): { balanced: number; flagship: number } | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    balanced: sorted[Math.floor((sorted.length - 1) / 3)]!,
    flagship: sorted[Math.floor(((sorted.length - 1) * 2) / 3)]!,
  };
}

function assignTier(value: number | null, thresholds: ReturnType<typeof tierThresholds>): ModelValueTier | null {
  if (value === null || !thresholds) return null;
  if (value >= thresholds.flagship) return "flagship";
  if (value >= thresholds.balanced) return "balanced";
  return "flash";
}

export interface BuildSnapshotResult {
  rows: ModelValueSnapshotRow[];
  unmatchedCopilotModels: string[];
  unmatchedPricingModels: string[];
  unmatchedAaModels: string[];
  ignoredAaVariants: string[];
}

export function buildModelValueSnapshot(input: {
  copilotModels: CopilotModelMetadata[];
  aaModels: AaModel[];
  pricing: CopilotPricing[];
  inputTokens: number;
  outputTokens: number;
  fetchedAt: string;
}): BuildSnapshotResult {
  const intermediate = input.copilotModels.map((model) => {
    const alias = COPILOT_MODEL_VALUE_ALIASES[model.modelId];
    const aa = chooseAaVariant(alias, input.aaModels, model.validEffortTiers);
    return { model, aa, pricing: choosePricing(alias, input.pricing), alias };
  });
  const thresholds = tierThresholds(
    intermediate.flatMap((entry) =>
      entry.aa.row?.intelligenceIndex == null ? [] : [entry.aa.row.intelligenceIndex]
    )
  );
  const matchedAa = new Set(intermediate.flatMap((entry) => (entry.aa.row ? [entry.aa.row.slug] : [])));
  return {
    rows: intermediate.map(({ model, aa, pricing }) => {
      const credits = pricing
        ? creditsPerTask(input.inputTokens, input.outputTokens, pricing.inputRate, pricing.outputRate)
        : null;
      const intelligence = aa.row?.intelligenceIndex ?? null;
      return {
        copilotModel: model.modelId,
        aaSlug: aa.row?.slug ?? null,
        tier: assignTier(intelligence, thresholds),
        intelligenceIndex: intelligence,
        benchmarks: aa.row?.benchmarks ?? {},
        inputRate: pricing?.inputRate ?? null,
        cachedInputRate: pricing?.cachedInputRate ?? null,
        cacheWriteRate: pricing?.cacheWriteRate ?? null,
        outputRate: pricing?.outputRate ?? null,
        creditsPerTask: credits,
        valueScore: intelligence !== null && credits && credits > 0 ? intelligence / credits : null,
        validEffortTiers: model.validEffortTiers,
        priceCategory: model.priceCategory,
        fetchedAt: input.fetchedAt,
      };
    }),
    unmatchedCopilotModels: intermediate.filter((entry) => !entry.alias).map((entry) => entry.model.modelId),
    unmatchedPricingModels: intermediate
      .filter((entry) => entry.model.modelId !== "auto" && !entry.pricing)
      .map((entry) => entry.model.modelId),
    unmatchedAaModels: intermediate
      .filter((entry) => entry.alias && entry.alias.aaSlugPrefixes.length > 0 && !entry.aa.row)
      .map((entry) => entry.model.modelId),
    ignoredAaVariants: intermediate.flatMap((entry) => entry.aa.ignored),
  };
}

export function rankSnapshotRows(
  rows: ModelValueSnapshotRow[],
  benchmark = DEFAULT_MODEL_VALUE_BENCHMARK
): ModelValueRanking[] {
  const benchmarkKey = benchmark === "intelligence_index" ? DEFAULT_MODEL_VALUE_BENCHMARK : benchmark;
  const ranked = rows.map((row) => {
    const value =
      benchmarkKey === DEFAULT_MODEL_VALUE_BENCHMARK
        ? row.intelligenceIndex
        : row.benchmarks[benchmarkKey] ?? null;
    const score = value !== null && row.creditsPerTask && row.creditsPerTask > 0
      ? value / row.creditsPerTask
      : null;
    const result: ModelValueRanking = {
      model: row.copilotModel,
      tier: row.tier,
      value_score: score,
      benchmark: value === null ? null : { name: benchmarkKey, value },
      pricing:
        row.inputRate === null || row.outputRate === null || row.creditsPerTask === null
          ? null
          : {
              input_per_million: row.inputRate,
              cached_input_per_million: row.cachedInputRate,
              cache_write_per_million: row.cacheWriteRate,
              output_per_million: row.outputRate,
              credits_per_standard_task: row.creditsPerTask,
            },
      valid_effort_tiers: row.validEffortTiers,
      price_category: row.priceCategory,
    };
    return result;
  });
  const tierOrder: Record<string, number> = { flagship: 0, balanced: 1, flash: 2 };
  ranked.sort((a, b) => {
    const tierDelta = (tierOrder[a.tier ?? ""] ?? 3) - (tierOrder[b.tier ?? ""] ?? 3);
    if (tierDelta !== 0) return tierDelta;
    if (a.value_score === null && b.value_score !== null) return 1;
    if (a.value_score !== null && b.value_score === null) return -1;
    return (b.value_score ?? 0) - (a.value_score ?? 0) || a.model.localeCompare(b.model);
  });
  return ranked;
}

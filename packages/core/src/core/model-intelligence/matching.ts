import type { MetadataSourceModel } from "../model-metadata/types.js";
import type { CopilotPricing } from "../model-value/types.js";

const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
const EFFORT_RANK = new Map<string, number>(EFFORTS.map((value, index) => [value, index]));

/** Syntax exceptions only: this is intentionally not a release allowlist. */
const SOURCE_SPELLING_OVERRIDES: Readonly<Record<string, readonly string[]>> = {
  "claude-opus-4-1": ["claude-4-1-opus"],
  "claude-sonnet-4-5": ["claude-4-5-sonnet"],
  "claude-haiku-4-5": ["claude-4-5-haiku"],
};

export interface MatchableCatalogModel {
  modelId: string;
  displayName: string;
  aliases?: readonly string[];
  effortChoices?: readonly string[];
  effortDefault?: string;
  effortMechanism?: string;
}

export interface AutomaticMatch<T> {
  status: "matched" | "no-source-record" | "ambiguous" | "unresolved-effort";
  row: T | null;
  selectedEffort: string | null;
  candidates: string[];
  ignored: string[];
}

export function normalizeExternalModelName(value: string): string {
  return value.normalize("NFKC").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

export function normalizeAaEffort(value: string): string | null {
  const parenthesized = [...value.matchAll(/\(([^)]+)\)/g)].at(-1)?.[1]?.trim().toLowerCase();
  const suffix = splitEffort(value).effort;
  const effort = parenthesized ?? suffix;
  return effort && EFFORT_RANK.has(effort) ? effort : null;
}

function identityKeys(model: MatchableCatalogModel, source: "artificial-analysis" | "github-copilot-pricing"): Set<string> {
  const keys = new Set(
    [model.modelId, model.displayName, ...(model.aliases ?? [])]
      .map(normalizeExternalModelName)
      .filter(Boolean)
  );
  if (source === "artificial-analysis") {
    for (const key of [...keys]) {
      for (const override of SOURCE_SPELLING_OVERRIDES[key] ?? []) keys.add(override);
    }
  }
  if (model.effortMechanism === "modelBaked" || (model.effortChoices?.length ?? 0) === 0) {
    const baked = splitEffort(model.modelId);
    if (baked.effort) keys.add(baked.base);
  }
  return keys;
}

function splitEffort(value: string): { base: string; effort: string | null } {
  const normalized = normalizeExternalModelName(value);
  const parts = normalized.split("-");
  const suffix = parts.at(-1) ?? "";
  if (!EFFORT_RANK.has(suffix)) return { base: normalized, effort: null };
  return { base: parts.slice(0, -1).join("-"), effort: suffix };
}

function splitSourceEffort(
  value: string,
  declaredEfforts: ReadonlySet<string>,
): { base: string; effort: string | null; unknownEffort: string | null } {
  const match = value.match(/\(([^)]+)\)\s*$/);
  if (match) {
    const token = normalizeExternalModelName(match[1]!);
    const base = normalizeExternalModelName(value.slice(0, match.index));
    if (EFFORT_RANK.has(token)) return { base, effort: token, unknownEffort: null };
    if (declaredEfforts.has(token)) return { base, effort: null, unknownEffort: token || "unknown" };
  }
  return { ...splitEffort(value), unknownEffort: null };
}

/** Deterministic AA join. Ambiguity is data, never a row-order tie-break. */
export function matchArtificialAnalysis(
  model: MatchableCatalogModel,
  rows: readonly MetadataSourceModel[]
): AutomaticMatch<MetadataSourceModel> {
  const keys = identityKeys(model, "artificial-analysis");
  const supported = new Set((model.effortChoices ?? []).map((value) => value.toLowerCase()));
  const bakedEffort = model.effortMechanism === "modelBaked" || supported.size === 0
    ? splitEffort(model.modelId).effort : null;
  const syntactic = rows.flatMap((row) => {
    const slug = splitSourceEffort(row.slug, supported);
    const name = splitSourceEffort(row.name, supported);
    const baseMatches = keys.has(slug.base) || keys.has(name.base) ||
      keys.has(normalizeExternalModelName(row.slug)) || keys.has(normalizeExternalModelName(row.name));
    return baseMatches ? [{
      row,
      effort: slug.effort ?? name.effort,
      unknownEffort: name.unknownEffort ?? slug.unknownEffort,
    }] : [];
  });
  if (syntactic.length === 0) {
    return { status: "no-source-record", row: null, selectedEffort: null, candidates: [], ignored: [] };
  }
  const eligible = syntactic.filter(({ effort, unknownEffort }) => !unknownEffort && (bakedEffort
    ? effort === bakedEffort
    : (!effort || supported.size === 0 || supported.has(effort))));
  const ignored = syntactic.filter(({ effort, unknownEffort }) => unknownEffort ||
      (effort && supported.size > 0 && !supported.has(effort)))
    .map(({ row }) => row.slug).sort();
  if (eligible.length === 0) {
    return { status: "unresolved-effort", row: null, selectedEffort: null,
      candidates: syntactic.map(({ row }) => row.slug).sort(), ignored };
  }
  const rank = (effort: string | null): number => effort ? EFFORT_RANK.get(effort) ?? -1 : -1;
  const bestRank = Math.max(...eligible.map(({ effort }) => rank(effort)));
  const best = eligible.filter(({ effort }) => rank(effort) === bestRank);
  if (best.length !== 1) {
    return { status: "ambiguous", row: null, selectedEffort: null,
      candidates: eligible.map(({ row }) => row.slug).sort(), ignored };
  }
  return { status: "matched", row: best[0]!.row, selectedEffort: best[0]!.effort,
    candidates: eligible.map(({ row }) => row.slug).sort(), ignored };
}

export function matchCopilotPricing(
  model: MatchableCatalogModel,
  rows: readonly CopilotPricing[],
  tier: "default" | "long-context" = "default"
): AutomaticMatch<CopilotPricing> {
  const keys = identityKeys(model, "github-copilot-pricing");
  const matches = rows.filter((row) => keys.has(normalizeExternalModelName(row.modelName)));
  const defaults = matches.filter((row) => (row.tier ?? "default") === tier);
  if (defaults.length === 0) {
    return { status: "no-source-record", row: null, selectedEffort: null, candidates: [], ignored: [] };
  }
  if (defaults.length !== 1) {
    return { status: "ambiguous", row: null, selectedEffort: null,
      candidates: defaults.map((row) => `${row.modelName}:${row.tier ?? "default"}`).sort(), ignored: [] };
  }
  return { status: "matched", row: defaults[0]!, selectedEffort: null,
    candidates: [`${defaults[0]!.modelName}:${defaults[0]!.tier ?? "default"}`], ignored: [] };
}

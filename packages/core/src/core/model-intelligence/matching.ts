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

interface IdentityKeys {
  all: Set<string>;
  exact: Set<string>;
}

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
  const parenthesized = [...value.matchAll(/\(([^)]+)\)/g)].at(-1)?.[1];
  const suffix = splitEffort(value).effort;
  return (parenthesized ? parseSourceQualifier(parenthesized).effort : null) ?? suffix;
}

function identityKeys(model: MatchableCatalogModel, source: "artificial-analysis" | "github-copilot-pricing"): IdentityKeys {
  const exact = new Set(
    [model.modelId, ...(model.aliases ?? [])]
      .map(normalizeExternalModelName)
      .filter(Boolean)
  );
  const all = new Set([...exact, normalizeExternalModelName(model.displayName)].filter(Boolean));
  if (source === "artificial-analysis") {
    for (const key of [...all]) {
      const overrides = [
        ...(SOURCE_SPELLING_OVERRIDES[key] ?? []),
        // The live catalog calls Claude Opus 4.6's baked reasoning identity
        // `thinking`; AA publishes that exact identity as `adaptive` (#465).
        // Removing this leaves those nine live scoped rows unscored; it does
        // not authorize fuzzy matching for any non-Claude identity.
        ...(key.startsWith("claude-") && key.endsWith("-thinking")
          ? [`${key.slice(0, -"-thinking".length)}-adaptive`]
          : []),
      ];
      for (const override of overrides) {
        all.add(override);
        if (exact.has(key)) exact.add(override);
      }
    }
  }
  if (model.effortMechanism === "modelBaked" || (model.effortChoices?.length ?? 0) === 0) {
    const baked = splitEffort(model.modelId);
    if (baked.effort) {
      all.add(baked.base);
      exact.add(baked.base);
    }
  }
  return { all, exact };
}

function splitEffort(value: string): { base: string; effort: string | null } {
  const normalized = normalizeExternalModelName(value);
  const parts = normalized.split("-");
  const suffix = parts.at(-1) ?? "";
  if (!EFFORT_RANK.has(suffix)) return { base: normalized, effort: null };
  return { base: parts.slice(0, -1).join("-"), effort: suffix };
}

function splitSourceEffort(value: string): { base: string; effort: string | null; unknownEffort: string | null } {
  const match = value.match(/\(([^)]+)\)\s*$/);
  if (match) {
    const base = normalizeExternalModelName(value.slice(0, match.index));
    return { base, ...parseSourceQualifier(match[1]!) };
  }
  return { ...splitEffort(value), unknownEffort: null };
}

function parseSourceQualifier(value: string): { effort: string | null; unknownEffort: string | null } {
  // AA's current Claude rows put reasoning mode, effort, and fallback metadata
  // in one parenthesis. Treating the whole phrase as an effort made all 60
  // live Claude rows unresolved (#465), so parse its comma-delimited facts.
  const unknown: string[] = [];
  let effort: string | null = null;
  for (const segment of value.split(",").map(normalizeExternalModelName).filter(Boolean)) {
    const candidate = segment.endsWith("-effort") ? segment.slice(0, -"-effort".length) : segment;
    if (EFFORT_RANK.has(candidate)) {
      if (effort && effort !== candidate) unknown.push(segment);
      else effort = candidate;
      continue;
    }
    if (/^(?:(?:adaptive|non)-)?reasoning$/.test(segment) || segment === "thinking" || segment.endsWith("-fallback")) {
      continue;
    }
    // A future AA qualifier is evidence, not permission to guess. Keep the
    // affected model unresolved while unrelated models continue to enrich.
    unknown.push(segment);
  }
  return { effort, unknownEffort: unknown.length > 0 ? unknown.join(",") : null };
}

/** Deterministic AA join. Ambiguity is data, never a row-order tie-break. */
export function matchArtificialAnalysis(
  model: MatchableCatalogModel,
  rows: readonly MetadataSourceModel[]
): AutomaticMatch<MetadataSourceModel> {
  const keys = identityKeys(model, "artificial-analysis");
  const supported = new Set((model.effortChoices ?? []).map((value) => value.toLowerCase()));
  const modelBaked = model.effortMechanism === "modelBaked";
  const bakedEffort = modelBaked || supported.size === 0
    ? splitEffort(model.modelId).effort : null;
  const syntactic = rows.flatMap((row) => {
    const slug = splitSourceEffort(row.slug);
    const name = splitSourceEffort(row.name);
    const normalizedSlug = normalizeExternalModelName(row.slug);
    const normalizedName = normalizeExternalModelName(row.name);
    const baseMatches = keys.all.has(slug.base) || keys.all.has(name.base) ||
      keys.all.has(normalizedSlug) || keys.all.has(normalizedName);
    return baseMatches ? [{
      row,
      effort: slug.effort ?? name.effort,
      unknownEffort: name.unknownEffort ?? slug.unknownEffort,
      exactIdentity: keys.exact.has(normalizedSlug) || keys.exact.has(normalizedName),
    }] : [];
  });
  if (syntactic.length === 0) {
    return { status: "no-source-record", row: null, selectedEffort: null, candidates: [], ignored: [] };
  }
  if (modelBaked && !bakedEffort) {
    const exactBaked = syntactic.filter(({ exactIdentity }) => exactIdentity);
    // Model-baked Claude Sonnet 4.6 has three nearby AA rows but its exact slug
    // names the non-reasoning identity; Opus 4.6 thinking has one exact spelling
    // override above. A display-name match cannot choose between modes. Refuse
    // only this model's enrichment if exact identity is absent/ambiguous; the
    // rest of the catalog continues through the normal effort policy.
    const eligible = exactBaked.filter(({ unknownEffort }) => !unknownEffort);
    const ignored = syntactic.filter(({ exactIdentity, unknownEffort }) => !exactIdentity || unknownEffort)
      .map(({ row }) => row.slug).sort();
    if (eligible.length === 0) {
      return { status: "unresolved-effort", row: null, selectedEffort: null,
        candidates: syntactic.map(({ row }) => row.slug).sort(), ignored };
    }
    if (eligible.length !== 1) {
      return { status: "ambiguous", row: null, selectedEffort: null,
        candidates: eligible.map(({ row }) => row.slug).sort(), ignored };
    }
    return { status: "matched", row: eligible[0]!.row, selectedEffort: eligible[0]!.effort,
      candidates: syntactic.map(({ row }) => row.slug).sort(), ignored };
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
  const matches = rows.filter((row) => keys.all.has(normalizeExternalModelName(row.modelName)));
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

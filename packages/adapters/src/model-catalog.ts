import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import {
  assertCatalogSemantics,
  assertCatalogValues,
  assertClosedCatalogShape,
  assertCatalogDescription,
  canonicalJson,
  parseCatalogEvidenceList,
  sortCatalogEvidence,
  substantiveJson,
  type ParsedCatalogEvidence,
} from "./catalog-evidence.js";

export type CatalogEffortMechanism =
  | "meta"
  | "configOption"
  | "spawnArgs"
  | "modelBaked"
  | "none";

export type CatalogApplicationMode = "live" | "reload" | "freshSession";
export type CatalogVisionMode = "native" | "tool" | "none";

/** Version this build WRITES. */
export const MODEL_CATALOG_SCHEMA_VERSION = 1;
/**
 * Oldest version this build can LOAD. Durable last-known-good snapshots are the
 * only thing standing between a deploy and a cold-cache outage, so loading
 * accepts a RANGE and {@link upgradeCatalogCandidate} normalizes older rows
 * forward. Raising the write version without raising this deliberately is what
 * would throw away every stored generation on upgrade.
 */
export const MODEL_CATALOG_MIN_SUPPORTED_SCHEMA_VERSION = 1;

/**
 * Where a per-model fact came from. Deliberately generic: core renders and
 * validates these, and never interprets a provider's model names.
 *
 * - `live-observation` — read from the provider/CLI during this fetch.
 * - `verified-record` — proven out of band earlier and carried forward.
 * - `declared-manifest` — operator/adapter configuration.
 * - `enrichment` — joined from an external metadata source.
 */
/**
 * The per-model provenance record. Its exact-key schema, bounds, content
 * screens, and canonical ordering all live in `catalog-evidence.ts`, which is
 * the ONE portable validator applied before bridge return and again before
 * persistence — so this is a type alias, not a second definition to drift from.
 */
export type CatalogModelEvidence = ParsedCatalogEvidence;
export type CatalogEvidenceKind = CatalogModelEvidence["kind"];
export type CatalogContextEvidence = NonNullable<CatalogModelEvidence["context"]>;
export type CatalogEffortEvidence = NonNullable<CatalogModelEvidence["effort"]>;

export interface CatalogScope {
  /** Stable, non-secret semantic identity. Equal fingerprints may share a generation. */
  fingerprint: string;
  provider: string;
  credentialProfile?: string;
  backend?: string;
  project?: string;
  region?: string;
  policy?: string;
}

export interface CatalogEffortChoice {
  id: string;
  /** Exact adapter/provider value. Omitted only for normalized `default`. */
  raw?: string;
}

export interface CatalogEffort {
  mechanism: CatalogEffortMechanism;
  configId?: string;
  choices: CatalogEffortChoice[];
  selectionDefault: string;
}

/**
 * Exhaustive portable codec row. A future model-baked adapter can map many
 * normalized `{model, effort}` pairs to unusual raw model ids without teaching
 * core any provider naming convention (#228's required forward/reverse hook).
 */
export interface CatalogSelectionBinding {
  model: string;
  effort: string;
  rawModel: string;
  rawEffort?: string;
}

export interface CatalogModel {
  id: string;
  runtimeId: string;
  displayName: string;
  /** Optional human-readable summary of the model. Display only. */
  description?: string;
  /**
   * Structured per-model provenance. A row may carry several records — a live
   * advertisement PLUS a separately verified resolution, say — which is exactly
   * what candidate-wide `source` cannot express for a mixed catalog.
   */
  evidence?: CatalogModelEvidence[];
  aliases: string[];
  default: boolean;
  context: {
    native: number | null;
    maximum: number | null;
    effective: number | null;
  };
  modalities: { input: string[]; output: string[] };
  visionMode: CatalogVisionMode;
  availability: "available" | "unavailable";
  lifecycle: "stable" | "preview" | "deprecated" | "retired";
  serviceTiers: string[];
  effort: CatalogEffort;
  pricingCategory: string | null;
  compatibility: string | null;
  applicationMode: CatalogApplicationMode;
  bindings: CatalogSelectionBinding[];
  /**
   * Optional, human-readable record of HOW this row was established — e.g.
   * `acp-live` vs `verified-overlay (2026-09-02, …)`. A generic carrier only:
   * the adapter owns its wording, core never parses it. Adapters that publish a
   * single uniform source leave it unset.
   */
  provenance?: string;
}

export interface AdapterCatalogCandidate {
  schemaVersion: number;
  scope: CatalogScope;
  models: CatalogModel[];
  source: string;
  sourceVersion?: string;
  adapterVersion: number;
  cliVersion?: string;
  fetchedAt: string;
}

export interface AdapterCatalogSource {
  /** Cache-independent semantic scope used to single-flight even a cold fetch. */
  scope(): CatalogScope;
  /** Fetch/parse/normalize boundary. This is called only by refresh orchestration. */
  fetch(): Promise<AdapterCatalogCandidate>;
  /** Optional provider-specific validation after generic validation. */
  validate?(candidate: AdapterCatalogCandidate): void;
}

export interface NormalizedCatalogSelection {
  model: string;
  effort: string;
}

export interface RawCatalogSelection {
  model: string;
  effort?: string;
}

export function encodeCatalogSelection(
  model: CatalogModel,
  selection: NormalizedCatalogSelection
): RawCatalogSelection {
  const row = model.bindings.find(
    (binding) => binding.model === selection.model && binding.effort === selection.effort
  );
  if (!row) {
    throw new Error(
      `catalog has no raw binding for model ${JSON.stringify(selection.model)} effort ${JSON.stringify(selection.effort)}`
    );
  }
  return { model: row.rawModel, ...(row.rawEffort ? { effort: row.rawEffort } : {}) };
}

export function decodeCatalogSelection(
  models: ReadonlyArray<CatalogModel>,
  raw: RawCatalogSelection
): NormalizedCatalogSelection | null {
  for (const model of models) {
    const row = model.bindings.find(
      (binding) =>
        binding.rawModel === raw.model &&
        (binding.rawEffort ?? undefined) === (raw.effort ?? undefined)
    );
    if (row) return { model: row.model, effort: row.effort };
  }
  return null;
}

/**
 * Normalize a durably stored candidate forward to the current schema version.
 *
 * Today every supported version is 1, so this is a structural identity — but it
 * is the hook a future bump MUST extend instead of widening the accepted
 * version check. Unknown//future fields are carried through untouched: a
 * snapshot written by a newer build that this build can still read must not be
 * corrupted by round-tripping through here.
 *
 * Returns null when the snapshot is too old to understand, which the caller
 * treats as "ignore this row", never as "delete it".
 */
export function upgradeCatalogCandidate(candidate: AdapterCatalogCandidate): AdapterCatalogCandidate | null {
  const version = candidate?.schemaVersion;
  if (!Number.isInteger(version)) return null;
  if (version < MODEL_CATALOG_MIN_SUPPORTED_SCHEMA_VERSION) return null;
  if (version > MODEL_CATALOG_SCHEMA_VERSION) return null;
  return candidate;
}

/**
 * Generic protection against publishing a partial catalog.
 *
 * Two independent rules, no provider knowledge in either:
 *
 * 1. **Small catalogs.** At or below `smallCatalogMaxModels`, ANY removal is
 *    held — including a same-size replacement (`{a,b}` → `{a,c}`). A provider
 *    with two or three models has no margin: losing one is not a "collapse" by
 *    any proportional measure, yet it silently deletes a model the operator
 *    was using, and a same-size swap is indistinguishable from a partial fetch
 *    that substituted a placeholder. This covers 2→1, 3→1/2, and 2→2-by-swap.
 * 2. **Large catalogs.** The pre-existing proportional rule: from
 *    `collapseMinModels` upward, losing more than half is suspicious.
 *
 * Deliberately NOT held: pure additions and metadata-only edits, which remove
 * nothing.
 */
export interface CatalogReductionPolicy {
  smallCatalogMaxModels: number;
  collapseMinModels: number;
}

export const DEFAULT_CATALOG_REDUCTION_POLICY: CatalogReductionPolicy = {
  smallCatalogMaxModels: 3,
  collapseMinModels: 4,
};

export interface CatalogReductionAssessment {
  removed: string[];
  rule: "small-catalog" | "collapse";
  reason: string;
}

export function assessCatalogReduction(
  before: ReadonlyArray<Pick<CatalogModel, "id">>,
  after: ReadonlyArray<Pick<CatalogModel, "id">>,
  policy: CatalogReductionPolicy = DEFAULT_CATALOG_REDUCTION_POLICY
): CatalogReductionAssessment | null {
  if (before.length === 0) return null;
  const next = new Set(after.map((model) => model.id));
  const removed = before.map((model) => model.id).filter((id) => !next.has(id));
  if (removed.length === 0) return null;
  if (before.length <= policy.smallCatalogMaxModels) {
    return {
      removed,
      rule: "small-catalog",
      reason:
        `candidate drops ${removed.length} of ${before.length} published model(s) ` +
        `(${removed.join(", ")}) from a small catalog`,
    };
  }
  if (after.length >= before.length) return null;
  if (before.length >= policy.collapseMinModels && after.length < Math.ceil(before.length / 2)) {
    return {
      removed,
      rule: "collapse",
      reason: `candidate coverage collapsed (${after.length}/${before.length})`,
    };
  }
  return null;
}

/**
 * The ONE portable, provider-neutral screen for per-model description and
 * evidence. Applied at BOTH boundaries — before a remote bridge returns a
 * candidate, and again before core persists or loads one — so a bridge cannot
 * be used to smuggle unbounded or secret-bearing content past validation.
 *
 * Normalizes as it validates: evidence records are re-emitted in canonical
 * semantic order so array order can never become an identity authority.
 * Throws {@link CatalogEvidenceError} on any violation; the caller decides
 * whether that means "refuse the fetch" or "retain the previous generation".
 */
export function validateCatalogEvidence(candidate: AdapterCatalogCandidate): void {
  // Keys, then VALUES, then description/evidence content. Closing only
  // description/evidence left every other level open, so an undeclared key at
  // candidate/scope/model/context crossed the bridge and was persisted inside
  // schema 1; and closing only KEYS still admitted an object where a version
  // string belongs, a fractional context window, or 5,000 aliases.
  //
  // PURE: normalization (sanitized scope, canonical evidence order) belongs to
  // `normalizeCatalogCandidate`, which both boundaries run first.
  assertClosedCatalogShape(candidate);
  assertCatalogValues(candidate);
  assertCatalogSemantics(candidate);
  if (!candidate || !Array.isArray(candidate.models)) return;
  for (const model of candidate.models) {
    const id = typeof model?.id === "string" ? model.id : "(unknown)";
    if (model.description !== undefined) assertCatalogDescription(`${id}.description`, model.description);
    if (model.evidence !== undefined) parseCatalogEvidenceList(`${id}.evidence`, model.evidence);
  }
}

/**
 * Canonical content identity for a candidate. Key-order independent, so a
 * property reordering cannot masquerade as a new generation, and vice versa.
 */
export function catalogContentChecksum(candidate: AdapterCatalogCandidate): string {
  return createHash("sha256").update(canonicalJson({
    schemaVersion: candidate.schemaVersion,
    scope: candidate.scope,
    models: candidate.models,
  })).digest("hex");
}

/**
 * Identity used to decide whether two reduction observations are "the same".
 *
 * Deliberately EXCLUDES volatile observation timestamps (`observedAt`,
 * `fetchedAt`). Two independent observations of the same reduced catalog differ
 * only in when they were taken; including those would give them different
 * fingerprints, so no reduction could ever be confirmed by repetition and the
 * quarantine would be a permanent block rather than a confirmation gate.
 */
export function catalogReductionFingerprint(candidate: AdapterCatalogCandidate): string {
  return createHash("sha256").update(substantiveJson({
    schemaVersion: candidate.schemaVersion,
    scope: candidate.scope,
    models: candidate.models,
  })).digest("hex");
}

/** Stable per-model identity for diffing, independent of key order. */
export function catalogModelFingerprint(model: CatalogModel): string {
  return canonicalJson(model);
}

export function catalogScopeFingerprint(fields: Record<string, string | undefined>): string {
  const canonical = Object.entries(fields)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

export interface ManifestCatalogModel {
  modelId: string;
  runtimeId?: string;
  name: string;
  description?: string;
  evidence?: ReadonlyArray<CatalogModelEvidence>;
  aliases?: ReadonlyArray<string>;
  contextLimit?: number;
  context?: {
    native: number | null;
    maximum: number | null;
    effective: number | null;
  };
  modalities?: { input: ReadonlyArray<string>; output: ReadonlyArray<string> };
  visionMode?: CatalogVisionMode;
  availability?: CatalogModel["availability"];
  lifecycle?: CatalogModel["lifecycle"];
  serviceTiers?: ReadonlyArray<string>;
  pricingCategory?: string | null;
  compatibility?: string | null;
  provenance?: string;
  effort?: {
    mechanism: CatalogEffortMechanism;
    configId?: string;
    choices: ReadonlyArray<string | CatalogEffortChoice>;
    selectionDefault?: string;
  };
}

export function manifestCatalogScope(opts: {
  provider: string;
  backend?: string;
  credentialProfile?: string;
  policy?: string;
  project?: string;
  region?: string;
}): CatalogScope {
  return {
    fingerprint: catalogScopeFingerprint({
      provider: opts.provider,
      backend: opts.backend,
      credentialProfile: opts.credentialProfile,
      policy: opts.policy,
      project: opts.project,
      region: opts.region,
    }),
    provider: opts.provider,
    ...(opts.backend ? { backend: opts.backend } : {}),
    ...(opts.credentialProfile ? { credentialProfile: opts.credentialProfile } : {}),
    ...(opts.policy ? { policy: opts.policy } : {}),
    ...(opts.project ? { project: opts.project } : {}),
    ...(opts.region ? { region: opts.region } : {}),
  };
}

/** Validated manifest strategy used by adapters whose operational list is configured. */
export function manifestCatalogSource(opts: {
  provider: string;
  backend?: string;
  credentialProfile?: string;
  policy?: string;
  project?: string;
  region?: string;
  defaultModel: string;
  models: () => ReadonlyArray<ManifestCatalogModel>;
  effort?: {
    mechanism: CatalogEffortMechanism;
    configId?: string;
    choices: ReadonlyArray<string | CatalogEffortChoice>;
    selectionDefault?: string;
  };
  adapterVersion: number;
  applicationMode?: CatalogApplicationMode;
  source?: string;
}): AdapterCatalogSource {
  const scope = manifestCatalogScope(opts);
  return {
    scope: () => scope,
    async fetch() {
      const rawModels = [...opts.models()];
      const normalized = rawModels.map((raw): CatalogModel => {
        const declared = raw.effort ?? opts.effort;
        const selectionDefault = declared?.selectionDefault ?? "default";
        const choices: CatalogEffortChoice[] = declared?.choices.length
          ? declared.choices.map((choice) => typeof choice === "string"
              ? { id: choice, ...(choice === "default" ? {} : { raw: choice }) }
              : { ...choice })
          : [{ id: "default" }];
        if (!choices.some((choice) => choice.id === selectionDefault)) {
          choices.unshift({
            id: selectionDefault,
            ...(selectionDefault === "default" ? {} : { raw: selectionDefault }),
          });
        }
        const effort: CatalogEffort = {
          mechanism: declared?.mechanism ?? "none",
          ...(declared?.configId ? { configId: declared.configId } : {}),
          choices,
          selectionDefault,
        };
        return {
          id: raw.modelId,
          runtimeId: raw.runtimeId ?? raw.modelId,
          displayName: raw.name,
          ...(raw.description ? { description: raw.description } : {}),
          ...(raw.evidence?.length ? { evidence: raw.evidence.map((entry) => ({ ...entry })) } : {}),
          aliases: [...(raw.aliases ?? [])],
          default: raw.modelId === opts.defaultModel,
          context: raw.context ?? {
            native: raw.contextLimit ?? null,
            maximum: raw.contextLimit ?? null,
            effective: raw.contextLimit ?? null,
          },
          modalities: raw.modalities
            ? { input: [...raw.modalities.input], output: [...raw.modalities.output] }
            : {
                input: raw.visionMode && raw.visionMode !== "none" ? ["text", "image"] : ["text"],
                output: ["text"],
              },
          visionMode: raw.visionMode ?? "none",
          availability: raw.availability ?? "available",
          lifecycle: raw.lifecycle ?? "stable",
          serviceTiers: [...(raw.serviceTiers ?? [])],
          effort,
          pricingCategory: raw.pricingCategory ?? null,
          compatibility: raw.compatibility ?? null,
          ...(raw.provenance ? { provenance: raw.provenance } : {}),
          applicationMode: opts.applicationMode ?? "freshSession",
          bindings: choices.map((choice) => ({
            model: raw.modelId,
            effort: choice.id,
            rawModel: raw.runtimeId ?? raw.modelId,
            ...(choice.raw ? { rawEffort: choice.raw } : {}),
          })),
        };
      });
      // Honest defaults (#236): the configured default must resolve to a row
      // that actually exists, by exact id or by a declared alias. Silently
      // promoting row zero produced a catalog that claimed a default nobody
      // chose — a thread would start on whichever model happened to sort
      // first. Failing candidate construction keeps the previous generation.
      resolveManifestDefault(normalized, opts.defaultModel);
      return {
        schemaVersion: MODEL_CATALOG_SCHEMA_VERSION,
        scope,
        models: normalized,
        source: opts.source ?? "validated-manifest",
        adapterVersion: opts.adapterVersion,
        fetchedAt: new Date().toISOString(),
      };
    },
  };
}

/**
 * Resolve a configured default to exactly one row and mark it, collision-safely.
 *
 * Exact id wins outright. Failing that, a DECLARED alias may resolve it — an
 * adapter that publishes `{ modelId: "canonical", aliases: ["recommended"] }`
 * and configures `recommended` means that row. Two rows claiming the same
 * alias is ambiguous, and guessing which one the operator meant is exactly the
 * class of silent mis-selection this replaced; it fails instead.
 */
export function resolveManifestDefault(
  models: ReadonlyArray<CatalogModel>,
  defaultModel: string
): CatalogModel {
  const wanted = defaultModel.trim();
  const known = models.map((model) => model.id).join(", ") || "none";
  const exact = models.filter((model) => model.id === wanted);
  if (exact.length === 1) {
    for (const model of models) model.default = model === exact[0];
    return exact[0]!;
  }
  const byAlias = models.filter((model) => model.aliases.includes(wanted));
  if (byAlias.length > 1) {
    throw new Error(
      `catalog default ${JSON.stringify(wanted)} is ambiguous: declared as an alias by ` +
        `${byAlias.map((model) => model.id).join(", ")}`
    );
  }
  if (byAlias.length === 1) {
    for (const model of models) model.default = model === byAlias[0];
    return byAlias[0]!;
  }
  throw new Error(
    `catalog default ${JSON.stringify(wanted)} does not resolve to a published model row or declared alias (have: ${known})`
  );
}

/** Bounded adapter helper; Discord input can never choose the executable or args. */
export function execFileBounded(
  executable: string,
  args: ReadonlyArray<string>,
  opts: { timeoutMs?: number; maxBytes?: number; cwd?: string } = {}
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxBytes = opts.maxBytes ?? 1_000_000;
  return new Promise((resolve, reject) => {
    execFile(executable, [...args], { cwd: opts.cwd, timeout: timeoutMs, maxBuffer: maxBytes }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export async function readCliVersion(
  executable: string,
  args: ReadonlyArray<string> = ["--version"]
): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileBounded(executable, args, {
      timeoutMs: 5_000,
      maxBytes: 16_384,
    });
    return (stdout || stderr).trim().split(/\r?\n/, 1)[0]?.slice(0, 256) || undefined;
  } catch {
    return undefined;
  }
}

/** Bounded structured-file helper; paths are adapter-owned, never Discord-owned. */
export async function readJsonFileBounded(path: string, maxBytes = 4_000_000): Promise<unknown> {
  const stat = await fsp.stat(path);
  if (!stat.isFile()) throw new Error("catalog source is not a regular file");
  if (stat.size > maxBytes) throw new Error(`catalog source exceeds ${maxBytes} bytes`);
  return JSON.parse(await fsp.readFile(path, "utf8"));
}

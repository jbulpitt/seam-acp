import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";

export type CatalogEffortMechanism =
  | "meta"
  | "configOption"
  | "spawnArgs"
  | "modelBaked"
  | "none";

export type CatalogApplicationMode = "live" | "reload" | "freshSession";
export type CatalogVisionMode = "native" | "tool" | "none";
export const MODEL_CATALOG_SCHEMA_VERSION = 1;

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
  effort?: {
    mechanism: CatalogEffortMechanism;
    configId?: string;
    choices: ReadonlyArray<string>;
    selectionDefault?: string;
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
    choices: ReadonlyArray<string>;
    selectionDefault?: string;
  };
  adapterVersion: number;
  applicationMode?: CatalogApplicationMode;
  source?: string;
}): AdapterCatalogSource {
  return {
    async fetch() {
      const rawModels = [...opts.models()];
      const normalized = rawModels.map((raw): CatalogModel => {
        const declared = raw.effort ?? opts.effort;
        const selectionDefault = declared?.selectionDefault ?? "default";
        const choices = declared?.choices.length ? [...declared.choices] : ["default"];
        if (!choices.includes(selectionDefault)) choices.unshift(selectionDefault);
        const effort: CatalogEffort = {
          mechanism: declared?.mechanism ?? "none",
          ...(declared?.configId ? { configId: declared.configId } : {}),
          choices: choices.map((id) => ({ id, ...(id === "default" ? {} : { raw: id }) })),
          selectionDefault,
        };
        return {
          id: raw.modelId,
          runtimeId: raw.runtimeId ?? raw.modelId,
          displayName: raw.name,
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
          applicationMode: opts.applicationMode ?? "freshSession",
          bindings: choices.map((choice) => ({
            model: raw.modelId,
            effort: choice,
            rawModel: raw.modelId,
            ...(choice === "default" ? {} : { rawEffort: choice }),
          })),
        };
      });
      // A configured default alias may intentionally not be listed. Give it a
      // concrete row so generic validation and selection stay deterministic.
      if (!normalized.some((model) => model.default) && opts.defaultModel === "default") {
        const fallback = normalized[0];
        if (fallback) fallback.default = true;
      }
      return {
        schemaVersion: MODEL_CATALOG_SCHEMA_VERSION,
        scope: {
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
        },
        models: normalized,
        source: opts.source ?? "validated-manifest",
        adapterVersion: opts.adapterVersion,
        fetchedAt: new Date().toISOString(),
      };
    },
  };
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

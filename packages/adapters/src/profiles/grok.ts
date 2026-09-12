import { spawn } from "node:child_process";
import { createReadStream, lstatSync, readFileSync } from "node:fs";
import { readdir, stat, readFile } from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
} from "@agentclientprotocol/sdk";
import { AGENT_ADAPTER_VERSION, asLocalAdapter, type AgentProfile } from "../agent-profile.js";
import {
  catalogScopeFingerprint,
  manifestCatalogSource,
  type CatalogModelEvidence,
  type CatalogScope,
} from "../model-catalog.js";
import { ProbeError, runBoundedProbe } from "../probe-process.js";
import type { ContextUsage, ISessionManager, SessionSummary } from "../session-manager.js";

/**
 * Known context windows for xAI text models (from docs.x.ai/developers/models).
 * Used to enrich models returned by the /v1/models discovery endpoint, which
 * doesn't include context-window fields.
 */
const KNOWN_CONTEXT_WINDOWS: Record<string, number> = {
  "grok-4.6":                           500_000,
  "grok-4.5":                           500_000,
};

/** Friendly display label: strip date suffixes and capitalize. */
function modelLabel(id: string): string {
  // "grok-build-0.1" → "Grok Build 0.1"
  // "grok-4.3" → "Grok 4.3"
  return id
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** One fetch with a 10s abort timeout. */
async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

type DiscoveredModel = {
  modelId: string;
  name: string;
  contextLimit?: number;
};

export type GrokAuthSource = "subscription" | "api-key" | "unknown";

export interface GrokAuthIdentity {
  source: Exclude<GrokAuthSource, "unknown">;
  /** One-way semantic identity. Raw account/key material is never returned. */
  fingerprint: string;
}

export interface GrokCatalogEffortChoice {
  id: string;
  raw: string;
  default: boolean;
}

export interface GrokCatalogProbeModel {
  modelId: string;
  name: string;
  description: string | null;
  contextLimit: number;
  effortChoices: GrokCatalogEffortChoice[];
  effortDefault: string;
}

export interface GrokCatalogProbe {
  modelState: Pick<GrokCatalogProbeState, "defaultModel" | "models"> | null;
  protocolVersion: string;
  authSource: GrokAuthSource;
  authIdentity: GrokAuthIdentity;
}

export interface GrokCatalogProbeState {
  defaultModel: string;
  models: GrokCatalogProbeModel[];
}

export interface GrokModelsProbe {
  defaultModel: string;
  modelIds: string[];
  authSource: GrokAuthSource;
  authIdentity: GrokAuthIdentity;
}

type GrokModelsOutput = Omit<GrokModelsProbe, "authIdentity">;

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Grok-specific normalization of initialize `_meta.modelState`. */
export function parseGrokModelState(raw: unknown): GrokCatalogProbeState {
  const state = objectRecord(raw);
  if (!state) throw new Error("Grok ACP modelState is malformed");
  const defaultModel = nonEmptyString(state.currentModelId);
  const available = Array.isArray(state.availableModels) ? state.availableModels : null;
  if (!defaultModel || !available?.length) {
    throw new Error("Grok ACP modelState has no current model or available models");
  }

  const seenModels = new Set<string>();
  const models = available.map((entry, index): GrokCatalogProbeModel => {
    const model = objectRecord(entry);
    const modelId = nonEmptyString(model?.modelId);
    if (!modelId || seenModels.has(modelId)) {
      throw new Error(`Grok ACP modelState has a malformed or duplicate model at index ${index}`);
    }
    seenModels.add(modelId);
    const meta = objectRecord(model?._meta);
    const contextLimit = meta?.totalContextTokens;
    if (!Number.isInteger(contextLimit) || (contextLimit as number) <= 0) {
      throw new Error(`Grok ACP modelState has an invalid context limit for ${modelId}`);
    }

    const rawEfforts = Array.isArray(meta?.reasoningEfforts) ? meta.reasoningEfforts : [];
    const supportsEffort = meta?.supportsReasoningEffort === true || rawEfforts.length > 0;
    const effortChoices: GrokCatalogEffortChoice[] = [];
    if (supportsEffort) {
      const seenEfforts = new Set<string>();
      for (const [effortIndex, rawEffort] of rawEfforts.entries()) {
        const effort = objectRecord(rawEffort);
        const id = nonEmptyString(effort?.id) ?? nonEmptyString(effort?.value);
        const value = nonEmptyString(effort?.value) ?? id;
        if (!id || !value || seenEfforts.has(id)) {
          throw new Error(
            `Grok ACP modelState has a malformed or duplicate effort for ${modelId} at index ${effortIndex}`
          );
        }
        seenEfforts.add(id);
        effortChoices.push({
          id,
          raw: value,
          default: effort?.default === true,
        });
      }
      if (!effortChoices.length) {
        throw new Error(`Grok ACP modelState advertises reasoning effort without choices for ${modelId}`);
      }
    }

    const markedDefaults = effortChoices.filter((choice) => choice.default);
    const selectedEffort = nonEmptyString(meta?.reasoningEffort);
    if (markedDefaults.length > 1) {
      throw new Error(`Grok ACP modelState has multiple default efforts for ${modelId}`);
    }
    const effortDefault = markedDefaults[0]?.id ?? selectedEffort ?? "default";
    if (supportsEffort && !effortChoices.some((choice) => choice.id === effortDefault)) {
      throw new Error(`Grok ACP modelState default effort is unavailable for ${modelId}`);
    }

    return {
      modelId,
      name: nonEmptyString(model?.name) ?? modelLabel(modelId),
      description: nonEmptyString(model?.description),
      contextLimit: contextLimit as number,
      effortChoices,
      effortDefault,
    };
  });
  if (!seenModels.has(defaultModel)) {
    throw new Error(`Grok ACP current model ${JSON.stringify(defaultModel)} is not available`);
  }
  return { defaultModel, models };
}

function initializeAuthSource(raw: unknown): GrokAuthSource {
  const response = objectRecord(raw);
  const ids = Array.isArray(response?.authMethods)
    ? response.authMethods.flatMap((entry) => {
        const id = nonEmptyString(objectRecord(entry)?.id);
        return id ? [id] : [];
      })
    : [];
  return ids.some((id) => id === "cached_token" || id === "grok.com")
    ? "subscription"
    : "unknown";
}

function grokHome(env: NodeJS.ProcessEnv): string {
  const configured = nonEmptyString(env.GROK_HOME);
  if (configured) return configured;
  const home = nonEmptyString(env.HOME);
  if (!home) throw new Error("Grok subscription credential home is not configured");
  return path.join(home, ".grok");
}

/**
 * Derive a stable, non-secret account identity from Grok's cached credential
 * metadata. The path locates evidence only; neither it nor raw account fields
 * cross the adapter boundary. Multiple distinct accounts fail closed because
 * the CLI's active choice would otherwise be ambiguous.
 */
export function resolveGrokSubscriptionIdentity(env: NodeJS.ProcessEnv): GrokAuthIdentity {
  const authPath = path.join(grokHome(env), "auth.json");
  let raw: unknown;
  try {
    const stat = lstatSync(authPath);
    if (!stat.isFile() || stat.size > 256_000) {
      throw new Error("credential evidence is not a bounded regular file");
    }
    raw = JSON.parse(readFileSync(authPath, "utf8"));
  } catch {
    // Do not surface the credential path or parser detail; refresh failures can
    // be recorded durably by the catalog service.
    throw new Error("Grok subscription account identity is unavailable");
  }
  const root = objectRecord(raw);
  if (!root) throw new Error("Grok subscription account identity is malformed");
  const identities = new Set<string>();
  for (const [recordKey, value] of Object.entries(root)) {
    const record = objectRecord(value);
    if (!record) continue;
    const issuer = nonEmptyString(record.oidc_issuer) ?? nonEmptyString(recordKey.split("::", 1)[0]);
    const principalId = nonEmptyString(record.principal_id);
    const userId = nonEmptyString(record.user_id);
    const teamId = nonEmptyString(record.team_id);
    if (!issuer || (!principalId && !userId)) continue;
    identities.add(catalogScopeFingerprint({
      issuer,
      principalId: principalId ?? undefined,
      userId: userId ?? undefined,
      teamId: teamId ?? undefined,
    }));
  }
  if (identities.size !== 1) {
    throw new Error(`Grok subscription account identity is ${identities.size ? "ambiguous" : "unavailable"}`);
  }
  return { source: "subscription", fingerprint: [...identities][0]! };
}

function apiKeyIdentity(apiKey: string): GrokAuthIdentity {
  return {
    source: "api-key",
    fingerprint: catalogScopeFingerprint({ provider: "xai", source: "api-key", credential: apiKey }),
  };
}

function sameAuthIdentity(left: GrokAuthIdentity, right: GrokAuthIdentity): boolean {
  return left.source === right.source && left.fingerprint === right.fingerprint;
}

function grokCatalogScope(identity: GrokAuthIdentity): CatalogScope {
  return {
    fingerprint: catalogScopeFingerprint({
      provider: "xai",
      authSource: identity.source,
      accountIdentity: identity.fingerprint,
    }),
    provider: "xai",
    credentialProfile: identity.source === "subscription" ? "subscription-account" : "api-key-account",
  };
}

function abortOn(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Grok ACP initialize cancelled"));
      return;
    }
    signal.addEventListener("abort", () => reject(new Error("Grok ACP initialize cancelled")), { once: true });
  });
}

/**
 * Start the configured Grok ACP server and stop immediately after initialize.
 * No ACP session is created and no prompt/model turn is sent.
 */
export async function probeGrokCatalog(options: {
  cliPath?: string;
  baseArgs?: ReadonlyArray<string>;
  defaultModel: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<GrokCatalogProbe> {
  const cli = options.cliPath?.trim() || "grok";
  const env = options.env ?? process.env;
  const args = grokAgentArgs(options.baseArgs ?? [], options.defaultModel);
  const expectedIdentity = resolveGrokSubscriptionIdentity(env);
  return runBoundedProbe({
    executable: cli,
    args,
    cwd: options.cwd ?? process.cwd(),
    env,
    timeoutMs: options.timeoutMs ?? 30_000,
    ...(options.signal ? { signal: options.signal } : {}),
    label: "Grok ACP initialize",
    async run(handle) {
      const connection = new ClientSideConnection(
        () => ({
          async requestPermission() {
            return { outcome: { outcome: "cancelled" as const } };
          },
          async sessionUpdate() {},
        } satisfies Client),
        ndJsonStream(
          Writable.toWeb(handle.stdin) as unknown as WritableStream<Uint8Array>,
          Readable.toWeb(handle.stdout) as unknown as ReadableStream<Uint8Array>
        )
      );
      // The legacy ACP connection has no public close(); closing its writable
      // transport rejects pending requests before the shared lifecycle reaps.
      handle.onClose(() => { handle.stdin.destroy(); }, "connection");
      const response = await Promise.race([
        connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        }),
        abortOn(handle.signal),
      ]);
      const responseRecord = response as unknown as Record<string, unknown>;
      const meta = objectRecord(responseRecord._meta);
      const authSource = initializeAuthSource(responseRecord);
      if (authSource !== "subscription") {
        throw new Error(`Grok ACP initialize did not corroborate subscription authentication (${authSource})`);
      }
      const observedIdentity = resolveGrokSubscriptionIdentity(env);
      if (!sameAuthIdentity(expectedIdentity, observedIdentity)) {
        throw new Error("Grok subscription account identity changed during ACP initialize");
      }
      return {
        modelState: "modelState" in (meta ?? {}) ? parseGrokModelState(meta?.modelState) : null,
        protocolVersion: String(response.protocolVersion),
        authSource,
        authIdentity: observedIdentity,
      };
    },
  });
}

function execGrokBounded(
  cliPath: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ stdout: string; stderr: string }> {
  const operation = runBoundedProbe({
    executable: cliPath,
    args,
    env,
    cwd,
    timeoutMs,
    ...(signal ? { signal } : {}),
    // One-shot CLI commands get a short cooperative window, then the shared
    // lifecycle escalates to SIGKILL and requires an observed exit.
    killGraceMs: Math.min(250, Math.max(25, Math.floor(timeoutMs / 4))),
    finalizeDeadlineMs: Math.min(250, Math.max(25, Math.floor(timeoutMs / 4))),
    maxStdoutBytes: 256_000,
    maxStderrBytes: 256_000,
    allowCleanExit: true,
    label: "Grok CLI command",
    async run(handle) {
      const chunks: Buffer[] = [];
      const readStdout = (async () => {
        for await (const chunk of handle.stdout) chunks.push(Buffer.from(chunk));
      })();
      await Promise.race([
        Promise.all([readStdout, handle.completed]),
        abortOn(handle.signal),
      ]);
      return { stdout: Buffer.concat(chunks).toString("utf8"), stderr: handle.stderrTail() };
    },
  });
  return operation.catch((error: unknown) => {
    // The catalog service persists Error.message. Preserve only the shared
    // lifecycle code: child stderr, executable, cwd, argv, and env values are
    // deliberately not propagated into returned or durable refresh errors.
    if (error instanceof ProbeError) {
      throw new ProbeError(error.code, "Grok CLI command failed safely");
    }
    throw new ProbeError("protocol_error", "Grok CLI command failed safely");
  });
}

/** Parse the subscription-scoped, human-readable `grok models` output. */
export function parseGrokModelsOutput(raw: string): GrokModelsOutput {
  const output = raw.replace(/\u001b\[[0-9;]*m/g, "");
  const defaultModel = output.match(/^Default model:\s*(\S+)\s*$/im)?.[1]?.trim();
  const modelIds: string[] = [];
  for (const match of output.matchAll(/^\s*[*-]\s+([^\s(]+)(?:\s+\(default\))?\s*$/gim)) {
    const id = match[1]?.trim();
    if (id && !modelIds.includes(id)) modelIds.push(id);
  }
  if (!defaultModel || !modelIds.length || !modelIds.includes(defaultModel)) {
    throw new Error("grok models returned a malformed or empty catalog");
  }
  const authSource: GrokAuthSource = /logged in with grok\.com/i.test(output)
    ? "subscription"
    : /api[- ]?key/i.test(output) ? "api-key" : "unknown";
  return { defaultModel, modelIds, authSource };
}

export async function probeGrokModels(options: {
  cliPath?: string;
  baseArgs?: ReadonlyArray<string>;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  expectedAuthIdentity?: GrokAuthIdentity;
} = {}): Promise<GrokModelsProbe> {
  const cli = options.cliPath?.trim() || "grok";
  const env = options.env ?? process.env;
  const before = resolveGrokSubscriptionIdentity(env);
  if (options.expectedAuthIdentity && !sameAuthIdentity(options.expectedAuthIdentity, before)) {
    throw new Error("Grok subscription account identity changed before grok models fallback");
  }
  const result = await execGrokBounded(
    cli,
    [...(options.baseArgs ?? []), "models"],
    env,
    options.cwd ?? process.cwd(),
    options.timeoutMs ?? 15_000,
    options.signal
  );
  const parsed = parseGrokModelsOutput(result.stdout || result.stderr);
  if (parsed.authSource !== "subscription") {
    throw new Error(`grok models did not corroborate subscription authentication (${parsed.authSource})`);
  }
  const after = resolveGrokSubscriptionIdentity(env);
  if (!sameAuthIdentity(before, after)) {
    throw new Error("Grok subscription account identity changed during grok models fallback");
  }
  return { ...parsed, authIdentity: after };
}

function grokAgentArgs(baseArgs: ReadonlyArray<string>, model?: string, effort?: string): string[] {
  const args = [...baseArgs, "agent"];
  if (model) args.push("--model", model);
  if (effort && effort !== "default") args.push("--reasoning-effort", effort);
  args.push("stdio");
  return args;
}

/**
 * Discover the live model list from xAI's OpenAI-compatible `/v1/models`
 * endpoint (`https://api.x.ai/v1/models`).  Returns only text models (filters
 * out image/video/audio/embedding models).
 *
 * Context windows are looked up from KNOWN_CONTEXT_WINDOWS since the
 * `/v1/models` response doesn't include them.
 *
 * Requires `XAI_API_KEY`. Returns [] on failure. This source is an optional
 * alternative after subscription-authenticated ACP/CLI discovery, never a
 * prerequisite for it.
 */
export async function fetchXaiModels(
  apiKey: string,
  baseUrl = "https://api.x.ai",
): Promise<DiscoveredModel[]> {
  const root = baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
  };

  let body: {
    data?: Array<{
      id?: string;
      object?: string;
      // OpenAI-compat shape — xAI may include extra fields.
      [key: string]: unknown;
    }>;
  };
  try {
    body = await fetchJson(`${root}/v1/models`, { headers });
  } catch {
    return [];
  }

  const out: DiscoveredModel[] = [];
  // Prefixes to skip — these are non-text models.
  const skipPrefixes = [
    "grok-imagine",
    "grok-voice",
    "grok-audio",
    "grok-stt",
    "grok-tts",
    "embedding",
  ];

  for (const m of body.data ?? []) {
    if (typeof m.id !== "string" || m.id.length === 0) continue;
    // Filter out non-text models.
    if (skipPrefixes.some((p) => m.id!.startsWith(p))) continue;

    const contextLimit = KNOWN_CONTEXT_WINDOWS[m.id] ?? undefined;
    out.push({
      modelId: m.id,
      name: modelLabel(m.id),
      ...(contextLimit ? { contextLimit } : {}),
    });
  }
  return out.sort((a, b) => a.modelId.localeCompare(b.modelId));
}

/**
 * xAI Grok Build as an ACP server.  The CLI speaks ACP natively via
 * `grok agent stdio` — no separate adapter package is needed.
 *
 * Setup on the host (one-time):
 *   curl -fsSL https://x.ai/cli/install.sh | bash
 *   grok login              # or set XAI_API_KEY in the environment
 *
 * The `grok agent stdio` command starts a JSON-RPC / ACP server on stdio,
 * identical in shape to claude-agent-acp and codex-acp.  Auth method IDs
 * exposed by `initialize` are `xai.api_key` (uses $XAI_API_KEY) and
 * `cached_token` (from `grok login`).
 *
 * Reasoning effort: `grok agent` accepts `--reasoning-effort` (alias
 * `--effort`). Canonical CLI levels (grok 1.0.5+): none, minimal, low,
 * medium, high, xhigh, max. We pass it as a spawn-time CLI flag.
 */
export function makeGrokProfile(opts: {
  /** Profile id. Defaults to "grok". */
  id?: string;
  /** Display name shown in pickers. Defaults to "Grok Build". */
  displayName?: string;
  /** Path to the `grok` binary. Defaults to looking it up on PATH. */
  cliPath?: string;
  /** Fixed arguments prepended before the Grok subcommand. */
  baseArgs?: ReadonlyArray<string>;
  /** Working directory shared by runtime and catalog subprocesses. */
  cwd?: string;
  /** Default model id for sessions (e.g. "grok-build-0.1"). */
  defaultModel: string;
  staticModels?: ReadonlyArray<{ modelId: string; name: string; contextLimit?: number }>;
  /** Optional API-key `/v1/models` collector for explicit API mode. */
  discoverModels?: () => Promise<ReadonlyArray<{ modelId: string; name: string; contextLimit?: number }>>;
  /** Subscription ACP/CLI by default; API discovery requires an explicit mode. */
  catalogMode?: "subscription" | "api-key";
  /** Required only for explicit API-key catalog/runtime mode. */
  apiKey?: string;
  /** Test/embedding seam; production initializes the configured ACP runtime. */
  catalogProbe?: () => Promise<GrokCatalogProbe>;
  /** Test/embedding seam for the same-account `grok models` fallback. */
  modelsProbe?: () => Promise<GrokModelsProbe>;
  /** Test/embedding seam for CLI provenance. */
  cliVersionProbe?: () => Promise<string | undefined>;
  /** Test/embedding seam for semantic credential identity. */
  authIdentityProbe?: () => GrokAuthIdentity;
  /** Override the effort descriptor. Defaults to spawnArgs + the CLI levels. */
  effort?: AgentProfile["effort"];
  /** Custom environment variables to inject into the spawned process. */
  extraEnv?: Record<string, string | undefined>;
  /** Complete inherited environment; production defaults to process.env. */
  baseEnv?: NodeJS.ProcessEnv;
}): AgentProfile {
  const cli = opts.cliPath?.trim() || "grok";
  const baseArgs = [...(opts.baseArgs ?? [])];
  const runtimeCwd = opts.cwd ?? process.cwd();
  const catalogMode = opts.catalogMode ?? "subscription";
  const apiKey = nonEmptyString(opts.apiKey);
  if (catalogMode === "api-key" && !apiKey) {
    throw new Error("explicit Grok API-key mode requires an API key");
  }
  const catalogEffort = opts.effort ?? {
    mechanism: "spawnArgs" as const,
    levels: ["low", "medium", "high", "xhigh", "max"],
  };
  const profileEnvironment = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...(opts.baseEnv ?? process.env) };
    if (opts.extraEnv) {
      for (const [key, value] of Object.entries(opts.extraEnv)) {
        if (value === undefined) delete env[key];
        else env[key] = value;
      }
    }
    // Source mode is an explicit authority. A legacy ambient/configured key
    // must never silently replace the cached subscription that ACP sessions use.
    if (catalogMode === "subscription") delete env.XAI_API_KEY;
    else env.XAI_API_KEY = apiKey!;
    return env;
  };
  const currentAuthIdentity = (): GrokAuthIdentity => {
    const identity = opts.authIdentityProbe
      ? opts.authIdentityProbe()
      : catalogMode === "api-key"
        ? apiKeyIdentity(apiKey!)
        : resolveGrokSubscriptionIdentity(profileEnvironment());
    if (identity.source !== catalogMode || !/^[a-f0-9]{64}$/.test(identity.fingerprint)) {
      throw new Error("Grok credential identity does not match the configured source mode");
    }
    return identity;
  };

  return asLocalAdapter({
    id: opts.id ?? "grok",
    displayName: opts.displayName ?? "Grok Build",
    defaultModel: opts.defaultModel,
    catalog: {
      scope: () => grokCatalogScope(currentAuthIdentity()),
      async fetch() {
        const expectedIdentity = currentAuthIdentity();
        const scope = grokCatalogScope(expectedIdentity);
        const fetchedAt = new Date().toISOString();
        const cliVersion = opts.cliVersionProbe
          ? await opts.cliVersionProbe()
          : (await execGrokBounded(
              cli,
              [...baseArgs, "--version"],
              profileEnvironment(),
              runtimeCwd,
              5_000
            ).then(({ stdout, stderr }) => (stdout || stderr).trim().split(/\r?\n/, 1)[0]?.slice(0, 256))
              .catch(() => undefined));
        if (!cliVersion) throw new Error("Grok CLI version probe failed");
        let source: string;
        let sourceVersion: string;
        let defaultModel: string;
        let models: Array<{
          modelId: string;
          name: string;
          description?: string;
          contextLimit?: number;
          evidence?: ReadonlyArray<CatalogModelEvidence>;
          effort: {
            mechanism: "spawnArgs" | "none";
            choices: ReadonlyArray<string | { id: string; raw?: string }>;
            selectionDefault: string;
          };
        }>;
        if (catalogMode === "api-key") {
          const discovered = opts.discoverModels
            ? await opts.discoverModels()
            : await fetchXaiModels(apiKey!);
          if (!discovered.length) throw new Error("xAI API catalog discovery returned no text models");
          source = "xai-models-api";
          sourceVersion = "xai-v1/models auth api-key";
          defaultModel = opts.defaultModel;
          models = discovered.map((model) => ({
            ...model,
            evidence: [
              {
                kind: "live-observation",
                source: "xai-models-api",
                runtimeVersion: cliVersion,
                adapterVersion: AGENT_ADAPTER_VERSION,
                scopeRef: scope.fingerprint,
                resolvedModel: model.modelId,
              },
              ...(model.contextLimit ? [{
                kind: "verified-record" as const,
                source: "grok-context-metadata",
                adapterVersion: AGENT_ADAPTER_VERSION,
                scopeRef: scope.fingerprint,
                resolvedModel: model.modelId,
                context: {
                  native: model.contextLimit,
                  maximum: model.contextLimit,
                  effective: model.contextLimit,
                  method: "exact model id",
                },
              }] : []),
            ],
            effort: {
              mechanism: catalogEffort.mechanism === "spawnArgs" ? "spawnArgs" : "none",
              choices: catalogEffort.levels.length ? catalogEffort.levels : ["default"],
              selectionDefault: "default",
            },
          }));
        } else {
          const initialized = opts.catalogProbe
            ? await opts.catalogProbe()
            : await probeGrokCatalog({
                cliPath: cli,
                baseArgs,
                defaultModel: opts.defaultModel,
                cwd: runtimeCwd,
                env: profileEnvironment(),
              });
          if (!sameAuthIdentity(expectedIdentity, initialized.authIdentity)) {
            throw new Error("Grok ACP catalog authentication does not match the configured subscription account");
          }
          if (initialized.authSource !== "subscription") {
            throw new Error(`Grok ACP catalog did not use subscription authentication (${initialized.authSource})`);
          }
          if (initialized.modelState) {
            const acp = initialized.modelState;
            source = "grok-acp-model-state";
            sourceVersion = `acp/${initialized.protocolVersion} auth subscription`;
            defaultModel = acp.defaultModel;
            models = acp.models.map((model) => ({
              modelId: model.modelId,
              name: model.name,
              ...(model.description ? { description: model.description } : {}),
              contextLimit: model.contextLimit,
              evidence: [{
                kind: "live-observation",
                source: "grok-acp-model-state",
                runtimeVersion: cliVersion,
                adapterVersion: AGENT_ADAPTER_VERSION,
                scopeRef: scope.fingerprint,
                resolvedModel: model.modelId,
                context: {
                  native: model.contextLimit,
                  maximum: model.contextLimit,
                  effective: model.contextLimit,
                  method: "ACP initialize modelState",
                },
                ...(model.effortChoices.length ? { effort: {
                  choices: model.effortChoices.map((choice) => choice.id),
                  selectionDefault: model.effortDefault,
                  method: "ACP initialize modelState",
                } } : {}),
              }],
              effort: model.effortChoices.length
                ? {
                    mechanism: "spawnArgs",
                    choices: model.effortChoices.map((choice) => ({ id: choice.id, raw: choice.raw })),
                    selectionDefault: model.effortDefault,
                  }
                : { mechanism: "none", choices: ["default"], selectionDefault: "default" },
            }));
          } else {
            const command = opts.modelsProbe
              ? await opts.modelsProbe()
              : await probeGrokModels({
                  cliPath: cli,
                  baseArgs,
                  cwd: runtimeCwd,
                  env: profileEnvironment(),
                  expectedAuthIdentity: initialized.authIdentity,
                });
            if (command.authSource !== "subscription" ||
                !sameAuthIdentity(initialized.authIdentity, command.authIdentity)) {
              throw new Error("grok models fallback did not use the same subscription account as ACP initialize");
            }
            const configured = new Map((opts.staticModels ?? []).map((model) => [model.modelId, model]));
            source = "grok-models-cli";
            sourceVersion = "grok-models auth subscription";
            defaultModel = command.defaultModel;
            models = command.modelIds.map((modelId) => {
              const known = configured.get(modelId);
              const contextLimit = known?.contextLimit ?? KNOWN_CONTEXT_WINDOWS[modelId];
              return {
                modelId,
                name: known?.name ?? modelLabel(modelId),
                ...(contextLimit ? { contextLimit } : {}),
                evidence: [
                  {
                    kind: "live-observation",
                    source: "grok-models-cli",
                    runtimeVersion: cliVersion,
                    adapterVersion: AGENT_ADAPTER_VERSION,
                    scopeRef: scope.fingerprint,
                    resolvedModel: modelId,
                  },
                  ...(contextLimit ? [{
                    kind: known?.contextLimit ? "declared-manifest" as const : "verified-record" as const,
                    source: known?.contextLimit ? "grok-configured-model" : "grok-context-metadata",
                    adapterVersion: AGENT_ADAPTER_VERSION,
                    scopeRef: scope.fingerprint,
                    resolvedModel: modelId,
                    context: {
                      native: contextLimit,
                      maximum: contextLimit,
                      effective: contextLimit,
                      method: "exact model id",
                    },
                  }] : []),
                  {
                    kind: "declared-manifest",
                    source: "grok-runtime-config",
                    adapterVersion: AGENT_ADAPTER_VERSION,
                    scopeRef: scope.fingerprint,
                    resolvedModel: modelId,
                    effort: {
                      choices: catalogEffort.levels.length
                        ? ["default", ...catalogEffort.levels.filter((level) => level !== "default")]
                        : ["default"],
                      selectionDefault: "default",
                      method: "configured spawn arguments",
                    },
                  },
                ],
                effort: {
                  mechanism: catalogEffort.mechanism === "spawnArgs" ? "spawnArgs" : "none",
                  choices: catalogEffort.levels.length ? catalogEffort.levels : ["default"],
                  selectionDefault: "default",
                },
              };
            });
          }
        }
        const candidate = await manifestCatalogSource({
          provider: "xai",
          credentialProfile: scope.credentialProfile,
          defaultModel,
          models: () => models,
          adapterVersion: AGENT_ADAPTER_VERSION,
          applicationMode: "freshSession",
          source,
        }).fetch();
        candidate.scope = scope;
        candidate.fetchedAt = fetchedAt;
        candidate.cliVersion = cliVersion;
        candidate.sourceVersion = sourceVersion;
        return candidate;
      },
    },
    // Reasoning effort: CLI flag at spawn (`--reasoning-effort`). Without
    // mechanism "spawnArgs", SessionRouter treats grok as having no effort
    // and silently ignores channel/thread preset pins.
    effort: catalogEffort,
    spawn(modelOverride?: string, effortOverride?: string) {
      const model = modelOverride ?? opts.defaultModel;
      return spawn(cli, grokAgentArgs(baseArgs, model, effortOverride), {
        cwd: runtimeCwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: profileEnvironment(),
        detached: true,
      });
    },
    sessionManager: new GrokSessionManager(),
  });
}

/** Custom ACP method the TUI `/usage` panel uses (leading underscore is load-bearing). */
export const GROK_BILLING_METHOD = "_x.ai/billing";

export interface GrokUsageData {
  subscriptionTier: string | null;
  /** 0–100 weekly (or current-period) allowance used. */
  creditUsagePercent: number | null;
  periodType: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  isUnifiedBillingUser: boolean;
}

/**
 * Normalize the `_x.ai/billing` payload. The TUI "Usage limit" tab is
 * `creditUsagePercent` + `subscription_tier` + the weekly period — not
 * `_x.ai/session/usage` (that's per-session token counts).
 */
export function parseGrokBilling(raw: unknown): GrokUsageData {
  const root = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const config =
    root.config && typeof root.config === "object"
      ? (root.config as Record<string, unknown>)
      : {};
  const period =
    config.currentPeriod && typeof config.currentPeriod === "object"
      ? (config.currentPeriod as Record<string, unknown>)
      : {};
  const periodTypeRaw = typeof period.type === "string" ? period.type : null;
  const periodType = periodTypeRaw
    ? periodTypeRaw.replace(/^USAGE_PERIOD_TYPE_/i, "").toLowerCase()
    : null;
  const pct = config.creditUsagePercent;
  return {
    subscriptionTier:
      typeof root.subscription_tier === "string" ? root.subscription_tier : null,
    creditUsagePercent: typeof pct === "number" && Number.isFinite(pct) ? pct : null,
    periodType,
    periodStart:
      (typeof period.start === "string" && period.start) ||
      (typeof config.billingPeriodStart === "string" && config.billingPeriodStart) ||
      null,
    periodEnd:
      (typeof period.end === "string" && period.end) ||
      (typeof config.billingPeriodEnd === "string" && config.billingPeriodEnd) ||
      null,
    isUnifiedBillingUser: config.isUnifiedBillingUser === true,
  };
}

/**
 * Ask a live grok ACP connection for the SuperGrok weekly allowance.
 * `request` is `AgentRuntime.request` / `ClientSideConnection.request`.
 *
 * The signal is checked BEFORE the request and not after (#349). This path
 * borrows a connection that belongs to a live Grok session, so there is
 * nothing here we may cancel: the only lever would be tearing down that
 * connection, which would refuse Grok as an agent to answer a question about
 * Grok's quota. Refusing to START a request we have already been told to
 * abandon is the whole of what is available, and it is honest — unlike the
 * cold path below, no process is left running by declining to do more.
 */
export async function fetchGrokUsageFromConnection(
  request: (method: string, params?: unknown) => Promise<unknown>,
  signal?: AbortSignal
): Promise<GrokUsageData> {
  signal?.throwIfAborted();
  const raw = await request(GROK_BILLING_METHOD, {});
  return parseGrokBilling(raw);
}

/**
 * Spawn a throwaway `grok agent stdio`, initialize (no session/new), call
 * `_x.ai/billing`, and kill the process. Use when no grok runtime is warm.
 *
 * #349: `signal` cancels the WORK, not merely the wait.
 *
 * This path's own bounds are 30s to initialize plus 20s to bill — up to 50s,
 * against the quota poller's 30s per-source deadline (#344). Without the
 * signal the poller's refusal stopped the caller and left a spawned `grok
 * agent stdio` running for up to another 20s, still holding stdio and still
 * about to answer a question nobody would read. An accepted-but-unconsumed
 * signal is worse than no timeout: the caller believes it has a bound it does
 * not have.
 *
 * What an abort refuses: this one Grok quota reading, which degrades to "we
 * cannot currently tell you Grok's quota" and leaves the registry's
 * last-known-good value in place. What keeps working: every other agent's
 * quota source, each of which has its own controller and is unaffected; and
 * Grok itself as an agent, because the only process torn down here is this
 * throwaway probe — live Grok sessions have their own runtimes and are never
 * touched by this path.
 */
export async function fetchGrokUsage(
  cliPath?: string,
  signal?: AbortSignal
): Promise<GrokUsageData> {
  // Do not spawn at all for a refresh that has already been abandoned; the
  // cheapest cancellation is the one that never starts a process.
  signal?.throwIfAborted();
  const cli = cliPath?.trim() || "grok";
  const child = spawn(cli, ["agent", "stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
    detached: true,
  });

  let buf = "";
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  const onData = (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: {
        id?: number;
        method?: string;
        result?: unknown;
        error?: { code?: number; message?: string };
      };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        continue;
      }
      if (msg.id != null && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) {
          p.reject(
            new Error(msg.error.message || `rpc error ${msg.error.code ?? ""}`.trim())
          );
        } else {
          p.resolve(msg.result);
        }
      } else if (msg.method && msg.id != null && child.stdin.writable) {
        child.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32601, message: "not implemented" },
          }) + "\n"
        );
      }
    }
  };
  child.stdout.on("data", onData);

  const call = (method: string, params: unknown, timeoutMs: number) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`grok ${method} timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      if (!child.stdin.writable) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error("grok stdin closed"));
        return;
      }
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
      );
    });

  const exit = new Promise<never>((_, reject) => {
    child.once("error", (err) => reject(new Error(`grok spawn failed: ${err.message}`)));
    child.once("exit", (code, childSignal) => {
      reject(new Error(`grok exited before billing (code=${code}, signal=${childSignal})`));
    });
  });

  // Racing this alongside `exit` is what turns an abort into a real
  // cancellation: it rejects whichever call is outstanding, which unwinds to
  // the `finally` below and kills the child. Rejecting the pending map too
  // means nothing is left waiting on a process that is about to disappear.
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    if (!signal) return;
    onAbort = () => {
      const error = signal.reason instanceof Error
        ? signal.reason
        : new Error("grok quota request aborted");
      for (const [id, waiter] of [...pending]) {
        pending.delete(id);
        waiter.reject(error);
      }
      reject(error);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    await Promise.race([
      call(
        "initialize",
        {
          protocolVersion: 1,
          clientInfo: { name: "seam-acp", version: "0" },
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        },
        30_000
      ),
      exit,
      aborted,
    ]);
    const raw = await Promise.race([
      call(GROK_BILLING_METHOD, {}, 20_000),
      exit,
      aborted,
    ]);
    return parseGrokBilling(raw);
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    child.stdout.off("data", onData);
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------
// Grok session manager — minimal implementation for context-window display.
// Reads chat_history.jsonl from ~/.grok/sessions/<encodedCwd>/<sessionId>/
// and estimates token usage by character count (~4 chars/token).
// ---------------------------------------------------------------------------

/** URL-encode a cwd path the same way grok does for its session directories. */
function encodeCwd(cwd: string): string {
  return encodeURIComponent(cwd).replace(/%2F/gi, "%2F");
}

class GrokSessionManager implements ISessionManager {
  private grokHome(): string {
    return process.env.GROK_HOME ?? path.join(process.env.HOME ?? "", ".grok");
  }

  private sessionsDir(cwd: string): string {
    // Strip trailing slash — Grok encodes cwd without it.
    const normalized = cwd.replace(/\/+$/, "");
    return path.join(this.grokHome(), "sessions", encodeCwd(normalized));
  }

  async listSessions(cwd: string): Promise<SessionSummary[]> {
    const dir = this.sessionsDir(cwd);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }
    const summaries: SessionSummary[] = [];
    for (const entry of entries) {
      // Session dirs are UUIDs; skip non-dir entries like prompt_history.jsonl.
      if (!entry.match(/^[0-9a-f]{8}-/)) continue;
      const sessionDir = path.join(dir, entry);
      try {
        const summaryPath = path.join(sessionDir, "summary.json");
        const raw = await readFile(summaryPath, "utf-8");
        const data = JSON.parse(raw);
        summaries.push({
          sessionId: entry,
          createdAt: data.created_at ? new Date(data.created_at).getTime() : undefined,
          lastActivityAt: data.updated_at ? new Date(data.updated_at).getTime() : undefined,
          previewLines: [{ sender: "agent", text: data.session_summary ?? "" }],
        });
      } catch {
        // Damaged or incomplete session — skip.
      }
    }
    return summaries.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  }

  async cloneSession(_cwd: string, _oldId: string, _newId: string): Promise<void> {
    // Not implemented for Grok.
  }

  async deleteSession(_cwd: string, _sessionId: string): Promise<void> {
    // Not implemented for Grok.
  }

  async getTranscript(cwd: string, sessionId: string): Promise<string> {
    const chatPath = path.join(this.sessionsDir(cwd), sessionId, "chat_history.jsonl");
    const lines: string[] = [];
    try {
      const rl = readline.createInterface({ input: createReadStream(chatPath) });
      for await (const line of rl) {
        try {
          const d = JSON.parse(line);
          if (d.type === "user" || d.type === "assistant") {
            const sender = d.type === "user" ? "Human" : "Assistant";
            const text = typeof d.content === "string" ? d.content : "";
            lines.push(`${sender}: ${text.slice(0, 500)}`);
          }
        } catch { /* skip bad lines */ }
      }
    } catch { /* file missing */ }
    return lines.join("\n\n");
  }

  async getUsage(cwd: string, sessionId?: string): Promise<ContextUsage> {
    const dir = this.sessionsDir(cwd);
    let targetId = sessionId;

    if (!targetId) {
      // Find the most recently modified session.
      try {
        const entries = await readdir(dir);
        let latest = { id: "", mtime: 0 };
        for (const entry of entries) {
          if (!entry.match(/^[0-9a-f]{8}-/)) continue;
          const s = await stat(path.join(dir, entry)).catch(() => null);
          if (s && s.mtimeMs > latest.mtime) {
            latest = { id: entry, mtime: s.mtimeMs };
          }
        }
        targetId = latest.id || undefined;
      } catch {
        return { model: null, totalUsed: 0, contextLimit: 0 };
      }
    }
    if (!targetId) return { model: null, totalUsed: 0, contextLimit: 0 };

    // Read summary.json for model.
    let model: string | null = null;
    try {
      const raw = await readFile(path.join(dir, targetId, "summary.json"), "utf-8");
      const data = JSON.parse(raw);
      model = data.current_model_id ?? null;
    } catch { /* ok */ }

    // Estimate tokens from chat_history.jsonl character count.
    const chatPath = path.join(dir, targetId, "chat_history.jsonl");
    let totalChars = 0;
    try {
      const rl = readline.createInterface({ input: createReadStream(chatPath) });
      for await (const line of rl) {
        try {
          const d = JSON.parse(line);
          const content = d.content;
          if (typeof content === "string") {
            totalChars += content.length;
          } else if (Array.isArray(content)) {
            for (const block of content) {
              if (block && typeof block === "object" && typeof block.text === "string") {
                totalChars += block.text.length;
              }
            }
          }
        } catch { /* skip bad lines */ }
      }
    } catch { /* file missing */ }

    // Rough estimate: ~4 chars per token.
    const estimatedTokens = Math.round(totalChars / 4);
    const contextLimit = model ? (KNOWN_CONTEXT_WINDOWS[model] ?? 256_000) : 256_000;

    return { model, totalUsed: estimatedTokens, contextLimit };
  }
}

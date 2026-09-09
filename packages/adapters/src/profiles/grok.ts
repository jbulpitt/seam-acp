import { execFile, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
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
import { manifestCatalogScope, manifestCatalogSource } from "../model-catalog.js";
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
  defaultModel: string;
  models: GrokCatalogProbeModel[];
  protocolVersion: string;
  authSource: GrokAuthSource;
}

export interface GrokModelsProbe {
  defaultModel: string;
  modelIds: string[];
  authSource: GrokAuthSource;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Grok-specific normalization of initialize `_meta.modelState`. */
export function parseGrokModelState(raw: unknown): Pick<GrokCatalogProbe, "defaultModel" | "models"> {
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

function configuredAuthSource(env: NodeJS.ProcessEnv): GrokAuthSource {
  return nonEmptyString(env.XAI_API_KEY) ? "api-key" : "subscription";
}

function initializeAuthSource(raw: unknown, env: NodeJS.ProcessEnv): GrokAuthSource {
  if (nonEmptyString(env.XAI_API_KEY)) return "api-key";
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
}): Promise<GrokCatalogProbe | null> {
  const cli = options.cliPath?.trim() || "grok";
  const env = options.env ?? process.env;
  const args = grokAgentArgs(options.baseArgs ?? [], options.defaultModel);
  const child = spawn(cli, args, {
    cwd: options.cwd ?? process.cwd(),
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
  let rejectDied: (error: Error) => void = () => undefined;
  const died = new Promise<never>((_resolve, reject) => { rejectDied = reject; });
  const onError = (error: Error) => rejectDied(error);
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => rejectDied(
    new Error(`Grok ACP exited before initialize (code=${code}, signal=${signal}): ${stderr.trim()}`)
  );
  child.once("error", onError);
  child.once("exit", onExit);
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error("Grok ACP initialize timed out")),
      options.timeoutMs ?? 30_000
    );
    timeout.unref?.();
  });
  const connection = new ClientSideConnection(
    () => ({
      async requestPermission() {
        return { outcome: { outcome: "cancelled" as const } };
      },
      async sessionUpdate() {},
    } satisfies Client),
    ndJsonStream(
      Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
    )
  );
  try {
    const response = await Promise.race([
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      }),
      died,
      timedOut,
    ]);
    const responseRecord = response as unknown as Record<string, unknown>;
    const meta = objectRecord(responseRecord._meta);
    if (!("modelState" in (meta ?? {}))) return null;
    const parsed = parseGrokModelState(meta?.modelState);
    return {
      ...parsed,
      protocolVersion: String(response.protocolVersion),
      authSource: initializeAuthSource(responseRecord, env),
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    child.off("error", onError);
    child.off("exit", onExit);
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      if (child.kill("SIGKILL")) {
        let cleanupTimer: NodeJS.Timeout | undefined;
        const cleanupDeadline = new Promise<void>((resolve) => {
          cleanupTimer = setTimeout(resolve, 1_000);
          cleanupTimer.unref?.();
        });
        await Promise.race([exited, cleanupDeadline]);
        if (cleanupTimer) clearTimeout(cleanupTimer);
      }
    }
    child.removeAllListeners();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
}

function execGrokBounded(
  cliPath: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cliPath, [...args], {
      env,
      cwd,
      timeout: timeoutMs,
      maxBuffer: 256_000,
    }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** Parse the subscription-scoped, human-readable `grok models` output. */
export function parseGrokModelsOutput(raw: string): GrokModelsProbe {
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
} = {}): Promise<GrokModelsProbe> {
  const cli = options.cliPath?.trim() || "grok";
  const result = await execGrokBounded(
    cli,
    [...(options.baseArgs ?? []), "models"],
    options.env ?? process.env,
    options.cwd ?? process.cwd(),
    options.timeoutMs ?? 15_000
  );
  return parseGrokModelsOutput(result.stdout || result.stderr);
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
  /** Test/embedding seam; production initializes the configured ACP runtime. */
  catalogProbe?: () => Promise<GrokCatalogProbe | null>;
  /** Test/embedding seam for the same-account `grok models` fallback. */
  modelsProbe?: () => Promise<GrokModelsProbe>;
  /** Test/embedding seam for CLI provenance. */
  cliVersionProbe?: () => Promise<string | undefined>;
  /** Override the effort descriptor. Defaults to spawnArgs + the CLI levels. */
  effort?: AgentProfile["effort"];
  /** Custom environment variables to inject into the spawned process. */
  extraEnv?: Record<string, string | undefined>;
}): AgentProfile {
  const cli = opts.cliPath?.trim() || "grok";
  const baseArgs = [...(opts.baseArgs ?? [])];
  const runtimeCwd = opts.cwd ?? process.cwd();
  const catalogMode = opts.catalogMode ?? "subscription";
  const catalogEffort = opts.effort ?? {
    mechanism: "spawnArgs" as const,
    levels: ["low", "medium", "high", "xhigh", "max"],
  };
  const profileEnvironment = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (opts.extraEnv) {
      for (const [key, value] of Object.entries(opts.extraEnv)) {
        if (value === undefined) delete env[key];
        else env[key] = value;
      }
    }
    return env;
  };
  const env = profileEnvironment();
  const authProfile = configuredAuthSource(env);
  const grokHome = nonEmptyString(env.GROK_HOME)
    ?? (nonEmptyString(env.HOME) ? path.join(env.HOME!, ".grok") : "default");
  const scopeOptions = {
    provider: "xai",
    credentialProfile: `${authProfile}:${grokHome}`,
  };

  return asLocalAdapter({
    id: opts.id ?? "grok",
    displayName: opts.displayName ?? "Grok Build",
    defaultModel: opts.defaultModel,
    catalog: {
      scope: () => manifestCatalogScope(scopeOptions),
      async fetch() {
        let source: string;
        let sourceVersion: string;
        let defaultModel: string;
        let models: Array<{
          modelId: string;
          name: string;
          contextLimit?: number;
          effort: {
            mechanism: "spawnArgs" | "none";
            choices: ReadonlyArray<string | { id: string; raw?: string }>;
            selectionDefault: string;
          };
        }>;
        if (catalogMode === "api-key") {
          if (!nonEmptyString(profileEnvironment().XAI_API_KEY)) {
            throw new Error("explicit Grok API catalog mode requires XAI_API_KEY");
          }
          if (!opts.discoverModels) {
            throw new Error("explicit Grok API catalog mode requires an API discovery source");
          }
          const discovered = await opts.discoverModels();
          if (!discovered.length) throw new Error("xAI API catalog discovery returned no text models");
          source = "xai-models-api";
          sourceVersion = "xai-v1/models; auth=api-key";
          defaultModel = discovered.some((model) => model.modelId === opts.defaultModel)
            ? opts.defaultModel
            : discovered[0]!.modelId;
          models = discovered.map((model) => ({
            ...model,
            effort: {
              mechanism: catalogEffort.mechanism === "spawnArgs" ? "spawnArgs" : "none",
              choices: catalogEffort.levels.length ? catalogEffort.levels : ["default"],
              selectionDefault: "default",
            },
          }));
        } else {
          const acp = opts.catalogProbe
            ? await opts.catalogProbe()
            : await probeGrokCatalog({
                cliPath: cli,
                baseArgs,
                defaultModel: opts.defaultModel,
                cwd: runtimeCwd,
                env: profileEnvironment(),
              });
          if (acp) {
            source = "grok-acp-model-state";
            sourceVersion = `acp/${acp.protocolVersion}; auth=${acp.authSource}`;
            defaultModel = acp.defaultModel;
            models = acp.models.map((model) => ({
              modelId: model.modelId,
              name: model.name,
              contextLimit: model.contextLimit,
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
                });
            const configured = new Map((opts.staticModels ?? []).map((model) => [model.modelId, model]));
            source = "grok-models-cli";
            sourceVersion = `grok-models; auth=${command.authSource}`;
            defaultModel = command.defaultModel;
            models = command.modelIds.map((modelId) => {
              const known = configured.get(modelId);
              return {
                modelId,
                name: known?.name ?? modelLabel(modelId),
                ...(known?.contextLimit ?? KNOWN_CONTEXT_WINDOWS[modelId]
                  ? { contextLimit: known?.contextLimit ?? KNOWN_CONTEXT_WINDOWS[modelId] }
                  : {}),
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
          ...scopeOptions,
          defaultModel,
          models: () => models,
          adapterVersion: AGENT_ADAPTER_VERSION,
          applicationMode: "freshSession",
          source,
        }).fetch();
        candidate.cliVersion = opts.cliVersionProbe
          ? await opts.cliVersionProbe()
          : (await execGrokBounded(
              cli,
              [...baseArgs, "--version"],
              profileEnvironment(),
              runtimeCwd,
              5_000
            ).then(({ stdout, stderr }) => (stdout || stderr).trim().split(/\r?\n/, 1)[0]?.slice(0, 256))
              .catch(() => undefined));
        if (!candidate.cliVersion) throw new Error("Grok CLI version probe failed");
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
 */
export async function fetchGrokUsageFromConnection(
  request: (method: string, params?: unknown) => Promise<unknown>
): Promise<GrokUsageData> {
  const raw = await request(GROK_BILLING_METHOD, {});
  return parseGrokBilling(raw);
}

/**
 * Spawn a throwaway `grok agent stdio`, initialize (no session/new), call
 * `_x.ai/billing`, and kill the process. Use when no grok runtime is warm.
 */
export async function fetchGrokUsage(cliPath?: string): Promise<GrokUsageData> {
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
    child.once("exit", (code, signal) => {
      reject(new Error(`grok exited before billing (code=${code}, signal=${signal})`));
    });
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
    ]);
    const raw = await Promise.race([
      call(GROK_BILLING_METHOD, {}, 20_000),
      exit,
    ]);
    return parseGrokBilling(raw);
  } finally {
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

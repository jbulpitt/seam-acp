import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { AGENT_ADAPTER_VERSION, asLocalAdapter, type AgentProfile } from "../agent-profile.js";
import {
  manifestCatalogScope,
  manifestCatalogSource,
  readCliVersion,
  readJsonFileBounded,
  type CatalogModelEvidence,
  type ManifestCatalogModel,
} from "../model-catalog.js";
import {
  ProbeError,
  redactProbeText,
  runBoundedProbe,
  type ProbeHandle,
} from "../probe-process.js";
import {
  CodexSessionManager,
  defaultCodexSessionsRoot,
} from "./codex-session-manager.js";

export { CodexSessionManager, defaultCodexSessionsRoot } from "./codex-session-manager.js";

interface CodexCachedModel {
  slug?: unknown;
  display_name?: unknown;
  context_window?: unknown;
  max_context_window?: unknown;
  effective_context_window_percent?: unknown;
  input_modalities?: unknown;
  default_reasoning_level?: unknown;
  supported_reasoning_levels?: unknown;
  default_service_tier?: unknown;
  supported_in_api?: unknown;
}

interface CodexCatalogSnapshot {
  models: ManifestCatalogModel[];
  sourceVersion?: string;
  defaultModel?: string;
}

interface CodexLiveEvidenceContext {
  observedAt: string;
  scopeRef: string;
  runtimeVersion: string;
  wrapperVersion: string;
}

interface CodexAppServerModel {
  id?: unknown;
  model?: unknown;
  displayName?: unknown;
  description?: unknown;
  hidden?: unknown;
  supportedReasoningEfforts?: unknown;
  defaultReasoningEffort?: unknown;
  inputModalities?: unknown;
  serviceTiers?: unknown;
  isDefault?: unknown;
}

interface CodexAppServerProbe {
  models: CodexAppServerModel[];
  runtimeVersion?: string;
  wrapperVersion?: string;
}

const CODEX_CATALOG_TIMEOUT_MS = 15_000;
const CODEX_CATALOG_MAX_BYTES = 4_000_000;
const CODEX_CATALOG_MAX_PAGES = 20;
const CODEX_CATALOG_CLIENT_NAME = "seam-catalog-collector";

type CodexAppServerChild = ChildProcessByStdio<Writable, Readable, Readable>;

interface CodexRuntimeCommand {
  executable: string;
  baseArgs: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

function codexRuntimeCommand(
  executable: string,
  extraEnv?: Record<string, string>,
): CodexRuntimeCommand {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (extraEnv) {
    for (const [key, value] of Object.entries(extraEnv)) env[key] = value;
  }
  return { executable, baseArgs: [], cwd: process.cwd(), env };
}

function spawnCodexRuntime(
  runtime: CodexRuntimeCommand,
  args: ReadonlyArray<string>,
): CodexAppServerChild {
  return spawn(runtime.executable, [...runtime.baseArgs, ...args], {
    cwd: runtime.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: runtime.env,
    detached: true,
  });
}

function errorText(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function credentialDigest(kind: "account" | "api", value: string): string {
  return `${kind}-${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

/** Stable across hosts for the same account, distinct across configured accounts, and never secret-bearing. */
function codexCredentialProfile(codexHome: string, env: NodeJS.ProcessEnv): string {
  const runtimeApiKey = nonEmptyString(env.CODEX_API_KEY) ?? nonEmptyString(env.OPENAI_API_KEY);
  if (runtimeApiKey) return credentialDigest("api", runtimeApiKey);
  try {
    const authPath = path.join(codexHome, "auth.json");
    if (fs.statSync(authPath).size <= 1_000_000) {
      const auth = record(JSON.parse(fs.readFileSync(authPath, "utf8")));
      const accountId = nonEmptyString(record(auth?.tokens)?.account_id);
      if (accountId) return credentialDigest("account", accountId);
      const storedApiKey = nonEmptyString(auth?.OPENAI_API_KEY);
      if (storedApiKey) return credentialDigest("api", storedApiKey);
    }
  } catch {
    // Missing/unreadable auth means no stable account identity was available.
  }
  return "default";
}

/** Minimal bounded JSON-RPC client for the Codex app-server's JSONL transport. */
class CodexAppServerJsonRpc {
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private nextId = 1;
  private stdoutBuffer = "";
  private closed = false;
  private failure: Error | null = null;
  private readonly onData = (chunk: Buffer | string): void => this.onStdout(chunk);
  private readonly onStdoutError = (error: Error): void => this.fail(error);
  private readonly onStdinError = (error: Error): void => this.fail(error);
  private readonly onAbort = (): void => this.fail(
    new ProbeError("cancelled", "Codex ACP app-server model/list cancelled")
  );

  constructor(private readonly handle: ProbeHandle) {
    handle.stdout.on("data", this.onData);
    handle.stdout.on("error", this.onStdoutError);
    handle.stdin.on("error", this.onStdinError);
    if (handle.signal.aborted) queueMicrotask(this.onAbort);
    else handle.signal.addEventListener("abort", this.onAbort, { once: true });
    handle.onClose((signal) => this.close(signal), "connection");
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new Error("configured Codex ACP app-server is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.handle.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        (error) => {
          if (!error) return;
          this.pending.delete(id);
          const wrapped = new Error(`configured Codex ACP app-server stdin failed: ${error.message}`);
          reject(wrapped);
          this.fail(wrapped);
        }
      );
    });
  }

  async close(signal: AbortSignal): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.handle.signal.removeEventListener("abort", this.onAbort);
    this.handle.stdout.removeListener("data", this.onData);
    this.handle.stdout.removeListener("error", this.onStdoutError);
    this.handle.stdin.removeListener("error", this.onStdinError);
    for (const pending of this.pending.values()) {
      pending.reject(new Error("configured Codex ACP app-server connection closed"));
    }
    this.pending.clear();
    this.handle.stdin.end();
    if (signal.aborted) return;
    await Promise.race([
      this.handle.exited.catch(() => undefined),
      new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
    ]);
  }

  private onStdout(chunk: Buffer | string): void {
    if (this.closed) return;
    this.stdoutBuffer += String(chunk);
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message: Record<string, unknown> | null;
      try {
        message = record(JSON.parse(line));
      } catch (error) {
        this.fail(new Error(`configured Codex ACP app-server emitted malformed JSON: ${errorText(error)}`));
        return;
      }
      if (!message) {
        this.fail(new Error("configured Codex ACP app-server emitted a non-object JSON message"));
        return;
      }
      const id = typeof message.id === "number" ? message.id : null;
      if (id === null) continue;
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      if (message.error !== undefined) {
        pending.reject(new Error(
          `configured Codex ACP app-server request failed: ${errorText(message.error)}`
        ));
      } else if (!("result" in message)) {
        pending.reject(new Error("configured Codex ACP app-server response has no result"));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private fail(error: Error): void {
    if (this.failure || this.closed) return;
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function codexRuntimeVersion(initializeResult: unknown): string {
  const userAgent = nonEmptyString(record(initializeResult)?.userAgent);
  if (!userAgent) {
    throw new Error("configured Codex ACP app-server initialize omitted its runtime version");
  }
  const version = userAgent.match(/^\S+\/([^\s]+)/)?.[1];
  return version ? `codex-cli ${version}` : userAgent.slice(0, 256);
}

async function probeCodexAppServer(
  runtime: CodexRuntimeCommand,
  timeoutMs = CODEX_CATALOG_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<CodexAppServerProbe> {
  return runBoundedProbe({
    executable: runtime.executable,
    args: [...runtime.baseArgs, "cli", "app-server"],
    cwd: runtime.cwd,
    env: runtime.env,
    timeoutMs,
    signal,
    maxStdoutBytes: CODEX_CATALOG_MAX_BYTES,
    label: "Codex ACP app-server model/list",
    async run(handle) {
      const connection = new CodexAppServerJsonRpc(handle);
      const initialized = await connection.request("initialize", {
        clientInfo: {
          name: CODEX_CATALOG_CLIENT_NAME,
          title: "Seam Catalog Collector",
          version: String(AGENT_ADAPTER_VERSION),
        },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      const models: CodexAppServerModel[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < CODEX_CATALOG_MAX_PAGES; page += 1) {
        const result = record(await connection.request("model/list", { cursor, limit: null }));
        if (!result || !Array.isArray(result.data)) {
          throw new Error("configured Codex ACP app-server model/list returned malformed output");
        }
        models.push(...result.data as CodexAppServerModel[]);
        const nextCursor = result.nextCursor;
        if (nextCursor == null) {
          return { models, runtimeVersion: codexRuntimeVersion(initialized) };
        }
        if (typeof nextCursor !== "string" || !nextCursor || seenCursors.has(nextCursor)) {
          throw new Error("configured Codex ACP app-server model/list returned an invalid pagination cursor");
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
      throw new Error(`configured Codex ACP app-server model/list exceeded ${CODEX_CATALOG_MAX_PAGES} pages`);
    },
  });
}

function parseReasoningEfforts(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new Error("configured Codex ACP app-server model/list omitted supportedReasoningEfforts");
  }
  const choices: string[] = [];
  for (const entry of raw) {
    const effort = nonEmptyString(record(entry)?.reasoningEffort);
    if (!effort) throw new Error("configured Codex ACP app-server returned a malformed reasoning effort");
    if (!choices.includes(effort)) choices.push(effort);
  }
  return choices;
}

function parseStringArray(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw)) {
    throw new Error(`configured Codex ACP app-server model/list omitted ${field}`);
  }
  const values = raw.map(nonEmptyString);
  if (values.some((value) => !value)) {
    throw new Error(`configured Codex ACP app-server returned malformed ${field}`);
  }
  return [...new Set(values as string[])];
}

function parseServiceTiers(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new Error("configured Codex ACP app-server model/list omitted serviceTiers");
  }
  const tiers: string[] = [];
  for (const entry of raw) {
    const id = nonEmptyString(record(entry)?.id);
    if (!id) throw new Error("configured Codex ACP app-server returned malformed serviceTiers");
    if (!tiers.includes(id)) tiers.push(id);
  }
  return tiers;
}

function normalizeCodexAppServerModels(
  rows: ReadonlyArray<CodexAppServerModel>,
  configuredDefault: string,
  evidenceContext: CodexLiveEvidenceContext,
): CodexCatalogSnapshot {
  const models: ManifestCatalogModel[] = [];
  const ids = new Set<string>();
  let defaultModel: string | undefined;
  for (const raw of rows) {
    if (!record(raw)) throw new Error("configured Codex ACP app-server model/list returned a malformed model");
    if (raw.hidden !== true && raw.hidden !== false) {
      throw new Error("configured Codex ACP app-server model/list omitted model visibility");
    }
    const modelId = nonEmptyString(raw.id);
    const runtimeId = nonEmptyString(raw.model);
    const name = nonEmptyString(raw.displayName);
    if (!modelId || !runtimeId || !name) {
      throw new Error("configured Codex ACP app-server model/list returned a model without id/model/displayName");
    }
    if (ids.has(modelId)) throw new Error(`configured Codex ACP app-server returned duplicate model ${modelId}`);
    ids.add(modelId);
    const description = raw.description === undefined ? undefined : nonEmptyString(raw.description);
    if (raw.description !== undefined && !description) {
      throw new Error(`configured Codex ACP app-server returned a malformed description for ${modelId}`);
    }
    const choices = parseReasoningEfforts(raw.supportedReasoningEfforts);
    const declaredDefault = nonEmptyString(raw.defaultReasoningEffort);
    if (choices.length > 0 && (!declaredDefault || !choices.includes(declaredDefault))) {
      throw new Error(`configured Codex ACP app-server returned an invalid default effort for ${modelId}`);
    }
    if (choices.length === 0 && declaredDefault) {
      throw new Error(`configured Codex ACP app-server returned a default effort without choices for ${modelId}`);
    }
    const input = parseStringArray(raw.inputModalities, "inputModalities");
    const serviceTiers = parseServiceTiers(raw.serviceTiers);
    if (raw.isDefault !== true && raw.isDefault !== false) {
      throw new Error(`configured Codex ACP app-server model/list omitted default state for ${modelId}`);
    }
    if (raw.hidden) continue;
    const isDefault = raw.isDefault;
    if (isDefault) {
      if (defaultModel) throw new Error("configured Codex ACP app-server returned multiple default models");
      defaultModel = modelId;
    }
    models.push({
      modelId,
      runtimeId,
      name,
      ...(description ? { description } : {}),
      evidence: [{
        kind: "live-observation",
        source: "codex-app-server-model-list",
        observedAt: evidenceContext.observedAt,
        runtimeVersion: `${evidenceContext.wrapperVersion} / ${evidenceContext.runtimeVersion}`.slice(0, 200),
        adapterVersion: AGENT_ADAPTER_VERSION,
        scopeRef: evidenceContext.scopeRef,
        resolvedModel: runtimeId,
        effort: {
          choices: choices.length ? choices : ["default"],
          selectionDefault: choices.length ? declaredDefault! : "default",
          method: "model-list",
        },
      }],
      aliases: runtimeId === modelId ? [] : [runtimeId],
      modalities: { input, output: ["text"] },
      visionMode: input.includes("image") ? "native" : "none",
      availability: "available",
      serviceTiers,
      effort: choices.length > 0
        ? {
            mechanism: "configOption",
            configId: "reasoning_effort",
            choices,
            selectionDefault: declaredDefault!,
          }
        : { mechanism: "none", choices: ["default"], selectionDefault: "default" },
    });
  }
  if (models.length === 0) {
    throw new Error("configured Codex ACP app-server model/list returned no selectable models");
  }
  if (!defaultModel) {
    throw new Error("configured Codex ACP app-server model/list returned no default model");
  }
  const configuredId = configuredDefault.trim();
  if (!configuredId || !models.some((model) =>
    model.modelId === configuredId || model.runtimeId === configuredId || model.aliases?.includes(configuredId)
  )) {
    throw new Error(
      `configured Codex default ${JSON.stringify(configuredDefault)} is not advertised by the active app-server; configuration drift must be corrected`
    );
  }
  return { models, defaultModel };
}

function mergeExactCodexEnrichment(
  models: ReadonlyArray<ManifestCatalogModel>,
  cached: ReadonlyArray<ManifestCatalogModel>,
  configured: ReadonlyArray<{ modelId: string; name: string; contextLimit?: number }>,
  scopeRef: string,
  cacheObservedAt?: string,
): ManifestCatalogModel[] {
  const cacheById = new Map(cached.map((model) => [model.modelId, model]));
  const configuredById = new Map(configured.map((model) => [model.modelId, model]));
  return models.map((model) => {
    const cache = cacheById.get(model.modelId);
    const declared = configuredById.get(model.modelId);
    const declaredContext = declared?.contextLimit;
    const context = declaredContext != null
      ? { native: declaredContext, maximum: declaredContext, effective: declaredContext }
      : cache?.context;
    if (!context || !Object.values(context).some((value) => value != null)) return { ...model };
    const source = declaredContext != null ? "codex-static-model-metadata" : "codex-model-cache";
    const enrichment: CatalogModelEvidence = {
      kind: "enrichment",
      source,
      ...(declaredContext == null && cacheObservedAt && Number.isFinite(Date.parse(cacheObservedAt))
        ? { observedAt: cacheObservedAt }
        : {}),
      scopeRef,
      resolvedModel: model.modelId,
      context: { ...context, method: "exact-id" },
    };
    return {
      ...model,
      context: { ...context },
      evidence: [...(model.evidence ?? []), enrichment],
    };
  });
}

async function readCodexAcpVersion(
  runtime: CodexRuntimeCommand,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = execFile(runtime.executable, [...runtime.baseArgs, "--version"], {
      cwd: runtime.cwd,
      env: runtime.env,
      timeout: 5_000,
      maxBuffer: 16_384,
    }, (error, stdout, stderr) => {
      if (error) {
        const failure = error as Error & {
          code?: string | number | null;
          killed?: boolean;
          signal?: NodeJS.Signals | null;
        };
        if (failure.code === "ENOENT" || failure.code === "EACCES") {
          return reject(new ProbeError("spawn_failed", "Codex ACP wrapper version command could not start"));
        }
        if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          return reject(new ProbeError("output_overflow", "Codex ACP wrapper version output exceeded 16384 bytes"));
        }
        if (child.pid === undefined) {
          return reject(new ProbeError("spawn_failed", "Codex ACP wrapper version command could not start"));
        }
        if (failure.killed && failure.signal === "SIGTERM") {
          return reject(new ProbeError("timeout", "Codex ACP wrapper version command timed out after 5000ms"));
        }
        const exitCode = typeof failure.code === "number" ? String(failure.code) : "unknown";
        return reject(new ProbeError(
          "exited_early",
          `Codex ACP wrapper version command exited (code=${exitCode}, signal=${failure.signal ?? "none"})`
        ));
      }
      const rawVersion = (String(stdout) || String(stderr)).trim().split(/\r?\n/, 1)[0]?.slice(0, 256);
      const version = rawVersion ? redactProbeText(rawVersion, runtime.env) : undefined;
      if (!version) {
        return reject(new ProbeError("protocol_error", "Codex ACP wrapper returned an empty version"));
      }
      const containsFilesystemPath = /(?:^|[\s=:'"])(?:\/(?:[^/\s]+\/)+[^\s]*|[A-Za-z]:[\\/][^\s]+)/
        .test(rawVersion!);
      const containsCredentialValue = Object.entries(runtime.env).some(([key, value]) =>
        /(?:token|secret|passw(?:or)?d|api[_-]?key|private[_-]?key|access[_-]?key|authorization|credential)/i.test(key) &&
        typeof value === "string" && value.length > 0 && rawVersion!.includes(value)
      );
      if (version !== rawVersion || containsFilesystemPath || containsCredentialValue) {
        return reject(new ProbeError("protocol_error", "Codex ACP wrapper returned unsafe version output"));
      }
      resolve(version);
    });
  });
}

async function readCodexCatalogSnapshot(modelsCachePath: string): Promise<CodexCatalogSnapshot> {
  try {
    const parsed = await readJsonFileBounded(modelsCachePath) as {
      fetched_at?: unknown;
      models?: unknown;
    };
    if (!Array.isArray(parsed.models)) return { models: [] };
    const models: ManifestCatalogModel[] = [];
    for (const raw of parsed.models as CodexCachedModel[]) {
      if (!raw || typeof raw !== "object" || typeof raw.slug !== "string") continue;
      const modelId = raw.slug.trim();
      if (!modelId) continue;
      const name = typeof raw.display_name === "string" && raw.display_name.trim()
        ? raw.display_name.trim()
        : modelId;
      const native = typeof raw.context_window === "number" && Number.isFinite(raw.context_window) && raw.context_window > 0
        ? raw.context_window
        : null;
      const maximum = typeof raw.max_context_window === "number" && Number.isFinite(raw.max_context_window) && raw.max_context_window > 0
        ? raw.max_context_window
        : native;
      const percent = typeof raw.effective_context_window_percent === "number" &&
        Number.isFinite(raw.effective_context_window_percent) && raw.effective_context_window_percent > 0
        ? raw.effective_context_window_percent
        : 100;
      const effective = native ? Math.floor(native * percent / 100) : null;
      const choices = Array.isArray(raw.supported_reasoning_levels)
        ? raw.supported_reasoning_levels.flatMap((entry) => {
            if (typeof entry === "string" && entry.trim()) return [entry.trim()];
            if (entry && typeof entry === "object" && "effort" in entry &&
              typeof (entry as { effort?: unknown }).effort === "string") {
              const effort = (entry as { effort: string }).effort.trim();
              return effort ? [effort] : [];
            }
            return [];
          })
        : [];
      const declaredDefault = typeof raw.default_reasoning_level === "string" &&
        choices.includes(raw.default_reasoning_level)
        ? raw.default_reasoning_level
        : undefined;
      const input = Array.isArray(raw.input_modalities)
        ? raw.input_modalities.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
        : ["text"];
      models.push({
        modelId,
        name,
        context: { native, maximum, effective },
        modalities: { input, output: ["text"] },
        visionMode: input.includes("image") ? "native" : "none",
        availability: raw.supported_in_api === false ? "unavailable" : "available",
        serviceTiers: typeof raw.default_service_tier === "string" ? [raw.default_service_tier] : [],
        effort: {
          mechanism: choices.length ? "configOption" : "none",
          ...(choices.length ? { configId: "reasoning_effort" } : {}),
          choices: choices.length ? choices : ["default"],
          ...(declaredDefault ? { selectionDefault: declaredDefault } : {}),
        },
      });
    }
    const sourceVersion = typeof parsed.fetched_at === "string" && parsed.fetched_at.trim()
      ? parsed.fetched_at.trim().slice(0, 256)
      : undefined;
    return { models, ...(sourceVersion ? { sourceVersion } : {}) };
  } catch {
    return { models: [] };
  }
}

/**
 * Read Codex's host-local model cache for exact-id metadata enrichment. The effective
 * percentage is the same reduction Codex applies before reporting
 * `model_context_window` in rollout usage events (for example 272000 * 95% =
 * 258400). Missing or malformed caches fail soft so the refresh retains its
 * prior generation; this file never controls operational availability.
 */
export async function readCodexModelCatalog(
  modelsCachePath: string
): Promise<ManifestCatalogModel[]> {
  return (await readCodexCatalogSnapshot(modelsCachePath)).models;
}

/**
 * OpenAI Codex CLI as an ACP server, via the official adapter
 * `@agentclientprotocol/codex-acp` (binary `codex-acp`).
 *
 * Setup on the host (one-time):
 *   npm i -g @openai/codex @agentclientprotocol/codex-acp
 *   codex auth                # complete the API-key flow
 *
 * The Codex adapter speaks ACP over stdio just like claude-agent-acp.
 * It honors the standard ACP session/new → session/prompt flow.
 *
 * Reasoning effort: Codex surfaces effort as an ACP config option
 * `reasoning_effort` (same as Copilot — both are OpenAI-backed).
 * Applied post-session-create via setSessionConfigOption in AgentRuntime.
 */
export function makeCodexProfile(opts: {
  /** Profile id. Defaults to "codex". Must be unique across registered profiles. */
  id?: string;
  /** Display name shown in pickers. Defaults to "OpenAI Codex". */
  displayName?: string;
  /** Path to the `codex-acp` binary. Defaults to looking it up on PATH. */
  cliPath?: string;
  /** Default model id for sessions on this profile (e.g. "o3"). */
  defaultModel: string;
  staticModels?: ReadonlyArray<{ modelId: string; name: string; contextLimit?: number }>;
  /** Override the effort descriptor. Defaults to configOption-based
   *  reasoning_effort (low/medium/high/xhigh/max/ultra), matching the OpenAI pattern. */
  effort?: AgentProfile["effort"];
  /** Custom environment variables to inject into the spawned process. */
  extraEnv?: Record<string, string>;
  /**
   * Override the on-disk Codex rollout root (`~/.codex/sessions`). Tests pass a
   * temp dir; production omits this and uses `$HOME/.codex/sessions`.
   */
  sessionsRoot?: string;
  /** Override Codex's host-local model catalog (`~/.codex/models_cache.json`). */
  modelsCachePath?: string;
  /** Test seam for the app-server protocol; production always probes cliPath. */
  catalogProbe?: () => Promise<CodexAppServerProbe>;
  /** Overall initialize-plus-pagination collector deadline; production defaults to 15 seconds. */
  catalogTimeoutMs?: number;
  /** Test-only cancellation hook for collector lifecycle coverage. */
  catalogAbortSignal?: AbortSignal;
}): AgentProfile {
  const cli = opts.cliPath?.trim() || "codex-acp";
  const configuredCodexHome = nonEmptyString(opts.extraEnv?.CODEX_HOME) ??
    nonEmptyString(process.env.CODEX_HOME);
  const codexHome = configuredCodexHome ??
    (opts.sessionsRoot ? path.dirname(opts.sessionsRoot) : path.dirname(defaultCodexSessionsRoot()));
  const sessionsRoot = opts.sessionsRoot ?? path.join(codexHome, "sessions");
  const modelsCachePath =
    opts.modelsCachePath ??
    path.join(codexHome, "models_cache.json");
  const catalogEffort = opts.effort ?? {
    mechanism: "configOption" as const,
    configId: "reasoning_effort",
    levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
  };
  const runtime = codexRuntimeCommand(cli, opts.extraEnv);
  const directCodex = (opts.id ?? "codex") === "codex";
  const credentialProfile = directCodex
    ? codexCredentialProfile(codexHome, runtime.env)
    : path.basename(path.dirname(modelsCachePath)) || ".codex";
  const scope = manifestCatalogScope({
    provider: opts.id === "ollama-cloud" ? "ollama-cloud" : "openai",
    backend: opts.extraEnv?.OPENAI_BASE_URL,
    credentialProfile,
  });
  return asLocalAdapter({
    id: opts.id ?? "codex",
    displayName: opts.displayName ?? "OpenAI Codex",
    defaultModel: opts.defaultModel,
    catalog: {
      scope: () => scope,
      async fetch() {
        if (directCodex) {
          const probe = opts.catalogProbe
            ? await opts.catalogProbe()
            : await probeCodexAppServer(runtime, opts.catalogTimeoutMs, opts.catalogAbortSignal);
          const wrapperVersion = nonEmptyString(probe.wrapperVersion) ?? await readCodexAcpVersion(runtime);
          const runtimeVersion = nonEmptyString(probe.runtimeVersion);
          if (!runtimeVersion) {
            throw new Error("configured Codex ACP app-server probe omitted its runtime version");
          }
          const observedAt = new Date().toISOString();
          const live = normalizeCodexAppServerModels(probe.models, opts.defaultModel, {
            observedAt,
            scopeRef: scope.fingerprint,
            runtimeVersion,
            wrapperVersion,
          });
          const cache = await readCodexCatalogSnapshot(modelsCachePath);
          const models = mergeExactCodexEnrichment(
            live.models,
            cache.models,
            opts.staticModels ?? [],
            scope.fingerprint,
            cache.sourceVersion,
          );
          const candidate = await manifestCatalogSource({
            provider: "openai",
            backend: opts.extraEnv?.OPENAI_BASE_URL,
            credentialProfile,
            defaultModel: live.defaultModel!,
            models: () => models,
            adapterVersion: AGENT_ADAPTER_VERSION,
            source: "codex-acp-app-server",
          }).fetch();
          candidate.sourceVersion = runtimeVersion;
          candidate.cliVersion = wrapperVersion;
          return candidate;
        }
        // Non-OpenAI profiles that reuse the Codex harness (currently parked
        // Ollama Cloud) retain their separately configured provider contract.
        const snapshot: CodexCatalogSnapshot = opts.staticModels?.length
          ? { models: [...opts.staticModels] }
          : await readCodexCatalogSnapshot(modelsCachePath);
        const candidate = await manifestCatalogSource({
          provider: opts.id === "ollama-cloud" ? "ollama-cloud" : "openai",
          backend: opts.extraEnv?.OPENAI_BASE_URL,
          credentialProfile,
          defaultModel: opts.defaultModel,
          models: () => snapshot.models,
          effort: {
            mechanism: catalogEffort.mechanism,
            ...(catalogEffort.configId ? { configId: catalogEffort.configId } : {}),
            choices: catalogEffort.levels,
          },
          adapterVersion: AGENT_ADAPTER_VERSION,
          source: opts.staticModels?.length ? "validated-manifest" : "codex-model-cache",
        }).fetch();
        candidate.sourceVersion = snapshot.sourceVersion;
        candidate.cliVersion = await readCliVersion(cli);
        return candidate;
      },
    },
    // Codex uses the same configOption effort mechanism as Copilot (both OpenAI).
    effort: catalogEffort,
    spawn() {
      return spawnCodexRuntime(runtime, []);
    },
    sessionManager: new CodexSessionManager({ sessionsRoot }),
  });
}

import { spawn } from "node:child_process";
import path from "node:path";
import { AGENT_ADAPTER_VERSION, asLocalAdapter, type AgentProfile } from "../agent-profile.js";
import {
  manifestCatalogScope,
  manifestCatalogSource,
  readCliVersion,
  readJsonFileBounded,
  type ManifestCatalogModel,
} from "../model-catalog.js";
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
 * Read Codex's host-local model cache without starting a session. The effective
 * percentage is the same reduction Codex applies before reporting
 * `model_context_window` in rollout usage events (for example 272000 * 95% =
 * 258400). Missing or malformed caches fail soft so the refresh retains its
 * prior generation; this function is never called by a lookup path.
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
}): AgentProfile {
  const cli = opts.cliPath?.trim() || "codex-acp";
  const sessionsRoot = opts.sessionsRoot ?? defaultCodexSessionsRoot();
  const modelsCachePath =
    opts.modelsCachePath ??
    path.join(path.dirname(sessionsRoot), "models_cache.json");
  const catalogEffort = opts.effort ?? {
    mechanism: "configOption" as const,
    configId: "reasoning_effort",
    levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
  };
  return asLocalAdapter({
    id: opts.id ?? "codex",
    displayName: opts.displayName ?? "OpenAI Codex",
    defaultModel: opts.defaultModel,
    catalog: {
      scope: () => manifestCatalogScope({
        provider: opts.id === "ollama-cloud" ? "ollama-cloud" : "openai",
        backend: opts.extraEnv?.OPENAI_BASE_URL,
        credentialProfile: path.dirname(modelsCachePath),
      }),
      async fetch() {
        const snapshot: CodexCatalogSnapshot = opts.staticModels?.length
          ? { models: [...opts.staticModels] }
          : await readCodexCatalogSnapshot(modelsCachePath);
        const candidate = await manifestCatalogSource({
          provider: opts.id === "ollama-cloud" ? "ollama-cloud" : "openai",
          backend: opts.extraEnv?.OPENAI_BASE_URL,
          credentialProfile: path.dirname(modelsCachePath),
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
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (opts.extraEnv) {
        for (const [k, v] of Object.entries(opts.extraEnv)) {
          if (v !== undefined) env[k] = v;
        }
      }
      return spawn(cli, [], {
        stdio: ["pipe", "pipe", "pipe"],
        env,
        detached: true,
      });
    },
    sessionManager: new CodexSessionManager({ sessionsRoot }),
  });
}

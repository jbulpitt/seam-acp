import { spawn } from "node:child_process";
import type { AgentProfile } from "../agent-profile.js";

/**
 * Known context windows for xAI text models (from docs.x.ai/developers/models).
 * Used to enrich models returned by the /v1/models discovery endpoint, which
 * doesn't include context-window fields.
 */
const KNOWN_CONTEXT_WINDOWS: Record<string, number> = {
  "grok-build-0.1":                     256_000,
  "grok-4.3":                         1_000_000,
  "grok-4.20-0309-reasoning":         1_000_000,
  "grok-4.20-0309-non-reasoning":     1_000_000,
  "grok-4.20-multi-agent-0309":       1_000_000,
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

/**
 * Discover the live model list from xAI's OpenAI-compatible `/v1/models`
 * endpoint (`https://api.x.ai/v1/models`).  Returns only text models (filters
 * out image/video/audio/embedding models).
 *
 * Context windows are looked up from KNOWN_CONTEXT_WINDOWS since the
 * `/v1/models` response doesn't include them.
 *
 * Requires `XAI_API_KEY`.  Returns [] on failure (agent still registers;
 * picker falls back to GROK_STATIC_MODELS).
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
 * Reasoning effort: the docs mention reasoning levels but no ACP config
 * option for effort has been confirmed yet.  We leave `effort` as "none"
 * by default; callers can override via opts.effort if xAI adds it.
 */
export function makeGrokProfile(opts: {
  /** Profile id. Defaults to "grok". */
  id?: string;
  /** Display name shown in pickers. Defaults to "Grok Build". */
  displayName?: string;
  /** Path to the `grok` binary. Defaults to looking it up on PATH. */
  cliPath?: string;
  /** Default model id for sessions (e.g. "grok-build-0.1"). */
  defaultModel: string;
  staticModels?: ReadonlyArray<{ modelId: string; name: string; contextLimit?: number }>;
  threadAbbr?: string;
  /** Override the effort descriptor. Defaults to "none" until xAI
   *  exposes a configOption or meta path for reasoning effort. */
  effort?: AgentProfile["effort"];
  /** Custom environment variables to inject into the spawned process. */
  extraEnv?: Record<string, string>;
}): AgentProfile {
  const cli = opts.cliPath?.trim() || "grok";

  return {
    id: opts.id ?? "grok",
    displayName: opts.displayName ?? "Grok Build",
    defaultModel: opts.defaultModel,
    staticModels: opts.staticModels,
    threadAbbr: opts.threadAbbr,
    // No confirmed ACP reasoning-effort mechanism yet.
    effort: opts.effort ?? {
      mechanism: "none",
      levels: [],
    },
    spawn() {
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (opts.extraEnv) {
        for (const [k, v] of Object.entries(opts.extraEnv)) {
          if (v !== undefined) env[k] = v;
        }
      }
      return spawn(cli, ["agent", "stdio"], {
        stdio: ["pipe", "pipe", "pipe"],
        env,
        detached: true,
      });
    },
  };
}

import { spawn } from "node:child_process";
import type { AgentProfile } from "../agent-profile.js";

type OpencodeModel = { modelId: string; name: string; contextLimit?: number };

/** One fetch with a 10s abort timeout. */
async function fetchJson<T>(fetchFn: typeof fetch, url: string, init?: RequestInit): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetchFn(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a model's native context window from Ollama `/api/show` (GGUF metadata —
 * no need to load the model). The key is `<arch>.context_length` (e.g.
 * `gemma4.context_length`). On this server models are served at their native
 * window, so this is the effective limit; if you ever cap below native via
 * OLLAMA_CONTEXT_LENGTH, the truth shifts to /api/ps (loaded). Undefined on any
 * failure — the model just won't carry a contextLimit. */
async function fetchContextLength(fetchFn: typeof fetch, root: string, model: string): Promise<number | undefined> {
  try {
    const j = await fetchJson<{ model_info?: Record<string, unknown> }>(fetchFn, `${root}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
    });
    const mi = j.model_info ?? {};
    const key = Object.keys(mi).find((k) => k.endsWith(".context_length"));
    const v = key ? mi[key] : undefined;
    return typeof v === "number" && v > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Discover the live model list from an Ollama server's `/api/tags` and map each
 * to its opencode id (`<prefix>/<ollama-model>`, e.g. `ollama-remote/gemma4:26b`),
 * also reading each model's native context window from `/api/show` so the picker
 * carries an accurate `contextLimit` for the usage display. opencode auto-
 * discovers the same models from the endpoint, so this keeps the seam-acp picker
 * in sync with whatever is actually pulled — no hardcoded list. Returns [] if the
 * tag list can't be fetched (the agent still registers; picker empty until
 * Ollama is reachable). Each call has a 10s timeout.
 */
export async function fetchOllamaOpencodeModels(
  baseUrl: string,
  prefix: string,
  fetchFn: typeof fetch = fetch,
): Promise<OpencodeModel[]> {
  const root = baseUrl.replace(/\/+$/, "");
  let body: { models?: Array<{ name?: string }> };
  try {
    body = await fetchJson(fetchFn, `${root}/api/tags`);
  } catch {
    return [];
  }
  const names = (body.models ?? [])
    .map((m) => m.name)
    .filter((n): n is string => typeof n === "string" && n.length > 0)
    .sort();

  return Promise.all(
    names.map(async (n): Promise<OpencodeModel> => {
      const contextLimit = await fetchContextLength(fetchFn, root, n);
      return { modelId: `${prefix}/${n}`, name: `${n} 🦙`, ...(contextLimit ? { contextLimit } : {}) };
    }),
  );
}

/**
 * opencode (sst/opencode) as an ACP server (`opencode acp`).
 *
 * opencode is a provider-agnostic coding agent. Pointed at a local/remote Ollama
 * via its own config (`~/.config/opencode/opencode.json` — a custom
 * `@ai-sdk/openai-compatible` provider with the Ollama `/v1` baseURL), it drives
 * local models **natively over ACP** with no Anthropic translation proxy. Verified
 * end-to-end: clean ACP handshake (initialize → session/new → set_model →
 * session/prompt) and a real turn against `gemma4` through the tunnel.
 *
 * Models are referenced by their opencode id (e.g. `ollama-remote/gemma4:26b`).
 * Those ids carry `/` and `:`, so the picker list is provided as `staticModels`
 * (set in code) rather than the colon-delimited MODELS env format.
 *
 * Minimal by design: opencode owns its own session storage, so this profile
 * doesn't implement the optional `sessionManager` (the `/seam sessions` family is
 * unavailable for it) — but the core turn flow works over ACP like any agent.
 */
export function makeOpencodeProfile(opts: {
  /** Profile id. Defaults to "opencode". */
  id?: string;
  /** Display name in pickers. Defaults to "opencode". */
  displayName?: string;
  /** Path to the `opencode` binary. Defaults to `opencode` on PATH. */
  cliPath?: string;
  /** Default model id (opencode form, e.g. "ollama-remote/gemma4:26b"). */
  defaultModel: string;
  /** Picker models (incl. optional `contextLimit` for the usage display). */
  staticModels?: AgentProfile["staticModels"];
  threadAbbr?: string;
  /** Effort descriptor. Local models have no reasoning-effort knob → defaults to
   *  {mechanism:"none",levels:[]} so `/seam effort` reports it's unsettable. */
  effort?: AgentProfile["effort"];
}): AgentProfile {
  const cli = opts.cliPath?.trim() || "opencode";

  return {
    id: opts.id ?? "opencode",
    displayName: opts.displayName ?? "opencode",
    defaultModel: opts.defaultModel,
    staticModels: opts.staticModels,
    threadAbbr: opts.threadAbbr,
    effort: opts.effort ?? { mechanism: "none", levels: [] },
    spawn() {
      // `detached: true` makes the child a process-group leader so AgentRuntime's
      // cancel() (`process.kill(-pid)`) reaps opencode plus any tools it spawned.
      return spawn(cli, ["acp"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
        detached: true,
      });
    },
  };
}

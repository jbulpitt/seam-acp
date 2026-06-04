import { spawn } from "node:child_process";
import type { AgentProfile } from "../agent-profile.js";

/**
 * Discover the live model list from an Ollama server's `/api/tags` and map each
 * to its opencode id (`<prefix>/<ollama-model>`, e.g. `ollama-remote/gemma4:26b`).
 * opencode auto-discovers the same models from the endpoint, so this keeps the
 * seam-acp picker in sync with whatever is actually pulled on the box — no
 * hardcoded list. Returns [] on any failure (so the agent still registers; the
 * picker is just empty until Ollama is reachable). 10s timeout.
 */
export async function fetchOllamaOpencodeModels(
  baseUrl: string,
  prefix: string,
  fetchFn: typeof fetch = fetch,
): Promise<Array<{ modelId: string; name: string }>> {
  const url = baseUrl.replace(/\/+$/, "") + "/api/tags";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetchFn(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`Ollama /api/tags HTTP ${res.status}`);
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    return (body.models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0)
      .sort()
      .map((n) => ({ modelId: `${prefix}/${n}`, name: `${n} 🦙` }));
  } finally {
    clearTimeout(timer);
  }
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
  staticModels?: ReadonlyArray<{ modelId: string; name: string }>;
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

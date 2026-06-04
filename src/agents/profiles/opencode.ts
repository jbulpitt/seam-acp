import { spawn } from "node:child_process";
import type { AgentProfile } from "../agent-profile.js";

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

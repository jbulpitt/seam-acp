import { spawn } from "node:child_process";
import { asLocalAdapter, type AgentProfile } from "../agent-profile.js";
import { CodexSessionManager } from "./codex-session-manager.js";

export { CodexSessionManager, defaultCodexSessionsRoot } from "./codex-session-manager.js";

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
  threadAbbr?: string;
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
}): AgentProfile {
  const cli = opts.cliPath?.trim() || "codex-acp";

  return asLocalAdapter({
    id: opts.id ?? "codex",
    displayName: opts.displayName ?? "OpenAI Codex",
    defaultModel: opts.defaultModel,
    staticModels: opts.staticModels,
    threadAbbr: opts.threadAbbr,
    // Codex uses the same configOption effort mechanism as Copilot (both OpenAI).
    effort: opts.effort ?? {
      mechanism: "configOption",
      configId: "reasoning_effort",
      // codex-acp advertises six reasoning_effort levels (probed on 1.6.2);
      // "ultra" (max reasoning + auto task delegation) is codex-only.
      levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
    },
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
    sessionManager: new CodexSessionManager(
      opts.sessionsRoot ? { sessionsRoot: opts.sessionsRoot } : undefined
    ),
  });
}

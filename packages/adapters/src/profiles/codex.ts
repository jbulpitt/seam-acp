import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { asLocalAdapter, type AgentProfile } from "../agent-profile.js";
import {
  CodexSessionManager,
  defaultCodexSessionsRoot,
} from "./codex-session-manager.js";

export { CodexSessionManager, defaultCodexSessionsRoot } from "./codex-session-manager.js";

interface CodexCachedModel {
  slug?: unknown;
  display_name?: unknown;
  context_window?: unknown;
  effective_context_window_percent?: unknown;
}

/**
 * Read Codex's host-local model cache without starting a session. The effective
 * percentage is the same reduction Codex applies before reporting
 * `model_context_window` in rollout usage events (for example 272000 * 95% =
 * 258400). Missing or malformed caches fail soft so ACP discovery can remain
 * the picker fallback.
 */
export async function readCodexModelCatalog(
  modelsCachePath: string
): Promise<Array<{ modelId: string; name: string; contextLimit?: number }>> {
  try {
    const parsed = JSON.parse(await fsp.readFile(modelsCachePath, "utf8")) as {
      models?: unknown;
    };
    if (!Array.isArray(parsed.models)) return [];
    const out: Array<{ modelId: string; name: string; contextLimit?: number }> = [];
    for (const raw of parsed.models as CodexCachedModel[]) {
      if (!raw || typeof raw !== "object" || typeof raw.slug !== "string") continue;
      const modelId = raw.slug.trim();
      if (!modelId) continue;
      const name =
        typeof raw.display_name === "string" && raw.display_name.trim()
          ? raw.display_name.trim()
          : modelId;
      const nativeWindow =
        typeof raw.context_window === "number" &&
        Number.isFinite(raw.context_window) &&
        raw.context_window > 0
          ? raw.context_window
          : undefined;
      const effectivePercent =
        typeof raw.effective_context_window_percent === "number" &&
        Number.isFinite(raw.effective_context_window_percent) &&
        raw.effective_context_window_percent > 0
          ? raw.effective_context_window_percent
          : 100;
      const contextLimit = nativeWindow
        ? Math.floor(nativeWindow * effectivePercent / 100)
        : undefined;
      out.push({
        modelId,
        name,
        ...(contextLimit && contextLimit > 0 ? { contextLimit } : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
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

  return asLocalAdapter({
    id: opts.id ?? "codex",
    displayName: opts.displayName ?? "OpenAI Codex",
    defaultModel: opts.defaultModel,
    staticModels: opts.staticModels,
    async listPickerModels() {
      if (opts.staticModels && opts.staticModels.length > 0) return opts.staticModels;
      return readCodexModelCatalog(modelsCachePath);
    },
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
    sessionManager: new CodexSessionManager({ sessionsRoot }),
  });
}

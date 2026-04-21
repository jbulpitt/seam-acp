import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { AgentIdentity, AgentProfile } from "../agent-profile.js";

/**
 * Google Gemini CLI as an ACP server (`gemini --acp`).
 *
 * Gemini's CLI honors MCP servers from `~/.gemini/settings.json` plus
 * an optional `--allowed-mcp-server-names` allowlist. It does not
 * accept an inline MCP config flag the way Copilot does, so the
 * `mcpServers` option is accepted for parity but currently unused;
 * configure servers in `~/.gemini/settings.json` and list the names
 * you want enabled here (via env var) if you need to restrict them.
 *
 * Multi-account: set `configDir` to an alternate home directory. The
 * Gemini CLI honors `GEMINI_CLI_HOME` as a home-directory override —
 * it reads/writes all state (auth tokens, credentials, settings,
 * session history) under `$GEMINI_CLI_HOME/.gemini/`. So each profile
 * gets a fully isolated Gemini CLI sharing one binary.
 */
export function makeGeminiProfile(opts: {
  /** Profile id. Defaults to "gemini". Must be unique across registered profiles. */
  id?: string;
  /** Display name shown in pickers. Defaults to "Google Gemini". */
  displayName?: string;
  cliPath?: string;
  defaultModel: string;
  /** Kept for parity with other profiles — not wired through today. */
  mcpServers?: McpServer[];
  /** Optional list of MCP server names to allow at spawn. */
  allowedMcpServerNames?: string[];
  /**
   * Override Gemini's home directory. When set, the spawned process gets
   * `GEMINI_CLI_HOME=<dir>` in its env. The CLI resolves all config and
   * auth files relative to `<dir>/.gemini/`. When omitted, the CLI uses
   * the real home directory.
   */
  configDir?: string;
}): AgentProfile {
  const cli = opts.cliPath?.trim() || "gemini";
  const allow = opts.allowedMcpServerNames?.filter(Boolean) ?? [];
  const configDir = opts.configDir?.trim() || undefined;

  let identityCache: AgentIdentity | null | undefined;

  return {
    id: opts.id ?? "gemini",
    displayName: opts.displayName ?? "Google Gemini",
    defaultModel: opts.defaultModel,
    spawn() {
      const args = ["--acp"];
      if (allow.length > 0) {
        args.push("--allowed-mcp-server-names", ...allow);
      }
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (configDir) env.GEMINI_CLI_HOME = configDir;
      return spawn(cli, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env,
      });
    },
    async whoami() {
      if (identityCache !== undefined) return identityCache;
      identityCache = await readGeminiIdentity(configDir);
      return identityCache;
    },
  };
}

/**
 * Read the active Google account from Gemini's `google_accounts.json`.
 * Returns null on any failure.
 */
async function readGeminiIdentity(
  configDir: string | undefined
): Promise<AgentIdentity | null> {
  const home = configDir ?? (process.env.HOME ?? "");
  const file = path.join(home, ".gemini", "google_accounts.json");
  try {
    const raw = await fsp.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as { active?: string };
    if (typeof parsed.active === "string" && parsed.active.length > 0) {
      return { login: parsed.active };
    }
    return null;
  } catch {
    return null;
  }
}

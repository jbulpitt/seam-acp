import { spawn } from "node:child_process";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { AgentProfile } from "../agent-profile.js";

/**
 * Google Gemini CLI as an ACP server (`gemini --acp`).
 *
 * Gemini's CLI honors MCP servers from `~/.gemini/settings.json` plus
 * an optional `--allowed-mcp-server-names` allowlist. It does not
 * accept an inline MCP config flag the way Copilot does, so the
 * `mcpServers` option is accepted for parity but currently unused;
 * configure servers in `~/.gemini/settings.json` and list the names
 * you want enabled here (via env var) if you need to restrict them.
 */
export function makeGeminiProfile(opts: {
  cliPath?: string;
  defaultModel: string;
  /** Kept for parity with other profiles — not wired through today. */
  mcpServers?: McpServer[];
  /** Optional list of MCP server names to allow at spawn. */
  allowedMcpServerNames?: string[];
}): AgentProfile {
  const cli = opts.cliPath?.trim() || "gemini";
  const allow = opts.allowedMcpServerNames?.filter(Boolean) ?? [];

  return {
    id: "gemini",
    displayName: "Google Gemini",
    defaultModel: opts.defaultModel,
    spawn() {
      const args = ["--acp"];
      if (allow.length > 0) {
        args.push("--allowed-mcp-server-names", ...allow);
      }
      return spawn(cli, args, {
        stdio: ["pipe", "pipe", "pipe"],
      });
    },
  };
}

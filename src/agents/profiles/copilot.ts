import { spawn } from "node:child_process";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { AgentProfile } from "../agent-profile.js";

/**
 * GitHub Copilot CLI as an ACP server (`copilot --acp`).
 *
 * Start the ACP server with `--allow-all` so the bot can run end-to-end
 * without needing a permission UI. (The agent will still call
 * `session/request_permission`; we auto-approve those — see AgentRuntime.)
 *
 * Copilot ignores the `mcpServers` field on ACP `session/new` and only
 * loads MCP servers from `~/.copilot/mcp-config.json` plus anything
 * passed via `--additional-mcp-config`. So we translate our global
 * McpServer[] into Copilot's expected JSON shape and inject it at spawn.
 */
export function makeCopilotProfile(opts: {
  cliPath?: string;
  defaultModel: string;
  mcpServers?: McpServer[];
}): AgentProfile {
  const cli = opts.cliPath?.trim() || "copilot";
  const additionalMcpJson = buildCopilotMcpConfigJson(opts.mcpServers ?? []);

  return {
    id: "copilot",
    displayName: "GitHub Copilot",
    defaultModel: opts.defaultModel,
    spawn() {
      const args = ["--acp"];
      if (additionalMcpJson) {
        args.push("--additional-mcp-config", additionalMcpJson);
      }
      return spawn(cli, args, {
        stdio: ["pipe", "pipe", "pipe"],
      });
    },
  };
}

/**
 * Translate our generic ACP McpServer[] into Copilot's expected
 * `{mcpServers: {name: {...}}}` JSON. Returns undefined when the list
 * is empty so we don't pass an empty `--additional-mcp-config` flag.
 */
function buildCopilotMcpConfigJson(servers: McpServer[]): string | undefined {
  if (servers.length === 0) return undefined;

  const map: Record<string, unknown> = {};
  for (const s of servers) {
    // The ACP McpServer union is discriminated by `type` (http/sse) or
    // is the bare stdio variant (no type). We pass through the same
    // shape Copilot's mcp-config.json uses.
    if ("type" in s && (s.type === "http" || s.type === "sse")) {
      const { name, ...rest } = s as McpServer & { name: string };
      map[name] = rest;
    } else {
      // Stdio
      const stdio = s as McpServer & {
        name: string;
        command: string;
        args: string[];
        env?: Array<{ name: string; value: string }>;
      };
      const env: Record<string, string> = {};
      for (const v of stdio.env ?? []) env[v.name] = v.value;
      map[stdio.name] = {
        type: "stdio",
        command: stdio.command,
        args: stdio.args,
        ...(Object.keys(env).length > 0 ? { env } : {}),
      };
    }
  }
  return JSON.stringify({ mcpServers: map });
}

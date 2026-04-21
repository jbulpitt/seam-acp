import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { AgentIdentity, AgentProfile } from "../agent-profile.js";

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
 *
 * Multi-account: pass a custom `configDir` (and a unique `id` /
 * `displayName`) to register a second Copilot profile pointed at a
 * different `--config-dir`. Each config dir holds its own auth state,
 * MCP config, and session history, so the two profiles act as fully
 * isolated CLIs sharing one binary.
 */
export function makeCopilotProfile(opts: {
  /** Profile id. Defaults to "copilot". Must be unique across registered profiles. */
  id?: string;
  /** Display name shown in pickers / status. Defaults to "GitHub Copilot". */
  displayName?: string;
  cliPath?: string;
  defaultModel: string;
  mcpServers?: McpServer[];
  /**
   * Override Copilot's config directory (auth, MCP config, session state).
   * When set, spawn args include `--config-dir <dir>` and `whoami()` reads
   * `<dir>/config.json`. When omitted, the CLI uses its default (~/.copilot).
   */
  configDir?: string;
}): AgentProfile {
  const cli = opts.cliPath?.trim() || "copilot";
  const additionalMcpJson = buildCopilotMcpConfigJson(opts.mcpServers ?? []);
  const configDir = opts.configDir?.trim() || undefined;

  let identityCache: AgentIdentity | null | undefined;

  return {
    id: opts.id ?? "copilot",
    displayName: opts.displayName ?? "GitHub Copilot",
    defaultModel: opts.defaultModel,
    spawn() {
      const args = ["--acp"];
      if (configDir) {
        args.push("--config-dir", configDir);
      }
      if (additionalMcpJson) {
        args.push("--additional-mcp-config", additionalMcpJson);
      }
      return spawn(cli, args, {
        stdio: ["pipe", "pipe", "pipe"],
      });
    },
    async whoami() {
      if (identityCache !== undefined) return identityCache;
      identityCache = await readCopilotIdentity(configDir);
      return identityCache;
    },
  };
}

/**
 * Read GitHub login from Copilot's `config.json`. Returns null on any
 * failure (file missing, malformed JSON, no logged-in user).
 */
async function readCopilotIdentity(
  configDir: string | undefined
): Promise<AgentIdentity | null> {
  const dir = configDir ?? path.join(process.env.HOME ?? "", ".copilot");
  const file = path.join(dir, "config.json");
  try {
    const raw = await fsp.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as {
      lastLoggedInUser?: { login?: string; host?: string };
      loggedInUsers?: Array<{ login?: string; host?: string }>;
    };
    const u =
      parsed.lastLoggedInUser ??
      (parsed.loggedInUsers && parsed.loggedInUsers[0]) ??
      undefined;
    if (!u || !u.login) return null;
    return u.host ? { login: u.login, host: u.host } : { login: u.login };
  } catch {
    return null;
  }
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

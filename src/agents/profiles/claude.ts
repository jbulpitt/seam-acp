import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { AgentIdentity, AgentProfile } from "../agent-profile.js";

/**
 * Anthropic Claude Code as an ACP server, via the official adapter
 * `@agentclientprotocol/claude-agent-acp` (binary `claude-agent-acp`).
 *
 * Setup on the host (one-time):
 *   npm i -g @anthropic-ai/claude-code @agentclientprotocol/claude-agent-acp
 *   claude /login          # complete the OAuth / API-key flow
 *
 * Multi-account: set `configDir` to an alternate Claude config dir
 * (default `~/.claude`). The adapter honors `CLAUDE_CONFIG_DIR`, so we
 * inject it into the child env. Each dir holds its own auth and
 * settings, fully isolated from the others.
 *
 * MCP servers: the adapter forwards `mcpServers` provided on ACP
 * `session/new`. AgentRuntime already does this — we accept the option
 * for parity but don't need to translate to a config flag here.
 */
export function makeClaudeProfile(opts: {
  /** Profile id. Defaults to "claude". Must be unique across registered profiles. */
  id?: string;
  /** Display name shown in pickers. Defaults to "Anthropic Claude". */
  displayName?: string;
  /** Path to the `claude-agent-acp` binary. Defaults to looking it up on PATH. */
  cliPath?: string;
  /**
   * Override Claude's config directory (auth / settings). When set, the
   * spawned process gets `CLAUDE_CONFIG_DIR=<dir>`. When omitted, the
   * adapter's default (~/.claude) is used.
   */
  configDir?: string;
  /** Default model id for sessions on this profile (e.g. "claude-sonnet-4.5"). */
  defaultModel: string;
  /** Accepted for parity; unused — MCP servers are forwarded via ACP. */
  mcpServers?: McpServer[];
}): AgentProfile {
  const cli = opts.cliPath?.trim() || "claude-agent-acp";
  const configDir = opts.configDir?.trim() || undefined;

  let identityCache: AgentIdentity | null | undefined;

  return {
    id: opts.id ?? "claude",
    displayName: opts.displayName ?? "Anthropic Claude",
    defaultModel: opts.defaultModel,
    spawn() {
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
      return spawn(cli, [], {
        stdio: ["pipe", "pipe", "pipe"],
        env,
      });
    },
    async whoami() {
      if (identityCache !== undefined) return identityCache;
      identityCache = await readClaudeIdentity(configDir);
      return identityCache;
    },
  };
}

/**
 * Best-effort identity probe. Claude Code does not document a stable
 * "current user" file the way Copilot does, but ~/.claude/.credentials.json
 * (or ~/.claude.json on some setups) typically carries an `email` /
 * `account` field once `claude /login` has run. Returns null on any
 * failure so callers fall back to the generic "no account info" branch.
 */
async function readClaudeIdentity(
  configDir: string | undefined
): Promise<AgentIdentity | null> {
  const dir = configDir ?? path.join(process.env.HOME ?? "", ".claude");
  const candidates = [
    path.join(dir, ".credentials.json"),
    path.join(dir, "credentials.json"),
    path.join(dir, "settings.json"),
    path.join(process.env.HOME ?? "", ".claude.json"),
  ];
  for (const file of candidates) {
    try {
      const raw = await fsp.readFile(file, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const login = pickLogin(parsed);
      if (login) return { login };
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

function pickLogin(obj: Record<string, unknown>): string | undefined {
  const direct = pickStringField(obj, [
    "email",
    "userEmail",
    "account",
    "username",
    "login",
  ]);
  if (direct) return direct;
  // Sometimes nested under e.g. `oauthAccount` or `user`.
  for (const key of ["oauthAccount", "user", "account", "primary"]) {
    const v = obj[key];
    if (v && typeof v === "object") {
      const inner = pickStringField(v as Record<string, unknown>, [
        "email",
        "emailAddress",
        "login",
        "username",
      ]);
      if (inner) return inner;
    }
  }
  return undefined;
}

function pickStringField(
  obj: Record<string, unknown>,
  fields: string[]
): string | undefined {
  for (const f of fields) {
    const v = obj[f];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

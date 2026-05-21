import { spawn } from "node:child_process";
import fs, { promises as fsp } from "node:fs";
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
  staticModels?: ReadonlyArray<{ modelId: string; name: string }>;
  threadAbbr?: string;
}): AgentProfile {
  const cli = opts.cliPath?.trim() || "copilot";
  const additionalMcpJson = buildCopilotMcpConfigJson(opts.mcpServers ?? []);
  const configDir = opts.configDir?.trim() || undefined;

  let identityCache: AgentIdentity | null | undefined;

  return {
    id: opts.id ?? "copilot",
    displayName: opts.displayName ?? "GitHub Copilot",
    defaultModel: opts.defaultModel,
    staticModels: opts.staticModels,
    threadAbbr: opts.threadAbbr,
    configDir,
    spawn() {
      const args = ["--acp"];
      if (additionalMcpJson) {
        args.push("--additional-mcp-config", additionalMcpJson);
      }
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (configDir) {
        // --config-dir is not a supported CLI flag. Instead, read the OAuth
        // token from the profile's config.json and inject it via
        // COPILOT_GITHUB_TOKEN, which the CLI checks before the system
        // credential store — giving us true per-profile auth isolation.
        const token = readCopilotTokenSync(configDir);
        if (token) env.COPILOT_GITHUB_TOKEN = token;
      }
      return spawn(cli, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env,
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
 * Synchronously read the OAuth token for the last logged-in user from a
 * Copilot config.json. Used at spawn time to inject COPILOT_GITHUB_TOKEN.
 * Returns undefined on any failure.
 */
function readCopilotTokenSync(configDir: string): string | undefined {
  const file = path.join(configDir, "config.json");
  try {
    // Strip JS-style comments before parsing (Copilot uses JSONC)
    const raw = fs.readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "");
    const parsed = JSON.parse(raw) as {
      lastLoggedInUser?: { host?: string; login?: string };
      copilotTokens?: Record<string, string>;
    };
    const u = parsed.lastLoggedInUser;
    if (!u?.host || !u?.login) return undefined;
    const key = `${u.host}:${u.login}`;
    return parsed.copilotTokens?.[key];
  } catch {
    return undefined;
  }
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

export interface CopilotQuotaSnapshot {
  unlimited: boolean;
  entitlement: number;
  remaining: number;
  percentRemaining: number;
  overagePermitted: boolean;
  overageCount: number;
}

export interface CopilotUsageData {
  login: string | null;
  plan: string | null;
  org: string | null;
  quotaResetAt: string | null;
  chat: CopilotQuotaSnapshot | null;
  completions: CopilotQuotaSnapshot | null;
  premiumInteractions: CopilotQuotaSnapshot | null;
}

/**
 * Fetches Copilot plan and quota data from GitHub's internal user endpoint.
 * Uses the OAuth token stored in config.json. Returns what it can on failure.
 */
export async function fetchCopilotUsage(
  configDir?: string
): Promise<CopilotUsageData> {
  const dir = configDir?.trim() || path.join(process.env.HOME ?? "", ".copilot");
  const result: CopilotUsageData = {
    login: null,
    plan: null,
    org: null,
    quotaResetAt: null,
    chat: null,
    completions: null,
    premiumInteractions: null,
  };
  const identity = await readCopilotIdentity(configDir);
  if (identity?.login) result.login = identity.login;
  const token = readCopilotTokenSync(dir);
  if (!token) return result;
  try {
    const res = await fetch("https://api.github.com/copilot_internal/user", {
      headers: { Authorization: `token ${token}`, Accept: "application/json" },
    });
    if (res.ok) {
      const body = (await res.json()) as Record<string, unknown>;
      result.login = (body.login as string | undefined) ?? result.login;
      result.plan = (body.copilot_plan as string | undefined) ?? null;
      result.quotaResetAt = (body.quota_reset_date_utc as string | undefined) ?? null;
      const orgs = body.organization_list as Array<{ name?: string; login?: string }> | undefined;
      if (orgs && orgs.length > 0) result.org = orgs[0]?.name ?? orgs[0]?.login ?? null;
      const snaps = body.quota_snapshots as Record<string, unknown> | undefined;
      if (snaps) {
        result.chat = parseQuota(snaps.chat);
        result.completions = parseQuota(snaps.completions);
        result.premiumInteractions = parseQuota(snaps.premium_interactions);
      }
    }
  } catch {
    /* return what we have */
  }
  return result;
}

function parseQuota(raw: unknown): CopilotQuotaSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    unlimited: r.unlimited === true,
    entitlement: typeof r.entitlement === "number" ? r.entitlement : 0,
    remaining: typeof r.remaining === "number" ? r.remaining : 0,
    percentRemaining: typeof r.percent_remaining === "number" ? r.percent_remaining : 0,
    overagePermitted: r.overage_permitted === true,
    overageCount: typeof r.overage_count === "number" ? r.overage_count : 0,
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

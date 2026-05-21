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
  staticModels?: ReadonlyArray<{ modelId: string; name: string }>;
  threadAbbr?: string;
  /** Default model id for sessions on this profile (e.g. "claude-sonnet-4.5"). */
  defaultModel: string;
  /**
   * Extended-thinking budget in tokens. The adapter only emits
   * `agent_thought_chunk` when its child sees `MAX_THINKING_TOKENS` in the
   * env, so we forward this through. 0 / undefined leaves thinking off.
   */
  maxThinkingTokens?: number;
  /** Accepted for parity; unused — MCP servers are forwarded via ACP. */
  mcpServers?: McpServer[];
}): AgentProfile {
  const cli = opts.cliPath?.trim() || "claude-agent-acp";
  const configDir = opts.configDir?.trim() || undefined;
  const maxThinkingTokens = opts.maxThinkingTokens;

  let identityCache: AgentIdentity | null | undefined;

  return {
    id: opts.id ?? "claude",
    displayName: opts.displayName ?? "Anthropic Claude",
    defaultModel: opts.defaultModel,
    staticModels: opts.staticModels,
    threadAbbr: opts.threadAbbr,
    configDir,
    spawn() {
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
      if (maxThinkingTokens && maxThinkingTokens > 0) {
        env.MAX_THINKING_TOKENS = String(maxThinkingTokens);
      }
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

export interface ClaudeUsageBucket {
  utilization: number;
  resetsAt: string | null;
}

export interface ClaudeUsageData {
  login: string | null;
  subscriptionType: string | null;
  rateLimitTier: string | null;
  fiveHour: ClaudeUsageBucket | null;
  sevenDay: ClaudeUsageBucket | null;
  sevenDaySonnet: ClaudeUsageBucket | null;
  sevenDayOpus: ClaudeUsageBucket | null;
  extraUsage: {
    enabled: boolean;
    used: number;
    limit: number;
    utilization: number;
    currency: string;
  } | null;
}

/**
 * Reads subscription info from credentials, then calls the same
 * `/api/oauth/usage` endpoint Claude Code's `/usage` command uses to
 * fetch utilization. Requires the `oauth-2025-04-20` beta header.
 * Returns whatever fields could be populated; never throws.
 */
export async function fetchClaudeUsage(
  configDir?: string
): Promise<ClaudeUsageData> {
  const dir = configDir?.trim() || path.join(process.env.HOME ?? "", ".claude");
  const result: ClaudeUsageData = {
    login: null,
    subscriptionType: null,
    rateLimitTier: null,
    fiveHour: null,
    sevenDay: null,
    sevenDaySonnet: null,
    sevenDayOpus: null,
    extraUsage: null,
  };
  let accessToken: string | null = null;
  const candidates = [
    path.join(dir, ".credentials.json"),
    path.join(dir, "credentials.json"),
  ];
  for (const file of candidates) {
    try {
      const raw = await fsp.readFile(file, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const oauth = parsed.claudeAiOauth as Record<string, unknown> | undefined;
      result.login =
        pickLogin(parsed) ??
        (oauth ? pickStringField(oauth as Record<string, unknown>, ["email", "login"]) : undefined) ??
        null;
      result.subscriptionType = pickStringField(oauth ?? {}, ["subscriptionType"]) ?? null;
      result.rateLimitTier = pickStringField(oauth ?? {}, ["rateLimitTier"]) ?? null;
      const tok = pickStringField(oauth ?? {}, ["accessToken"]);
      if (tok) accessToken = tok;
      break;
    } catch {
      /* try next */
    }
  }
  if (!result.login) {
    const identity = await readClaudeIdentity(configDir);
    if (identity?.login) result.login = identity.login;
  }
  if (accessToken) {
    try {
      const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
      });
      if (res.ok) {
        const body = (await res.json()) as Record<string, unknown>;
        result.fiveHour = parseBucket(body.five_hour);
        result.sevenDay = parseBucket(body.seven_day);
        result.sevenDaySonnet = parseBucket(body.seven_day_sonnet);
        result.sevenDayOpus = parseBucket(body.seven_day_opus);
        const extra = body.extra_usage as Record<string, unknown> | null | undefined;
        if (extra && typeof extra === "object") {
          result.extraUsage = {
            enabled: extra.is_enabled === true,
            used: typeof extra.used_credits === "number" ? extra.used_credits : 0,
            limit: typeof extra.monthly_limit === "number" ? extra.monthly_limit : 0,
            utilization: typeof extra.utilization === "number" ? extra.utilization : 0,
            currency: typeof extra.currency === "string" ? extra.currency : "USD",
          };
        }
      }
    } catch {
      /* network failure — return what we have from credentials */
    }
  }
  return result;
}

function parseBucket(raw: unknown): ClaudeUsageBucket | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.utilization !== "number") return null;
  return {
    utilization: r.utilization,
    resetsAt: typeof r.resets_at === "string" ? r.resets_at : null,
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

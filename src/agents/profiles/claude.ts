import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { AgentIdentity, AgentProfile } from "../agent-profile.js";
import type { SessionSummary, SessionSummaryLine } from "../session-manager.js";

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
  /** Optional context token threshold to trigger context compaction. */
  compactionTokenThreshold?: number;
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
        detached: true,
      });
    },
    newSessionMeta(modelId?: string) {
      const model = modelId || opts.defaultModel;
      let threshold = opts.compactionTokenThreshold;
      if (threshold && threshold > 0) {
        if (threshold <= 1.0) {
          const cw = getClaudeContextWindow(model);
          threshold = Math.round(cw * threshold);
        }
        return {
          claudeCode: {
            options: {
              compactionControl: {
                enabled: true,
                contextTokenThreshold: threshold,
              },
            },
          },
        };
      }
      return undefined;
    },
    async whoami() {
      if (identityCache !== undefined) return identityCache;
      identityCache = await readClaudeIdentity(configDir);
      return identityCache;
    },
    sessionManager: {
      async listSessions(cwd: string): Promise<SessionSummary[]> {
        const dir = configDir ?? path.join(process.env.HOME ?? "", ".claude");
        const slug = cwd.replace(/\//g, "-");
        const projectDir = path.join(dir, "projects", slug);

        try {
          const files = await fsp.readdir(projectDir);
          const summaries: SessionSummary[] = [];

          for (const file of files) {
            if (!file.endsWith(".jsonl")) continue;
            const sessionId = file.slice(0, -6);
            const filePath = path.join(projectDir, file);

            try {
              const stat = await fsp.stat(filePath);
              let createdAt = stat.birthtimeMs;
              let lastActivityAt = stat.mtimeMs;

              const content = await fsp.readFile(filePath, "utf8");
              const lines = content.split("\n").filter(l => l.trim().length > 0);
              
              const allMessages: Array<{ sender: "human" | "agent"; text: string; timestamp?: number }> = [];

              for (const line of lines) {
                try {
                  const entry = JSON.parse(line);
                  if (entry.isMeta === true || entry.isSidechain === true) continue;
                  
                  let text = "";
                  if (entry.type === "user") {
                    const msgContent = entry.message?.content;
                    if (typeof msgContent === "string") {
                      text = msgContent;
                    } else if (Array.isArray(msgContent)) {
                      text = msgContent
                        .filter((c: any) => c.type === "text")
                        .map((c: any) => c.text || "")
                        .join("\n");
                    }
                    
                    const ts = entry.timestamp ? Date.parse(entry.timestamp) : undefined;
                    allMessages.push({ sender: "human", text, timestamp: ts });
                  } else if (entry.type === "assistant") {
                    const msgContent = entry.message?.content;
                    if (typeof msgContent === "string") {
                      text = msgContent;
                    } else if (Array.isArray(msgContent)) {
                      text = msgContent
                        .filter((c: any) => c.type === "text")
                        .map((c: any) => c.text || "")
                        .join("\n");
                    }
                    
                    const ts = entry.timestamp ? Date.parse(entry.timestamp) : undefined;
                    allMessages.push({ sender: "agent", text, timestamp: ts });
                  }
                } catch {
                  // ignore malformed lines
                }
              }

              // Extract timestamps from messages if available
              const validTimestamps = allMessages
                .map(m => m.timestamp)
                .filter((t): t is number => t !== undefined && !isNaN(t));
              if (validTimestamps.length > 0) {
                createdAt = validTimestamps[0]!;
                lastActivityAt = validTimestamps[validTimestamps.length - 1]!;
              }

              // Heuristic slice: first 6 and last 10 messages
              let previewLines: SessionSummaryLine[] = [];
              if (allMessages.length <= 16) {
                previewLines = allMessages.map(m => ({ sender: m.sender, text: m.text }));
              } else {
                const firstSix = allMessages.slice(0, 6);
                const lastTen = allMessages.slice(-10);
                previewLines = [...firstSix, ...lastTen].map(m => ({ sender: m.sender, text: m.text }));
              }

              const transcriptLines: string[] = [];
              for (const m of allMessages) {
                if (m.text.trim()) {
                  const prefix = m.sender === "human" ? "### User\n" : "### Assistant\n";
                  transcriptLines.push(`${prefix}${m.text.trim()}`);
                }
              }
              const estimatedTokens = Math.ceil(transcriptLines.join("\n\n").length / 4);

              summaries.push({
                sessionId,
                createdAt,
                lastActivityAt,
                previewLines,
                estimatedTokens,
              });
            } catch (err) {
              // Ignore individual session parsing errors
            }
          }

          // Sort by lastActivityAt desc
          return summaries.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
        } catch (err) {
          // If directory doesn't exist or is unreadable, return empty list
          return [];
        }
      },

      async cloneSession(cwd: string, oldSessionId: string, newSessionId: string): Promise<void> {
        const dir = configDir ?? path.join(process.env.HOME ?? "", ".claude");
        const slug = cwd.replace(/\//g, "-");
        const projectDir = path.join(dir, "projects", slug);

        const oldFile = path.join(projectDir, `${oldSessionId}.jsonl`);
        const newFile = path.join(projectDir, `${newSessionId}.jsonl`);

        // Read old file, replace sessionId in JSON lines, write to new file
        const content = await fsp.readFile(oldFile, "utf8");
        const lines = content.split("\n");
        const newLines: string[] = [];

        for (const line of lines) {
          if (!line.trim()) {
            newLines.push("");
            continue;
          }
          try {
            const entry = JSON.parse(line);
            if (entry.sessionId === oldSessionId) {
              entry.sessionId = newSessionId;
            }
            newLines.push(JSON.stringify(entry));
          } catch {
            newLines.push(line.replace(new RegExp(oldSessionId, "g"), newSessionId));
          }
        }

        await fsp.writeFile(newFile, newLines.join("\n"), "utf8");

        // Clone the directory too, if it exists
        const oldSubDir = path.join(projectDir, oldSessionId);
        const newSubDir = path.join(projectDir, newSessionId);
        try {
          const stat = await fsp.stat(oldSubDir);
          if (stat.isDirectory()) {
            await fsp.cp(oldSubDir, newSubDir, { recursive: true });
          }
        } catch {
          // subdirectory might not exist, ignore
        }
      },

      async deleteSession(cwd: string, sessionId: string): Promise<void> {
        const dir = configDir ?? path.join(process.env.HOME ?? "", ".claude");
        const slug = cwd.replace(/\//g, "-");
        const projectDir = path.join(dir, "projects", slug);

        const file = path.join(projectDir, `${sessionId}.jsonl`);
        try {
          await fsp.unlink(file);
        } catch {
          // ignore
        }

        const subDir = path.join(projectDir, sessionId);
        try {
          await fsp.rm(subDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      },

      async getTranscript(cwd: string, sessionId: string): Promise<string> {
        const dir = configDir ?? path.join(process.env.HOME ?? "", ".claude");
        const slug = cwd.replace(/\//g, "-");
        const projectDir = path.join(dir, "projects", slug);
        const file = path.join(projectDir, `${sessionId}.jsonl`);

        const content = await fsp.readFile(file, "utf8");
        const lines = content.split("\n").filter(l => l.trim().length > 0);
        const transcriptLines: string[] = [];

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.isMeta === true || entry.isSidechain === true) continue;

            let text = "";
            if (entry.type === "user") {
              const msgContent = entry.message?.content;
              if (typeof msgContent === "string") {
                text = msgContent;
              } else if (Array.isArray(msgContent)) {
                text = msgContent
                  .filter((c: any) => c.type === "text")
                  .map((c: any) => c.text || "")
                  .join("\n");
              }
              if (text.trim()) {
                transcriptLines.push(`### User\n${text.trim()}`);
              }
            } else if (entry.type === "assistant") {
              const msgContent = entry.message?.content;
              if (typeof msgContent === "string") {
                text = msgContent;
              } else if (Array.isArray(msgContent)) {
                text = msgContent
                  .filter((c: any) => c.type === "text")
                  .map((c: any) => c.text || "")
                  .join("\n");
              }
              if (text.trim()) {
                transcriptLines.push(`### Assistant\n${text.trim()}`);
              }
            }
          } catch {
            // ignore
          }
        }

        return transcriptLines.join("\n\n");
      },

      async repairSession(cwd: string, sessionId: string): Promise<void> {
        const dir = configDir ?? path.join(process.env.HOME ?? "", ".claude");
        const slug = cwd.replace(/\//g, "-");
        const projectDir = path.join(dir, "projects", slug);
        const file = path.join(projectDir, `${sessionId}.jsonl`);

        const content = await fsp.readFile(file, "utf8");
        const lines = content.split("\n");
        
        let lastAssistantIdx = -1;
        for (let i = lines.length - 1; i >= 0; i--) {
          const rawLine = lines[i];
          if (rawLine === undefined) continue;
          const line = rawLine.trim();
          if (!line) continue;
          try {
            const entry = JSON.parse(line);
            if (entry.type === "assistant") {
              lastAssistantIdx = i;
              break;
            }
          } catch {
            // ignore
          }
        }

        let linesToSave: string[] = [];
        if (lastAssistantIdx !== -1) {
          const keptLines = lines.slice(0, lastAssistantIdx + 1);
          
          for (let j = lastAssistantIdx + 1; j < lines.length; j++) {
            const rawLine = lines[j];
            if (rawLine === undefined) continue;
            const line = rawLine.trim();
            if (!line) continue;
            try {
              const entry = JSON.parse(line);
              if (entry.type !== "user" && entry.type !== "assistant") {
                keptLines.push(rawLine);
              } else {
                break;
              }
            } catch {
              break;
            }
          }
          linesToSave = keptLines;
        } else {
          linesToSave = lines;
        }

        const sanitizeEntry = (entry: any): any => {
          if (!entry || typeof entry !== "object") return entry;
          try {
            if (entry.message && typeof entry.message === "object" && Array.isArray(entry.message.content)) {
              entry.message.content = entry.message.content.map((block: any) => {
                if (!block || typeof block !== "object") return block;
                if (block.type === "image") {
                  return {
                    type: "text",
                    text: "[Image removed to prevent prompt size limit failure]"
                  };
                }
                if (block.type === "tool_result" && Array.isArray(block.content)) {
                  block.content = block.content.map((subBlock: any) => {
                    if (subBlock && typeof subBlock === "object" && subBlock.type === "image") {
                      return {
                        type: "text",
                        text: "[Image removed to prevent prompt size limit failure]"
                      };
                    }
                    return subBlock;
                  });
                }
                return block;
              });
            }

            if (entry.toolUseResult && typeof entry.toolUseResult === "object" && entry.toolUseResult.file && typeof entry.toolUseResult.file === "object") {
              if (typeof entry.toolUseResult.file.base64 === "string") {
                entry.toolUseResult.file.base64 = "[Stripped]";
              }
            }
          } catch {
            // ignore
          }
          return entry;
        };

        const sanitizedLines = linesToSave.map((rawLine) => {
          const trimmed = rawLine.trim();
          if (!trimmed) return rawLine;
          try {
            const entry = JSON.parse(trimmed);
            const sanitized = sanitizeEntry(entry);
            return JSON.stringify(sanitized);
          } catch {
            return rawLine;
          }
        });

        await fsp.writeFile(file, sanitizedLines.join("\n"), "utf8");
      },

      async compactSession(cwd: string, sessionId: string, summaryText: string): Promise<void> {
        const dir = configDir ?? path.join(process.env.HOME ?? "", ".claude");
        const slug = cwd.replace(/\//g, "-");
        const projectDir = path.join(dir, "projects", slug);
        const file = path.join(projectDir, `${sessionId}.jsonl`);

        const now = new Date().toISOString();
        const userUuid = crypto.randomUUID();
        const assistantUuid = crypto.randomUUID();

        const userEntry = {
          type: "user",
          message: {
            role: "user",
            content: "[Session history compacted due to context limits]"
          },
          uuid: userUuid,
          timestamp: now,
          sessionId,
          cwd
        };

        const assistantEntry = {
          type: "assistant",
          message: {
            role: "assistant",
            content: summaryText
          },
          uuid: assistantUuid,
          parentUuid: userUuid,
          timestamp: now,
          sessionId,
          cwd
        };

        await fsp.writeFile(
          file,
          JSON.stringify(userEntry) + "\n" + JSON.stringify(assistantEntry) + "\n",
          "utf8"
        );
      }
    }
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

function getClaudeContextWindow(modelId?: string): number {
  if (!modelId) return 200_000;
  if (/\b1m\b/i.test(modelId) || /-1m\b/i.test(modelId)) return 1_000_000;
  return 200_000;
}

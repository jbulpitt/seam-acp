import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { McpServer } from "@agentclientprotocol/sdk";
import {
  asLocalAdapter,
  type AdapterModel,
  type AgentIdentity,
  type AgentProfile,
} from "../agent-profile.js";
import type { SessionSummary, SessionSummaryLine } from "../session-manager.js";

/**
 * Resolve the Claude Code projects directory for a given cwd. Claude Code's
 * slug algorithm replaces both `/` and `.` with `-`, but our naive
 * `cwd.replace(/\//g, "-")` leaves dots intact. When the cwd contains a dot
 * (e.g. `.od`), the computed slug won't match the directory on disk.
 *
 * Fast path: if the computed slug exists, use it. Otherwise scan all project
 * dirs and match with a normalised comparison (dots→dashes, collapse runs).
 */
async function resolveProjectDir(claudeDir: string, cwd: string): Promise<string> {
  const slug = cwd.replace(/\//g, "-");
  const computed = path.join(claudeDir, "projects", slug);
  try {
    await fsp.access(computed);
    return computed;
  } catch { /* try scan */ }

  const projectsRoot = path.join(claudeDir, "projects");
  let entries: string[];
  try {
    entries = await fsp.readdir(projectsRoot);
  } catch {
    return computed;
  }

  const norm = (s: string) =>
    s.toLowerCase().replace(/\./g, "-").replace(/-+/g, "-");
  const target = norm(slug);
  const match = entries.find((e) => norm(e) === target);
  return match ? path.join(projectsRoot, match) : computed;
}

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
  staticModels?: ReadonlyArray<AdapterModel>;
  /** Default model id for sessions on this profile (e.g. "claude-sonnet-4.5"). */
  defaultModel: string;
  /**
   * Optional fixed thinking budget, forwarded as the deprecated
   * `MAX_THINKING_TOKENS` env var. 0 / undefined leaves it unset — modern models
   * still stream thinking on their own (Sonnet 4.6, Haiku 4.5), and adaptive
   * models (Opus 4.6+) ignore it. Only set to cap/force a budget on an older
   * model. Thinking *visibility* for Opus is governed by `thinkingDisplay`.
   */
  maxThinkingTokens?: number;
  /**
   * How thinking content is surfaced for adaptive-thinking models (Opus 4.6+),
   * via `_meta.claudeCode.options.thinking.display`. These models default to
   * "omitted" (empty thought chunks); "summarized" makes them stream a readable
   * summary of their reasoning. Non-adaptive models (Sonnet/Haiku) ignore this —
   * they already stream thinking via the maxThinkingTokens path.
   */
  thinkingDisplay?: "summarized" | "omitted";
  /**
   * Override the effort descriptor. Defaults to the Anthropic meta-effort path
   * (low|medium|high|xhigh|max via _meta). Set to {mechanism:"none",levels:[]}
   * for non-Anthropic backends (e.g. a Claude Code instance routed to Ollama) so
   * the `/seam effort` picker correctly reports effort isn't settable.
   */
  effort?: AgentProfile["effort"];
  /** Accepted for parity; unused — MCP servers are forwarded via ACP. */
  mcpServers?: McpServer[];
  /** Optional context token threshold to trigger context compaction. */
  compactionTokenThreshold?: number;
  /** Custom environment variables to inject into the spawned process environment. */
  extraEnv?: Record<string, string>;
  /**
   * Status-card brand key (#96). Override for Claude-harness profiles that
   * are not Anthropic (zai → `z-ai`, ollama-cloud, claude-vertex → `vertex`).
   */
  brand?: string;
}): AgentProfile {
  const cli = opts.cliPath?.trim() || "claude-agent-acp";
  const configDir = opts.configDir?.trim() || undefined;
  const maxThinkingTokens = opts.maxThinkingTokens;
  const thinkingDisplay = opts.thinkingDisplay;

  let identityCache: AgentIdentity | null | undefined;

  return asLocalAdapter({
    id: opts.id ?? "claude",
    displayName: opts.displayName ?? "Anthropic Claude",
    ...(opts.brand ? { brand: opts.brand } : {}),
    defaultModel: opts.defaultModel,
    // Stamp each picker entry with its canonical contextLimit so the
    // orchestrator's staticModels→modelContextFloor path (used by every other
    // agent) also seeds the Claude display window.
    staticModels: opts.staticModels
      ? withClaudeContextLimits(opts.staticModels)
      : undefined,
    configDir,
    // Effort is applied via `_meta.claudeCode.options.effort` in newSessionMeta.
    // Overridable for non-Anthropic backends (e.g. Ollama → mechanism "none").
    effort: opts.effort ?? { mechanism: "meta", levels: ["low", "medium", "high", "xhigh", "max"] },
    spawn(modelOverride?: string, _effortOverride?: string) {
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
      if (maxThinkingTokens && maxThinkingTokens > 0) {
        env.MAX_THINKING_TOKENS = String(maxThinkingTokens);
      }
      if (opts.extraEnv) {
        for (const [k, v] of Object.entries(opts.extraEnv)) {
          if (v !== undefined) {
            env[k] = v;
          }
        }
        if (opts.extraEnv.CLAUDE_CODE_USE_VERTEX === "1") {
          delete env.ANTHROPIC_API_KEY;
        }
      }
      // For non-Anthropic backends (Ollama Cloud, Z.ai, etc.): override the
      // model env vars so the adapter sends the right model to the backend.
      // setModel() (ACP config option) is rejected by claude-agent-acp for
      // non-Claude model IDs, so this is the only way to switch models.
      if (modelOverride && opts.extraEnv?.ANTHROPIC_BASE_URL) {
        env.ANTHROPIC_MODEL = modelOverride;
        env.ANTHROPIC_DEFAULT_SONNET_MODEL = modelOverride;
        env.ANTHROPIC_DEFAULT_HAIKU_MODEL = modelOverride;
        env.ANTHROPIC_DEFAULT_OPUS_MODEL = modelOverride;
      } else if (modelOverride && isForwardableFullModelId(modelOverride)) {
        // Direct Anthropic backend: this account's claude-agent-acp advertises
        // only a fixed alias set (default/sonnet/haiku/opus[1m]/…). A full
        // canonical ID that isn't advertised (e.g. a model that shipped after
        // this CLI version) is REJECTED by setSessionConfigOption("model", …)
        // with "Invalid value for config option model", and the session
        // silently falls back to the wrapper's default (observed: Sonnet). The
        // API itself can serve the model the day it ships, so forward it via
        // ANTHROPIC_MODEL — this both REGISTERS it in availableModels (so the
        // later set_config_option succeeds) AND selects it, no CLI upgrade
        // needed. Only ANTHROPIC_MODEL (the primary model) is set; the
        // small/fast/subagent model envs are left alone. Aliases like `default`
        // are intentionally excluded so Anthropic can keep pointing them at the
        // newest model server-side.
        env.ANTHROPIC_MODEL = modelOverride;
      }
      return spawn(cli, [], {
        stdio: ["pipe", "pipe", "pipe"],
        env,
        detached: true,
      });
    },
    newSessionMeta(modelId?: string, effort?: string) {
      const model = modelId || opts.defaultModel;
      const options: Record<string, unknown> = {};

      let threshold = opts.compactionTokenThreshold;
      if (threshold && threshold > 0) {
        if (threshold <= 1.0) {
          const cw = getClaudeContextWindow(model);
          threshold = Math.round(cw * threshold);
        }
        options.compactionControl = {
          enabled: true,
          contextTokenThreshold: threshold,
        };
      }

      // Reasoning effort is injected via _meta.claudeCode.options.effort, which
      // claude-agent-acp spreads straight into the SDK query Options.effort.
      // Seam uses this path for both new and resumed sessions. The 0.73.0
      // wrapper also exposes an ACP effort config option, but the query option
      // keeps stored thread configuration independent of wrapper UI state.
      // Verify applied values from the assistant JSONL entry's top-level
      // `effort` field; session/new no longer rejects arbitrary strings.
      if (effort && effort !== "default") {
        options.effort = effort;
      }

      // Thinking display: adaptive-thinking models (Opus 4.6+) default to
      // "omitted" — their reasoning never surfaces. Forwarding an adaptive
      // ThinkingConfig with display lets us show a summary. Verified end-to-end:
      // `thinking:{type:'adaptive',display:'summarized'}` flips Opus 4.8 from
      // empty thought chunks to readable summarized reasoning. Only applied to
      // adaptive models — Sonnet/Haiku stream thinking via the budget path.
      if (thinkingDisplay && isAdaptiveThinkingModel(model)) {
        options.thinking = { type: "adaptive", display: thinkingDisplay };
      }

      if (Object.keys(options).length === 0) return undefined;
      return { claudeCode: { options } };
    },
    async whoami() {
      if (identityCache !== undefined) return identityCache;
      identityCache = await readClaudeIdentity(configDir);
      return identityCache;
    },
    sessionManager: {
      async listSessions(cwd: string): Promise<SessionSummary[]> {
        const dir = configDir ?? path.join(process.env.HOME ?? "", ".claude");
        const projectDir = await resolveProjectDir(dir, cwd);

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
              // Real context size = the last assistant turn's usage (input + cache
              // + output), which counts tool I/O, thinking, and cache the text-only
              // estimate misses. Falls back to the char estimate when no turn has
              // usage (e.g. a freshly compacted session).
              let lastUsage: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens?: number } | null = null;

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
                    if (entry.message?.usage) lastUsage = entry.message.usage;
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
              const realTokens = lastUsage
                ? (lastUsage.input_tokens || 0) + (lastUsage.cache_read_input_tokens || 0) +
                  (lastUsage.cache_creation_input_tokens || 0) + (lastUsage.output_tokens || 0)
                : 0;
              const estimatedTokens = realTokens > 0
                ? realTokens
                : Math.ceil(transcriptLines.join("\n\n").length / 4);

              summaries.push({
                sessionId,
                createdAt,
                lastActivityAt,
                previewLines,
                estimatedTokens,
                tokensFromUsage: realTokens > 0,
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
        const projectDir = await resolveProjectDir(dir, cwd);

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
        const projectDir = await resolveProjectDir(dir, cwd);

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

      async getUsage(cwd: string, sessionId?: string, newerThanMs?: number) {
        const empty = { model: null, totalUsed: 0, contextLimit: 200_000 };
        const dir = configDir ?? path.join(process.env.HOME ?? "", ".claude");
        const projectDir = await resolveProjectDir(dir, cwd);
        let targetPath: string | undefined;
        if (sessionId) {
          targetPath = path.join(projectDir, `${sessionId}.jsonl`);
          try { await fsp.access(targetPath); } catch { targetPath = undefined; }
        }
        if (!targetPath) {
          try {
            const files = await fsp.readdir(projectDir);
            let newestMtime = 0;
            for (const f of files) {
              if (!f.endsWith(".jsonl")) continue;
              const stat = await fsp.stat(path.join(projectDir, f));
              if (stat.mtimeMs > newestMtime) {
                newestMtime = stat.mtimeMs;
                targetPath = path.join(projectDir, f);
              }
            }
          } catch { return empty; }
        }
        if (!targetPath) return empty;
        let content: string;
        try { content = await fsp.readFile(targetPath, "utf8"); }
        catch { return empty; }
        const lines = content.split("\n").filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const entry = JSON.parse(lines[i]!);
            if (entry.type !== "assistant" || !entry.message?.usage) continue;
            // If a timestamp filter is provided, skip entries older than the threshold.
            if (newerThanMs !== undefined && entry.timestamp) {
              const entryMs = Date.parse(entry.timestamp);
              if (!isNaN(entryMs) && entryMs < newerThanMs) continue;
            }
            const u = entry.message.usage;
            const model = entry.message.model ?? null;
            const input = u.input_tokens || 0;
            const cacheRead = u.cache_read_input_tokens || 0;
            const cacheCreation = u.cache_creation_input_tokens || 0;
            const output = u.output_tokens || 0;
            const totalUsed = input + cacheRead + cacheCreation + output;
            // Best-effort fallback from the JSONL model id (the orchestrator's
            // monotonic ceiling + the agent-reported UsageUpdate.size are the
            // real source). Uses the same canonical table as compaction so the
            // two never diverge.
            const contextLimit = getClaudeContextWindow(model ?? undefined);
            return {
              model,
              totalUsed,
              contextLimit,
            };
          } catch { /* skip malformed */ }
        }
        return empty;
      },

      async getHistoryPath(cwd: string, sessionId: string): Promise<string | undefined> {
        const dir = configDir ?? path.join(process.env.HOME ?? "", ".claude");
        const projectDir = await resolveProjectDir(dir, cwd);
        const file = path.join(projectDir, `${sessionId}.jsonl`);
        try {
          await fsp.access(file);
          return file;
        } catch {
          return undefined;
        }
      },

      async getTranscript(cwd: string, sessionId: string): Promise<string> {
        const dir = configDir ?? path.join(process.env.HOME ?? "", ".claude");
        const projectDir = await resolveProjectDir(dir, cwd);
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
        const projectDir = await resolveProjectDir(dir, cwd);
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
      }
    },
  });
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
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
    };
    // The OAuth usage endpoint occasionally 429s / times out; a couple of quick
    // retries keep a single transient blip from surfacing as "quota
    // unavailable" (the cold-start case last-known-good retention can't cover).
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
          headers,
          signal: AbortSignal.timeout(8000),
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
          break;
        }
        // Only 429/408/5xx are worth retrying; other 4xx (auth) won't recover.
        if (res.status !== 429 && res.status !== 408 && res.status < 500) break;
      } catch {
        /* network failure / timeout — retry, then fall back to credential-only data */
      }
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
      }
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

/** Canonical context windows for Claude models, keyed by full model id. Single
 *  source of truth for BOTH auto-compaction sizing (newSessionMeta) and the
 *  staticModels `contextLimit` the orchestrator uses to seed the display window.
 *
 *  Since claude-agent-acp ≥0.42 resolves full canonical IDs correctly and 1.x
 *  reports the true window at runtime (ACP UsageUpdate.size), model IDs no
 *  longer carry a `[1m]` suffix — each model just declares its native window
 *  here, and the agent-reported size refines this seed once a turn completes. */
const CLAUDE_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-fable-5-1": 1_000_000,
  "claude-opus-5": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 200_000,
  "claude-fable-5": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5": 200_000,
};

/** Family fallback for ids not in the exact table (dated ids, future point
 *  releases): Opus 4.7+ and Opus 5+, Sonnet 5+, and Fable/Mythos 5+ are 1M;
 *  Opus 4.6 and older, Sonnet 4.6 and older, and Haiku are 200K. */
function claudeContextWindowFamily(id: string): number {
  if (/opus-(?:4[.-](?:[7-9]|\d{2,})|[5-9]|\d{2,})\b/.test(id)) return 1_000_000;
  if (/(?:sonnet|fable|mythos)-(?:[5-9]|\d{2,})\b/.test(id)) return 1_000_000;
  return 200_000;
}

/** Whether a model id should be force-forwarded to the direct Anthropic backend
 *  via `ANTHROPIC_MODEL` at spawn time (see `spawn()`). True for full canonical
 *  Claude IDs (`claude-<family>-<version>`, e.g. `claude-opus-5`,
 *  `claude-sonnet-4-6`), which an older claude-agent-acp may not advertise and
 *  would therefore REJECT via `set_config_option` — forwarding makes them
 *  reachable + selected with no CLI upgrade. False for aliases (`default`,
 *  `sonnet`, `haiku`, `opus`, …) and empty values: those resolve through the
 *  wrapper's advertised list and are intentionally left dynamic so the backend
 *  can keep pointing them at the newest model server-side. */
export function isForwardableFullModelId(modelId?: string): boolean {
  if (!modelId) return false;
  return /^claude-[a-z]+-\d/.test(modelId.trim().toLowerCase());
}

/** Map a model id to its TRUE context window, which drives the auto-compaction
 *  threshold in newSessionMeta. Getting this wrong causes premature compaction
 *  (a 200K threshold on a 1M model throws away 800K of usable context). */
export function getClaudeContextWindow(modelId?: string): number {
  if (!modelId) return 200_000;
  // `default` resolves to the latest Opus on Max/Team-Premium → 1M. (On lower
  // tiers it is Sonnet 200K; revisit if this bot ever runs on a non-Max account.)
  const id = modelId.trim().toLowerCase().replace(/\[1m\]$/, "");
  if (id === "default") return 1_000_000;
  if (/\b1m\b/.test(id)) return 1_000_000; // tolerate any residual legacy suffix
  return CLAUDE_CONTEXT_WINDOWS[id] ?? claudeContextWindowFamily(id);
}

/** Stamp each picker entry with its canonical contextLimit so the orchestrator's
 *  `staticModels[].contextLimit → modelContextFloor` path (shared with every
 *  other agent) also works for Claude, seeding the display window on turn 1. */
function withClaudeContextLimits<T extends { modelId: string; name: string; contextLimit?: number }>(
  models: ReadonlyArray<T>
): Array<T & { contextLimit: number }> {
  return models.map((m) => ({
    ...m,
    // Preserve explicit contextLimit (e.g. from OLLAMA_CLOUD_STATIC_MODELS or
    // ZAI_STATIC_MODELS) — only fall back to the Claude lookup for models that
    // don't already declare one.
    contextLimit: m.contextLimit ?? getClaudeContextWindow(m.modelId),
  }));
}

/** Whether a model uses ADAPTIVE thinking (the SDK's ThinkingConfig marks this
 *  "Opus 4.6+"), which is the family whose thinking display defaults to
 *  "omitted". Only these take a `thinking:{type:'adaptive',display}` override;
 *  Sonnet/Haiku stream thinking via the budget path and are left untouched.
 *   - `default` → latest Opus on Max → adaptive.
 *   - claude-opus-4-6 and newer (4-6, 4-7, 4-8, … 4-10+, 5, …); 4-5 and older are not. */
function isAdaptiveThinkingModel(modelId?: string): boolean {
  if (!modelId) return false;
  const m = modelId.toLowerCase().trim();
  if (m === "default") return true;
  // Opus 4.6+, Opus 5+, Sonnet 5+, and Fable/Mythos 5+ are always-on adaptive
  // thinking; Sonnet 4.6 and Haiku stream thinking via the budget path and are
  // left alone.
  return (
    /opus-(?:4[.-](?:[6-9]|\d{2,})|[5-9]|\d{2,})\b/.test(m) ||
    /(?:sonnet|fable|mythos)-(?:[5-9]|\d{2,})\b/.test(m)
  );
}

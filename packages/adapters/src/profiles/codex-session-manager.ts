import { promises as fsp, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";
import type {
  ContextUsage,
  ISessionManager,
  SessionSummary,
  SessionSummaryLine,
} from "../session-manager.js";

const UUID_RE =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export function defaultCodexSessionsRoot(): string {
  return path.join(os.homedir(), ".codex", "sessions");
}

export function sessionIdFromRolloutFilename(name: string): string | undefined {
  const m = name.match(
    /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
  );
  return m?.[1];
}

type RolloutEntry = {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
};

type ChatMessage = {
  sender: "human" | "agent";
  text: string;
  timestamp?: number;
};

type TokenUsage = {
  totalTokens: number;
  contextLimit: number;
  model: string | null;
  atMs?: number;
};

function parseMs(raw: unknown): number | undefined {
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const n = typeof raw === "number" ? raw : Date.parse(raw);
  return Number.isFinite(n) ? n : undefined;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    if (item && typeof item === "object" && "text" in item) {
      const t = (item as { text?: unknown }).text;
      if (typeof t === "string") parts.push(t);
    }
  }
  return parts.join("\n");
}

function emptyUsage(): ContextUsage {
  return { model: null, totalUsed: 0, contextLimit: 0 };
}

export class CodexSessionManager implements ISessionManager {
  private readonly sessionsRoot: string;

  constructor(opts?: { sessionsRoot?: string }) {
    this.sessionsRoot = opts?.sessionsRoot ?? defaultCodexSessionsRoot();
  }

  async listSessions(cwd: string): Promise<SessionSummary[]> {
    try {
      const files = await this.collectJsonl(this.sessionsRoot);
      const summaries: SessionSummary[] = [];
      for (const filePath of files) {
        try {
          const summary = await this.summarizeFile(filePath, cwd);
          if (summary) summaries.push(summary);
        } catch {
          // skip unparseable files — never throw from list
        }
      }
      return summaries.sort(
        (a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)
      );
    } catch {
      return [];
    }
  }

  async getTranscript(cwd: string, sessionId: string): Promise<string> {
    const filePath = await this.findSessionFile(sessionId, cwd);
    if (!filePath) return "";
    const parsed = await this.parseRollout(filePath);
    const lines: string[] = [];
    for (const m of parsed.messages) {
      if (!m.text.trim()) continue;
      const prefix = m.sender === "human" ? "### User\n" : "### Assistant\n";
      lines.push(`${prefix}${m.text.trim()}`);
    }
    return lines.join("\n\n");
  }

  async deleteSession(cwd: string, sessionId: string): Promise<void> {
    const filePath = await this.findSessionFile(sessionId, cwd);
    if (!filePath) return;
    try {
      await fsp.unlink(filePath);
    } catch {
      // already gone
    }
  }

  async cloneSession(
    cwd: string,
    oldSessionId: string,
    newSessionId: string
  ): Promise<void> {
    const oldFile = await this.findSessionFile(oldSessionId, cwd);
    if (!oldFile) {
      throw new Error(`codex session not found: ${oldSessionId}`);
    }
    const dir = path.dirname(oldFile);
    const base = path.basename(oldFile);
    const newBase = UUID_RE.test(base)
      ? base.replace(UUID_RE, newSessionId)
      : `rollout-${newSessionId}.jsonl`;
    const newFile = path.join(dir, newBase);

    const content = await fsp.readFile(oldFile, "utf8");
    const lines = content.split("\n");
    const newLines: string[] = [];
    for (const line of lines) {
      if (!line.trim()) {
        newLines.push(line);
        continue;
      }
      try {
        const entry = JSON.parse(line) as RolloutEntry;
        const payload = entry.payload;
        if (payload && typeof payload === "object") {
          if (payload.session_id === oldSessionId) payload.session_id = newSessionId;
          if (payload.id === oldSessionId) payload.id = newSessionId;
        }
        newLines.push(JSON.stringify(entry));
      } catch {
        newLines.push(line.replace(new RegExp(oldSessionId, "g"), newSessionId));
      }
    }
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(newFile, newLines.join("\n"), "utf8");
  }

  async getHistoryPath(
    cwd: string,
    sessionId: string
  ): Promise<string | undefined> {
    return (await this.findSessionFile(sessionId, cwd)) ?? undefined;
  }

  async getUsage(
    cwd: string,
    sessionId?: string,
    newerThanMs?: number
  ): Promise<ContextUsage> {
    let filePath: string | undefined;
    if (sessionId) {
      filePath = (await this.findSessionFile(sessionId, cwd)) ?? undefined;
    } else {
      const listed = await this.listSessions(cwd);
      const newest = listed[0];
      if (newest) filePath = (await this.findSessionFile(newest.sessionId, cwd)) ?? undefined;
    }
    if (!filePath) return emptyUsage();
    try {
      const parsed = await this.parseRollout(filePath);
      const usage = parsed.lastUsage;
      if (!usage || usage.totalTokens <= 0) return emptyUsage();
      if (
        newerThanMs !== undefined &&
        usage.atMs !== undefined &&
        usage.atMs < newerThanMs
      ) {
        return emptyUsage();
      }
      return {
        model: usage.model,
        totalUsed: usage.totalTokens,
        contextLimit: usage.contextLimit,
      };
    } catch {
      return emptyUsage();
    }
  }

  private async summarizeFile(
    filePath: string,
    cwd: string
  ): Promise<SessionSummary | null> {
    const peek = await this.peekMeta(filePath);
    if (peek?.cwd && peek.cwd !== cwd) return null;
    const parsed = await this.parseRollout(filePath);
    if (!parsed.meta) return null;
    if (parsed.meta.cwd !== cwd) return null;

    const sessionId =
      parsed.meta.sessionId ||
      sessionIdFromRolloutFilename(path.basename(filePath));
    if (!sessionId) return null;

    const stat = await fsp.stat(filePath);
    const createdAt = parsed.meta.createdAt ?? stat.birthtimeMs;
    const lastActivityAt = parsed.lastActivityAt ?? stat.mtimeMs;

    let previewLines: SessionSummaryLine[];
    if (parsed.messages.length <= 16) {
      previewLines = parsed.messages.map((m) => ({
        sender: m.sender,
        text: m.text,
      }));
    } else {
      previewLines = [
        ...parsed.messages.slice(0, 6),
        ...parsed.messages.slice(-10),
      ].map((m) => ({ sender: m.sender, text: m.text }));
    }

    const transcriptChars = parsed.messages
      .map((m) => m.text.trim())
      .filter(Boolean)
      .join("\n\n").length;
    const realTokens = parsed.lastUsage?.totalTokens ?? 0;
    const estimatedTokens =
      realTokens > 0 ? realTokens : Math.ceil(transcriptChars / 4);

    return {
      sessionId,
      createdAt,
      lastActivityAt,
      previewLines,
      estimatedTokens,
      tokensFromUsage: realTokens > 0,
    };
  }

  private async parseRollout(filePath: string): Promise<{
    meta: { sessionId?: string; cwd?: string; createdAt?: number } | null;
    messages: ChatMessage[];
    lastUsage: TokenUsage | null;
    lastActivityAt?: number;
  }> {
    const content = await fsp.readFile(filePath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    let meta: { sessionId?: string; cwd?: string; createdAt?: number } | null =
      null;
    const fromItems: ChatMessage[] = [];
    const fromEvents: ChatMessage[] = [];
    let lastUsage: TokenUsage | null = null;
    let lastActivityAt: number | undefined;
    let lastModel: string | null = null;

    for (const line of lines) {
      let entry: RolloutEntry;
      try {
        entry = JSON.parse(line) as RolloutEntry;
      } catch {
        continue;
      }
      const ts = parseMs(entry.timestamp);
      if (ts !== undefined) lastActivityAt = ts;
      const payload = entry.payload;
      if (!payload || typeof payload !== "object") continue;

      if (entry.type === "session_meta") {
        const sessionId =
          typeof payload.session_id === "string"
            ? payload.session_id
            : typeof payload.id === "string"
              ? payload.id
              : undefined;
        const cwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
        const createdAt =
          parseMs(payload.timestamp) ?? parseMs(entry.timestamp);
        meta = { sessionId, cwd, createdAt };
        continue;
      }

      if (entry.type === "turn_context" && typeof payload.model === "string") {
        lastModel = payload.model;
        continue;
      }

      if (entry.type === "response_item" && payload.type === "message") {
        const role = payload.role;
        const text = textFromContent(payload.content).trim();
        if (!text) continue;
        if (role === "user") {
          fromItems.push({ sender: "human", text, timestamp: ts });
        } else if (role === "assistant") {
          fromItems.push({ sender: "agent", text, timestamp: ts });
        }
        continue;
      }

      if (entry.type === "event_msg") {
        const kind = payload.type;
        if (kind === "user_message" && typeof payload.message === "string") {
          const text = payload.message.trim();
          if (text) fromEvents.push({ sender: "human", text, timestamp: ts });
        } else if (
          kind === "agent_message" &&
          typeof payload.message === "string"
        ) {
          const text = payload.message.trim();
          if (text) fromEvents.push({ sender: "agent", text, timestamp: ts });
        } else if (kind === "token_count") {
          const info = payload.info as
            | {
                // `last_token_usage` = the most recent turn's context fill (what
                // seam reports as "context used"). `total_token_usage` is the
                // session CUMULATIVE total (grows unbounded across turns) — using
                // it here inflated the count to tens of millions. Use last_.
                last_token_usage?: { total_tokens?: number };
                total_token_usage?: { total_tokens?: number };
                model_context_window?: number;
              }
            | undefined;
          const totalTokens = info?.last_token_usage?.total_tokens ?? 0;
          const contextLimit =
            typeof info?.model_context_window === "number"
              ? info.model_context_window
              : 0;
          if (totalTokens > 0) {
            lastUsage = {
              totalTokens,
              contextLimit,
              model: lastModel,
              atMs: ts,
            };
          }
        }
      }
    }

    return {
      meta,
      messages: fromItems.length > 0 ? fromItems : fromEvents,
      lastUsage,
      lastActivityAt,
    };
  }

  private async findSessionFile(
    sessionId: string,
    cwd?: string
  ): Promise<string | null> {
    const files = await this.collectJsonl(this.sessionsRoot);
    for (const filePath of files) {
      const fromName = sessionIdFromRolloutFilename(path.basename(filePath));
      if (fromName === sessionId) return filePath;
      try {
        const parsed = await this.parseRollout(filePath);
        if (parsed.meta?.sessionId !== sessionId) continue;
        if (cwd && parsed.meta.cwd && parsed.meta.cwd !== cwd) continue;
        return filePath;
      } catch {
        // skip
      }
    }
    return null;
  }

  private async peekMeta(
    filePath: string
  ): Promise<{ sessionId?: string; cwd?: string } | null> {
    // Read only the FIRST line (session_meta). Codex embeds base_instructions
    // (~18KB) in it, so a fixed-size buffer read truncates the JSON — stream
    // line-by-line and stop after line 1 (any size) without reading the rest.
    const stream = createReadStream(filePath, { encoding: "utf8" });
    try {
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      let first: string | undefined;
      for await (const line of rl) {
        first = line;
        break;
      }
      rl.close();
      if (!first?.trim()) return null;
      const entry = JSON.parse(first) as RolloutEntry;
      if (entry.type !== "session_meta" || !entry.payload) return null;
      const sessionId =
        typeof entry.payload.session_id === "string"
          ? entry.payload.session_id
          : typeof entry.payload.id === "string"
            ? entry.payload.id
            : undefined;
      const cwd =
        typeof entry.payload.cwd === "string" ? entry.payload.cwd : undefined;
      return { sessionId, cwd };
    } catch {
      return null;
    } finally {
      stream.destroy();
    }
  }

  private async collectJsonl(root: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
      }
    };
    await walk(root);
    return out;
  }
}

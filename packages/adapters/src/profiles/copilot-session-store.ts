import { promises as fs } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { SessionInfo } from "@agentclientprotocol/sdk";
import type { SessionSummary, SessionSummaryLine } from "../session-manager.js";

export interface CopilotSessionRow {
  id?: string;
  cwd?: string | null;
  created_at?: string;
  updated_at?: string;
  repository?: string | null;
  host_type?: string | null;
  branch?: string | null;
  summary?: string | null;
}

export interface CopilotTurnRow {
  turn_index?: number;
  user_message?: string | null;
  assistant_response?: string | null;
  timestamp?: string | number | null;
}

interface History {
  messages: SessionSummaryLine[];
  createdAt?: number;
  lastActivityAt?: number;
}

function sourceError(operation: string, source: string, cause: unknown): Error {
  return new Error(`Copilot ${operation} (${source}): ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
}

export async function rewriteCopilotClone(
  source: string,
  target: string,
  sessionId: string,
  cwd: string,
): Promise<void> {
  const workspaceFile = path.join(target, "workspace.yaml");
  let workspace: string;
  try { workspace = await fs.readFile(workspaceFile, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw sourceError("read cloned workspace", workspaceFile, error);
    workspace = "";
  }
  for (const [key, value] of [["id", sessionId], ["cwd", cwd]]) {
    const field = `${key}: ${JSON.stringify(value)}`;
    const pattern = new RegExp(`^${key}:[^\\r\\n]*`, "m");
    workspace = pattern.test(workspace) ? workspace.replace(pattern, () => field)
      : `${workspace}${workspace.endsWith("\n") || !workspace ? "" : "\n"}${field}\n`;
  }
  await fs.writeFile(workspaceFile, workspace, "utf8");

  const eventsFile = path.join(target, "events.jsonl");
  let events: string;
  try { events = await fs.readFile(eventsFile, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw sourceError("read cloned session history", eventsFile, error);
  }
  const lines = events.split("\n").map((line, index) => {
    if (!line.trim()) return line;
    let event: { type?: string; data?: { sessionId?: string; context?: Record<string, unknown>; checkpointPath?: string } };
    try { event = JSON.parse(line); }
    catch (error) { throw sourceError(`parse cloned session history line ${index + 1}`, eventsFile, error); }
    let changed = false;
    // Copilot restores the session identity from the start event, not its directory.
    if (event.type === "session.start" && event.data) {
      event.data.sessionId = sessionId;
      event.data.context = { ...event.data.context, cwd };
      changed = true;
    }
    const checkpoint = event.data?.checkpointPath;
    if (checkpoint?.startsWith(`${source}${path.sep}`)) {
      event.data!.checkpointPath = target + checkpoint.slice(source.length);
      changed = true;
    }
    return changed ? JSON.stringify(event) : line;
  });
  await fs.writeFile(eventsFile, lines.join("\n"), "utf8");
}

async function optionalDatabase<T>(file: string, read: (db: Database.Database) => T | Promise<T>): Promise<T | undefined> {
  try { await fs.access(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw sourceError("read session index", file, error);
  }
  try {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try { return await read(db); }
    finally { db.close(); }
  } catch (error) { throw sourceError("read session index", file, error); }
}

function timestamp(value: string | null | undefined): number | undefined {
  const result = value ? Date.parse(value) : NaN;
  return Number.isFinite(result) ? result : undefined;
}

function transcript(messages: SessionSummaryLine[]): string {
  return messages.filter(message => message.text.trim()).map(message =>
    `### ${message.sender === "human" ? "User" : "Assistant"}\n${message.text.trim()}`
  ).join("\n\n");
}

function summary(sessionId: string, history: History): SessionSummary {
  const messages = history.messages;
  return {
    sessionId,
    createdAt: history.createdAt,
    lastActivityAt: history.lastActivityAt,
    previewLines: messages.length <= 16 ? messages : [...messages.slice(0, 6), ...messages.slice(-10)],
    estimatedTokens: Math.ceil(transcript(messages).length / 4),
  };
}

function turnMessages(turns: CopilotTurnRow[]): SessionSummaryLine[] {
  return turns.flatMap(turn => [
    ...(turn.user_message ? [{ sender: "human" as const, text: turn.user_message }] : []),
    ...(turn.assistant_response ? [{ sender: "agent" as const, text: turn.assistant_response }] : []),
  ]);
}

function readEventHistory(file: string): Promise<History>;
function readEventHistory(file: string, optional: true): Promise<History | undefined>;
async function readEventHistory(file: string, optional = false): Promise<History | undefined> {
  let text: string;
  try { text = await fs.readFile(file, "utf8"); }
  catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw sourceError("read session history", file, error);
  }
  const history: History = { messages: [] };
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index]!.trim()) continue;
    let event: { type: string; timestamp?: string; data?: { content?: string } };
    try { event = JSON.parse(lines[index]!); }
    catch (error) { throw sourceError(`parse session history line ${index + 1}`, file, error); }
    const at = timestamp(event.timestamp);
    if (at !== undefined) {
      history.createdAt ??= at;
      history.lastActivityAt = Math.max(history.lastActivityAt ?? at, at);
    }
    if ((event.type === "user.message" || event.type === "assistant.message") && event.data?.content) {
      history.messages.push({ sender: event.type === "user.message" ? "human" : "agent", text: event.data.content });
    }
  }
  return history;
}

export async function readCopilotSessionSummaries(
  dir: string,
  cwd: string,
  nativeSessions: SessionInfo[],
  seamDbPath: string,
): Promise<SessionSummary[]> {
  const dbPath = path.join(dir, "session-store.db");
  const legacy = await optionalDatabase(dbPath, async db => {
    const sessions = db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC").all() as CopilotSessionRow[];
    const recorded = sessions.some(session => !session.cwd)
      ? await optionalDatabase(seamDbPath, seamDb => new Set(
          (seamDb.prepare("SELECT acp_session_id FROM sessions WHERE repo_path = ?").all(cwd) as Array<{ acp_session_id: string | null }>)
            .flatMap(row => row.acp_session_id ? [row.acp_session_id] : [])
        )) ?? new Set<string>()
      : new Set<string>();
    return sessions.filter(session => session.id &&
      (session.cwd === cwd || (!session.cwd && recorded.has(session.id)))
    ).map(session => ({
      session,
      turns: db.prepare("SELECT * FROM turns WHERE session_id = ? ORDER BY turn_index ASC").all(session.id) as CopilotTurnRow[],
    }));
  }) ?? [];
  const summaries = new Map<string, SessionSummary>();
  // ACP stopped indexing sessions in SQL: https://github.com/github/copilot-cli/issues/5053
  for (const { session, turns } of legacy) {
    if (!session.id) continue;
    summaries.set(session.id, summary(session.id, {
      messages: turnMessages(turns),
      createdAt: timestamp(session.created_at),
      lastActivityAt: timestamp(session.updated_at),
    }));
  }
  for (const session of nativeSessions) {
    if (session.cwd !== cwd) continue;
    const file = path.join(dir, "session-state", session.sessionId, "events.jsonl");
    const history = await readEventHistory(file);
    const previous = summaries.get(session.sessionId);
    history.createdAt ??= previous?.createdAt;
    history.lastActivityAt = timestamp(session.updatedAt) ?? history.lastActivityAt ?? previous?.lastActivityAt;
    summaries.set(session.sessionId, summary(session.sessionId, history));
  }
  return [...summaries.values()].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
}

export async function readCopilotTranscript(dir: string, sessionId: string): Promise<string> {
  const file = path.join(dir, "session-state", sessionId, "events.jsonl");
  const history = await readEventHistory(file, true);
  if (history) return transcript(history.messages);
  const dbPath = path.join(dir, "session-store.db");
  const turns = await optionalDatabase(dbPath, db =>
    db.prepare("SELECT * FROM turns WHERE session_id = ? ORDER BY turn_index ASC").all(sessionId) as CopilotTurnRow[]
  );
  if (turns === undefined) throw sourceError("read session history", file, new Error("ENOENT: no event history or legacy session index"));
  return transcript(turnMessages(turns));
}

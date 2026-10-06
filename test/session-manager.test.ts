import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanTextForPreview } from "@seam/adapters";
import { makeCopilotProfile } from "@seam/adapters";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("cleanTextForPreview", () => {
  it("filters out slash commands", () => {
    const text = "/model model default\nThis is a real message.";
    const result = cleanTextForPreview(text);
    expect(result).toBe("This is a real message.");
  });

  it("filters out model configuration messages", () => {
    const text = "Set model to claude-opus-4-7\nAnother message here.";
    const result = cleanTextForPreview(text);
    expect(result).toBe("Another message here.");
  });

  it("filters out variations of model setting lines case insensitively", () => {
    const variations = [
      "Set model to claude",
      "model default",
      "active model is sonnet",
      "current model set to gemini",
      "model: claude-3-5-sonnet",
      "set model",
    ];
    for (const line of variations) {
      expect(cleanTextForPreview(line)).toBe("");
    }
  });

  it("does not filter out lines containing model in normal contexts", () => {
    const text = "We need to design a model architecture for our application.";
    expect(cleanTextForPreview(text)).toBe(text);
  });

  it("filters out bot thoughts and programmatic outputs beginning with 'I will'", () => {
    const variations = [
      "I will search the codebase",
      "*I will view file*",
      "- I will check if the build has completed",
      "i will do this",
    ];
    for (const line of variations) {
      expect(cleanTextForPreview(line)).toBe("");
    }
  });
});

describe("Copilot Session Manager", () => {
  let tempDir: string;
  let profile: any;
  let manager: any;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-test-"));
    const dbPath = path.join(tempDir, "session-store.db");
    
    // Create sqlite db and tables
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        cwd TEXT,
        repository TEXT,
        host_type TEXT,
        branch TEXT,
        summary TEXT,
        created_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS turns (
        session_id TEXT,
        turn_index INTEGER,
        user_message TEXT,
        assistant_response TEXT,
        timestamp TEXT
      );
    `);
    
    // Insert a dummy session
    const nowIso = new Date().toISOString();
    db.prepare(`
      INSERT INTO sessions (id, cwd, repository, host_type, branch, summary, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("session-123", "/workspace/repo", "repo", "github", "main", "initial summary", nowIso, nowIso);

    db.prepare(`
      INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run("session-123", 0, "hello", "hi there", nowIso);

    db.close();

    profile = makeCopilotProfile({
      configDir: tempDir,
      defaultModel: "gpt-4",
      sessionList: async () => [],
    });
    manager = profile.sessionManager;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("lists sessions and filters by cwd", async () => {
    const list = await manager.listSessions("/workspace/repo");
    expect(list).toHaveLength(1);
    expect(list[0].sessionId).toBe("session-123");
    expect(list[0].previewLines).toEqual([
      { sender: "human", text: "hello" },
      { sender: "agent", text: "hi there" }
    ]);

    const emptyList = await manager.listSessions("/other/repo");
    expect(emptyList).toHaveLength(0);
  });

  it("clones a session and writes the active cwd", async () => {
    await manager.cloneSession("/workspace/repo-cloned", "session-123", "session-456");

    // Check list for the new cwd
    const listNewCwd = await manager.listSessions("/workspace/repo-cloned");
    expect(listNewCwd).toHaveLength(1);
    expect(listNewCwd[0].sessionId).toBe("session-456");
    expect(listNewCwd[0].previewLines).toEqual([
      { sender: "human", text: "hello" },
      { sender: "agent", text: "hi there" }
    ]);
  });

  it.each([true, false])("clones native identity and cwd without changing history; indexed=%s", async indexed => {
    const source = path.join(tempDir, "session-state", "session-123");
    const target = path.join(tempDir, "session-state", "session-456");
    const cwd = '/workspace/repo $&: "cloned"';
    const workspace = 'id: session-123\ncwd: /workspace/repo\nname: |-\n  Source context\nclient_name: github/acp\n';
    const messages = [
      JSON.stringify({ id: "start", parentId: null, type: "session.start",
        data: { sessionId: "session-123", context: { cwd: "/workspace/repo", branch: "main" } } }),
      JSON.stringify({ id: "user", parentId: "start", type: "user.message",
        data: { content: "Remember session-123 and /workspace/repo exactly." } }),
      JSON.stringify({ id: "agent", parentId: "user", type: "assistant.message", data: { content: "Remembered." } }),
      JSON.stringify({ id: "subagent-start", parentId: "agent", agentId: "task-1", type: "session.start",
        data: { sessionId: "subagent-conversation", context: { cwd: "/workspace/repo" } } }),
      JSON.stringify({ id: "checkpoint", parentId: "subagent-start", type: "session.compaction_complete",
        data: { checkpointPath: path.join(source, "checkpoints", "1.md"), success: true } }),
    ];
    fs.mkdirSync(path.join(source, "checkpoints"), { recursive: true });
    fs.writeFileSync(path.join(source, "workspace.yaml"), workspace);
    fs.writeFileSync(path.join(source, "events.jsonl"), messages.join("\n") + "\n");
    fs.writeFileSync(path.join(source, "checkpoints", "1.md"), "Retained source context");
    if (!indexed) {
      const db = new Database(path.join(tempDir, "session-store.db"));
      db.prepare("DELETE FROM turns WHERE session_id = ?").run("session-123");
      db.prepare("DELETE FROM sessions WHERE id = ?").run("session-123");
      db.close();
    }

    await manager.cloneSession(cwd, "session-123", "session-456");

    expect(fs.readFileSync(path.join(target, "workspace.yaml"), "utf8")).toBe(
      `id: "session-456"\ncwd: ${JSON.stringify(cwd)}\nname: |-\n  Source context\nclient_name: github/acp\n`
    );
    const clonedLines = fs.readFileSync(path.join(target, "events.jsonl"), "utf8").trimEnd().split("\n");
    expect(JSON.parse(clonedLines[0]!)).toEqual({ id: "start", parentId: null, type: "session.start",
      data: { sessionId: "session-456", context: { cwd, branch: "main" } } });
    expect(clonedLines.slice(1, 4)).toEqual(messages.slice(1, 4));
    expect(JSON.parse(clonedLines[4]!)).toMatchObject({ id: "checkpoint", parentId: "subagent-start",
      data: { checkpointPath: path.join(target, "checkpoints", "1.md") } });
    expect(fs.readFileSync(path.join(target, "checkpoints", "1.md"), "utf8")).toBe("Retained source context");
    expect(fs.readFileSync(path.join(source, "workspace.yaml"), "utf8")).toBe(workspace);
    expect(fs.readFileSync(path.join(source, "events.jsonl"), "utf8")).toBe(messages.join("\n") + "\n");
    expect(await manager.getTranscript(cwd, "session-456")).toContain("Remember session-123 and /workspace/repo exactly.");
  });

  it("surfaces the real native copy error instead of reporting clone success", async () => {
    fs.mkdirSync(path.join(tempDir, "session-state", "session-123"), { recursive: true });
    const cause = Object.assign(new Error("EACCES: permission denied while copying source events"), { code: "EACCES" });
    vi.spyOn(fs.promises, "cp").mockRejectedValue(cause);
    await expect(manager.cloneSession("/workspace/repo", "session-123", "session-456")).rejects.toBe(cause);
  });

  it("reports the path and line of malformed cloned history", async () => {
    const source = path.join(tempDir, "session-state", "session-123");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "events.jsonl"), "not JSON\n");
    await expect(manager.cloneSession("/workspace/repo", "session-123", "session-456"))
      .rejects.toThrow(`Copilot parse cloned session history line 1 (${path.join(tempDir, "session-state", "session-456", "events.jsonl")}):`);
  });
});

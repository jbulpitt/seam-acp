import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
    const text = "Set model to claude-opus-4-7[1m]\nAnother message here.";
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
    });
    manager = profile.sessionManager;
  });

  afterEach(async () => {
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
});


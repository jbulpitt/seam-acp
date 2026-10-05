import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { makeCopilotProfile, type CopilotCatalogLaunch, type AgentProfile } from "@seam/adapters";
import type { SessionInfo } from "@agentclientprotocol/sdk";

const fixture = fileURLToPath(new URL("./fixtures/copilot-session-list.mjs", import.meta.url));
const earlier = "2026-09-28T12:00:00.000Z";
const later = "2026-10-05T12:00:00.000Z";

describe("Copilot session listing and history", () => {
  let root: string;
  let dir: string;
  let cwd: string;
  let dataDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-copilot-list-"));
    dir = path.join(root, "copilot");
    cwd = path.join(root, "workspace");
    dataDir = path.join(root, "data");
    for (const folder of [dir, cwd, dataDir]) fs.mkdirSync(folder);
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

  function profile(sessions: SessionInfo[] = [], overrides: Partial<Parameters<typeof makeCopilotProfile>[0]> = {}): AgentProfile {
    return makeCopilotProfile({
      defaultModel: "fixture-model", configDir: dir, cwd,
      environment: { ...process.env, DATA_DIR: dataDir },
      sessionList: async () => sessions,
      ...overrides,
    });
  }

  function events(id: string, messages: string[] = ["new user", "new assistant"]): string {
    const folder = path.join(dir, "session-state", id);
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, "events.jsonl");
    fs.writeFileSync(file, [
      { type: "session.start", timestamp: earlier, data: { context: { cwd } } },
      ...messages.map((content, index) => ({
        type: index % 2 ? "assistant.message" : "user.message", timestamp: later, data: { content },
      })),
    ].map(event => JSON.stringify(event)).join("\n") + "\n");
    return file;
  }

  function legacy(rows: Array<{ id: string; cwd: string | null; at?: string }>): string {
    const file = path.join(dir, "session-store.db");
    const db = new Database(file);
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE turns (session_id TEXT, turn_index INTEGER, user_message TEXT, assistant_response TEXT);
    `);
    for (const row of rows) {
      db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)").run(row.id, row.cwd, earlier, row.at ?? earlier);
      db.prepare("INSERT INTO turns VALUES (?, 0, ?, ?)").run(row.id, `old user ${row.id}`, `old assistant ${row.id}`);
    }
    db.close();
    return file;
  }

  it("lists native-only fresh sessions and reads their transcripts without creating SQL", async () => {
    events("fresh");
    const p = profile([{ sessionId: "fresh", cwd, updatedAt: later }]);
    const rows = await p.listSessions(cwd);
    expect(rows).toEqual([{
      sessionId: "fresh", createdAt: Date.parse(earlier), lastActivityAt: Date.parse(later),
      previewLines: [{ sender: "human", text: "new user" }, { sender: "agent", text: "new assistant" }],
      estimatedTokens: Math.ceil("### User\nnew user\n\n### Assistant\nnew assistant".length / 4),
    }]);
    await expect(p.getTranscript(cwd, "fresh")).resolves.toBe("### User\nnew user\n\n### Assistant\nnew assistant");
    expect(fs.existsSync(path.join(dir, "session-store.db"))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, "seam.db"))).toBe(false);
  });

  it("merges legacy-only rows, prefers native history for duplicate ids, and sorts by current activity", async () => {
    const db = legacy([{ id: "legacy", cwd }, { id: "duplicate", cwd }, { id: "other", cwd: "/elsewhere" }]);
    const before = fs.readFileSync(db);
    events("duplicate", ["current user", "current assistant"]);
    const p = profile([{ sessionId: "duplicate", cwd, updatedAt: later }]);
    const rows = await p.listSessions(cwd);
    expect(rows.map(row => row.sessionId)).toEqual(["duplicate", "legacy"]);
    expect(rows[0]!.previewLines[0]!.text).toBe("current user");
    expect(rows[1]!.previewLines[0]!.text).toBe("old user legacy");
    await expect(p.getTranscript(cwd, "duplicate")).resolves.toContain("current assistant");
    await expect(p.getTranscript(cwd, "legacy")).resolves.toContain("old assistant legacy");
    expect(fs.readFileSync(db)).toEqual(before);
  });

  it("keeps missing-cwd legacy sessions only when Seam associates them with this workspace", async () => {
    legacy([{ id: "associated", cwd: null }, { id: "unassociated", cwd: null }, { id: "other", cwd: "/elsewhere" }]);
    const seam = new Database(path.join(dataDir, "seam.db"));
    seam.exec("CREATE TABLE sessions (acp_session_id TEXT, repo_path TEXT)");
    seam.prepare("INSERT INTO sessions VALUES (?, ?)").run("associated", cwd);
    seam.prepare("INSERT INTO sessions VALUES (?, ?)").run("other", cwd);
    seam.close();
    await expect(profile().listSessions(cwd)).resolves.toMatchObject([{ sessionId: "associated" }]);
  });

  it("returns a genuine empty list without creating either optional database", async () => {
    await expect(profile().listSessions(cwd)).resolves.toEqual([]);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(fs.readdirSync(dataDir)).toEqual([]);
  });

  it("keeps the first-six/last-ten preview policy and the full event transcript", async () => {
    const messages = Array.from({ length: 20 }, (_, index) => `message ${index}`);
    events("long", messages);
    const p = profile([{ sessionId: "long", cwd }]);
    const [row] = await p.listSessions(cwd);
    expect(row!.previewLines.map(line => line.text)).toEqual([...messages.slice(0, 6), ...messages.slice(-10)]);
    expect(await p.getTranscript(cwd, "long")).toContain("message 8");
  });

  it("passes the configured launch environment and disables probe MCPs", async () => {
    const sessionList = vi.fn(async (_launch: CopilotCatalogLaunch) => []);
    fs.writeFileSync(path.join(dir, "mcp-config.json"), JSON.stringify({ mcpServers: { fixture: {} } }));
    const p = profile([], { cliPath: "fixture-copilot", acpArgs: ["--acp", "--allow-all"], sessionList });
    await p.listSessions(cwd);
    expect(sessionList.mock.calls[0]![0]).toMatchObject({
      cliPath: "fixture-copilot", cwd,
      args: ["--acp", "--allow-all", "--disable-builtin-mcps", "--disable-mcp-server", "fixture"],
      env: { DATA_DIR: dataDir },
    });
  });

  it("initializes and paginates the real ACP transport without session/new or prompts", async () => {
    events("first"); events("second");
    const log = path.join(root, "requests.jsonl");
    const p = profile([], {
      cliPath: process.execPath, acpArgs: [fixture], sessionList: undefined,
      environment: { ...process.env, DATA_DIR: dataDir, FIXTURE_REQUEST_LOG: log,
        FIXTURE_SESSION_PAGES: JSON.stringify({
          first: { sessions: [{ sessionId: "first", cwd }], nextCursor: "page-two" },
          "page-two": { sessions: [{ sessionId: "second", cwd }, { sessionId: "other", cwd: "/elsewhere" }] },
        }) },
    });
    expect((await p.listSessions(cwd)).map(row => row.sessionId)).toEqual(["first", "second"]);
    const requests = fs.readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(requests.map(request => request.method)).toEqual(["initialize", "session/list", "session/list"]);
    expect(requests[1].params).toEqual({ cwd });
    expect(requests[2].params).toEqual({ cwd, cursor: "page-two" });
  });

  it("surfaces the provider's real session/list failure rather than using a partial SQL list", async () => {
    legacy([{ id: "legacy", cwd }]);
    const p = profile([], { cliPath: process.execPath, acpArgs: [fixture], sessionList: undefined,
      environment: { ...process.env, DATA_DIR: dataDir, FIXTURE_LIST_FAILURE: "1" } });
    await expect(p.listSessions(cwd)).rejects.toThrow("session source unavailable (permission denied)");
  });

  it("surfaces missing or unreadable native history with its path and cause", async () => {
    const p = profile([{ sessionId: "missing", cwd }]);
    await expect(p.listSessions(cwd)).rejects.toThrow(/events\.jsonl.*ENOENT/);
    const file = events("missing");
    fs.rmSync(file); fs.mkdirSync(file);
    await expect(p.listSessions(cwd)).rejects.toThrow(/events\.jsonl.*EISDIR/);
    await expect(p.getTranscript(cwd, "missing")).rejects.toThrow(/events\.jsonl.*EISDIR/);
  });

  it("surfaces malformed event history instead of presenting legacy data as current", async () => {
    legacy([{ id: "malformed", cwd }]);
    const file = events("malformed");
    fs.appendFileSync(file, "not-json\n");
    const p = profile([{ sessionId: "malformed", cwd }]);
    await expect(p.listSessions(cwd)).rejects.toThrow(/parse session history line 4.*events\.jsonl/);
    await expect(p.getTranscript(cwd, "malformed")).rejects.toThrow(/parse session history line 4.*events\.jsonl/);
  });

  it("surfaces existing corrupt SQL rather than treating it as missing", async () => {
    events("fresh");
    fs.writeFileSync(path.join(dir, "session-store.db"), "not a database");
    await expect(profile([{ sessionId: "fresh", cwd }]).listSessions(cwd)).rejects.toThrow(/session-store\.db.*file is not a database/);
    await expect(profile().getTranscript(cwd, "legacy")).rejects.toThrow(/session-store\.db.*file is not a database/);
  });
});

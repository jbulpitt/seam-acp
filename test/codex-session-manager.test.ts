import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeCodexProfile } from "@seam/adapters";
import {
  CodexSessionManager,
  sessionIdFromRolloutFilename,
} from "../packages/adapters/src/profiles/codex-session-manager.js";

const ID_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const CREATED = "2026-08-26T06:05:17.899Z";

function rolloutLine(
  type: string,
  payload: unknown,
  timestamp = "2026-08-26T06:05:18.221Z"
): string {
  return JSON.stringify({ timestamp, type, payload });
}

function writeRollout(
  root: string,
  sessionId: string,
  cwd: string,
  extra: string[] = []
): string {
  const dir = path.join(root, "2026", "08", "26");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(
    dir,
    `rollout-2026-08-26T01-05-17-${sessionId}.jsonl`
  );
  const lines = [
    rolloutLine("session_meta", {
      session_id: sessionId,
      id: sessionId,
      timestamp: CREATED,
      cwd,
    }),
    ...extra,
  ];
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

describe("sessionIdFromRolloutFilename", () => {
  it("pulls the UUID off a date-partitioned rollout name", () => {
    expect(
      sessionIdFromRolloutFilename(
        `rollout-2026-08-26T01-05-17-${ID_A}.jsonl`
      )
    ).toBe(ID_A);
  });
});

describe("Codex Session Manager", () => {
  let root: string;
  let manager: CodexSessionManager;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sessions-"));
    manager = new CodexSessionManager({ sessionsRoot: root });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("lists sessions filtered by cwd and returns id/createdAt/preview/usage", async () => {
    writeRollout(root, ID_A, "/workspace/repo", [
      rolloutLine("turn_context", { model: "gpt-5.4" }),
      rolloutLine("response_item", {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello from user" }],
      }),
      rolloutLine("response_item", {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hi there from codex" }],
      }),
      rolloutLine("event_msg", {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 100,
            output_tokens: 20,
            total_tokens: 120,
          },
          last_token_usage: { total_tokens: 120 },
          model_context_window: 258400,
        },
      }),
    ]);
    writeRollout(root, ID_B, "/other/repo", [
      rolloutLine("response_item", {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "wrong project" }],
      }),
    ]);
    fs.writeFileSync(
      path.join(root, "2026", "08", "26", "garbage.jsonl"),
      "not-json\n{bad\n"
    );

    const list = await manager.listSessions("/workspace/repo");
    expect(list).toHaveLength(1);
    expect(list[0]!.sessionId).toBe(ID_A);
    expect(list[0]!.createdAt).toBe(Date.parse(CREATED));
    expect(list[0]!.previewLines).toEqual([
      { sender: "human", text: "hello from user" },
      { sender: "agent", text: "hi there from codex" },
    ]);
    expect(list[0]!.tokensFromUsage).toBe(true);
    expect(list[0]!.estimatedTokens).toBe(120);

    const other = await manager.listSessions("/other/repo");
    expect(other).toHaveLength(1);
    expect(other[0]!.sessionId).toBe(ID_B);

    const empty = await manager.listSessions("/missing");
    expect(empty).toHaveLength(0);
  });

  it("renders a transcript from response_item messages", async () => {
    writeRollout(root, ID_A, "/workspace/repo", [
      rolloutLine("response_item", {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "system prompt" }],
      }),
      rolloutLine("response_item", {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello from user" }],
      }),
      rolloutLine("response_item", {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hi there from codex" }],
      }),
    ]);
    const text = await manager.getTranscript("/workspace/repo", ID_A);
    expect(text).toContain("### User\nhello from user");
    expect(text).toContain("### Assistant\nhi there from codex");
    expect(text).not.toContain("system prompt");
  });

  it("falls back to event_msg text when response_item messages are absent", async () => {
    writeRollout(root, ID_A, "/workspace/repo", [
      rolloutLine("event_msg", {
        type: "user_message",
        message: "typed in the tui",
      }),
      rolloutLine("event_msg", {
        type: "agent_message",
        message: "replied in the tui",
        phase: "final",
      }),
    ]);
    const list = await manager.listSessions("/workspace/repo");
    expect(list[0]!.previewLines).toEqual([
      { sender: "human", text: "typed in the tui" },
      { sender: "agent", text: "replied in the tui" },
    ]);
    expect(list[0]!.tokensFromUsage).toBe(false);
  });

  it("clones a rollout with a new session id and deletes the original", async () => {
    writeRollout(root, ID_A, "/workspace/repo", [
      rolloutLine("response_item", {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "keep me" }],
      }),
    ]);
    const newId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    await manager.cloneSession("/workspace/repo", ID_A, newId);
    const listed = await manager.listSessions("/workspace/repo");
    expect(listed.map((s) => s.sessionId).sort()).toEqual([ID_A, newId].sort());

    const clonedPath = await manager.getHistoryPath("/workspace/repo", newId);
    expect(clonedPath).toBeTruthy();
    const raw = fs.readFileSync(clonedPath!, "utf8");
    expect(raw).toContain(newId);
    expect(raw).not.toContain(ID_A);

    await manager.deleteSession("/workspace/repo", ID_A);
    const after = await manager.listSessions("/workspace/repo");
    expect(after).toHaveLength(1);
    expect(after[0]!.sessionId).toBe(newId);
  });

  it("getUsage reads the latest token_count", async () => {
    writeRollout(root, ID_A, "/workspace/repo", [
      rolloutLine("turn_context", { model: "gpt-5.4" }),
      rolloutLine("event_msg", {
        type: "token_count",
        info: {
          total_token_usage: { total_tokens: 50 },
          last_token_usage: { total_tokens: 50 },
          model_context_window: 258400,
        },
      }),
      rolloutLine(
        "event_msg",
        {
          type: "token_count",
          info: {
            total_token_usage: { total_tokens: 90 },
            last_token_usage: { total_tokens: 90 },
            model_context_window: 258400,
          },
        },
        "2026-08-26T06:06:00.000Z"
      ),
    ]);
    const usage = await manager.getUsage("/workspace/repo", ID_A);
    expect(usage.totalUsed).toBe(90);
    expect(usage.contextLimit).toBe(258400);
    expect(usage.model).toBe("gpt-5.4");
  });

  it("never throws from listSessions on a missing root", async () => {
    const missing = new CodexSessionManager({
      sessionsRoot: path.join(root, "does-not-exist"),
    });
    await expect(missing.listSessions("/workspace/repo")).resolves.toEqual([]);
  });
});

describe("makeCodexProfile wires sessionManager", () => {
  it("exposes listSessions through the profile", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-profile-"));
    try {
      writeRollout(root, ID_A, "/workspace/repo", [
        rolloutLine("response_item", {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "via profile" }],
        }),
      ]);
      const profile = makeCodexProfile({
        defaultModel: "o3",
        sessionsRoot: root,
      });
      expect(profile.sessionManager).toBeTruthy();
      const list = await profile.listSessions("/workspace/repo");
      expect(list).toHaveLength(1);
      expect(list[0]!.sessionId).toBe(ID_A);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

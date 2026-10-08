import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeClaudeProfile } from "@seam/adapters";

let root: string;
let project: string;
const cwd = "/fixture/project";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-claude-usage-"));
  project = path.join(root, "projects", cwd.replace(/\//g, "-"));
  fs.mkdirSync(project, { recursive: true });
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function writeUsage(sessionId: string, tokens: number, modified: number) {
  const file = path.join(project, `${sessionId}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({
    type: "assistant", sessionId, timestamp: "2026-10-08T12:00:00Z",
    message: { model: "fixture-model", usage: { input_tokens: tokens } },
  }) + "\n");
  fs.utimesSync(file, modified, modified);
}

function manager() {
  return makeClaudeProfile({ configDir: root, defaultModel: "default" }).sessionManager!;
}

describe("Claude usage belongs to the requested session", () => {
  it("returns no side-channel evidence when its JSONL is missing beside a newer concurrent session", async () => {
    writeUsage("concurrent", 999, 200);
    expect(await manager().getUsage!(cwd, "missing-own-session", Date.parse("2026-10-08T11:00:00Z")))
      .toEqual({ model: null, totalUsed: 0, contextLimit: 200_000 });
  });

  it("reads its own older file rather than the newest concurrent session", async () => {
    writeUsage("own", 123, 100);
    writeUsage("concurrent", 999, 200);
    expect(await manager().getUsage!(cwd, "own")).toMatchObject({ model: "fixture-model", totalUsed: 123 });
  });

  it("retains the newest-file lookup for a session-unspecified caller", async () => {
    writeUsage("older", 123, 100);
    writeUsage("newer", 999, 200);
    expect(await manager().getUsage!(cwd)).toMatchObject({ model: "fixture-model", totalUsed: 999 });
  });
});

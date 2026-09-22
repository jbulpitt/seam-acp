import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeWorktreePrune,
  parseWorktreeList,
  planWorktreePrune,
  readDispatchBindings,
} from "../scripts/lib/worktree-prune.mjs";
import { parseWorktreePruneArgs } from "../scripts/prune-worktrees.mjs";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const repo = "/srv/seam-acp";
const dataDir = `${repo}/data`;
const trees = {
  main: repo,
  merged: "/srv/.worktrees/seam-acp/merged",
  active: "/srv/.worktrees/seam-acp/active",
  dirty: "/srv/.worktrees/seam-acp/dirty",
  open: "/srv/.worktrees/seam-acp/open",
  advanced: "/srv/.worktrees/seam-acp/advanced",
};

const porcelain = `worktree ${trees.main}
HEAD main-head
branch refs/heads/main

worktree ${trees.merged}
HEAD merged-head
branch refs/heads/fix/merged

worktree ${trees.active}
HEAD base-head
branch refs/heads/fix/fresh-active

worktree ${trees.dirty}
HEAD dirty-head
branch refs/heads/fix/dirty

worktree ${trees.open}
HEAD open-head
branch refs/heads/fix/open

worktree ${trees.advanced}
HEAD advanced-local-head
branch refs/heads/fix/advanced
`;

function pr(branch: string, state: "OPEN" | "MERGED" | "CLOSED", headRefOid: string) {
  return { number: 1, state, url: "https://example.test/pr/1", headRefName: branch, headRefOid };
}

function fixture() {
  const calls: Array<{ command: string; args: string[] }> = [];
  const prs: Record<string, unknown[]> = {
    "fix/merged": [pr("fix/merged", "MERGED", "merged-head")],
    "fix/fresh-active": [pr("fix/fresh-active", "MERGED", "base-head")],
    "fix/dirty": [pr("fix/dirty", "CLOSED", "dirty-head")],
    "fix/open": [pr("fix/open", "OPEN", "open-head")],
    "fix/advanced": [pr("fix/advanced", "MERGED", "old-reviewed-head")],
  };
  const run = vi.fn((command: string, args: string[]) => {
    calls.push({ command, args });
    if (command === "git" && args.includes("rev-parse") && args.includes("--show-toplevel")) return `${repo}\n`;
    if (command === "git" && args.includes("rev-parse") && args.includes("--git-common-dir")) return ".git\n";
    if (command === "git" && args.includes("rev-parse") && args.includes("--git-dir")) return ".git\n";
    if (command === "git" && args.includes("worktree") && args.includes("list")) return porcelain;
    if (command === "git" && args.includes("status")) return args[1] === trees.dirty ? "?? notes.txt\n" : "";
    if (command === "git" && args.includes("prune")) return "";
    if (command === "gh" && args[0] === "repo") return JSON.stringify({ nameWithOwner: "jbulpitt/seam-acp" });
    if (command === "gh" && args[0] === "pr") {
      const branch = args[args.indexOf("--head") + 1];
      return JSON.stringify(prs[branch] ?? []);
    }
    if (command === "wt" || command.endsWith("/wt")) return "{}\n";
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  });
  const dispatchReader = vi.fn(() => ({
    paths: [path.join(trees.active, "packages", "core")],
    attemptIds: ["dispatch-active"],
    bindings: [{ id: "dispatch-active", state: "active", cwd: path.join(trees.active, "packages", "core") }],
    unknownAttemptIds: [],
    unavailable: null,
  }));
  const processReader = vi.fn(() => ({ bindings: [], unavailable: null }));
  return { calls, run, dispatchReader, processReader };
}

describe("worktree cleanup (#511)", () => {
  it("defaults the operator command to dry-run", () => {
    expect(parseWorktreePruneArgs([]).apply).toBe(false);
    expect(parseWorktreePruneArgs(["--apply"]).apply).toBe(true);
  });

  it("uses frozen execution cwd first and maps queued/resumable work without guessing from ancestry", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-worktree-prune-"));
    tempRoots.push(root);
    const dbPath = path.join(root, "seam.db");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE turn_attempts (id TEXT, state TEXT, identity TEXT, spec_json TEXT);
      CREATE TABLE sessions (channel_ref TEXT, repo_path TEXT);
      CREATE TABLE presets (name TEXT, repo_path TEXT);
    `);
    db.prepare("INSERT INTO sessions VALUES (?, ?)").run("thread", "/trees/session-now");
    db.prepare("INSERT INTO presets VALUES (?, ?)").run("worker", "/trees/preset");
    const insert = db.prepare("INSERT INTO turn_attempts VALUES (?, ?, ?, ?)");
    insert.run("claimed", "active", JSON.stringify({ cwd: "/trees/frozen" }), JSON.stringify({ target: "thread" }));
    insert.run("queued", "pending", "", JSON.stringify({ target: "thread" }));
    insert.run("resumable", "suspended", "", JSON.stringify({ preset: "worker" }));
    insert.run("done", "completed", JSON.stringify({ cwd: "/trees/ignored" }), JSON.stringify({ target: "thread" }));
    db.close();

    const result = readDispatchBindings(dbPath);
    expect(result.unavailable).toBeNull();
    expect(result.unknownAttemptIds).toEqual([]);
    expect(result.bindings).toEqual([
      { id: "claimed", state: "active", cwd: "/trees/frozen" },
      { id: "queued", state: "pending", cwd: "/trees/session-now" },
      { id: "resumable", state: "suspended", cwd: "/trees/preset" },
    ]);
  });

  it("marks malformed unsettled ownership unknown instead of declaring a tree safe", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-worktree-prune-"));
    tempRoots.push(root);
    const dbPath = path.join(root, "seam.db");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE turn_attempts (id TEXT, state TEXT, identity TEXT, spec_json TEXT)");
    db.prepare("INSERT INTO turn_attempts VALUES (?, ?, ?, ?)").run("opaque", "active", "{", "{}");
    db.close();

    expect(readDispatchBindings(dbPath)).toMatchObject({
      unknownAttemptIds: ["opaque"],
      unavailable: null,
    });
  });

  it("parses branch worktrees without treating ancestry as evidence", () => {
    expect(parseWorktreeList(porcelain)).toContainEqual(expect.objectContaining({
      path: trees.active,
      branch: "fix/fresh-active",
      head: "base-head",
    }));
  });

  it("requires terminal exact-head PR evidence, a clean tree, and no unsettled dispatch", () => {
    const f = fixture();
    const plan = planWorktreePrune({ repo, dataDir, run: f.run, dispatchReader: f.dispatchReader, processReader: f.processReader });
    const reasons = Object.fromEntries(plan.decisions.map((decision) => [decision.path, decision.reason]));

    expect(reasons).toEqual({
      [trees.main]: "main_checkout",
      [trees.merged]: "terminal_pull_request",
      [trees.active]: "unsettled_dispatch",
      [trees.dirty]: "dirty_worktree",
      [trees.open]: "pull_request_open",
      [trees.advanced]: "pull_request_head_mismatch",
    });
    expect(plan.decisions.filter((decision) => decision.eligible).map((decision) => decision.path)).toEqual([trees.merged]);
    // The fresh branch is ancestry-identical to main in the incident shape;
    // no ancestry command exists because ancestry is not deletion authority.
    expect(f.calls.some((call) => call.args.includes("merge-base") || call.args.includes("--is-ancestor"))).toBe(false);
  });

  it("defaults to a non-mutating prune preview", () => {
    const f = fixture();
    const plan = planWorktreePrune({ repo, dataDir, run: f.run, dispatchReader: f.dispatchReader, processReader: f.processReader });
    const result = executeWorktreePrune({ plan, run: f.run, dispatchReader: f.dispatchReader, processReader: f.processReader });

    expect(result).toMatchObject({ apply: false, removed: [] });
    expect(f.calls).toContainEqual({ command: "git", args: ["-C", repo, "worktree", "prune", "--dry-run", "--verbose"] });
    expect(f.calls.some((call) => call.command === "wt")).toBe(false);
  });

  it("rechecks all three authorities, then delegates unmount-first removal to wt", () => {
    const f = fixture();
    const plan = planWorktreePrune({ repo, dataDir, run: f.run, dispatchReader: f.dispatchReader, processReader: f.processReader });
    const result = executeWorktreePrune({ plan, apply: true, run: f.run, dispatchReader: f.dispatchReader, processReader: f.processReader });

    expect(result.removed).toEqual([trees.merged]);
    expect(f.dispatchReader).toHaveBeenCalledTimes(2);
    expect(f.calls).toContainEqual({ command: "wt", args: ["teardown", "--repo", repo, trees.merged] });
    expect(f.calls).toContainEqual({ command: "git", args: ["-C", repo, "worktree", "prune", "--verbose"] });
  });

  it("refuses at apply time when a dispatch claims the candidate after planning", () => {
    const f = fixture();
    const initiallyClear = {
      paths: [], attemptIds: [], bindings: [], unknownAttemptIds: [], unavailable: null,
    };
    f.dispatchReader
      .mockReturnValueOnce(initiallyClear)
      .mockReturnValueOnce({
        paths: [trees.merged], attemptIds: ["late"],
        bindings: [{ id: "late", state: "active", cwd: trees.merged }],
        unknownAttemptIds: [], unavailable: null,
      });
    const plan = planWorktreePrune({ repo, dataDir, run: f.run, dispatchReader: f.dispatchReader, processReader: f.processReader });
    const result = executeWorktreePrune({ plan, apply: true, run: f.run, dispatchReader: f.dispatchReader, processReader: f.processReader });

    expect(result.refused).toContainEqual({ path: trees.merged, reason: "unsettled_dispatch" });
    expect(f.calls.some((call) => call.command === "wt" && call.args.includes(trees.merged))).toBe(false);
  });

  it("fails closed when the dispatch ledger is unreadable or an unsettled attempt cannot be mapped", () => {
    for (const dispatch of [
      { paths: [], attemptIds: [], unknownAttemptIds: [], unavailable: "locked" },
      { paths: [], attemptIds: [], unknownAttemptIds: ["unknown"], unavailable: null },
    ]) {
      const f = fixture();
      f.dispatchReader.mockReturnValue(dispatch);
      const plan = planWorktreePrune({ repo, dataDir, run: f.run, dispatchReader: f.dispatchReader, processReader: f.processReader });
      expect(plan.decisions.some((decision) => decision.eligible)).toBe(false);
    }
  });

  it("refuses a clean merged tree while any process still has a cwd inside it", () => {
    const f = fixture();
    f.dispatchReader.mockReturnValue({
      paths: [], attemptIds: [], bindings: [], unknownAttemptIds: [], unavailable: null,
    });
    f.processReader.mockReturnValue({
      bindings: [{ pid: 4242, cwd: path.join(trees.merged, "packages", "core") }],
      unavailable: null,
    });

    const plan = planWorktreePrune({
      repo, dataDir, run: f.run, dispatchReader: f.dispatchReader, processReader: f.processReader,
    });
    expect(plan.decisions.find((decision) => decision.path === trees.merged)).toMatchObject({
      eligible: false,
      reason: "process_in_worktree",
      processes: [{ pid: 4242 }],
    });
  });
});

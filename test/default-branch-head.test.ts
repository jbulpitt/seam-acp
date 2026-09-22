import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readDefaultBranchHead } from "../packages/core/src/core/dispatch/default-branch-head.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "seam-test",
      GIT_AUTHOR_EMAIL: "seam-test@example.com",
      GIT_COMMITTER_NAME: "seam-test",
      GIT_COMMITTER_EMAIL: "seam-test@example.com",
    },
  });
}

describe("readDefaultBranchHead", () => {
  it("reads origin/HEAD and nothing else", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "seam-451-git-"));
    dirs.push(dir);
    git(dir, ["init", "-b", "main"]);
    git(dir, ["commit", "--allow-empty", "-m", "init"]);
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    git(dir, ["update-ref", "refs/remotes/origin/main", sha]);
    git(dir, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    await expect(readDefaultBranchHead(dir)).resolves.toEqual({ name: "origin/main", sha });
  });

  it("is no opinion when the checkout has no origin HEAD", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "seam-451-git-"));
    dirs.push(dir);
    git(dir, ["init", "-b", "main"]);
    await expect(readDefaultBranchHead(dir)).resolves.toBeUndefined();
    await expect(readDefaultBranchHead(path.join(dir, "missing"))).resolves.toBeUndefined();
  });
});

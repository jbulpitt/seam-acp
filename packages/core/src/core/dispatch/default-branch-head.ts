/**
 * Default-branch tip of a checkout this process can see (#451).
 *
 * Read at resume time. Not stored. Failure, a missing origin HEAD, or a
 * remote session is no opinion — the caller omits the line.
 */
import { execFile } from "node:child_process";

const SHA = /^[0-9a-f]{40}$/;
const NAME = /^origin\/[A-Za-z0-9._/-]+$/;

function git(cwd: string, args: string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { timeout: timeoutMs, encoding: "utf8" },
      (err, stdout) => {
        if (err) resolve(undefined);
        else resolve(String(stdout).trim() || undefined);
      },
    );
  });
}

/** `origin/HEAD` on this machine. Undefined when git cannot answer. */
export async function readDefaultBranchHead(
  cwd: string,
  timeoutMs = 2000,
): Promise<{ name: string; sha: string } | undefined> {
  if (!cwd || cwd.includes("\0") || cwd.includes("\n")) return undefined;
  const name = await git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], timeoutMs);
  if (!name || !NAME.test(name)) return undefined;
  const sha = await git(cwd, ["rev-parse", "--verify", `refs/remotes/${name}`], timeoutMs);
  if (!sha || !SHA.test(sha)) return undefined;
  return { name, sha };
}

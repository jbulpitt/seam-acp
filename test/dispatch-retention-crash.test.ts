import { afterEach, describe, expect, it } from "vitest";
import { execFile, fork, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionStore } from "../packages/core/src/core/session-store.js";

const repo = fileURLToPath(new URL("..", import.meta.url));
const children: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    }
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function temporary(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "seam-306-crash-"));
  dirs.push(dir); return dir;
}
function child(dataDir: string, phase: string): ChildProcess {
  const compiled = process.env.SEAM_306_COMPILED === "1";
  const proc = fork(path.join(repo, "test/fixtures/done-retention-child.mjs"),
    [repo, dataDir, phase, compiled ? "dist" : "src"], {
      cwd: repo, execArgv: compiled ? [] : ["--import", "tsx"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { PATH: process.env.PATH, HOME: dataDir },
    });
  children.push(proc); return proc;
}
async function message(proc: ChildProcess): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("disposable child timed out")); }, 5000);
    const onMessage = (value: Record<string, unknown>): void => { cleanup(); resolve(value); };
    const onExit = (): void => { cleanup(); reject(new Error("disposable child exited before checkpoint")); };
    const cleanup = (): void => { clearTimeout(timer); proc.off("message", onMessage); proc.off("exit", onExit); };
    proc.once("message", onMessage); proc.once("exit", onExit);
  });
}

describe("result retention across real process death (#306)", () => {
  it.skipIf(process.env.SEAM_306_COMPILED !== "1")("compiled maintenance CLI defaults to dry-run and applies only canonical proof", async () => {
    const dataDir = await temporary();
    const store = new SessionStore(path.join(dataDir, "seam.db"));
    const done = path.join(dataDir, "dispatch/done");
    try {
      await mkdir(done, { recursive: true });
      store.recordDelegation({ id: "resolved", kind: "wake", status: "completed" });
      store.recordDelegation({ id: "unresolved", kind: "wake", status: "running" });
      for (const id of ["resolved", "unresolved", "unknown"]) {
        await writeFile(path.join(done, `${id}.json`), JSON.stringify({ id, kind: "wake", target: "worker",
          status: "completed", finishedUtc: new Date().toISOString(), output: "synthetic result" }));
      }
      const run = async (args: string[]) => JSON.parse((await promisify(execFile)(process.execPath,
        [path.join(repo, "scripts/prune-dispatch-done.mjs"), "--data-dir", dataDir, ...args],
        { cwd: repo, env: { PATH: process.env.PATH, HOME: dataDir }, timeout: 5000 })).stdout);
      // Without default dry-run the operator's inspection destroys artifacts; without canonical gating apply loses unresolved output.
      expect(await run([])).toMatchObject({ scanned: 3, pruned: 1, retained: 2, dryRun: true, failed: 0 });
      expect(await readdir(done)).toHaveLength(3);
      expect(await run(["--apply"])).toMatchObject({ scanned: 3, pruned: 1, retained: 2, dryRun: false, failed: 0 });
      expect((await readdir(done)).sort()).toEqual(["unknown.json", "unresolved.json"]);
      expect(store.getDelegation("resolved")?.status).toBe("completed");
    } finally { store.close(); }
  }, 15_000);

  it("recovers an undelivered output after SIGKILL without executing the original task again", async () => {
    const dataDir = await temporary();
    const producer = child(dataDir, "produce");
    expect(await message(producer)).toEqual({ event: "result-produced" });
    const exit = once(producer, "exit"); producer.kill("SIGKILL"); await exit;
    // Without unresolved retention, this process-death window loses the only
    // delivery artifact; without SQL completion it can replay the paid task.
    const done = path.join(dataDir, "dispatch/done/crash-before-delivery.json");
    expect(JSON.parse(await readFile(done, "utf8")).output).toBe("captured synthetic output");
    await expect(access(path.join(dataDir, "delivery-sink.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const recovery = child(dataDir, "recover");
    const recoveredExit = once(recovery, "exit");
    expect(await message(recovery)).toEqual({ event: "recovered", reconciled: 1, pruned: 1, executionCount: "1" });
    await recoveredExit;
    expect(JSON.parse(await readFile(path.join(dataDir, "delivery-sink.json"), "utf8"))).toEqual({
      id: "crash-before-delivery", output: "captured synthetic output",
    });
    await expect(access(done)).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);

  it("operator --wait reads the SQL outcome after a delivered artifact has disappeared", async () => {
    const dataDir = await temporary();
    const store = new SessionStore(path.join(dataDir, "seam.db"));
    const proc = spawn(process.execPath, [path.join(repo, "scripts/seam-dispatch.mjs"),
      "--target", "synthetic-worker", "--prompt", "synthetic task", "--wait", "--timeout", "5", "--data-dir", dataDir],
      { cwd: repo, env: { PATH: process.env.PATH, HOME: dataDir }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(proc);
    let output = ""; proc.stdout.on("data", (chunk) => { output += chunk; });
    const exited = once(proc, "exit");
    try {
      let name: string | undefined;
      const deadline = Date.now() + 3000;
      while (!name && Date.now() < deadline) {
        name = (await readdir(path.join(dataDir, "dispatch/pending")).catch(() => []))
          .find((entry) => entry.endsWith(".json"));
        if (!name) await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (!name) throw new Error("CLI did not publish disposable spec");
      const spec = JSON.parse(await readFile(path.join(dataDir, "dispatch/pending", name), "utf8"));
      store.recordDelegation({ id: spec.id, kind: "wake", status: "completed" });
      const a = store.turnAttempts.claim(spec, "fixture", "fixture-owner");
      store.turnAttempts.complete(a, { id: spec.id, target: spec.target, status: "completed", output: "SQL result", finishedUtc: new Date().toISOString() });
      store.turnAttempts.markDeliveryDone(a.id);
      // Without SQL fallback the 500ms polling CLI times out after successful delivery and pruning.
      expect((await exited)[0]).toBe(0);
      expect(JSON.parse(output).output).toBe("SQL result");
    } finally { store.close(); }
  }, 10_000);
});

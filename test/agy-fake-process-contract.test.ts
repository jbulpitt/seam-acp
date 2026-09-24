/**
 * #609 — agy's in-process ACP host must honour Node's ChildProcess exit state:
 * exitCode/signalCode are null while running and set on exit, and `killed` is
 * live. Without that, adapter-child treated every agy session as exited and
 * dropped its input. The end-to-end path is covered by
 * bridge-adapter-child-real.test.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeAgyProfile, makeAgyUnpinnedRuntime } from "../packages/adapters/src/index.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function installFakeAgy(): { dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agy-fake-process-"));
  dirs.push(dir);
  // Only ever probed for --version by makeAgyUnpinnedRuntime's constructor;
  // the ACP `initialize` handshake under test never spawns this binary.
  fs.writeFileSync(path.join(dir, "agy"), "#!/bin/sh\necho 1.2.2\n", { mode: 0o755 });
  return { dir };
}

function spawnFakeAgyProc() {
  const { dir } = installFakeAgy();
  const runtime = makeAgyUnpinnedRuntime({
    credentialScope: "antigravity-oauth:default",
    cwd: dir,
    baseEnv: { PATH: dir, HOME: os.homedir() },
  });
  const profile = makeAgyProfile({ runtime, defaultModel: "gemini-3.8-flash-high" });
  return profile.spawn("gemini-3.8-flash-high", undefined, [], { cwd: dir });
}

describe("agy fake ACP process — Node ChildProcess contract", () => {
  it("reports exitCode and signalCode as null while running, like a real ChildProcess", () => {
    const proc = spawnFakeAgyProc();
    expect(proc.exitCode).toBeNull();
    expect(proc.signalCode).toBeNull();
    expect(proc.killed).toBe(false);
    proc.kill();
  });

  it("sets a real exitCode and killed only after kill()", async () => {
    const proc = spawnFakeAgyProc();
    const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    proc.kill();
    await exited;
    expect(proc.exitCode).not.toBeNull();
    expect(proc.killed).toBe(true);
  });

  it("answers a real ACP initialize request written to its stdin", async () => {
    const proc = spawnFakeAgyProc();
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("no ACP response within 2s")), 2_000);
      proc.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const newline = buf.indexOf("\n");
        if (newline === -1) return;
        clearTimeout(timer);
        resolve(JSON.parse(buf.slice(0, newline)));
      });
    });
    proc.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: { fs: {}, terminal: false } },
      })}\n`
    );
    const message = await response;
    expect(message).toMatchObject({ jsonrpc: "2.0", id: 0, result: { protocolVersion: 1 } });
    proc.kill();
  });
});

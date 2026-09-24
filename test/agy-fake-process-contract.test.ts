/**
 * #610 — the ACP host `profile.spawn()` returns for agy is a fabricated,
 * in-process object (no real OS child; `makeFakeAgyProcess` in
 * packages/adapters/src/profiles/agy.ts), cast to Node's real
 * `ChildProcessByStdio` type. `adapter-child.ts`'s generic `writeAgent` guard
 * — written for a real ChildProcess, where a running process always has
 * `exitCode === null` and `signalCode === null` — treats ANY other value,
 * including `undefined`, as "already exited" and refuses to write.
 *
 * The fake object never set either property, so they read as `undefined`.
 * `undefined !== null`, so every input write after the bootstrap (which
 * bypasses this object — sessiond writes it straight to the wrapper
 * process's own real stdin) was silently refused. No agy turn could ever
 * deliver `initialize`; every session timed out at 45s with a message
 * indistinguishable from a real installation or auth failure. This is
 * NOT the same bug as #606 (a resolved `false` from `writeInput` going
 * unreported) or #608/#609 (a stale AGY version pin, or a bridge-only
 * restart poisoning sessiond's slot map) — it reproduces standalone, with
 * no bridge, sessiond, or restart involved at all.
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

/** adapter-child.ts's exact guard (packages/bridge/src/adapter-child.ts). A
 *  future rewrite of either side must keep this expression's meaning intact
 *  for the fake process to stay writable — assert the real predicate, not a
 *  paraphrase of it. */
function writableByAdapterChild(child: {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
  stdin?: { writable?: boolean } | null;
}): boolean {
  return !(!child || child.exitCode !== null || child.signalCode !== null || child.killed || !child.stdin?.writable);
}

describe("agy fake ACP process — Node ChildProcess contract", () => {
  it("reports exitCode and signalCode as null while running, like a real ChildProcess", () => {
    const proc = spawnFakeAgyProc();
    expect(proc.exitCode).toBeNull();
    expect(proc.signalCode).toBeNull();
    expect(proc.killed).toBe(false);
    proc.kill();
  });

  it("is writable by adapter-child.ts's guard immediately after spawn", () => {
    const proc = spawnFakeAgyProc();
    // This is the exact condition that silently dropped every agy input
    // frame: it evaluated to `false` the instant the process was created,
    // before any real work happened and with nothing that could recover.
    expect(writableByAdapterChild(proc)).toBe(true);
    proc.kill();
  });

  it("sets a real exitCode only after kill(), and stops being writable", async () => {
    const proc = spawnFakeAgyProc();
    const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    proc.kill();
    await exited;
    expect(proc.exitCode).not.toBeNull();
    expect(writableByAdapterChild(proc)).toBe(false);
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

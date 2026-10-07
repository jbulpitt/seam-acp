import { afterEach, describe, expect, it, vi } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSessiondProcessIdentity } from "../packages/bridge/src/sessiond-server.js";
import { savedSessionHost } from "./helpers/saved-session-recovery.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const owners: ChildProcess[] = [];
const roots: string[] = [];
const holders: Array<{ socketPath: string; identity: NonNullable<ReturnType<typeof readSessiondProcessIdentity>> }> = [];
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function untilGone(pid: number, ms = 3_000) {
  const end = performance.now() + ms;
  while (readSessiondProcessIdentity(pid) && performance.now() < end) await delay(20);
  return !readSessiondProcessIdentity(pid);
}

async function socketHolders(socketPath: string) {
  if (process.platform !== "linux") return holders.filter(h => h.socketPath === socketPath && readSessiondProcessIdentity(h.identity.pid));
  const found: number[] = [];
  for (const name of await fs.readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const argv = await fs.readFile(`/proc/${name}/cmdline`, "utf8").catch(() => "");
    if (argv.split("\0").includes(socketPath)) found.push(Number(name));
  }
  return found;
}

async function ownerFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "seam-holder-lifetime-"));
  roots.push(root);
  const owner = fork(path.join(here, "fixtures/slot-holder-lifetime-owner.mjs"), [root], {
    execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"], env: { PATH: process.env.PATH, HOME: root },
  });
  owners.push(owner);
  const ready = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture holder did not start")), 10_000);
    owner.once("message", value => { clearTimeout(timer); resolve(value); });
    owner.once("exit", () => { clearTimeout(timer); reject(new Error("fixture owner exited before spawning")); });
  });
  holders.push(ready.holder);
  expect(await socketHolders(ready.holder.socketPath)).toEqual([ready.holder.identity.pid]);
  return { owner, ...ready };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const owner of owners.splice(0)) {
    if (owner.exitCode !== null || owner.signalCode !== null) continue;
    const exited = once(owner, "exit");
    owner.kill("SIGKILL");
    await exited;
  }
  // Red runs leave real holders; only this fixture's socket/identity may be reaped.
  for (const holder of holders.splice(0)) {
    const current = readSessiondProcessIdentity(holder.identity.pid);
    if (current?.started === holder.identity.started) {
      expect((await socketHolders(holder.socketPath))).toContain(holder.identity.pid);
      process.kill(-holder.identity.pgid, "SIGKILL");
      expect(await untilGone(holder.identity.pid)).toBe(true);
    }
  }
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("test holders belong to their fixture lifetime", () => {
  it("reaps the saved-session holder even while Date is frozen", async () => {
    const host = await savedSessionHost();
    let closed: Promise<void> | undefined;
    let date: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await host.makeRouter().getOrStartRuntime(host.record);
      const state = JSON.parse(await fs.readFile(path.join(host.root, "slots.json"), "utf8"));
      const holder = state.slots[0];
      expect(await socketHolders(holder.socketPath)).toEqual([holder.identity.pid]);
      date = vi.spyOn(Date, "now").mockReturnValue(Date.now());
      closed = host.close();
      const finished = await Promise.race([closed.then(() => true), delay(4_000).then(() => false)]);
      expect(finished, `holder still owns ${holder.socketPath}`).toBe(true);
      expect(await socketHolders(holder.socketPath)).toEqual([]);
    } finally {
      date?.mockRestore();
      await (closed ?? host.close());
    }
  }, 20_000);

  it("reaps the group on fixture teardown even if its child ignores SIGTERM", async () => {
    const { owner, holder, childPid } = await ownerFixture();
    const released = once(owner, "message");
    owner.send("teardown");
    await released;
    expect(await untilGone(holder.identity.pid)).toBe(true);
    expect(await socketHolders(holder.socketPath)).toEqual([]);
    expect(await untilGone(childPid)).toBe(true);
  }, 20_000);

  it("bounds a source fixture's SIGTERM cleanup with a real timer", async () => {
    const { owner, holder, childPid } = await ownerFixture();
    const signalled = once(owner, "message");
    owner.send("signal");
    await signalled;
    expect(await untilGone(holder.identity.pid)).toBe(true);
    expect(await socketHolders(holder.socketPath)).toEqual([]);
    expect(await untilGone(childPid)).toBe(true);
  }, 20_000);

  it.each(["throw", "timeout"] as const)("reaps the group after its owner exits: %s", async mode => {
    const { owner, holder, childPid } = await ownerFixture();
    const exited = once(owner, "exit");
    if (mode === "throw") owner.send("throw");
    else owner.kill("SIGKILL");
    await exited;
    expect(await untilGone(holder.identity.pid)).toBe(true);
    expect(await socketHolders(holder.socketPath)).toEqual([]);
    expect(await untilGone(childPid)).toBe(true);
  }, 20_000);
});

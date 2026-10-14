import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessiondClient } from "../packages/bridge/src/sessiond-client.js";
import { readSessiondProcessIdentity, SessiondServer } from "../packages/bridge/src/sessiond-server.js";
import type { SessiondEvent, SessiondReplayOutputResult } from "../packages/bridge/src/sessiond-protocol.js";

interface Fixture { root: string; socketPath: string; statePath: string }
const fixtures: Fixture[] = [];
const daemons: ChildProcess[] = [];
const clients: SessiondClient[] = [];
const servers: SessiondServer[] = [];
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined) return result;
    await delay(10);
  }
  throw new Error("sessiond cutover fixture did not settle within 10s");
}

async function fixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "seam-ack-cutover-"));
  await fs.chmod(root, 0o700);
  const value = { root, socketPath: path.join(root, "sd.sock"), statePath: path.join(root, "slots.json") };
  fixtures.push(value);
  return value;
}

async function connect(socketPath: string): Promise<SessiondClient> {
  const client = await SessiondClient.connect(socketPath);
  clients.push(client);
  return client;
}

async function startDaemon(value: Fixture) {
  const daemon = spawn(process.execPath, ["--import", "tsx", path.resolve("packages/bridge/src/sessiond.ts"),
    "--socket", value.socketPath, "--state", value.statePath,
    "--resume-dir", path.join(value.root, "resume")], {
    cwd: process.cwd(), env: { ...process.env }, stdio: ["ignore", "ignore", "pipe"],
  });
  daemons.push(daemon);
  let stderr = "";
  let cause: Error | undefined;
  daemon.stderr!.on("data", chunk => { stderr += String(chunk); });
  daemon.once("error", error => { cause = error; });
  const client = await until(async () => {
    if (cause) throw cause;
    if (daemon.exitCode !== null || daemon.signalCode !== null) throw new Error(`sessiond exited: ${stderr}`);
    try { return await connect(value.socketPath); }
    catch (error) {
      if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      return undefined;
    }
  });
  return { daemon, client };
}

async function stopDaemon(daemon: ChildProcess) {
  const exited = once(daemon, "exit");
  daemon.kill("SIGTERM");
  return await exited;
}

const echo = "process.stdin.pipe(process.stdout);";
const text = (replay: SessiondReplayOutputResult) => replay.frames.filter(frame => frame.stream === "stdout")
  .map(frame => Buffer.from(frame.dataBase64!, "base64").toString()).join("");

async function output(client: SessiondClient, slot: number, afterSeq: number, marker: string) {
  return await until(async () => {
    const replay = await client.replayOutput({ slot, afterSeq });
    return text(replay).includes(marker) ? replay : undefined;
  });
}

async function persisted(value: Fixture, slot: number) {
  const state = JSON.parse(await fs.readFile(value.statePath, "utf8"));
  return state.slots.find((row: { slot: number }) => row.slot === slot) as {
    pid: number; identity: ReturnType<typeof readSessiondProcessIdentity>; outputAckedThrough?: number; status: string;
  };
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const daemon of daemons.splice(0)) {
    if (daemon.exitCode !== null || daemon.signalCode !== null) continue;
    const exited = once(daemon, "exit");
    daemon.kill("SIGTERM");
    await Promise.race([exited, delay(5_000)]);
    if (daemon.exitCode === null && daemon.signalCode === null) {
      daemon.kill("SIGKILL");
      await exited;
    }
  }
  for (const server of servers.splice(0)) await server.close({ terminateChildren: true });
  for (const value of fixtures.splice(0)) {
    const cleanup = new SessiondServer({ ...value, resumeDir: path.join(value.root, "resume") });
    try { await cleanup.start(); }
    finally { await cleanup.close({ terminateChildren: true }); }
    await fs.rm(value.root, { recursive: true, force: true });
  }
});

describe("sessiond live ACK cutover", () => {
  it.each([false, true])("retains the real consumer cursor through main-PID SIGTERM (unread output: %s)", async unread => {
    const value = await fixture(), slot = 1009;
    const first = await startDaemon(value);
    const { pid } = await first.client.spawn({ slot, executable: process.execPath, args: ["-e", echo], cwd: value.root, env: {} });
    const holder = (await persisted(value, slot)).identity;
    const child = readSessiondProcessIdentity(pid);
    expect(holder).toBeDefined(); expect(child).toBeDefined();
    await first.client.write(slot, "read-1\nread-2\n");
    const read = await output(first.client, slot, 0, "read-2\n");
    const cursor = read.frames.at(-1)!.seq;
    await first.client.ack({ slot, throughSeq: cursor });
    if (unread) {
      await first.client.write(slot, "unread-3\n");
      await output(first.client, slot, cursor, "unread-3\n");
    }
    first.client.close();
    expect(await stopDaemon(first.daemon)).toEqual([0, null]);

    const second = await startDaemon(value);
    const health = (await second.client.listSlots()).health.find(row => row.slot === slot)!;
    const events: SessiondEvent[] = [];
    await second.client.subscribe({ slot, afterSeq: health.outputAckedThrough ?? 0 }, event => events.push(event));
    await second.client.write(slot, unread ? "live-4\n" : "unread-3\nlive-4\n");
    const replay = await output(second.client, slot, health.outputAckedThrough ?? 0, "live-4\n");
    expect(replay.gap).toBeUndefined();
    expect(health).toMatchObject({ alive: true, attached: true, pid, outputAckedThrough: cursor });
    expect(text(replay)).toBe("unread-3\nlive-4\n");
    expect(events.filter(event => event.type === "output_gap")).toEqual([]);
    expect(events.filter(event => event.type === "output" && event.frame.stream === "stdout")
      .map(event => Buffer.from(event.frame.dataBase64!, "base64").toString()).join(""))
      .toBe("unread-3\nlive-4\n");
    expect(readSessiondProcessIdentity(holder!.pid)).toEqual(holder);
    expect(readSessiondProcessIdentity(pid)).toEqual(child);
    expect((await persisted(value, slot)).outputAckedThrough).toBe(cursor);

    const latest = replay.frames.at(-1)!.seq;
    await second.client.ack({ slot, throughSeq: latest });
    second.client.close();
    expect(await stopDaemon(second.daemon)).toEqual([0, null]);
    const third = await startDaemon(value);
    const idle = (await third.client.listSlots()).health.find(row => row.slot === slot)!;
    expect(idle.outputAckedThrough).toBe(latest);
    expect(await third.client.replayOutput({ slot, afterSeq: latest })).toEqual({ slot, frames: [] });
    await third.client.write(slot, "same-child-5\n");
    const final = await output(third.client, slot, idle.outputAckedThrough!, "same-child-5\n");
    expect(final.gap).toBeUndefined(); expect(text(final)).toBe("same-child-5\n");
    expect(readSessiondProcessIdentity(holder!.pid)).toEqual(holder);
    expect(readSessiondProcessIdentity(pid)).toEqual(child);
  }, 45_000);

  it("still reports unread output lost to a real replay-buffer bound after cutover", async () => {
    const value = await fixture(), slot = 1010;
    const outputLog = { maxFramesPerSlot: 2 };
    const first = new SessiondServer({ ...value, outputLog }); servers.push(first);
    await first.start();
    const client = await connect(value.socketPath);
    const { pid } = await client.spawn({ slot, executable: process.execPath, args: ["-e", echo], cwd: value.root, env: {} });
    await client.write(slot, "consumed-1\n");
    const cursor = (await output(client, slot, 0, "consumed-1\n")).frames.at(-1)!.seq;
    await client.ack({ slot, throughSeq: cursor });
    await client.write(slot, "unread-2\nunread-3\nunread-4\nunread-5\nunread-6\nunread-7\n");
    const lost = await output(client, slot, cursor, "unread-7\n");
    expect(lost.gap).toMatchObject({ afterSeq: cursor, droppedFrames: 4 });
    client.close(); await first.close(); servers.splice(servers.indexOf(first), 1);

    const second = new SessiondServer({ ...value, outputLog }); servers.push(second);
    await second.start();
    const replacement = await connect(value.socketPath);
    const replay = await output(replacement, slot, cursor, "unread-7\n");
    expect(replay.gap).toEqual({ afterSeq: cursor, firstAvailableSeq: cursor + 5, droppedFrames: 4 });
    expect(text(replay)).toBe("unread-6\nunread-7\n");
    const events: SessiondEvent[] = [];
    await replacement.subscribe({ slot, afterSeq: cursor }, event => events.push(event));
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "output_gap", gap: replay.gap })]));
    expect((await replacement.listSlots()).health.find(row => row.slot === slot)?.pid).toBe(pid);
  }, 30_000);
});

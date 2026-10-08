import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessiondClient } from "../packages/bridge/src/sessiond-client.js";
import { readSessiondProcessIdentity, SessiondServer } from "../packages/bridge/src/sessiond-server.js";

const roots: string[] = [];
const servers: SessiondServer[] = [];
const clients: SessiondClient[] = [];
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(10);
  }
  throw new Error("slot pruning condition did not settle");
}

async function connect(server: SessiondServer, socketPath: string) {
  servers.push(server);
  await server.start();
  const client = await SessiondClient.connect(socketPath);
  clients.push(client);
  return client;
}

async function harness() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "seam-prune621-"));
  roots.push(root);
  const socketPath = path.join(root, "control.sock");
  const statePath = path.join(root, "slots.json");
  const server = new SessiondServer({ socketPath, statePath });
  const client = await connect(server, socketPath);
  return { root, socketPath, statePath, server, client };
}

async function exited(client: SessiondClient, slot: number) {
  await client.spawn({ slot, executable: process.execPath, args: ["-e", 'process.stdout.write("finished\\n"); process.exit(0)'],
    cwd: process.cwd(), env: {} });
  await until(async () => (await client.replayOutput({ slot, afterSeq: 0 })).frames.some(frame => frame.stream === "exit"));
  return (await client.replayOutput({ slot, afterSeq: 0 })).frames;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) await server.close({ terminateChildren: true });
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("#621 acknowledged dead slots", () => {
  it("drops an acknowledged exit, its retained output and its artifacts without waiting a day", async () => {
    const { root, statePath, server, client } = await harness();
    const frames = await exited(client, 621);
    expect(frames.map(frame => frame.stream)).toContain("stdout");
    await client.ack({ slot: 621, throughSeq: frames.at(-1)!.seq });
    await until(async () => !(await client.listSlots()).slots.includes(621));
    await until(async () => !JSON.parse(await fs.readFile(statePath, "utf8")).slots.length);
    expect((server as any).outputLog.stats()).toEqual({ slots: 0, frames: 0, bytes: 0 });
    expect(await fs.readdir(path.join(root, "slots"))).toEqual([]);
  });

  it("retains an unacknowledged exit even after a day, and replays it to a new client", async () => {
    const { socketPath, server, client } = await harness();
    const frames = await exited(client, 622);
    await client.ack({ slot: 622, throughSeq: frames.at(-1)!.seq - 1 });
    const entry = (server as any).slots.get(622);
    entry.exitedAt = Date.now() - 25 * 60 * 60_000;
    process.kill(entry.identity.pid, "SIGTERM");
    await until(() => !readSessiondProcessIdentity(entry.identity.pid));
    client.close();
    await (server as any).pruneExited();
    const reconnected = await SessiondClient.connect(socketPath);
    clients.push(reconnected);
    expect((await reconnected.listSlots()).slots).toContain(622);
    const events: unknown[] = [];
    await reconnected.subscribe({ slot: 622, afterSeq: frames.at(-1)!.seq - 1 }, event => events.push(event));
    expect(events).toEqual([expect.objectContaining({ frame: expect.objectContaining({ stream: "exit", seq: frames.at(-1)!.seq }) })]);
  });

  it("never prunes a living holder, even when its child's exit is acknowledged", async () => {
    const { server, client } = await harness();
    const frames = await exited(client, 623);
    const entry = (server as any).slots.get(623);
    const write = entry.link.write.bind(entry.link);
    const intercepted = vi.spyOn(entry.link, "write").mockImplementation((line: unknown) => {
      if (JSON.parse(String(line)).type === "ack") return true;
      return write(line);
    });
    await client.ack({ slot: 623, throughSeq: frames.at(-1)!.seq });
    expect(readSessiondProcessIdentity(entry.identity.pid)).toEqual(entry.identity);
    await (server as any).pruneExited();
    expect((await client.listSlots()).slots).toContain(623);
    intercepted.mockRestore();
    write(JSON.stringify({ v: 1, type: "ack", throughSeq: frames.at(-1)!.seq }) + "\n");
    await until(async () => !(await client.listSlots()).slots.includes(623));
  });

  it("prunes an acknowledged dead entry on restart but reattaches the same live holder", async () => {
    const { socketPath, statePath, server: first, client } = await harness();
    const live = await client.spawn({ slot: 624, executable: process.execPath, args: ["-e",
      'process.stdin.on("data", chunk => process.stdout.write(chunk)); setInterval(() => {}, 1000)'],
      cwd: process.cwd(), env: {} });
    const frames = await exited(client, 625);
    const entry = (first as any).slots.get(625);
    vi.spyOn(first as any, "pruneExited").mockResolvedValue(undefined);
    await client.ack({ slot: 625, throughSeq: frames.at(-1)!.seq });
    await until(() => !readSessiondProcessIdentity(entry.identity.pid));
    const persisted = JSON.parse(await fs.readFile(statePath, "utf8"));
    expect(persisted.slots.find((row: any) => row.slot === 625)).toMatchObject({
      exitSeq: frames.at(-1)!.seq, outputAckedThrough: frames.at(-1)!.seq,
    });
    client.close();
    await first.close();
    const successor = new SessiondServer({ socketPath, statePath });
    const next = await connect(successor, socketPath);
    expect((await next.listSlots()).health).toEqual([expect.objectContaining({ slot: 624, alive: true, attached: true, pid: live.pid })]);
    const output: string[] = [];
    await next.subscribe({ slot: 624, afterSeq: 0 }, event => {
      if (event.type === "output" && event.frame.stream === "stdout") output.push(Buffer.from(event.frame.dataBase64!, "base64").toString());
    });
    await next.write(624, "same-holder-after-restart\n");
    await until(() => output.join("").includes("same-holder-after-restart"));
  });

  it("does not drop alive output whose controller acknowledged it before a restart", async () => {
    const { socketPath, statePath, server: first, client } = await harness();
    const live = await client.spawn({ slot: 626, executable: process.execPath, args: ["-e",
      'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'], cwd: process.cwd(), env: {} });
    await until(async () => (await client.replayOutput({ slot: 626, afterSeq: 0 })).frames.length > 0);
    const frames = (await client.replayOutput({ slot: 626, afterSeq: 0 })).frames;
    await client.ack({ slot: 626, throughSeq: frames.at(-1)!.seq });
    client.close();
    await first.close();
    const successor = new SessiondServer({ socketPath, statePath });
    const next = await connect(successor, socketPath);
    expect((await next.listSlots()).health).toEqual([expect.objectContaining({ slot: 626, alive: true, attached: true, pid: live.pid })]);
  });

  it("uses the holder's start identity, not a reused pid, and preserves records with no proof", async () => {
    const { socketPath, statePath, server: first, client } = await harness();
    const owned = await client.spawn({ slot: 628, executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(), env: {} });
    const identity = (first as any).slots.get(628).identity;
    client.close();
    await first.close();
    const exitedAt = Date.now() - 25 * 60 * 60_000;
    await fs.writeFile(statePath, JSON.stringify({ version: 1, slots: [
      { slot: 627, pid: owned.pid, identity: { ...identity, started: identity.started + "-prior-owner" },
        status: "dead", exitedAt, lastSeq: 3, exitSeq: 3, outputAckedThrough: 3 },
      { slot: 628, pid: owned.pid, identity, status: "dead", exitedAt, lastSeq: 3, exitSeq: 3, outputAckedThrough: 3 },
      { slot: 629, pid: null, status: "dead", exitedAt, lastSeq: 3, exitSeq: 3, outputAckedThrough: 3 },
      { slot: 630, pid: null, identity: { ...identity, started: identity.started + "-prior-owner" }, status: "dead", exitedAt },
    ] }));
    const successor = new SessiondServer({ socketPath, statePath });
    const next = await connect(successor, socketPath);
    await (successor as any).pruneExited();
    expect((await next.listSlots()).slots.sort()).toEqual([628, 629, 630]);
    expect(readSessiondProcessIdentity(identity.pid)).toEqual(identity);
  });

  it("keeps the registry and retained log bounded under repeated completed lifecycles", async () => {
    const { server, statePath, client } = await harness();
    for (let slot = 640; slot < 645; slot++) {
      const frames = await exited(client, slot);
      await client.ack({ slot, throughSeq: frames.at(-1)!.seq });
      await until(async () => !(await client.listSlots()).slots.length);
    }
    await until(async () => !JSON.parse(await fs.readFile(statePath, "utf8")).slots.length);
    expect((server as any).outputLog.stats()).toEqual({ slots: 0, frames: 0, bytes: 0 });
  });

  it("prunes legacy gone holders after owner reconciliation, but not an unfinished attempt or a live holder", async () => {
    const { socketPath, statePath, server: first, client } = await harness();
    const owned = await client.spawn({ slot: 652, executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(), env: {} });
    const identity = (first as any).slots.get(652).identity;
    client.close();
    await first.close();
    const priorOwner = { ...identity, started: identity.started + "-prior-owner" };
    await fs.writeFile(statePath, JSON.stringify({ version: 1, slots: [
      { slot: 650, pid: null, identity: priorOwner, status: "dead" },
      { slot: 651, pid: null, identity: priorOwner, status: "dead" },
      { slot: 652, pid: owned.pid, identity, status: "dead" },
      { slot: 653, pid: null, status: "dead" },
    ] }));
    const successor = new SessiondServer({ socketPath, statePath });
    const owner = await connect(successor, socketPath);
    const before = await owner.listSlots();
    expect(before.slots.sort()).toEqual([650, 651, 652, 653]);
    // Only the controller's attempt ledger can declare output unnecessary.
    const unfinishedAttemptSlots = new Set([651]);
    const retiredSlots = before.slots.filter(slot => !unfinishedAttemptSlots.has(slot));
    expect((await owner.listSlots({ retiredSlots })).slots.sort()).toEqual([651, 652, 653]);
    await until(async () => !JSON.parse(await fs.readFile(statePath, "utf8")).slots.some((row: any) => row.slot === 650));
    expect(readSessiondProcessIdentity(identity.pid)).toEqual(identity);
  });
});

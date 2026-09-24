/**
 * #573 — the descriptor owner survives the control plane.
 *
 * These are real Unix-socket and real child-process tests. Calling helpers in
 * isolation would not prove the production boundary: the incident is exactly
 * a process losing its anonymous pipe endpoints when its parent goes away.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessiondClient, SessiondClientError } from "../packages/bridge/src/sessiond-client.js";
import { readSessiondProcessIdentity, SessiondServer } from "../packages/bridge/src/sessiond-server.js";
import type { SessiondEvent, SessiondOutputFrame } from "../packages/bridge/src/sessiond-protocol.js";

const roots: string[] = [];
const servers: SessiondServer[] = [];
const clients: SessiondClient[] = [];
const daemons: ChildProcess[] = [];

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(read: () => T | undefined, timeoutMs = 4_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await delay(10);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

async function waitForAsync<T>(read: () => Promise<T | undefined>, timeoutMs = 4_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(10);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

async function harness(outputLog?: { maxBytes?: number; maxAgeMs?: number; maxFramesPerSlot?: number }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "seam-sessiond-test-"));
  await fs.chmod(root, 0o700);
  roots.push(root);
  const socketPath = path.join(root, "control.sock");
  const statePath = path.join(root, "slots.json");
  const server = new SessiondServer({ socketPath, statePath, outputLog });
  servers.push(server);
  await server.start();
  const client = await SessiondClient.connect(socketPath, { requestTimeoutMs: 2_000 });
  clients.push(client);
  return { root, socketPath, statePath, server, client };
}

function stdoutText(events: SessiondEvent[]): string {
  return events
    .filter((event): event is Extract<SessiondEvent, { type: "output" }> =>
      event.type === "output" && event.frame.stream === "stdout")
    .map((event) => Buffer.from(event.frame.dataBase64 ?? "", "base64").toString())
    .join("");
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) await server.close({ terminateChildren: true });
  for (const daemon of daemons.splice(0)) {
    if (daemon.exitCode !== null || daemon.signalCode !== null) continue;
    const exited = new Promise<void>((resolve) => daemon.once("exit", () => resolve()));
    daemon.kill("SIGTERM");
    await Promise.race([exited, delay(1_000)]);
    if (daemon.exitCode === null && daemon.signalCode === null) {
      daemon.kill("SIGKILL");
      await exited;
    }
  }
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("#573 seam-sessiond control-plane restart", () => {
  it("keeps the child and descriptors alive, then replays gap output once and in order", async () => {
    const { socketPath, client } = await harness();
    const script = [
      'process.stdout.write("ready\\n")',
      'setTimeout(() => process.stdout.write("away-1\\n"), 120)',
      'setTimeout(() => process.stdout.write("away-2\\n"), 180)',
      'process.stdin.on("data", chunk => process.stdout.write(`echo:${chunk.toString()}`))',
      'process.on("SIGTERM", () => process.exit(0))',
      'setInterval(() => {}, 1000)',
    ].join(";");
    const spawned = await client.spawn({
      slot: 7,
      executable: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", LANG: "C" },
    });
    expect(spawned.pid).toBeGreaterThan(1);

    const firstEvents: SessiondEvent[] = [];
    await client.subscribe({ slot: 7, afterSeq: 0 }, (event) => firstEvents.push(event));
    await waitFor(() => stdoutText(firstEvents).includes("ready\n") ? true : undefined);
    const firstCursor = Math.max(...firstEvents
      .filter((event): event is Extract<SessiondEvent, { type: "output" }> => event.type === "output")
      .map((event) => event.frame.seq));

    // Closing the entire control-plane connection is the production failure.
    // It must remove only a subscription, never the child or its descriptors.
    client.close();
    await delay(240);

    const replacement = await SessiondClient.connect(socketPath, { requestTimeoutMs: 2_000 });
    clients.push(replacement);
    const secondEvents: SessiondEvent[] = [];
    const subscribed = await replacement.subscribe(
      { slot: 7, afterSeq: firstCursor },
      (event) => secondEvents.push(event),
    );
    expect(subscribed.throughSeq).toBeGreaterThan(firstCursor);
    expect(stdoutText(secondEvents)).toBe("away-1\naway-2\n");
    expect(secondEvents.filter((event) => event.type === "output").every((event) => event.replay)).toBe(true);

    await replacement.write(7, "ping\n");
    await waitFor(() => stdoutText(secondEvents).includes("echo:ping\n") ? true : undefined);
    expect(stdoutText(secondEvents)).toBe("away-1\naway-2\necho:ping\n");

    const beforeKill = await replacement.listSlots();
    expect(beforeKill.slots).toEqual([7]);
    expect(beforeKill.health).toEqual([
      expect.objectContaining({ slot: 7, alive: true, pid: spawned.pid, attached: true }),
    ]);

    await replacement.kill({ slot: 7 });
    await waitForAsync(async () => {
      const listed = await replacement.listSlots();
      return listed.health[0]?.alive === false ? listed : undefined;
    });
    expect((await replacement.listSlots()).slots).toEqual([7]);
  });

  it("reports a child that dies while unattached as a dead retained entry", async () => {
    const { socketPath, client } = await harness();
    await client.spawn({
      slot: 3,
      executable: process.execPath,
      args: ["-e", 'setTimeout(() => { process.stdout.write("last\\n"); process.exit(7); }, 80)'],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
    });
    client.close();
    await delay(180);

    const replacement = await SessiondClient.connect(socketPath);
    clients.push(replacement);
    const listed = await replacement.listSlots();
    expect(listed.slots).toEqual([3]);
    expect(listed.health).toEqual([
      expect.objectContaining({ slot: 3, alive: false, attached: true, exitCode: 7 }),
    ]);
    const replay = await replacement.replayOutput({ slot: 3, afterSeq: 0 });
    expect(replay.frames.map((frame) => frame.stream)).toEqual(["stdout", "exit"]);
    expect(Buffer.from(replay.frames[0]!.dataBase64!, "base64").toString()).toBe("last\n");
  });

  it("bounds an unattached producer by frames and names the replay gap", async () => {
    const { client } = await harness({ maxFramesPerSlot: 2, maxBytes: 1024 * 1024, maxAgeMs: 60_000 });
    const writes = Array.from({ length: 6 }, (_, i) =>
      `setTimeout(() => process.stdout.write("${i}\\n"), ${i * 30})`).join(";");
    await client.spawn({
      slot: 9,
      executable: process.execPath,
      args: ["-e", `${writes};setTimeout(() => process.exit(0), 250)`],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
    });
    await delay(320);
    const replay = await client.replayOutput({ slot: 9, afterSeq: 0 });
    expect(replay.frames).toHaveLength(2);
    expect(replay.gap).toEqual(expect.objectContaining({ afterSeq: 0, droppedFrames: expect.any(Number) }));
    expect(replay.gap!.droppedFrames).toBeGreaterThan(0);
  });

  it("keeps a running slot through a supervisor restart and reattaches it fully (#631)", async () => {
    const { socketPath, statePath, server, client } = await harness();
    const { pid } = await client.spawn({
      slot: 11,
      executable: process.execPath,
      args: ["-e", 'process.stdin.on("data", (d) => process.stdout.write("echo:" + d))'],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
    });
    client.close();
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    expect(() => process.kill(pid, 0)).not.toThrow();

    const successor = new SessiondServer({ socketPath, statePath });
    servers.push(successor);
    await successor.start();
    const replacement = await SessiondClient.connect(socketPath);
    clients.push(replacement);
    const listed = await replacement.listSlots();
    expect(listed.health).toEqual([
      expect.objectContaining({ slot: 11, alive: true, pid, attached: true }),
    ]);
    const events: SessiondEvent[] = [];
    await replacement.subscribe({ slot: 11, afterSeq: 0 }, (event) => events.push(event));
    await replacement.write(11, "after restart\n");
    await waitFor(() => stdoutText(events).includes("echo:after restart") ? true : undefined);
  });

  it("loses no output produced while sessiond is down (#631)", async () => {
    const { socketPath, statePath, server, client } = await harness();
    await client.spawn({
      slot: 13,
      executable: process.execPath,
      args: ["-e", 'let n = 0; const t = setInterval(() => { process.stdout.write("line " + (++n) + "\\n"); if (n === 20) { clearInterval(t); process.exit(0); } }, 25)'],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
    });
    client.close();
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    await delay(800);

    const successor = new SessiondServer({ socketPath, statePath });
    servers.push(successor);
    await successor.start();
    const replacement = await SessiondClient.connect(socketPath);
    clients.push(replacement);
    const events: SessiondEvent[] = [];
    await replacement.subscribe({ slot: 13, afterSeq: 0 }, (event) => events.push(event));
    await waitFor(() => events.some((event) => event.type === "output" && event.frame.stream === "exit") ? true : undefined);
    expect(events.some((event) => event.type === "output_gap")).toBe(false);
    const text = stdoutText(events);
    for (let n = 1; n <= 20; n += 1) expect(text).toContain(`line ${n}\n`);
  });

  it("never signals a persisted pid when its start identity does not match", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "seam-sessiond-test-"));
    await fs.chmod(root, 0o700);
    roots.push(root);
    const socketPath = path.join(root, "control.sock");
    const statePath = path.join(root, "slots.json");
    const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    sentinel.unref();
    const pid = sentinel.pid!;
    const identity = readSessiondProcessIdentity(pid)!;
    await fs.writeFile(statePath, JSON.stringify({
      version: 1,
      slots: [{
        slot: 12,
        pid,
        identity: { ...identity, started: `${identity.started}-wrong` },
        status: "live",
      }],
    }), { mode: 0o600 });

    try {
      const server = new SessiondServer({ socketPath, statePath });
      servers.push(server);
      await server.start();
      const client = await SessiondClient.connect(socketPath);
      clients.push(client);
      expect((await client.listSlots()).health).toEqual([
        expect.objectContaining({
          slot: 12,
          alive: false,
          pid: null,
          attached: false,
          orphanReason: "identity_mismatch",
        }),
      ]);
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      try { process.kill(-identity.pgid, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  it("does not expose executable, cwd, env, or raw spawn errors in state or replies", async () => {
    const { root, statePath, client } = await harness();
    const secret = "TOKEN_SHAPED_VALUE_573";
    const secretCwd = path.join(root, secret);
    await fs.mkdir(secretCwd);
    await client.spawn({
      slot: 16,
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)", secret],
      cwd: secretCwd,
      env: { PATH: process.env.PATH ?? "", SECRET: secret },
    });
    const persisted = await fs.readFile(statePath, "utf8");
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain(process.execPath);

    const failed = await client.spawn({
      slot: 17,
      executable: "/definitely/missing/private/bin",
      args: [secret],
      cwd: "/private/missing/cwd",
      env: { SECRET: secret },
    }).catch((error) => error as SessiondClientError);
    expect(failed).toMatchObject<Partial<SessiondClientError>>({
      code: "spawn_failed",
      processCode: "ENOENT",
      syscall: "spawn",
    });
    // #583: Node's raw spawn error serializes `path` and `spawnargs`. The
    // supervisor emits only its closed typed fields, so a credential-shaped
    // argv value cannot escape through an unhandled event or the wire reply.
    expect(JSON.stringify({
      code: failed.code,
      message: failed.message,
      processCode: failed.processCode,
      syscall: failed.syscall,
    })).not.toContain(secret);
    expect(failed).not.toHaveProperty("path");
    expect(failed).not.toHaveProperty("spawnargs");
    const secondError = await client.spawn({
      slot: 18,
      executable: "/another/missing/private/bin",
      args: [],
      cwd: "/another/private/cwd",
      env: {},
    }).catch((error) => error);
    expect(String(secondError)).not.toContain("/another/private");
  });

  it("keeps token-shaped spawnargs out of the supervisor process output", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "seam-sessiond-cli-test-"));
    await fs.chmod(root, 0o700);
    roots.push(root);
    const socketPath = path.join(root, "control.sock");
    const statePath = path.join(root, "slots.json");
    const secret = "TOKEN_SHAPED_VALUE_573";
    const daemon = spawn(process.execPath, [
      "--import", "tsx",
      path.resolve("packages/bridge/src/sessiond.ts"),
      "--socket", socketPath,
      "--state", statePath,
    ], { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] });
    daemons.push(daemon);
    let emitted = "";
    daemon.stderr?.on("data", (chunk) => { emitted += chunk.toString(); });
    const client = await waitForAsync(async () => {
      try {
        return await SessiondClient.connect(socketPath, { requestTimeoutMs: 1_000 });
      } catch {
        return undefined;
      }
    });
    clients.push(client);

    await expect(client.spawn({
      slot: 19,
      executable: "/missing/private/sessiond-agent",
      args: [secret],
      cwd: "/missing/private/cwd",
      env: { PRIVATE_TOKEN: secret },
    })).rejects.toMatchObject({ code: "spawn_failed", processCode: "ENOENT", syscall: "spawn" });
    await delay(50);

    expect(daemon.exitCode).toBeNull();
    expect(emitted).not.toContain(secret);
    expect(emitted).not.toContain("/missing/private");
  });

  it("creates a private socket and state file", async () => {
    const { socketPath, statePath, client } = await harness();
    await client.spawn({
      slot: 21,
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
    });
    expect((await fs.stat(socketPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(statePath)).mode & 0o777).toBe(0o600);
  });
});

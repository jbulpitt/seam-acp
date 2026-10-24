import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { readProcessIdentity } from "@seam/adapters/process-group";
import { SessiondServer } from "../packages/bridge/src/sessiond-server.js";
import { DEFAULT_REMOTE_RUNG1_POLICY } from "../packages/core/src/core/remote-spawn.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}, 20_000);

it("recovers silent opening handshakes at startup and reconnect without restarting or replaying retained work", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "seam-bridge-handshake-"));
  const socketPath = path.join(directory, "control.sock");
  const statePath = path.join(directory, "slots.json");
  const requestsPath = path.join(directory, "requests.jsonl");
  const daemon = new SessiondServer({ socketPath, statePath, resumeDir: path.join(directory, "resume"),
    supervisor: { pid: process.pid, entrypoint: fileURLToPath(import.meta.url), releaseSha: null } });
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<Socket>();
  const frames: Array<Record<string, any>> = [];
  const hellos: Array<Record<string, any>> = [];
  let upgrades = 0;
  let current: WebSocket;
  let bridge: ChildProcess | undefined;
  let stderr = "";

  cleanups.push(async () => {
    try {
      if (bridge && bridge.exitCode === null && bridge.signalCode === null) {
        const exited = once(bridge, "exit");
        bridge.kill("SIGTERM");
        await exited;
      }
    } finally {
      try {
        for (const ws of wss.clients) ws.terminate();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => wss.close(() => resolve()));
        await new Promise<void>(resolve => http.close(() => resolve()));
      } finally {
        try { await daemon.close({ terminateChildren: true }); }
        finally { await fs.rm(directory, { recursive: true, force: true }); }
      }
    }
  });

  http.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  http.on("upgrade", (request, socket, head) => {
    upgrades++;
    // Accept TCP and read the upgrade request, but leave these handshakes silent.
    if (upgrades === 1 || upgrades === 3) return;
    wss.handleUpgrade(request, socket, head, ws => wss.emit("connection", ws, request));
  });
  wss.on("connection", ws => {
    current = ws;
    ws.on("message", raw => {
      const frame = JSON.parse(raw.toString());
      frames.push(frame);
      if (frame.type === "hello") {
        hellos.push(frame);
        ws.send(JSON.stringify({ type: "hello_ack", accepted: true }));
      }
    });
  });

  async function observed<T>(read: () => T | undefined, what: string, timeout = 10_000): Promise<T> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = read();
      if (value !== undefined) return value;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`did not observe ${what}; upgrades=${upgrades}; bridge stderr: ${stderr}`);
  }
  const frame = (matches: (value: Record<string, any>) => boolean, what: string) =>
    observed(() => frames.find(matches), what);
  const send = (value: object) => current.send(JSON.stringify(value));
  const input = (value: object) => send({ type: "data", slot: 7, data: JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n" });
  const command = async (cmdId: string, action: string, payload: object) => {
    send({ type: "cmd", cmdId, action, payload });
    const reply = await frame(value => value.type === "cmd_reply" && value.cmdId === cmdId, `${action} reply`);
    expect(reply.error).toBeUndefined();
    return reply.payload;
  };
  const native = async (): Promise<Array<{ pid: number; method: string }>> =>
    (await fs.readFile(requestsPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const persistedSlot = async () =>
    JSON.parse(await fs.readFile(statePath, "utf8")).slots.find((value: { slot: number }) => value.slot === 7);

  await daemon.start();
  const listening = once(http, "listening");
  http.listen(0, "127.0.0.1");
  await listening;
  const port = (http.address() as { port: number }).port;
  bridge = spawn(process.execPath, [path.join(root, "packages/bridge/dist/index.js"), "connect",
    "--server", `ws://127.0.0.1:${port}/bridge`, "--id", "handshake-fixture", "--token", "fixture",
    "--cwd", directory], {
    cwd: root, stdio: ["ignore", "ignore", "pipe"], env: {
      HOME: directory, XDG_CONFIG_HOME: directory,
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      COPILOT_CMD: path.join(root, "test/fixtures/fake-acp-agent.mjs"),
      SEAM_SESSIOND_SOCKET: socketPath, SEAM_SESSIOND_STATE: statePath,
      AGY_ENABLED: "false", FAKE_AGENT_REQUESTS: requestsPath,
    },
  });
  bridge.stderr!.on("data", bytes => { stderr += bytes.toString(); });
  const bridgeIdentity = readProcessIdentity(bridge.pid!);
  const daemonIdentity = readProcessIdentity(process.pid);
  expect(bridgeIdentity).toBeDefined();
  expect(daemonIdentity).toBeDefined();
  await observed(() => upgrades === 1 ? true : undefined, "initial accepted silent handshake");

  // Exercise the actual 60s ws request/socket timeout and existing 5s reconnect.
  await observed(() => hellos[0], "initial handshake timeout followed by a real hello", 80_000);
  expect(upgrades).toBe(2);
  expect(stderr).toContain("WebSocket error: Opening handshake has timed out");
  expect(stderr).toContain("Disconnected (code=1006");
  expect(stderr).toContain("Reconnecting in 5s");

  send({ type: "rpc", id: "spawn", method: "spawn", agentId: "copilot",
    params: { slot: 7, agentId: "copilot", cwd: directory, rung1Recovery: DEFAULT_REMOTE_RUNG1_POLICY } });
  expect(await frame(value => value.type === "rpc_reply" && value.id === "spawn", "slot configuration"))
    .toMatchObject({ ok: true });
  input({ id: 1, method: "initialize", params: { protocolVersion: 1 } });
  await frame(value => value.data?.includes('"id":1,"result"'), "native initialize");
  input({ id: 2, method: "session/new", params: { cwd: directory, mcpServers: [] } });
  await frame(value => value.data?.includes('"sessionId":"s1"'), "native session");
  await command("arm", "armRung1Recovery", {
    slot: 7, submissionId: "handshake-turn", acpSessionId: "s1", continuation: "continue",
  });
  input({ id: 3, method: "session/prompt", params: {
    sessionId: "s1", prompt: [{ type: "text", text: "continue with a client reply" }],
  } });
  await frame(value => value.data?.includes('"fixture-client-reply"'), "native pending client reply");
  const owner = (await command("before", "listSlots", {})).health.find((value: { slot: number }) => value.slot === 7);
  const holder = await persistedSlot();
  const childIdentity = readProcessIdentity(owner.pid);
  const nativeIdentity = readProcessIdentity((await native())[0]!.pid);
  expect(owner).toMatchObject({ alive: true, session: { acpSessionId: "s1" },
    recovery: { submissionId: "handshake-turn" } });
  expect(childIdentity).toBeDefined();
  expect(nativeIdentity).toBeDefined();
  expect(holder.identity).toBeDefined();

  current!.terminate();
  await observed(() => upgrades === 3 ? true : undefined, "accepted silent reconnect");
  await observed(() => hellos[1], "reconnect handshake timeout followed by a real hello", 80_000);
  expect(upgrades).toBe(4);
  expect(hellos[1]).toMatchObject({ bridgeId: "handshake-fixture", instanceId: hellos[0]!.instanceId,
    sessiond: hellos[0]!.sessiond });
  expect(stderr.match(/WebSocket error: Opening handshake has timed out/g)).toHaveLength(2);
  expect(bridge.exitCode).toBeNull();
  expect(readProcessIdentity(bridge.pid!)).toEqual(bridgeIdentity);
  expect(readProcessIdentity(process.pid)).toEqual(daemonIdentity);
  expect(readProcessIdentity(owner.pid)).toEqual(childIdentity);
  expect(readProcessIdentity(nativeIdentity!.pid)).toEqual(nativeIdentity);
  expect(await persistedSlot()).toMatchObject({ pid: holder.pid, identity: holder.identity });
  expect((await command("after", "listSlots", {})).health.find((value: { slot: number }) => value.slot === 7))
    .toMatchObject({ alive: true, pid: owner.pid, session: { acpSessionId: "s1" },
      recovery: { submissionId: "handshake-turn" } });

  input({ id: "fixture-client-reply", result: { outcome: { outcome: "selected", optionId: "allow" } } });
  await frame(value => value.data?.includes('"id":3,"result"'), "original turn completion");
  await frame(value => value.type === "recovery_result", "original submission result");
  expect(frames.filter(value => value.type === "recovery_result")).toEqual([
    expect.objectContaining({ recoveryResult: expect.objectContaining({
      submissionId: "handshake-turn", status: "completed", text: "resumed ok", stopReason: "end_turn",
    }) }),
  ]);
  expect(frames.some(value => value.type === "exit")).toBe(false);
  const requests = await native();
  for (const method of ["initialize", "session/new", "session/prompt"]) {
    expect(requests.filter(value => value.method === method)).toHaveLength(1);
  }
  expect(requests.some(value => value.method === "session/load" || value.method === "session/cancel")).toBe(false);
  expect(new Set(requests.map(value => value.pid))).toEqual(new Set([nativeIdentity!.pid]));
}, 200_000);

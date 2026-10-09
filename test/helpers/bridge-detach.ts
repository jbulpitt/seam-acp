import { afterEach, expect, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { SessiondServer } from "../../packages/bridge/src/sessiond-server.js";
import { DEFAULT_REMOTE_RUNG1_POLICY } from "../../packages/core/src/core/remote-spawn.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const entry = path.join(root, "packages/bridge/dist/index.js");
const cleanups: Array<() => Promise<void>> = [];
export const slot = 9;

export async function until<T>(read: () => T | undefined, what: string, timeout = 10_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`did not observe ${what}`);
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

export async function bridgeDetachFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "seam-detach-transfers-"));
  const requestedCwd = path.join(directory, "missing-controller-project");
  const hostServer = { name: "host-mcp", type: "http", url: "https://host.example/mcp", headers: [] };
  await fs.writeFile(path.join(directory, ".mcp.json"), JSON.stringify({
    mcpServers: { "host-mcp": { url: hostServer.url } },
  }));
  const requests = path.join(directory, "requests.jsonl");
  const socketPath = path.join(directory, "control.sock");
  const daemon = new SessiondServer({ socketPath, statePath: path.join(directory, "slots.json") });
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const bridges: ChildProcess[] = [];
  const sockets: WebSocket[] = [];
  const frames: Array<Record<string, any>> = [];
  const releaseWrites: Array<() => void> = [];
  let socket: WebSocket | undefined;
  server.on("connection", ws => {
    socket = ws;
    sockets.push(ws);
    ws.on("message", raw => frames.push(JSON.parse(raw.toString())));
  });
  cleanups.push(async () => {
    for (const release of releaseWrites) release();
    for (const bridge of bridges) {
      if (bridge.exitCode !== null || bridge.signalCode !== null) continue;
      const exited = once(bridge, "exit");
      bridge.kill("SIGTERM");
      await exited;
    }
    for (const ws of sockets) ws.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await daemon.close({ terminateChildren: true });
    await fs.rm(directory, { recursive: true, force: true });
  });
  await Promise.all([daemon.start(), once(server, "listening")]);
  const port = (server.address() as { port: number }).port;

  const send = (value: object) => socket!.send(JSON.stringify(value));
  const data = (text: string) => send({ type: "data", slot, data: text });
  const wire = (id: number | string, method: string, params: object) =>
    JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  const input = (id: number, method: string, params: object) => data(wire(id, method, params));
  const prompt = (text = "continue") => wire(7, "session/prompt", {
    sessionId: "s1", prompt: [{ type: "text", text }],
  });
  const frame = (predicate: (value: Record<string, any>) => boolean, what: string) =>
    until(() => frames.find(predicate), what);
  const reply = (id: string) => frame(value => value.type === "cmd_reply" && value.cmdId === id, `${id} reply`);
  const command = async (cmdId: string, action: string, payload: object) => {
    send({ type: "cmd", cmdId, action, payload });
    const result = await reply(cmdId);
    expect(result.error).toBeUndefined();
    return result.payload;
  };
  const arm = () => command("arm", "armRung1Recovery", {
    slot, submissionId: "detach-turn", acpSessionId: "s1", continuation: "continue",
  });
  const handled = async () => {
    // WS ordering makes the pong evidence that all preceding input was received.
    const ts = Math.random();
    send({ type: "ping", ts });
    await frame(value => value.type === "pong" && value.ts === ts, "input receipt pong");
  };

  async function start() {
    const previous = frames.filter(value => value.type === "hello").length;
    const bridge = spawn(process.execPath, [entry, "connect", "--server", `ws://127.0.0.1:${port}`,
      "--id", "fixture", "--token", "fixture", "--cwd", directory], {
      cwd: root, stdio: ["ignore", "ignore", "pipe"], env: {
        HOME: directory, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        COPILOT_CMD: path.join(root, "test/fixtures/fake-acp-agent.mjs"),
        SEAM_SESSIOND_SOCKET: socketPath, SEAM_SESSIOND_STATE: path.join(directory, "slots.json"),
        AGY_ENABLED: "false", FAKE_AGENT_REQUESTS: requests,
      },
    });
    bridges.push(bridge);
    let stderr = "";
    bridge.stderr!.on("data", bytes => { stderr += bytes.toString(); });
    await until(() => frames.filter(value => value.type === "hello").length > previous ? true : undefined,
      "compiled bridge hello");
    send({ type: "hello_ack", accepted: true });
    return {
      bridge,
      stderr: () => stderr,
      signal: () => { expect(bridge.kill("SIGUSR2")).toBe(true); },
      exited: async (timeout = 5_000) => {
        await until(() => bridge.exitCode !== null || bridge.signalCode !== null ? true : undefined,
          `bridge detach after accepted transfers; stderr: ${stderr}`, timeout);
        expect(bridge.signalCode).toBeNull();
        expect(bridge.exitCode).toBe(0);
      },
    };
  }

  const first = await start();
  send({ type: "rpc", id: "spawn", method: "spawn", agentId: "copilot",
    params: { slot, agentId: "copilot", cwd: requestedCwd, rung1Recovery: DEFAULT_REMOTE_RUNG1_POLICY } });
  const configured = await frame(value => value.type === "rpc_reply" && value.id === "spawn", "spawn reply");
  expect(configured.ok).toBe(true);
  input(1, "initialize", { protocolVersion: 1 });
  input(2, "session/new", { cwd: requestedCwd, mcpServers: [] });
  await frame(value => value.data?.includes('"sessionId":"s1"'), "warm session");
  const childPid = (await daemon["listSlots"]({})).health.find(value => value.slot === slot)?.pid;
  expect(childPid).toBeGreaterThan(0);

  const blockWrite = (matches: (value: Record<string, any>) => boolean) => {
    let reached = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    releaseWrites.push(release);
    const original = daemon["holderWrite"].bind(daemon);
    vi.spyOn(daemon as any, "holderWrite").mockImplementation(async (...args: any[]) => {
      const [holder, bytes] = args;
      const value = JSON.parse(bytes.toString());
      if (matches(value)) { reached = true; await gate; }
      return original(holder, bytes);
    });
    return { reached: () => reached, release };
  };
  const replay = async () => {
    const afterSeq = Math.max(0, ...frames.map(value => typeof value.seq === "number" ? value.seq : 0));
    const payload = await command(`replay-${bridges.length}`, "replayOutput", { slot, afterSeq });
    expect(payload.gap).toBeUndefined();
    frames.push(...payload.frames.map((value: object) => ({ slot, ...value })));
  };
  const completed = async () => {
    await frame(value => value.type === "recovery_result", "one completed native turn");
    for (const result of frames.filter(value => value.type === "recovery_result")) {
      expect(result.recoveryResult).toMatchObject({
        submissionId: "detach-turn", status: "completed", text: "resumed ok", stopReason: "end_turn",
      });
    }
    // Recovery reports can repeat on reconnect; the native completion cannot.
    await frame(value => value.data?.includes('"id":7,"result"'), "native end_turn");
    expect(frames.filter(value => value.data?.includes('"id":7,"result"'))).toHaveLength(1);
    expect(frames.some(value => value.type === "exit")).toBe(false);
    const health = (await daemon["listSlots"]({})).health.find(value => value.slot === slot);
    expect(health).toMatchObject({ alive: true, pid: childPid });
    const native = (await fs.readFile(requests, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(native.filter(value => value.method === "session/prompt")).toHaveLength(1);
    expect(new Set(native.map(value => value.pid)).size).toBe(1);
  };
  return { first, start, arm, data, prompt, input, handled, frame, replay, completed, blockWrite,
    directory, requestedCwd, hostServer, requests, daemon, childPid };
}


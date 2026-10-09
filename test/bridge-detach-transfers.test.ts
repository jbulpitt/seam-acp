import { afterEach, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { SessiondServer } from "../packages/bridge/src/sessiond-server.js";
import { DEFAULT_REMOTE_RUNG1_POLICY } from "../packages/core/src/core/remote-spawn.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "packages/bridge/dist/index.js");
const cleanups: Array<() => Promise<void>> = [];
const slot = 9;

async function until<T>(read: () => T | undefined, what: string, timeout = 10_000): Promise<T> {
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

async function fixture() {
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
  const blockHealth = () => {
    let reached = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    releaseWrites.push(release);
    const original = daemon["listSlots"].bind(daemon);
    vi.spyOn(daemon as any, "listSlots").mockImplementation(async (...args: any[]) => {
      reached = true;
      await gate;
      return original(args[0]);
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
  return { first, start, arm, data, prompt, input, handled, frame, replay, completed, blockWrite, blockHealth,
    directory, requestedCwd, hostServer, requests, daemon, childPid };
}

it("detaches after transferring an already-received arm and its queued prompt", async () => {
  const f = await fixture();
  const held = f.blockWrite(value => value.type === "arm_recovery");
  const armed = f.arm();
  await until(() => held.reached() ? true : undefined, "arm transfer held before holder acceptance");
  f.data(f.prompt());
  await f.handled();
  f.first.signal();
  await until(() => f.first.stderr().includes("SIGUSR2 received") ? true : undefined, "restart signal handled");
  await f.handled();
  expect(f.first.bridge.exitCode).toBeNull();
  held.release();
  await armed;
  await f.first.exited();
  await f.start();
  await f.replay();
  await f.completed();
}, 30_000);

it("includes an already-received arm whose owner-health lookup is pending", async () => {
  const f = await fixture();
  const held = f.blockHealth();
  const armed = f.arm();
  await until(() => held.reached() ? true : undefined, "arm owner-health lookup held");
  f.first.signal();
  await until(() => f.first.stderr().includes("SIGUSR2 received") ? true : undefined, "restart signal handled");
  await f.handled();
  expect(f.first.bridge.exitCode).toBeNull();
  held.release();
  await armed;
  await f.first.exited();
  await f.start();
  await f.replay();
  f.data(f.prompt());
  await f.completed();
}, 30_000);

it("keeps an outstanding native client request answerable after bridge detach", async () => {
  const f = await fixture();
  await f.arm();
  f.data(f.prompt("continue with a client reply"));
  await f.frame(value => value.data?.includes('"id":"fixture-client-reply"'), "native permission request");
  f.first.signal();
  await f.first.exited();
  await f.start();
  await f.replay();
  f.data(JSON.stringify({ jsonrpc: "2.0", id: "fixture-client-reply",
    result: { outcome: { outcome: "selected", optionId: "allow" } } }) + "\n");
  await f.completed();
}, 30_000);

it("finishes a received client reply transfer before detaching", async () => {
  const f = await fixture();
  await f.arm();
  f.data(f.prompt("continue with a client reply"));
  await f.frame(value => value.data?.includes('"id":"fixture-client-reply"'), "native permission request");
  const held = f.blockWrite(value => value.type === "input"
    && Buffer.from(value.dataBase64, "base64").toString().includes('"fixture-client-reply"'));
  f.data(JSON.stringify({ jsonrpc: "2.0", id: "fixture-client-reply",
    result: { outcome: { outcome: "selected", optionId: "allow" } } }) + "\n");
  await until(() => held.reached() ? true : undefined, "client reply held before holder acceptance");
  f.first.signal();
  await until(() => f.first.stderr().includes("SIGUSR2 received") ? true : undefined, "restart signal handled");
  await f.handled();
  expect(f.first.bridge.exitCode).toBeNull();
  held.release();
  await f.first.exited();
  await f.start();
  await f.replay();
  await f.completed();
}, 30_000);

it("keeps a fragmented prompt in its surviving owner across bridge detach", async () => {
  const f = await fixture();
  await f.arm();
  const prompt = f.prompt();
  const split = prompt.indexOf("continue") + 3;
  f.data(prompt.slice(0, split));
  await f.handled();
  f.first.signal();
  // Let main really exit, so the regression also proves loss of its fragment buffer.
  await f.first.exited(15_000);
  await f.start();
  await f.replay();
  f.data(prompt.slice(split));
  await f.completed();
}, 40_000);

it("retains session/load frame rewriting when its fragments cross bridge detach", async () => {
  const f = await fixture();
  const load = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/load",
    params: { sessionId: "s1", cwd: f.requestedCwd, mcpServers: [
      { name: "fixture-mcp", type: "http", url: "https://example.invalid/mcp", headers: [] },
    ] } }) + "\n";
  const split = load.indexOf("mcpServers") + 4;
  f.data(load.slice(0, split));
  await f.handled();
  f.first.signal();
  await f.first.exited(15_000);
  await f.start();
  await f.replay();
  f.data(load.slice(split));
  await f.frame(value => value.data?.includes('"id":3,"result"'), "complete session/load after replacement");
  const native = (await fs.readFile(f.requests, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(native.filter(value => value.method === "session/load")).toEqual([
    expect.objectContaining({ pid: native[0].pid, params: {
      sessionId: "s1", cwd: f.directory, mcpServers: [
        { name: "fixture-mcp", type: "http", url: "https://example.invalid/mcp", headers: [] },
        f.hostServer,
      ],
    } }),
  ]);
}, 40_000);

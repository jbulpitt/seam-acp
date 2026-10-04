import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { SessiondServer } from "../packages/bridge/src/sessiond-server.js";
import { DEFAULT_REMOTE_RUNG1_POLICY } from "../packages/core/src/core/remote-spawn.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "packages/bridge/dist/index.js");
async function until<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("bridge drain fixture did not progress");
}

it.skipIf(!existsSync(entry))("#777 compiled bridge delivers arm, prompt and client replies during drain", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "seam-777-drain-"));
  const socketPath = path.join(directory, "control.sock");
  const statePath = path.join(directory, "slots.json");
  const daemon = new SessiondServer({ socketPath, statePath });
  await daemon.start();
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const frames: Array<Record<string, any>> = [];
  let socket: WebSocket | undefined;
  server.on("connection", ws => {
    socket = ws;
    ws.on("message", raw => frames.push(JSON.parse(raw.toString())));
  });
  const child = spawn(process.execPath, [entry, "connect", "--server", `ws://127.0.0.1:${port}`,
    "--id", "fixture", "--token", "fixture", "--cwd", directory], {
    cwd: root, stdio: ["ignore", "ignore", "pipe"], env: {
      HOME: directory, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      COPILOT_CMD: path.join(root, "test/fixtures/fake-acp-agent.mjs"),
      SEAM_SESSIOND_SOCKET: socketPath, SEAM_SESSIOND_STATE: statePath, AGY_ENABLED: "false",
    },
  });
  let stderr = "";
  child.stderr.on("data", data => { stderr += data.toString(); });
  const send = (value: object) => socket!.send(JSON.stringify(value));
  const input = (id: number, method: string, params: object) => send({ type: "data", slot: 9,
    data: JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n" });
  try {
    await until(() => frames.find(frame => frame.type === "hello"));
    send({ type: "hello_ack", accepted: true });
    send({ type: "rpc", id: "spawn", method: "spawn", agentId: "copilot",
      params: { slot: 9, agentId: "copilot", cwd: directory, rung1Recovery: DEFAULT_REMOTE_RUNG1_POLICY } });
    const spawned = await until(() => frames.find(frame => frame.type === "rpc_reply" && frame.id === "spawn"));
    expect(spawned.ok).toBe(true);
    input(1, "initialize", { protocolVersion: 1 });
    input(2, "session/new", { cwd: directory, mcpServers: [] });
    await until(() => frames.find(frame => frame.data?.includes('"sessionId":"s1"')));
    child.kill("SIGUSR2");
    await until(() => stderr.includes("entering drain mode") ? true : undefined);
    send({ type: "cmd", cmdId: "arm", action: "armRung1Recovery",
      payload: { slot: 9, submissionId: "draining-arm", acpSessionId: "s1", continuation: "continue" } });
    const armed = await until(() => frames.find(frame => frame.type === "cmd_reply" && frame.cmdId === "arm"));
    expect(armed.payload.phase).toBe("armed");
    input(7, "session/prompt", { sessionId: "s1", prompt: [{ type: "text", text: "continue with a client reply" }] });
    await until(() => frames.find(frame => frame.data?.includes('"id":"fixture-client-reply"')));
    send({ type: "data", slot: 9, data: JSON.stringify({ jsonrpc: "2.0", id: "fixture-client-reply",
      result: { outcome: { outcome: "selected", optionId: "allow" } } }) + "\n" });
    const result = await until(() => frames.find(frame => frame.type === "recovery_result"));
    expect(result.recoveryResult).toMatchObject({ submissionId: "draining-arm", status: "completed", text: "resumed ok" });
    expect(frames.some(frame => frame.recovery?.phase === "executing")).toBe(true);
    expect(frames.some(frame => frame.type === "exit")).toBe(false);
  } finally {
    const exited = child.exitCode !== null ? Promise.resolve() : once(child, "exit");
    child.kill("SIGTERM");
    await exited;
    socket?.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await daemon.close({ terminateChildren: true });
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 30_000);

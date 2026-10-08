/**
 * #610 — the local agent path end to end, with no stand-in for adapter-child.
 *
 * Every agy turn timed out for hours on 2026-09-23 while the suite was green:
 * no test ran SupervisedSlots → sessiond → adapter-child → the agy profile.
 * These do, with a real SessiondServer, the real adapter-child.ts, the
 * unpinned agy runtime production uses, and a stub `agy` on PATH (only its
 * `--version` is ever called before a prompt).
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { pino } from "pino";
import { makeMux, type AgentProfile } from "@seam/adapters";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import { BridgeHub } from "../packages/core/src/core/bridge-hub.js";
import { hashBridgeToken } from "../packages/core/src/core/bridge-pairing.js";
import { planIsolatedBridgeSpawn } from "../packages/core/src/core/location-bind.js";
import type { Config } from "../packages/core/src/config.js";
import type { ConfigMutationService } from "../packages/core/src/core/config-mutation.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import { dispatchBridgeRpc } from "../packages/bridge/src/rpc.js";
import { adapterChildLine } from "../packages/bridge/src/adapter-child-protocol.js";
import { SessiondClient } from "../packages/bridge/src/sessiond-client.js";
import { SessiondServer } from "../packages/bridge/src/sessiond-server.js";
import { SupervisedSlots, type SupervisedBridgeFrame } from "../packages/bridge/src/supervised-slots.js";

const adapterChild = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers/adapter-child-source.mjs");
const roots: string[] = [];
const servers: SessiondServer[] = [];
const clients: SessiondClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) await server.close({ terminateChildren: true });
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function until<T>(read: () => T | undefined, what: string, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function localBridge(nativeFixture = false, options: {
  missingInterpreter?: boolean;
  onFrame?: (frame: SupervisedBridgeFrame & { slot: number }) => void;
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "seam-610-"));
  roots.push(root);
  await fs.chmod(root, 0o700);
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  await fs.mkdir(bin);
  await fs.mkdir(home);
  await fs.mkdir(path.join(home, ".gemini", "antigravity-cli"), { recursive: true });
  await fs.writeFile(path.join(bin, "agy"), "#!/bin/sh\necho 1.2.9\n", { mode: 0o755 });
  const brokenGrok = path.join(bin, "grok-missing-interpreter");
  if (options.missingInterpreter) {
    // Executable discovery succeeds, but the actual OS spawn fails with ENOENT.
    await fs.writeFile(brokenGrok, `#!${root}/missing-interpreter\n`, { mode: 0o755 });
  }
  const invocationLog = path.join(root, "invocations.ndjson");
  if (nativeFixture) {
    const fixtures = fileURLToPath(new URL("./fixtures/agy-native-capabilities/", import.meta.url));
    await fs.writeFile(path.join(bin, "agy"),
      `#!/bin/sh\nSEAM_AGY_CAPABILITY_FIXTURE_DIR=${JSON.stringify(fixtures)} SEAM_AGY_CAPABILITY_INVOCATIONS=${JSON.stringify(invocationLog)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(fixtures, "fake-native-agy.mjs"))} "$@"\n`,
      { mode: 0o755 });
  }

  const socketPath = path.join(root, "sessiond.sock");
  const server = new SessiondServer({ socketPath, statePath: path.join(root, "slots.json") });
  servers.push(server);
  await server.start();
  const client = await SessiondClient.connect(socketPath);
  clients.push(client);

  const frames: Array<SupervisedBridgeFrame & { slot: number }> = [];
  const slots = new SupervisedSlots({
    client,
    copilotCmd: "/unused/copilot",
    localCwd: root,
    adapterChildPath: adapterChild,
    environment: {
      HOME: home,
      PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      AGY_ENABLED: "true",
      AGY_PIN: "unpinned",
      AGY_DEFAULT_MODEL: nativeFixture ? "fixture-native-model" : "gemini-3.8-flash-high",
      ...(options.missingInterpreter ? { GROK_CLI_PATH: brokenGrok } : {}),
    },
    onStderr: () => undefined,
    onFrame: (frame) => { frames.push(frame); options.onFrame?.(frame); },
  });
  return { root, client, slots, frames, invocationLog, brokenGrok };
}

const initialize = `${JSON.stringify({
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
})}\n`;

describe("#610 the local agent path, end to end", () => {
  it("#678 carries a real adapter spawn failure through the holder and mux to the controller", async () => {
    const ws = new EventEmitter() as EventEmitter & { readyState: number; send: (data: string) => void };
    ws.readyState = WebSocket.OPEN;
    const { root, slots, brokenGrok } = await localBridge(false, {
      missingInterpreter: true,
      onFrame: frame => ws.emit("message", Buffer.from(JSON.stringify(frame))),
    });
    ws.send = data => {
      const frame = JSON.parse(data);
      if (frame.type === "data") void slots.writeInput(frame.slot, frame.data);
    };
    const mux = makeMux({ id: "spawn-failure-host" } as never);
    mux.attach(ws as never);
    const runtime = new AgentRuntime({
      profile: { id: "grok" } as AgentProfile,
      logger: pino({ level: "silent" }) as unknown as Logger,
      spawnFn: () => {
        const child = mux.spawn();
        slots.configure(child.slot, { agentId: "grok", model: "grok-4.6", cwd: root });
        return child;
      },
    });
    try {
      const error = await runtime.start().catch(error => error as Error);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain(`spawn ${brokenGrok} ENOENT`);
      expect(error.message).toContain("host 'spawn-failure-host'");
      expect(error.message).not.toContain("the bridge reported no reason");
    } finally {
      await runtime.dispose();
      ws.emit("close");
    }
  }, 30_000);

  it.each([
    [129600, "capability-turn-one"],
    [1, "r5-stream-hang"],
  ] as const)("carries controller bound %ss through an isolated spawn to native AGY", async (seconds, prompt) => {
    const { root, slots, frames, invocationLog } = await localBridge(true);
    const http = createServer();
    const hub = new BridgeHub({
      logger: pino({ level: "silent" }) as unknown as Logger,
      config: { bridgePresets: new Map(), REPOS_ROOT: root, TURN_TIMEOUT_SECONDS: seconds } as Config,
      httpServer: http,
      mutation: {} as ConfigMutationService,
      healthPort: 3000,
      dataDir: root,
      localBridgeTokenHash: hashBridgeToken("turn-bound-fixture"),
    });
    await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
    const port = (http.address() as { port: number }).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`, {
      headers: { Authorization: "Bearer turn-bound-fixture" },
    });
    ws.on("message", async raw => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "rpc") {
        try {
          const result = await dispatchBridgeRpc(frame.method, frame.params, frame.agentId, {
            adapters: new Map(), cwd: root, workspaceRoot: root,
            configureSlot: (slot, config) => slots.configure(slot, config),
          });
          ws.send(JSON.stringify({ type: "rpc_reply", id: frame.id, ok: true, result }));
        } catch (error) {
          ws.send(JSON.stringify({ type: "rpc_reply", id: frame.id, ok: false, error: String(error) }));
        }
      }
    });
    await once(ws, "open");
    try {
      const mux = hub.muxFor("local")!;
      // Isolated scheduled dispatches use this same plan and hub-owned mux.
      hub.get = () => ({ mux }) as ReturnType<BridgeHub["get"]>;
      const plan = planIsolatedBridgeSpawn({ hub, sessionId: "fixture-scheduled", location: "local", agentId: "agy", cwd: root });
      const child = await plan.spawnFn("fixture-native-model");
      const slot = (child as unknown as { slot: number }).slot;
      const response = async (id: number) => until(() => {
        for (const frame of frames) {
          if (frame.slot !== slot || frame.type !== "data") continue;
          for (const line of (frame.data ?? "").trim().split("\n")) {
            const message = JSON.parse(line);
            if (message.id === id) return message;
          }
        }
        return undefined;
      }, `ACP response ${id}`);
      await slots.writeInput(slot, initialize);
      await response(0);
      await slots.writeInput(slot, `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: root, mcpServers: [] } })}\n`);
      const session = await response(1);
      expect(session.error).toBeUndefined();
      await slots.writeInput(slot, `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: session.result.sessionId, prompt: [{ type: "text", text: prompt }] } })}\n`);
      const result = await response(2);
      if (prompt === "r5-stream-hang") expect(result.error.message).toContain("native AGY timeout");
      else expect(result.result).toMatchObject({ stopReason: "end_turn" });
      const rows = (await fs.readFile(invocationLog, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      const invocation = rows.find(row => row.prompt === prompt);
      const flag = invocation.args.indexOf("--print-timeout");
      expect(invocation.args[flag + 1]).toBe(`${seconds}s`);
    } finally {
      ws.close();
      await once(ws, "close");
      hub.close();
      await new Promise<void>(resolve => http.close(() => resolve()));
    }
  }, 30_000);

  it("delivers agy's initialize through sessiond and the real adapter-child", async () => {
    const { root, slots, frames } = await localBridge();
    slots.configure(1, { agentId: "agy", model: "gemini-3.8-flash-high", cwd: root });

    await expect(slots.writeInput(1, initialize)).resolves.toBe(true);

    const first = await until(
      () => frames.find((frame) => frame.slot === 1 && (frame.type === "data" || frame.type === "exit")),
      "agy's initialize reply or exit",
    );
    expect(first).toMatchObject({ type: "data" });
    expect(JSON.parse(first.data ?? "")).toMatchObject({ jsonrpc: "2.0", id: 0, result: { protocolVersion: 1 } });
  }, 30_000);

  it("stops a slot that cannot take input, and says why", async () => {
    const { root, client, slots, frames } = await localBridge();
    slots.configure(2, { agentId: "agy", model: "gemini-3.8-flash-high", cwd: root });
    await slots.writeInput(2, initialize);
    await until(() => frames.find((frame) => frame.slot === 2 && frame.type === "data"), "the slot to start");

    // A control frame this wrapper cannot understand used to be dropped with
    // no frame at all, leaving the controller to wait out its timeout.
    await client.write(2, adapterChildLine({ v: 2, type: "input", dataBase64: "" } as never));

    const exit = await until(
      () => frames.find((frame) => frame.slot === 2 && frame.type === "exit"),
      "a named exit",
    );
    expect(exit).toMatchObject({ code: 1, spawnError: "unsupported control protocol version 2" });
  }, 30_000);
});

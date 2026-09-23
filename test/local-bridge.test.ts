import { createServer, type Server } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "@seam/adapters";
import { BridgeHub } from "../packages/core/src/core/bridge-hub.js";
import { loadOrCreateLocalBridgeCredential } from "../packages/core/src/core/local-bridge-credential.js";
import { acquireProcessLease } from "../packages/bridge/src/process-lease.js";
import { listAgentLocationChoices, listHosts } from "../packages/core/src/core/location.js";

const roots: string[] = [];
const servers: Server[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "seam-local-bridge-"));
  roots.push(root);
  return root;
}

describe("#575 local bridge process boundary", () => {
  it("persists a private stable credential without returning or logging the raw token", async () => {
    const root = await temporaryRoot();
    const first = await loadOrCreateLocalBridgeCredential(root);
    const tokenPath = path.join(root, "local-bridge", "token");
    const raw = (await fs.readFile(tokenPath, "utf8")).trim();
    const mode = (await fs.stat(tokenPath)).mode & 0o777;
    expect(raw.length).toBeGreaterThan(20);
    expect(first).toEqual({ tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(first)).not.toContain(raw);
    expect(mode).toBe(0o600);
    expect(await loadOrCreateLocalBridgeCredential(root)).toEqual(first);
  });

  it("allows only one bridge control process while preserving a stale-lease restart", async () => {
    const root = await temporaryRoot();
    const socketPath = path.join(root, "bridge.sock");
    const first = await acquireProcessLease(socketPath);
    expect(first).not.toBeNull();
    expect(await acquireProcessLease(socketPath)).toBeNull();
    await new Promise<void>((resolve) => first!.close(() => resolve()));
    const replacement = await acquireProcessLease(socketPath);
    expect(replacement).not.toBeNull();
    await new Promise<void>((resolve) => replacement!.close(() => resolve()));
  });

  it("authenticates local as an ordinary bridge and publishes its real inventory/readiness", async () => {
    const root = await temporaryRoot();
    const credential = await loadOrCreateLocalBridgeCredential(root);
    const token = (await fs.readFile(path.join(root, "local-bridge", "token"), "utf8")).trim();
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    const logger = { child: () => logger, info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
    const hub = new BridgeHub({
      logger,
      config: { bridgePresets: new Map(), REPOS_ROOT: root } as any,
      httpServer: server,
      mutation: { recordBridgeAudit: vi.fn(), recordRuntimeProvenance: vi.fn() } as any,
      healthPort: address.port,
      dataDir: root,
      localBridgeTokenHash: credential.tokenHash,
    });
    const ready = new Promise<string>((resolve) => hub.onBridgeReady(resolve));
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/bridge`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    sockets.push(socket);
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as { type?: string; id?: string; method?: string };
      if (frame.type === "rpc" && frame.id && frame.method === "prepare") {
        socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "rpc_reply", id: frame.id, ok: true, result: {} }));
      }
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({
      v: PROTOCOL_VERSION,
      type: "hello",
      bridgeId: "local",
      instanceId: "local-instance",
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { durableSlots: true },
      host: { os: "linux", arch: "x64", workspaceRoot: root },
      agents: [{ agentId: "claude", version: 1, installed: true }],
    }));
    await expect(ready).resolves.toBe("local");
    expect(hub.isBridgeReady("local")).toBe(true);
    expect(hub.get("local")?.agents.get("claude")).toMatchObject({ installed: true, ready: true });
    const hosts = listHosts({ bridges: [], connected: new Set(["local"]) });
    const choices = listAgentLocationChoices({
      profiles: [{ id: "claude", displayName: "Claude" }],
      hosts,
      agentsByHost: new Map([["local", new Set(hub.get("local")!.agents.keys())]]),
    });
    expect(hosts[0]).toMatchObject({ id: "local", ready: true });
    expect(choices.map((choice) => choice.value)).toEqual(["claude@local"]);
    hub.close();
  });
});

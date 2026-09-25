/**
 * A thread moved to a host that lacks its directory keeps working there, in
 * the host's workspace, and the thread is told once (2026-09-24: thread
 * 1543322695524159598 moved to claude@local; /home/ubuntu/Projects/pronoa
 * exists only on rhc-server, and the start failed).
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { dispatchBridgeRpc, type SlotSpawnConfig } from "../packages/bridge/src/rpc.js";
import { BridgeMcpInputRewriter } from "../packages/bridge/src/mcp-injection.js";
import { spawnRemoteSlot, type MuxHandle } from "../packages/core/src/core/remote-spawn.js";

describe("a directory missing on this host", () => {
  it("runs the slot in the host workspace and reports the substitution", async () => {
    const configured: SlotSpawnConfig[] = [];
    const reply = await dispatchBridgeRpc("spawn", { slot: 3, agentId: "claude", cwd: "/no/such/project", mcpServers: [] }, "claude", {
      adapters: new Map(), workspaceRoot: "/tmp", cwd: "/tmp",
      configureSlot: (_slot: number, config: SlotSpawnConfig) => configured.push(config),
    } as never);
    expect(configured[0]).toMatchObject({ cwd: "/tmp", requestedCwd: "/no/such/project" });
    expect(reply).toMatchObject({ cwdFallback: { requested: "/no/such/project", used: "/tmp" } });
  });

  it("keeps an existing directory as asked", async () => {
    const configured: SlotSpawnConfig[] = [];
    const reply = await dispatchBridgeRpc("spawn", { slot: 4, agentId: "claude", cwd: "/tmp", mcpServers: [] }, "claude", {
      adapters: new Map(), workspaceRoot: "/", cwd: "/",
      configureSlot: (_slot: number, config: SlotSpawnConfig) => configured.push(config),
    } as never);
    expect(configured[0]?.cwd).toBe("/tmp");
    expect(reply).not.toHaveProperty("cwdFallback");
  });

  it("opens the ACP session in the directory the host actually uses", () => {
    const rewriter = new BridgeMcpInputRewriter([], { from: "/no/such/project", to: "/tmp" });
    const out = rewriter.push(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/load", params: { sessionId: "s", cwd: "/no/such/project", mcpServers: [] } })}\n`);
    expect(JSON.parse(out).params.cwd).toBe("/tmp");
  });

  it("gives the thread one line saying where the session works", async () => {
    const child = Object.assign(new EventEmitter(), { slot: 7, stdin: new PassThrough(),
      stdout: new PassThrough(), stderr: new PassThrough(), killed: false, kill() {} });
    const mux = {
      spawn: () => child,
      rpc: async () => ({ ok: true, cwdFallback: { requested: "/no/such/project", used: "/tmp" } }),
      releaseStdin() {},
    } as unknown as MuxHandle;
    const spawned = await spawnRemoteSlot(mux, { mcpServers: [], agentId: "claude", cwd: "/no/such/project" });
    expect(spawned.hostNotice).toContain("/no/such/project");
    expect(spawned.hostNotice).toContain("/tmp");
  });
});

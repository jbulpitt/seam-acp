/**
 * A thread moved to a host that lacks its directory keeps working there, in
 * the host's workspace, and the thread is told once (2026-09-24: thread
 * 1543322695524159598 moved to claude@local; /home/operator/Projects/pronoa
 * exists only on remote-b, and the start failed).
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { AgentProfile } from "@seam/adapters";
import { dispatchBridgeRpc, type SlotSpawnConfig } from "../packages/bridge/src/rpc.js";
import { AgentRuntime, type AgentEvent } from "../packages/core/src/agents/agent-runtime.js";
import { rewriteSessionInput } from "../packages/bridge/src/mcp-injection.js";
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

  it("uses the host workspace for session RPCs when the requested cwd is missing", async () => {
    const calls: Array<[string, string]> = [];
    const adapter = {
      listSessions: vi.fn(async (cwd: string) => { calls.push(["list", cwd]); return []; }),
      getTranscript: vi.fn(async (cwd: string) => { calls.push(["transcript", cwd]); return ""; }),
      usage: vi.fn(async (cwd: string) => { calls.push(["usage", cwd]); return null; }),
      cloneSession: vi.fn(async (cwd: string) => { calls.push(["clone", cwd]); }),
      deleteSession: vi.fn(async (cwd: string) => { calls.push(["delete", cwd]); }),
    };
    const ctx = {
      adapters: new Map([["claude", adapter]]),
      workspaceRoot: "/tmp",
      cwd: "/tmp",
    } as never;
    const cwd = "/no/such/controller-workspace";

    await dispatchBridgeRpc("listSessions", { cwd }, "claude", ctx);
    await dispatchBridgeRpc("getTranscript", { cwd, sessionId: "old" }, "claude", ctx);
    await dispatchBridgeRpc("getUsage", { cwd, sessionId: "old" }, "claude", ctx);
    await dispatchBridgeRpc("cloneSession", { cwd, oldSessionId: "old", newSessionId: "new" }, "claude", ctx);
    await dispatchBridgeRpc("deleteSession", { cwd, sessionId: "new" }, "claude", ctx);

    expect(calls).toEqual([
      ["list", "/tmp"],
      ["transcript", "/tmp"],
      ["usage", "/tmp"],
      ["clone", "/tmp"],
      ["delete", "/tmp"],
    ]);
  });

  it("opens the ACP session in the directory the host actually uses", () => {
    const out = rewriteSessionInput(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/load", params: { sessionId: "s", cwd: "/no/such/project", mcpServers: [] } })}\n`, [], { from: "/no/such/project", to: "/tmp" });
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
    expect(spawned.cwdFallback).toEqual({ requested: "/no/such/project", used: "/tmp" });
    expect(spawned.hostNotice).toContain("/no/such/project");
    expect(spawned.hostNotice).toContain("/tmp");
  });

  it("uses the bridge-selected cwd for ACP new, load, and fork", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-missing-cwd-"));
    const requested = path.join(root, "missing-on-host");
    const configured: SlotSpawnConfig[] = [];
    const received: Array<{ method: string; cwd: string }> = [];
    const child = Object.assign(new EventEmitter(), {
      slot: 8,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      killed: false,
      kill() { this.killed = true; return true; },
    });
    agent({ name: "missing-cwd-fixture" })
      .onRequest(methods.agent.initialize, () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true, sessionCapabilities: { fork: {} } },
      }))
      .onRequest(methods.agent.session.new, ({ params }) => {
        received.push({ method: "new", cwd: params.cwd });
        return { sessionId: "new-session" };
      })
      .onRequest(methods.agent.session.load, ({ params }) => {
        received.push({ method: "load", cwd: params.cwd });
        return { sessionId: params.sessionId };
      })
      .onRequest("session/fork" as never, ({ params }: { params: { cwd: string } }) => {
        received.push({ method: "fork", cwd: params.cwd });
        return { sessionId: "forked-session" };
      })
      .onRequest(methods.agent.session.prompt, () => ({ stopReason: "end_turn" }))
      .onNotification(methods.agent.session.cancel, () => {})
      .connect(ndJsonStream(
        Writable.toWeb(child.stdout) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdin) as ReadableStream<Uint8Array>
      ));
    const mux = {
      spawn: () => child,
      rpc: (method: string, params: unknown, opts?: { agentId?: string }) =>
        dispatchBridgeRpc(method, params, opts?.agentId, {
          adapters: new Map(),
          workspaceRoot: root,
          cwd: root,
          configureSlot: (_slot: number, config: SlotSpawnConfig) => configured.push(config),
        }),
      releaseStdin() {},
    } as unknown as MuxHandle;
    const profile = {
      id: "claude",
      displayName: "Claude",
      defaultModel: "default",
    } as AgentProfile;
    const logger = {
      child() { return this; }, debug() {}, info() {}, warn() {}, error() {},
    } as never;
    const runtime = new AgentRuntime({
      profile,
      logger,
      spawnFn: () => spawnRemoteSlot(mux, {
        mcpServers: [],
        agentId: "claude",
        cwd: requested,
      }),
    });
    const events: AgentEvent[] = [];
    runtime.onEvent((event) => { events.push(event); });

    try {
      await runtime.start();
      await runtime.newSession({ cwd: requested });
      await runtime.prompt("show cwd");
      await runtime.loadSession({ sessionId: "existing-session", cwd: requested });
      await runtime.forkSession({ sessionId: "existing-session", cwd: requested });
    } finally {
      await runtime.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }

    expect(configured[0]).toMatchObject({ cwd: root, requestedCwd: requested });
    expect(received).toEqual([
      { method: "new", cwd: root },
      { method: "load", cwd: root },
      { method: "fork", cwd: root },
    ]);
    expect(events).toContainEqual({ kind: "cwd-fallback", requested, used: root });
  });
});

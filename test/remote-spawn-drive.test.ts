/**
 * #84 — a bridged spawn must receive the minted X-Seam-Session token and a
 * non-loopback MCP URL via rpc("spawn") before the first ACP data frame.
 */
import { createServer, type Server } from "node:http";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { pino } from "pino";
import { makeMux } from "@seam/adapters";
import type { AgentProfile } from "@seam/adapters";
import { BridgeHub } from "../packages/core/src/core/bridge-hub.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { SeamTokenRegistry } from "../packages/core/src/core/mcp/token-registry.js";
import { planSeamMcpInjection, spawnRemoteSlot, type MuxHandle } from "../packages/core/src/core/remote-spawn.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { Config } from "../packages/core/src/config.js";
import type { ConfigMutationService } from "../packages/core/src/core/config-mutation.js";
import type { SessionRecord, SessionConfigState } from "../packages/core/src/core/types.js";
import type { SessionStore } from "../packages/core/src/core/session-store.js";
import type { McpServer } from "@agentclientprotocol/sdk";

const silent = pino({ level: "silent" }) as unknown as Logger;

type RpcCall = { method: string; params: unknown; opts?: { agentId?: string } };

function seamEntry(servers: McpServer[]): {
  url: string;
  headers: Array<{ name: string; value: string }>;
} {
  const entry = servers.find((s) => (s as { name?: string }).name === "seam-mcp") as
    | { url: string; headers: Array<{ name: string; value: string }> }
    | undefined;
  if (!entry) throw new Error("expected a seam-mcp mcpServers entry");
  return entry;
}

function stubProfile(id: string, spawnCalls: unknown[]): AgentProfile {
  return {
    id,
    spawn(model?: string, effort?: string) {
      spawnCalls.push({ model, effort });
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      return Object.assign(new EventEmitter(), {
        stdin,
        stdout,
        stderr,
        killed: false,
        kill() {},
      });
    },
  } as unknown as AgentProfile;
}

function stubStore(): SessionStore {
  return {
    readConfig: (record: SessionRecord): SessionConfigState => {
      if (!record.configJson) return {};
      try {
        return JSON.parse(record.configJson) as SessionConfigState;
      } catch {
        return {};
      }
    },
  } as unknown as SessionStore;
}

function makeRecord(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "discord:thread-remote",
    platform: "discord",
    channelRef: "thread-remote",
    parentRef: "chan-1",
    agentId: "claude",
    acpSessionId: "",
    repoPath: "/repo/session",
    configJson: JSON.stringify({ model: "opus" } satisfies SessionConfigState),
    createdUtc: "2026-01-01T00:00:00Z",
    updatedUtc: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function fakeMux(rpcCalls: RpcCall[]): MuxHandle {
  let nextSlot = 0;
  return {
    spawn(opts?: { holdStdinUntilReady?: boolean }) {
      const slot = nextSlot++;
      return Object.assign(new EventEmitter(), {
        slot,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        killed: false,
        hold: opts?.holdStdinUntilReady === true,
        kill() {
          this.killed = true;
        },
      }) as unknown as ReturnType<MuxHandle["spawn"]>;
    },
    async rpc(method: string, params: unknown, opts?: { agentId?: string }) {
      rpcCalls.push({ method, params, opts });
      return { ok: true, slot: (params as { slot: number }).slot };
    },
    releaseStdin() {},
  };
}

describe("remote spawn drives token + reachable MCP URL (#84)", () => {
  let tmp: string;
  let httpServer: Server | undefined;
  let hub: BridgeHub | undefined;

  afterEach(() => {
    hub?.close();
    hub = undefined;
    if (httpServer) {
      httpServer.close();
      httpServer = undefined;
    }
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function makeHub(registry: SeamTokenRegistry): Promise<BridgeHub> {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seam-84-"));
    fs.writeFileSync(path.join(tmp, "tunnel-url.txt"), "https://reach.example");
    httpServer = createServer();
    await new Promise<void>((resolve) => httpServer!.listen(0, "127.0.0.1", resolve));
    hub = new BridgeHub({
      logger: silent,
      config: { bridgePresets: new Map() } as Config,
      httpServer,
      mutation: { recordBridgeAudit: () => {} } as unknown as ConfigMutationService,
      getMcpPort: () => 18765,
      getMcpRegistry: () => registry,
      healthPort: 3000,
      dataDir: tmp,
    });
    return hub;
  }

  it("markSessionBridge is a real write that binds the session", async () => {
    const registry = new SeamTokenRegistry();
    const h = await makeHub(registry);
    expect(h.sessionBridgeId("discord:thread-remote")).toBeUndefined();
    h.markSessionBridge("discord:thread-remote", "mac");
    expect(h.sessionBridgeId("discord:thread-remote")).toBe("mac");
  });

  it("bound session rpc-spawns with X-Seam-Session and a non-loopback URL; unbound stays loopback", async () => {
    const registry = new SeamTokenRegistry();
    const h = await makeHub(registry);
    const rpcCalls: RpcCall[] = [];
    const localSpawnCalls: unknown[] = [];
    const mux = fakeMux(rpcCalls);

    h.markSessionBridge("discord:thread-remote", "mac");

    const router = new SessionRouter({
      logger: silent,
      store: stubStore(),
      profiles: [stubProfile("claude", localSpawnCalls)],
      defaultAgentId: "claude",
      defaultModel: "opus",
      seamMcp: {
        registry,
        getPort: () => 18765,
        isRemoteSession: (sessionId) => !!h.sessionBridgeId(sessionId),
        mcpServersForRemoteSpawn: (sessionId) => h.mcpServersForRemoteSpawn(sessionId),
        muxForSession: (sessionId) => (h.sessionBridgeId(sessionId) ? mux : undefined),
      },
    });

    const remoteRecord = makeRecord();
    const plan = router.planRuntimeSpawn(remoteRecord);
    expect(plan.remote).toBe(true);

    const remoteSeam = seamEntry(plan.mcpServers);
    expect(remoteSeam.url).toBe("https://reach.example/mcp");
    expect(remoteSeam.url.startsWith("http://127.0.0.1")).toBe(false);
    expect(remoteSeam.headers).toEqual([
      { name: "X-Seam-Session", value: expect.any(String) },
    ]);
    expect(remoteSeam.headers[0]!.value.length).toBeGreaterThan(8);

    await plan.spawnChild(plan.model, plan.effort);

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]!.method).toBe("spawn");
    const params = rpcCalls[0]!.params as {
      slot: number;
      mcpServers: McpServer[];
      agentId: string;
      model?: string;
      env?: unknown;
    };
    expect(typeof params.slot).toBe("number");
    expect(params.agentId).toBe("claude");
    expect(params.model).toBe("opus");
    expect(params.env).toBeUndefined();
    const spawnedSeam = seamEntry(params.mcpServers);
    expect(spawnedSeam.headers).toEqual([{ name: "X-Seam-Session", value: remoteSeam.headers[0]!.value }]);
    expect(spawnedSeam.url).toBe("https://reach.example/mcp");
    expect(spawnedSeam.url).not.toContain("127.0.0.1");
    expect(localSpawnCalls).toHaveLength(0);

    const localRecord = makeRecord({ id: "discord:thread-local", channelRef: "thread-local" });
    const localPlan = router.planRuntimeSpawn(localRecord);
    expect(localPlan.remote).toBe(false);
    const localSeam = seamEntry(localPlan.mcpServers);
    expect(localSeam.url).toBe("http://127.0.0.1:18765/mcp");
    expect(localSeam.headers[0]!.name).toBe("X-Seam-Session");
    const localAgain = router.planRuntimeSpawn(localRecord);
    expect(seamEntry(localAgain.mcpServers).headers[0]!.value).toBe(localSeam.headers[0]!.value);

    localPlan.spawnChild(localPlan.model, localPlan.effort);
    expect(rpcCalls).toHaveLength(1);
    expect(localSpawnCalls).toHaveLength(1);
  });

  it("mux queues stdin until rpc spawn is released", async () => {
    const frames: Array<{ type?: string; data?: string; slot?: number; method?: string }> = [];
    const fakeWs = {
      readyState: WebSocket.OPEN,
      send(raw: string) {
        frames.push(JSON.parse(raw) as { type?: string; data?: string; slot?: number; method?: string });
      },
      on() {},
      close() {},
    };
    const mux = makeMux({ id: "hold-probe" });
    mux.attach(fakeWs as unknown as WebSocket);

    const child = mux.spawn({ holdStdinUntilReady: true });
    child.stdin.write("ACP-INIT");
    expect(frames.filter((f) => f.type === "data")).toHaveLength(0);

    await spawnRemoteSlot(
      {
        spawn: () => child,
        rpc: async (method, params) => {
          frames.push({ type: "rpc", method, slot: (params as { slot: number }).slot });
          return { ok: true };
        },
        releaseStdin: (slot) => mux.releaseStdin(slot),
      },
      { mcpServers: [], agentId: "claude" }
    );

    expect(frames.some((f) => f.type === "rpc" && f.method === "spawn")).toBe(true);
    const data = frames.filter((f) => f.type === "data");
    expect(data).toEqual([{ slot: child.slot, type: "data", data: "ACP-INIT" }]);
  });
});

describe("planSeamMcpInjection token reuse + stable loopback URL", () => {
  it("reuseToken keeps the existing token instead of rotating", () => {
    const registry = new SeamTokenRegistry();
    const first = registry.mint("discord:thread-geo");
    const wiring = {
      registry,
      getPort: () => 18765,
    };
    const a = planSeamMcpInjection({
      sessionId: "discord:thread-geo",
      globalMcpServers: [],
      seamMcp: wiring,
      reuseToken: true,
    });
    const b = planSeamMcpInjection({
      sessionId: "discord:thread-geo",
      globalMcpServers: [],
      seamMcp: wiring,
      reuseToken: true,
    });
    expect(seamEntry(a.mcpServers).headers[0]!.value).toBe(first);
    expect(seamEntry(b.mcpServers).headers[0]!.value).toBe(first);
  });

  it("prefers getLoopbackUrl over the ephemeral bind port", () => {
    const registry = new SeamTokenRegistry();
    const injection = planSeamMcpInjection({
      sessionId: "discord:thread-geo",
      globalMcpServers: [],
      seamMcp: {
        registry,
        getPort: () => 18765,
        getLoopbackUrl: () => "http://127.0.0.1:3000/mcp",
      },
      reuseToken: true,
    });
    expect(seamEntry(injection.mcpServers).url).toBe("http://127.0.0.1:3000/mcp");
  });
});

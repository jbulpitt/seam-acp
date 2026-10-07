import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { AgentProfile } from "@seam/adapters";
import type { SeamMcpWiring } from "../packages/core/src/core/session-router.js";
import type { MuxSpawnedProcess } from "../packages/core/src/core/remote-spawn.js";
import type { BridgeHub } from "../packages/core/src/core/bridge-hub.js";
import type { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SeamTokenRegistry } from "../packages/core/src/core/mcp/token-registry.js";
import fs from "node:fs";
import path from "node:path";
import { spawnSupervisedAdapter } from "../packages/bridge/src/spawn-agent.js";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { dispatchBridgeRpc, type SlotSpawnConfig } from "../packages/bridge/src/rpc.js";
import type { RemoteSlotSpawnParams } from "../packages/core/src/core/remote-spawn.js";
import { SeamMcpServer, buildSeamMcpServerEntry } from "../packages/core/src/core/mcp/seam-mcp-server.js";

import { afterAll } from "vitest";
import { pino } from "pino";
import type { Logger } from "../packages/core/src/lib/logger.js";

const registry = new SeamTokenRegistry();
const mcp = new SeamMcpServer({
  logger: pino({ level: "silent" }) as unknown as Logger,
  resolveSession: token => {
    const id = registry.resolve(token);
    return id ? {
      id, platform: "discord", channelRef: id, parentRef: null,
      agentId: "fixture", acpSessionId: "", repoPath: process.cwd(),
      configJson: "{}", createdUtc: "", updatedUtc: "",
    } : undefined;
  },
  enqueueDispatch: async () => {},
});
await mcp.start();
afterAll(() => mcp.stop());

type SpawnedChild = ChildProcessByStdio<Writable, Readable, Readable>;

/**
 * Unit-test boundary for the separate local bridge introduced by #575.
 *
 * Tests that mock AgentRuntime never call `spawn`; tests exercising the real
 * runtime can provide a profile (or exact spawn callback) and still cross the
 * same mux/RPC boundary as production. Keeping this fixture in test code is
 * deliberate: a production fallback to profile.spawn would recreate the
 * local-only implementation #575 removes.
 */
export function localBridgeWiring(
  spawn: ((params: RemoteSlotSpawnParams) => SpawnedChild) | AgentProfile | readonly AgentProfile[] = () => {
    throw new Error("synthetic local bridge spawn was not configured");
  },
): SeamMcpWiring {
  let nextSlot = 0;
  const profiles = Array.isArray(spawn) ? spawn : typeof spawn === "function" ? null : [spawn];
  const spawnChild = typeof spawn === "function" ? spawn : undefined;
  const slots = new Map<number, { child: MuxSpawnedProcess; process?: SpawnedChild }>();
  const mux = {
    spawn: (): MuxSpawnedProcess => {
      const slot = nextSlot++;
      const child = Object.assign(new EventEmitter(), {
        slot,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: (signal?: NodeJS.Signals) => slots.get(slot)?.process?.kill(signal) ?? false,
      }) as unknown as MuxSpawnedProcess;
      Object.defineProperty(child, "pid", { get: () => slots.get(slot)?.process?.pid });
      Object.defineProperty(child, "killed", { get: () => slots.get(slot)?.process?.killed ?? false });
      slots.set(slot, { child });
      return child;
    },
    rpc: async (method: string, params: unknown) => {
      const input = params as RemoteSlotSpawnParams & { slot: number };
      return dispatchBridgeRpc(method, params, input.agentId, {
        adapters: new Map((profiles ?? []).map(profile => [profile.id, profile])),
        workspaceRoot: input.cwd ?? process.cwd(), cwd: input.cwd ?? process.cwd(),
        configureSlot: (slot: number, config: SlotSpawnConfig) => {
          const state = slots.get(slot)!;
          const launch = { ...input, ...config, mcpServers: config.mcpServers ?? [] } as RemoteSlotSpawnParams;
          const process = spawnChild ? spawnChild(launch) : spawnSupervisedAdapter(
            new Map(profiles!.map(profile => [profile.id, profile])), config,
          ) as SpawnedChild;
          state.process = process;
          process.stdout.pipe(state.child.stdout as PassThrough);
          process.stderr.pipe(state.child.stderr as PassThrough);
          process.on("error", error => state.child.emit("error", error));
          process.on("exit", (code, signal) => state.child.emit("exit", code, signal));
          process.on("close", (code, signal) => state.child.emit("close", code, signal));
        },
      });
    },
    releaseStdin: (slot: number) => {
      const state = slots.get(slot)!;
      if (state.process) state.child.stdin.pipe(state.process.stdin);
    },
  };
  const port = mcp.port;
  return {
    registry,
    getPort: () => port,
    mcpServersForBridgeSpawn: sessionId => buildSeamMcpServerEntry(port, registry.peek(sessionId) ?? registry.mint(sessionId)),
    isBridgeSession: () => true,
    muxForSession: () => mux,
    bindSessionLocation: () => {},
  };
}

/** Minimal BridgeHub-shaped view for command/orchestrator unit tests. */
export function localBridgeHub(
  profiles: readonly AgentProfile[],
  workspaceRoot: string,
  wiring = localBridgeWiring(profiles),
): BridgeHub {
  const mux = wiring.muxForSession?.("test:local");
  const workspacePaths = (): string[] => {
    try {
      return fs.readdirSync(workspaceRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(workspaceRoot, entry.name));
    } catch {
      return [];
    }
  };
  return {
    connectedIds: () => new Set(["local"]),
    installedAgentsByHost: () => new Map([["local", new Set(profiles.map((profile) => profile.id))]]),
    isBridgeReady: (location: string) => location === "local",
    listWorkspaces: async (location: string) => location === "local"
      ? workspacePaths().map((workspacePath) => ({ path: workspacePath, name: path.basename(workspacePath) }))
      : [],
    get: (location: string) => location === "local" && mux ? { mux, host: { workspaceRoot } } : undefined,
    defaultCwdForLocation: () => workspaceRoot,
    markSessionBridge: () => {},
    mcpServersForBridgeSpawn: wiring.mcpServersForBridgeSpawn,
    rpc: async (_location: string, method: string, params: unknown, agentId?: string) => {
      const profile = profiles.find(candidate => candidate.id === agentId);
      const manager = profile?.sessionManager;
      const input = params as { cwd: string; sessionId: string; oldSessionId: string; newSessionId: string; newerThanMs?: number };
      switch (method) {
        case "listSessions": return manager?.listSessions(input.cwd) ?? [];
        case "getHistory": {
          const file = await manager?.getHistoryPath?.(input.cwd, input.sessionId);
          return file ? fs.promises.readFile(file, "utf8") : null;
        }
        case "repairSession": return manager?.repairSession?.(input.cwd, input.sessionId);
        case "getTranscript": return manager?.getTranscript(input.cwd, input.sessionId);
        case "cloneSession": return manager?.cloneSession(input.cwd, input.oldSessionId, input.newSessionId);
        case "deleteSession": return manager?.deleteSession(input.cwd, input.sessionId);
        case "getUsage": return manager?.getUsage?.(input.cwd, input.sessionId, input.newerThanMs) ?? null;
        case "whoami": return profile?.whoami?.() ?? null;
        default: return { ok: true };
      }
    },
    publicWsUrl: () => "ws://127.0.0.1/bridge",
  } as unknown as BridgeHub;
}

export function attachLocalBridge<T extends Orchestrator>(
  orchestrator: T,
  profiles: readonly AgentProfile[],
  workspaceRoot: string,
): T {
  orchestrator.setBridgeHub(localBridgeHub(profiles, workspaceRoot));
  return orchestrator;
}

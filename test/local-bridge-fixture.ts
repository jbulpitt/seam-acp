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
  spawn: (() => SpawnedChild) | AgentProfile | readonly AgentProfile[] = () => {
    throw new Error("synthetic local bridge spawn was not configured");
  },
): SeamMcpWiring {
  let nextSlot = 0;
  const profiles = Array.isArray(spawn) ? spawn : typeof spawn === "function" ? null : [spawn];
  const spawnChild = typeof spawn === "function" ? spawn : undefined;
  const mux = {
    spawn: (opts?: { launch?: { agentId: string; model?: string; effort?: string; mcpServers: Parameters<AgentProfile["spawn"]>[2]; cwd?: string } }): MuxSpawnedProcess => {
      const profile = profiles?.find((candidate) => candidate.id === opts?.launch?.agentId) ?? profiles?.[0];
      const child = (spawnChild?.() ?? profile!.spawn(
        opts?.launch?.model,
        opts?.launch?.effort,
        opts?.launch?.mcpServers,
        { cwd: opts?.launch?.cwd },
      )) as MuxSpawnedProcess;
      Object.defineProperty(child, "slot", { value: nextSlot++, configurable: true });
      return child;
    },
    rpc: async () => ({ projectMcpInjection: true, rung1RecoveryVersion: 1 }),
    releaseStdin: () => {},
  };
  return {
    registry: new SeamTokenRegistry(),
    getPort: () => undefined,
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
    get: (location: string) => location === "local" && mux ? { mux } : undefined,
    markSessionBridge: () => {},
    mcpServersForBridgeSpawn: () => undefined,
    rpc: async (_location: string, method: string, params: unknown, agentId?: string) => {
      if (method === "deleteSession") {
        const profile = profiles.find((candidate) => candidate.id === agentId) ?? profiles[0];
        const input = params as { cwd?: string; sessionId?: string };
        if (profile?.sessionManager?.deleteSession && input.cwd && input.sessionId) {
          await profile.sessionManager.deleteSession(input.cwd, input.sessionId);
        }
      }
      return { ok: true };
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

/**
 * Drive token + reachable MCP URL into a remote (bridge) spawn (#84).
 *
 * SessionRouter.startRuntime uses this so a bound session:
 *  - injects a seam-MCP entry whose URL is not 127.0.0.1
 *  - calls rpc("spawn", { slot, mcpServers, agentId, … }) after mux.spawn()
 *    allocates a slot and before the first ACP data frame.
 *
 * Does not dump control-plane process.env into rpc params.env (D4).
 */
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { McpServer } from "@agentclientprotocol/sdk";
import { buildSeamMcpServerEntry } from "./mcp/seam-mcp-server.js";
import { resolveReachableMcpUrl } from "./mcp-url.js";
import type { SeamTokenRegistry } from "./mcp/token-registry.js";

/** Subset of SessionRouter's seam-MCP wiring needed to inject an entry. */
export interface SeamMcpInjectionWiring {
  registry: SeamTokenRegistry;
  getPort: () => number | undefined;
  getPublicUrl?: () => string | undefined;
  isRemoteSession?: (sessionId: string) => boolean;
  mcpServersForRemoteSpawn?: (sessionId: string) => ReturnType<typeof buildSeamMcpServerEntry> | undefined;
}

export type MuxSpawnedProcess = ChildProcessByStdio<Writable, Readable, Readable> & {
  readonly slot: number;
};

/** Subset of makeMux() used to spawn a remote slot. */
export interface MuxHandle {
  spawn(opts?: { holdStdinUntilReady?: boolean }): MuxSpawnedProcess;
  rpc(
    method: string,
    params: unknown,
    opts?: { agentId?: string; timeoutMs?: number }
  ): Promise<unknown>;
  releaseStdin(slot: number): void;
}

export interface SeamMcpInjection {
  mcpServers: McpServer[];
  remote: boolean;
}

/**
 * Resolve the mcpServers list for a runtime start. Remote sessions go through
 * `mcpServersForRemoteSpawn` (reachable URL + minted X-Seam-Session). Unbound
 * sessions keep the loopback entry.
 */
export function planSeamMcpInjection(opts: {
  sessionId: string;
  globalMcpServers: McpServer[];
  seamMcp?: SeamMcpInjectionWiring;
  /** Reuse an existing session token instead of rotating it (isolated ingest
   *  while the authoring thread's live runtime is still using the old token). */
  reuseToken?: boolean;
}): SeamMcpInjection {
  const { sessionId, globalMcpServers, seamMcp } = opts;
  if (!seamMcp) {
    return { mcpServers: globalMcpServers, remote: false };
  }
  const remote = seamMcp.isRemoteSession?.(sessionId) === true;
  if (remote) {
    const entry = seamMcp.mcpServersForRemoteSpawn?.(sessionId);
    if (entry) {
      return { mcpServers: [...globalMcpServers, entry], remote: true };
    }
    const port = seamMcp.getPort();
    if (port === undefined) {
      return { mcpServers: globalMcpServers, remote: true };
    }
    const token = opts.reuseToken
      ? (seamMcp.registry.peek(sessionId) ?? seamMcp.registry.mint(sessionId))
      : seamMcp.registry.mint(sessionId);
    const publicUrl = seamMcp.getPublicUrl?.();
    const url = publicUrl ?? resolveReachableMcpUrl({ port, remote: true });
    return {
      mcpServers: [...globalMcpServers, buildSeamMcpServerEntry(port, token, { url })],
      remote: true,
    };
  }
  const port = seamMcp.getPort();
  if (port === undefined) {
    return { mcpServers: globalMcpServers, remote: false };
  }
  const token = opts.reuseToken
    ? (seamMcp.registry.peek(sessionId) ?? seamMcp.registry.mint(sessionId))
    : seamMcp.registry.mint(sessionId);
  return {
    mcpServers: [...globalMcpServers, buildSeamMcpServerEntry(port, token)],
    remote: false,
  };
}

export interface RemoteSlotSpawnParams {
  mcpServers: unknown;
  agentId: string;
  model?: string;
  effort?: string;
  cwd?: string;
}

/**
 * Allocate a mux slot, rpc("spawn") so the bridge fills slotConfigs, then
 * release stdin. No `env` key — the bridge host owns its own environment.
 */
export async function spawnRemoteSlot(
  mux: MuxHandle,
  params: RemoteSlotSpawnParams
): Promise<MuxSpawnedProcess> {
  const child = mux.spawn({ holdStdinUntilReady: true });
  const slot = child.slot;
  const rpcParams: Record<string, unknown> = {
    slot,
    mcpServers: params.mcpServers,
    agentId: params.agentId,
  };
  if (params.model !== undefined) rpcParams.model = params.model;
  if (params.effort !== undefined) rpcParams.effort = params.effort;
  if (params.cwd !== undefined) rpcParams.cwd = params.cwd;
  try {
    await mux.rpc("spawn", rpcParams, { agentId: params.agentId });
  } catch (err) {
    try {
      child.kill();
    } catch {
      /* already dead */
    }
    throw err;
  } finally {
    mux.releaseStdin(slot);
  }
  return child;
}

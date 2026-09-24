/**
 * Drive token + execution-host MCP URL into a bridge spawn (#84/#575).
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
import type { RemoteRung1Policy } from "@seam/adapters";
import { buildSeamMcpServerEntry } from "./mcp/seam-mcp-server.js";
import { resolveReachableMcpUrl } from "./mcp-url.js";
import type { SeamTokenRegistry } from "./mcp/token-registry.js";

/** Subset of SessionRouter's seam-MCP wiring needed to inject an entry. */
export interface SeamMcpInjectionWiring {
  registry: SeamTokenRegistry;
  getPort: () => number | undefined;
  getPublicUrl?: () => string | undefined;
  /** Stable loopback MCP URL (health `/mcp` proxy). Prefer this over the ephemeral bind port. */
  getLoopbackUrl?: () => string | undefined;
  isBridgeSession?: (sessionId: string) => boolean;
  mcpServersForBridgeSpawn?: (sessionId: string) => ReturnType<typeof buildSeamMcpServerEntry> | undefined;
}

/** #467: same-child retry policy travels as data to the child owner. Model,
 * session and user-facing recovery remain controller-owned. */
export const DEFAULT_REMOTE_RUNG1_POLICY: RemoteRung1Policy = Object.freeze<RemoteRung1Policy>({
  version: 1,
  retryCount: 3,
  backoffMs: [2_000, 5_000, 10_000],
  retryableErrorKinds: [
    "rate_limit",
    "auth_contention",
    "protocol_error",
    "overloaded",
    "server_error",
    "timeout",
    "unclassified",
  ],
  // #626: Claude Code raises auth_contention only when its OAuth refresh lock
  // went unchanged for ~7.5s (holder dead or stalled) while the token is
  // expired, and proper-lockfile will not take over that lock until it is 60s
  // stale. 2s/5s/10s all land inside that window: on 2026-09-24 a wake failed
  // four times in 46s and was dropped. One retry at 60s lands past it. The
  // delay stays within the v1 validator's 60s cap, and old bridges ignore
  // this field and keep `backoffMs`.
  backoffMsByKind: { auth_contention: [60_000] },
});

export type MuxSpawnedProcess = ChildProcessByStdio<Writable, Readable, Readable> & {
  readonly slot: number;
  remoteRung1Recovery?: boolean;
};

/** Subset of makeMux() used to spawn a remote slot. */
export interface MuxHandle {
  spawn(opts?: {
    holdStdinUntilReady?: boolean;
    /** Controller-selected identity accompanying this allocation. The bridge
     * RPC below remains authoritative; local wrappers may use this only to
     * construct the matching transport endpoint. */
    launch?: RemoteSlotSpawnParams;
  }): MuxSpawnedProcess;
  rpc(
    method: string,
    params: unknown,
    opts?: { agentId?: string; timeoutMs?: number }
  ): Promise<unknown>;
  releaseStdin(slot: number): void;
}

export interface SeamMcpInjection {
  mcpServers: McpServer[];
  bridged: boolean;
}

/**
 * Resolve the mcpServers list for a runtime start. Every production session is
 * bridge-bound. Its host selects the reachable URL: loopback for the separate
 * local bridge process, public/non-loopback for a remote bridge.
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
    return { mcpServers: globalMcpServers, bridged: false };
  }
  const bridged = seamMcp.isBridgeSession?.(sessionId) === true;
  if (bridged) {
    const entry = seamMcp.mcpServersForBridgeSpawn?.(sessionId);
    if (entry) {
      return { mcpServers: [...globalMcpServers, entry], bridged: true };
    }
    const port = seamMcp.getPort();
    if (port === undefined) {
      return { mcpServers: globalMcpServers, bridged: true };
    }
    const token = opts.reuseToken
      ? (seamMcp.registry.peek(sessionId) ?? seamMcp.registry.mint(sessionId))
      : seamMcp.registry.mint(sessionId);
    const publicUrl = seamMcp.getPublicUrl?.();
    const url = publicUrl ?? resolveReachableMcpUrl({ port, remote: true });
    return {
      mcpServers: [...globalMcpServers, buildSeamMcpServerEntry(port, token, { url })],
      bridged: true,
    };
  }
  const port = seamMcp.getPort();
  if (port === undefined) {
    return { mcpServers: globalMcpServers, bridged: false };
  }
  const token = opts.reuseToken
    ? (seamMcp.registry.peek(sessionId) ?? seamMcp.registry.mint(sessionId))
    : seamMcp.registry.mint(sessionId);
  const loopback = seamMcp.getLoopbackUrl?.();
  return {
    mcpServers: [
      ...globalMcpServers,
      buildSeamMcpServerEntry(port, token, loopback ? { url: loopback } : undefined),
    ],
    bridged: false,
  };
}

export interface RemoteSlotSpawnParams {
  mcpServers: McpServer[];
  agentId: string;
  model?: string;
  modelFallbacks?: import("@seam/adapters").ModelFallbackPlan;
  effort?: string;
  cwd?: string;
  rung1Recovery?: RemoteRung1Policy;
}

/**
 * Allocate a mux slot, rpc("spawn") so the bridge fills slotConfigs, then
 * release stdin. No `env` key — the bridge host owns its own environment.
 */
export async function spawnRemoteSlot(
  mux: MuxHandle,
  params: RemoteSlotSpawnParams
): Promise<MuxSpawnedProcess> {
  const child = mux.spawn({ holdStdinUntilReady: true, launch: params });
  const slot = child.slot;
  const rpcParams: Record<string, unknown> = {
    slot,
    mcpServers: params.mcpServers,
    agentId: params.agentId,
  };
  if (params.model !== undefined) rpcParams.model = params.model;
  if (params.modelFallbacks !== undefined) rpcParams.modelFallbacks = params.modelFallbacks;
  if (params.effort !== undefined) rpcParams.effort = params.effort;
  if (params.cwd !== undefined) rpcParams.cwd = params.cwd;
  if (params.rung1Recovery !== undefined) rpcParams.rung1Recovery = params.rung1Recovery;
  try {
    const result = await mux.rpc("spawn", rpcParams, { agentId: params.agentId });
    const projectMcpInjection = result && typeof result === "object"
      ? (result as { projectMcpInjection?: unknown }).projectMcpInjection
      : undefined;
    if (projectMcpInjection !== true) {
      // Old bridges cannot load remote project MCP. Keep the agent available
      // and make the compatibility gap loud until that host is rolled out.
      console.warn(
        `[remote-spawn] bridge for ${params.agentId} predates host-owned project MCP; ` +
        "continuing without remote project .mcp.json"
      );
    }
    child.remoteRung1Recovery = Boolean(result && typeof result === "object"
      && (result as { rung1RecoveryVersion?: unknown }).rung1RecoveryVersion === 1);
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

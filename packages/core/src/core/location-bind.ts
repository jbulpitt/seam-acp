/**
 * Bind a session to a host and (for isolated remote workers) plan a
 * bridge spawn. `markSessionBridge` is the #84 hook — this module is
 * the only production caller besides tests.
 */
import type { AgentProfile } from "@seam/adapters";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { BridgeHub } from "./bridge-hub.js";
import { isLocalLocation, LOCAL_LOCATION, normalizeLocation } from "./location.js";
import { spawnRemoteSlot } from "./remote-spawn.js";

/** Bind `sessionId` to `location` when it is a remote bridge. Local is unbound. */
export function bindSessionLocation(
  hub: Pick<BridgeHub, "markSessionBridge"> | undefined,
  sessionId: string,
  location: string | undefined
): void {
  const loc = normalizeLocation(location);
  // Always write: `local` unbinds so a @mac → @local switch does not keep
  // the remote spawn path. Remote ids call the #84 hook.
  hub?.markSessionBridge(sessionId, loc);
}

export function isolatedBindSessionId(dispatchId: string): string {
  return `dispatch:${dispatchId}`;
}

export function planIsolatedRemoteSpawn(opts: {
  hub: BridgeHub;
  sessionId: string;
  location: string;
  agentId: string;
  cwd: string;
  model?: string;
  effort?: string;
  globalMcpServers?: McpServer[];
}): {
  location: string;
  spawnFn: (
    model?: string,
    effort?: string
  ) => ReturnType<AgentProfile["spawn"]> | Promise<ReturnType<AgentProfile["spawn"]>>;
  mcpServers: McpServer[];
} {
  const loc = normalizeLocation(opts.location);
  if (isLocalLocation(loc)) {
    throw new Error("planIsolatedRemoteSpawn is for remote locations only");
  }
  bindSessionLocation(opts.hub, opts.sessionId, loc);
  const mux = opts.hub.get(loc)?.mux;
  if (!mux) {
    throw new Error(`bridge "${loc}" is not connected`);
  }
  const entry = opts.hub.mcpServersForRemoteSpawn(opts.sessionId);
  const mcpServers = entry
    ? [...(opts.globalMcpServers ?? []), entry]
    : (opts.globalMcpServers ?? []);
  return {
    location: loc,
    mcpServers,
    spawnFn: (modelOverride, effortOverride) =>
      spawnRemoteSlot(mux, {
        mcpServers,
        agentId: opts.agentId,
        model: modelOverride ?? opts.model,
        effort: effortOverride ?? opts.effort,
        cwd: opts.cwd,
      }),
  };
}

export { LOCAL_LOCATION };

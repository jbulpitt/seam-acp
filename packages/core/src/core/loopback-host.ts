/**
 * D9 — `local` is a loopback bridge.
 *
 * In-process transport implementing the same adapter-over-bus `rpc` surface
 * the remote mux uses. Local ACP spawn stays unbound (loopback MCP as today);
 * adapter methods (listWorkspaces, describe, whoami, …) go through this bus
 * so local + remote share one code path for enumerate / diagnostics.
 */
import { invokeAdapterRpc, type AgentAdapter } from "@seam/adapters";
import { LOCAL_HOST_EMOJI, LOCAL_LOCATION } from "./location.js";
import type { MuxHandle } from "./remote-spawn.js";

export class LoopbackHost implements Pick<MuxHandle, "rpc"> {
  readonly id = LOCAL_LOCATION;
  readonly emoji = LOCAL_HOST_EMOJI;
  private readonly adapters: Map<string, AgentAdapter>;
  private readonly workspaceRoot: string;

  constructor(opts: { adapters: Iterable<AgentAdapter>; workspaceRoot: string }) {
    this.adapters = new Map([...opts.adapters].map((a) => [a.id, a]));
    this.workspaceRoot = opts.workspaceRoot;
  }

  async rpc(
    method: string,
    params: unknown,
    opts?: { agentId?: string; timeoutMs?: number }
  ): Promise<unknown> {
    void opts?.timeoutMs;
    const adapter = opts?.agentId
      ? this.adapters.get(opts.agentId)
      : [...this.adapters.values()][0];
    return invokeAdapterRpc(method, params, {
      adapter,
      workspaceRoot: this.workspaceRoot,
    });
  }
}

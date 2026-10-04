import type { McpContribution } from "../mcp-registry.js";
import type { QuotaRegistry } from "../../core/quota/quota-registry.js";

export function quotaMcp(registry: QuotaRegistry): McpContribution[] {
  return [{
    descriptor: {
      name: "agent_quota",
      description: "Read normalized rolling and weekly quota for one configured agent or all agents. " +
        "Orchestration models use this to pick workers with headroom and steer handoffs away " +
        "from agents nearing a rolling or weekly cap.",
      inputSchema: { type: "object", properties: { agentId: { type: "string", description: "Optional configured agent id. Omit to return every agent." } }, required: [] },
    },
    access: "read-only", authorization: "user", available: () => true,
    instruction: "- agent_quota(agentId?): read normalized rolling + weekly quota for one agent or all agents\n  before choosing workers; steer away from agents nearing a cap.",
    handle: async ({ args }) => {
      const agentId = typeof args.agentId === "string" ? args.agentId.trim() || undefined : undefined;
      const quotas = agentId ? [registry.get(agentId)].filter(quota => quota !== undefined) : registry.all();
      return { content: [{ type: "text", text: agentId && quotas.length === 0 ? `Unknown configured agent: "${agentId}".` : JSON.stringify(quotas, null, 2) }],
        ...(agentId && quotas.length === 0 ? { isError: true } : {}),
      };
    },
  }];
}

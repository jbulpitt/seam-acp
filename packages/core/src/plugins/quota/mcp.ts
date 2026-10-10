import type { McpContribution } from "../mcp-registry.js";
import type { QuotaRegistry } from "../../core/quota/quota-registry.js";
import type { AgentProfile } from "@seam/adapters";
import type { AgentQuota } from "../../core/quota/agent-quota.js";

export function quotaMcp(registry: QuotaRegistry, agents: () => readonly Pick<AgentProfile, "id" | "displayName" | "brand">[] = () => []): McpContribution[] {
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
      const known = new Map(registry.all().map(quota => [quota.agentId, quota]));
      // Bridge-only Vertex agents have no subscription quota reader. Do not
      // turn missing GCP limits into synthetic zero usage or unlimited quota.
      for (const profile of agents()) {
        if (profile.brand !== "vertex") continue;
        const quota: AgentQuota = {
          agentId: profile.id, displayName: profile.displayName, ok: false,
          error: "Vertex AI quota is not reported by Seam; GCP project limits and billing apply",
          plan: null, credits: null, fetchedAt: null,
          rolling: { label: "rolling", usedPercent: null, resetsAt: null },
          weekly: { label: "weekly", usedPercent: null, resetsAt: null },
        };
        known.set(profile.id, quota);
      }
      const quotas = agentId ? [known.get(agentId)].filter(quota => quota !== undefined) : [...known.values()];
      const readings = quotas.map(quota => {
        if (!quota.source) return quota;
        const at = Date.parse(quota.source.observedAt ?? "");
        return { ...quota, ageSeconds: Number.isFinite(at) ? Math.max(0, Math.floor((Date.now() - at) / 1000)) : null };
      });
      return { content: [{ type: "text", text: agentId && quotas.length === 0 ? `Unknown configured agent: "${agentId}".` : JSON.stringify(readings, null, 2) }],
        ...(agentId && quotas.length === 0 ? { isError: true } : {}),
      };
    },
  }];
}

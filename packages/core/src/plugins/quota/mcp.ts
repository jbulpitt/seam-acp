import type { McpContribution } from "../mcp-registry.js";
import { quotaKey, type QuotaRegistry } from "../../core/quota/quota-registry.js";
import type { AgentProfile } from "@seam/adapters";
import type { AgentQuota } from "../../core/quota/agent-quota.js";

export function quotaMcp(registry: QuotaRegistry, agents: () => readonly Pick<AgentProfile, "id" | "displayName" | "brand">[] = () => []): McpContribution[] {
  return [{
    descriptor: {
      name: "agent_quota",
      description: "Read normalized rolling and weekly quota for one configured agent or all agents, including independent named pools for Antigravity and opted-in host rows. " +
        "Optional location selects that host's separate row, otherwise the global row. " +
        "These are cached snapshots; the quota card's Refresh button forces a live account/plan read without starting an agent turn. " +
        "Orchestration models use this to pick workers with headroom and steer handoffs away " +
        "from agents nearing a rolling or weekly cap.",
      inputSchema: { type: "object", properties: { agentId: { type: "string", description: "Optional configured agent id. Omit to return every agent." },
        location: { type: "string", description: "Optional execution host; uses its separate quota if configured, otherwise global." } }, required: [] },
    },
    access: "read-only", authorization: "user", available: () => true,
    instruction: "- agent_quota(agentId?, location?): read cached quota for one agent or all agents; opted-in hosts have separate rows.\n  Other hosts use global quota. Antigravity pools are independent; use the pool covering the selected model.",
    handle: async ({ args }) => {
      const agentId = typeof args.agentId === "string" ? args.agentId.trim() || undefined : undefined;
      const location = typeof args.location === "string" ? args.location.trim() || undefined : undefined;
      const known = new Map(registry.all().map(quota => [quotaKey(quota.agentId, quota.location), quota]));
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
      const quotas = agentId ? [known.get(quotaKey(agentId, location)) ?? known.get(agentId)].filter(quota => quota !== undefined)
        : location ? [...new Set([...known.values()].map(q => q.agentId))].map(id => known.get(quotaKey(id, location)) ?? known.get(id)).filter(q => q !== undefined)
        : [...known.values()];
      const readings = quotas.map(quota => {
        const at = quota.source ? Date.parse(quota.source.observedAt ?? "") : quota.fetchedAt === null ? NaN : quota.fetchedAt * 1000;
        return { ...quota, ageSeconds: Number.isFinite(at) ? Math.max(0, Math.floor((Date.now() - at) / 1000)) : null };
      });
      return { content: [{ type: "text", text: agentId && quotas.length === 0 ? `Unknown configured agent: "${agentId}".` : JSON.stringify(readings, null, 2) }],
        ...(agentId && quotas.length === 0 ? { isError: true } : {}),
      };
    },
  }];
}

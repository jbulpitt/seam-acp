import type { AgentQuotaSource } from "../../core/quota/quota-poller.js";
import type { UsageBinding, UsageProviderPort } from "../../core/quota/usage-provider.js";
import { mapAgyQuota, mapClaudeQuota, mapCodexQuota, mapCopilotQuota, mapGrokQuota, mapOllamaCloudQuota, mapUnavailableQuota } from "../../core/quota/agent-quota.js";

export function createQuotaSources(bindings: readonly Readonly<UsageBinding>[], usage: UsageProviderPort): AgentQuotaSource[] {
  return bindings.map(binding => ({
    agentId: binding.agentId, displayName: binding.displayName,
    eventDriven: binding.provider === "codex" || binding.provider === "grok",
    fetch: async (signal, active) => {
      if (!binding.quotaAvailable) return mapUnavailableQuota(binding, "This agent does not expose quota data");
      const result = await usage.readUsage(active ?? binding, signal);
      switch (result.provider) {
        case "agy": return mapAgyQuota(binding, result.data);
        case "claude": return mapClaudeQuota(binding, result.data);
        case "codex": return mapCodexQuota(binding, result.data);
        case "copilot": return mapCopilotQuota(binding, result.data);
        case "grok": return mapGrokQuota(binding, result.data);
        case "ollama-cloud": return mapOllamaCloudQuota(binding, result.data);
      }
    },
  }));
}

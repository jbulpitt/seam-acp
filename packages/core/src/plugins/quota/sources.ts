import type { AgentQuotaSource } from "../../core/quota/quota-poller.js";
import type { UsageBinding, UsageProviderPort } from "../../core/quota/usage-provider.js";
import { mapAgyQuota, mapClaudeQuota, mapCodexQuota, mapCopilotQuota, mapGrokQuota, mapOllamaCloudQuota, mapUnavailableQuota } from "../../core/quota/agent-quota.js";

export function createQuotaSources(bindings: readonly Readonly<UsageBinding>[], usage: UsageProviderPort): AgentQuotaSource[] {
  return bindings.map(binding => {
    const identity = { agentId: binding.agentId, displayName: binding.displayName };
    return {
      agentId: identity.agentId, displayName: identity.displayName,
      eventDriven: binding.provider === "codex" || binding.provider === "grok",
      fetch: async (signal, active) => {
        if (!binding.quotaAvailable) return mapUnavailableQuota(identity, "This agent does not expose quota data");
        const result = await usage.readUsage(active ?? binding, signal);
        switch (result.provider) {
          case "agy": return mapAgyQuota(identity, result.data);
          case "claude": return mapClaudeQuota(identity, result.data);
          case "codex": return mapCodexQuota(identity, result.data);
          case "copilot": return mapCopilotQuota(identity, result.data);
          case "grok": return mapGrokQuota(identity, result.data);
          case "ollama-cloud": return mapOllamaCloudQuota(identity, result.data);
        }
      },
    };
  });
}

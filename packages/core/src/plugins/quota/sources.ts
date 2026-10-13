import type { AgentQuotaSource } from "../../core/quota/quota-poller.js";
import type { UsageBinding, UsageProviderPort } from "../../core/quota/usage-provider.js";
import { mapAgyQuota, mapClaudeQuota, mapCodexQuota, mapCopilotQuota, mapGrokQuota, mapOllamaCloudQuota, mapUnavailableQuota } from "../../core/quota/agent-quota.js";

export function createQuotaSources(bindings: readonly Readonly<UsageBinding>[], usage: UsageProviderPort): AgentQuotaSource[] {
  return bindings.map(binding => {
    const identity = { agentId: binding.agentId, displayName: binding.displayName, location: binding.quotaLocation,
      host: binding.host, trackingUnavailable: binding.trackingUnavailable };
    return {
      ...identity,
      eventDriven: binding.provider === "codex" || binding.provider === "grok",
      fetch: async (signal, active) => {
        if (!binding.quotaAvailable) return mapUnavailableQuota(identity, "This agent does not expose quota data");
        const result = await usage.readUsage({ ...(active ?? binding), quotaLocation: binding.quotaLocation } as UsageBinding, signal);
        const observed = result.host && !binding.quotaLocation ? { ...identity, host: result.host } : identity;
        switch (result.provider) {
          case "agy": return mapAgyQuota(observed, result.data);
          case "claude": return mapClaudeQuota(observed, result.data);
          case "codex": return mapCodexQuota(observed, binding.quotaLocation && result.data.source
            ? { ...result.data, source: { ...result.data.source, host: binding.quotaLocation } } : result.data);
          case "copilot": return mapCopilotQuota(observed, result.data);
          case "grok": return mapGrokQuota(observed, result.data);
          case "ollama-cloud": return mapOllamaCloudQuota(observed, result.data);
        }
      },
    };
  });
}

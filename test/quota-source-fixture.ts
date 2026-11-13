import type { AgentAdapter } from "@seam/adapters";
import { createUsageProviderPort } from "../packages/core/src/core/quota/usage-provider.js";
import { createQuotaSources } from "../packages/core/src/plugins/quota/sources.js";

export function createAgentQuotaSources(profiles: AgentAdapter[], options: Omit<Parameters<typeof createUsageProviderPort>[0], "profiles">) {
  const port = createUsageProviderPort({ profiles, ...options });
  return createQuotaSources(port.bindings(), port);
}

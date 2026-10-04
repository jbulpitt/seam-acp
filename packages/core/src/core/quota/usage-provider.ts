import {
  fetchAgyUserStatus, fetchClaudeUsage, fetchCodexUsage, fetchCopilotUsage,
  fetchGrokUsage, fetchGrokUsageFromConnection, fetchOllamaCloudUsage,
  type AgentProfile, type AgyLaunchRuntime,
} from "@seam/adapters";
import type { TurnBinding } from "../../plugins/turn-activity-registry.js";
import { isOllamaCloudAgentId } from "../parked-agents.js";

export type ProviderUsage =
  | { provider: "agy"; data: Awaited<ReturnType<typeof fetchAgyUserStatus>> }
  | { provider: "claude"; data: Awaited<ReturnType<typeof fetchClaudeUsage>> }
  | { provider: "codex"; data: Awaited<ReturnType<typeof fetchCodexUsage>> }
  | { provider: "copilot"; data: Awaited<ReturnType<typeof fetchCopilotUsage>> }
  | { provider: "grok"; data: Awaited<ReturnType<typeof fetchGrokUsage>> }
  | { provider: "ollama-cloud"; data: Awaited<ReturnType<typeof fetchOllamaCloudUsage>> };
export interface UsageBinding extends TurnBinding {
  displayName: string;
  provider: ProviderUsage["provider"] | null;
  quotaAvailable: boolean;
}
export interface UsageProviderPort {
  readUsage(binding: Readonly<TurnBinding>, signal?: AbortSignal): Promise<ProviderUsage>;
}

/** Internal tier: only this facade sees launch profiles and live connections. */
export function createUsageProviderPort(options: {
  profiles: readonly AgentProfile[];
  agyRuntime?: AgyLaunchRuntime;
  grokCliPath?: string;
  ollamaUsageCliPath?: string;
  ollamaCloudEnabled?: boolean;
  liveRequest?: (sessionId: string) => ((method: string, params?: unknown) => Promise<unknown>) | undefined;
}): UsageProviderPort & { bindings(): readonly Readonly<UsageBinding>[]; binding(agentId: string, sessionId?: string, location?: string): Readonly<UsageBinding> } {
  const profiles = new Map(options.profiles.map(profile => [profile.id, profile]));
  const binding = (agentId: string, sessionId?: string, location = "local"): Readonly<UsageBinding> => {
    const profile = profiles.get(agentId);
    const provider = agentId === "agy" ? "agy"
      : isOllamaCloudAgentId(agentId) ? "ollama-cloud"
      : (["claude", "codex", "copilot", "grok"] as const).find(id => agentId === id || agentId.startsWith(`${id}-`)) ?? null;
    return Object.freeze({ agentId, displayName: profile?.displayName ?? agentId, location,
      account: profile?.runtime?.credentialScope ?? agentId, ...(sessionId ? { sessionId } : {}), provider,
      quotaAvailable: provider !== null && !(provider === "claude" && profile?.brand),
    });
  };
  return {
    binding,
    bindings: () => [...profiles.keys()].filter(id => options.ollamaCloudEnabled !== false || !isOllamaCloudAgentId(id)).map(id => binding(id)),
    readUsage: async (target, signal) => {
      const selected = binding(target.agentId, target.sessionId, target.location);
      const profile = profiles.get(target.agentId);
      switch (selected.provider) {
        case "agy":
          if (!options.agyRuntime) throw new Error("native agy quota requires the configured verified runtime");
          return { provider: "agy", data: await fetchAgyUserStatus(options.agyRuntime, signal) };
        case "ollama-cloud":
          return { provider: "ollama-cloud", data: await fetchOllamaCloudUsage(options.ollamaUsageCliPath, signal) };
        case "claude": return { provider: "claude", data: await fetchClaudeUsage(profile?.configDir) };
        case "codex": return { provider: "codex", data: await fetchCodexUsage({ signal }) };
        case "copilot": return { provider: "copilot", data: await fetchCopilotUsage(profile?.configDir, signal) };
        case "grok": {
          const request = target.sessionId ? options.liveRequest?.(target.sessionId) : undefined;
          return { provider: "grok", data: request ? await fetchGrokUsageFromConnection(request, signal) : await fetchGrokUsage(options.grokCliPath, signal) };
        }
        default: throw new Error(`Agent '${target.agentId}' does not expose usage data`);
      }
    },
  };
}

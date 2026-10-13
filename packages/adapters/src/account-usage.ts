import type { AgentProfile } from "./agent-profile.js";
import type { AgyLaunchRuntime } from "./agy-native-runtime.js";
import { fetchAgyUserStatus } from "./profiles/agy.js";
import { fetchClaudeUsage } from "./profiles/claude.js";
import { fetchCodexUsage } from "./profiles/codex-session-manager.js";
import { fetchCopilotUsage } from "./profiles/copilot.js";
import { fetchGrokUsage, fetchGrokUsageFromConnection } from "./profiles/grok.js";
import { fetchOllamaCloudUsage } from "./profiles/ollama-cloud.js";

export type ProviderUsage = { host?: string } & (
  | { provider: "agy"; data: Awaited<ReturnType<typeof fetchAgyUserStatus>> }
  | { provider: "claude"; data: Awaited<ReturnType<typeof fetchClaudeUsage>> }
  | { provider: "codex"; data: Awaited<ReturnType<typeof fetchCodexUsage>> }
  | { provider: "copilot"; data: Awaited<ReturnType<typeof fetchCopilotUsage>> }
  | { provider: "grok"; data: Awaited<ReturnType<typeof fetchGrokUsage>> }
  | { provider: "ollama-cloud"; data: Awaited<ReturnType<typeof fetchOllamaCloudUsage>> });
export type AccountUsageProfile = Pick<AgentProfile, "id" | "displayName"> &
  Pick<Partial<AgentProfile>, "configDir" | "runtime" | "accountUsage" | "brand">;
export const accountUsageReaders = { fetchAgyUserStatus, fetchClaudeUsage, fetchCodexUsage, fetchCopilotUsage, fetchGrokUsage, fetchGrokUsageFromConnection, fetchOllamaCloudUsage };
export function accountUsageProvider(agentId: string): ProviderUsage["provider"] | null {
  const id = agentId.trim();
  return agentId === "agy" ? "agy" : id === "ollama-cloud" || id.startsWith("ollama-cloud-") ? "ollama-cloud"
    : (["claude", "codex", "copilot", "grok"] as const).find(id => agentId === id || agentId.startsWith(`${id}-`)) ?? null;
}

/** Account reads run beside the credentials and configured adapter runtime. */
export async function readAccountUsage(options: {
  agentId: string; profile?: AccountUsageProfile; agyRuntime?: AgyLaunchRuntime;
  grokCliPath?: string; ollamaUsageCliPath?: string; signal?: AbortSignal;
  request?: (method: string, params?: unknown) => Promise<unknown>;
}, readers = accountUsageReaders): Promise<ProviderUsage> {
  const { agentId, profile, signal } = options;
  if (accountUsageProvider(agentId) === "claude" && profile?.brand) throw new Error("This agent does not expose quota data");
  switch (accountUsageProvider(agentId)) {
    case "agy":
      if (!options.agyRuntime) throw new Error("native agy quota requires the configured verified runtime");
      return { provider: "agy", data: await readers.fetchAgyUserStatus(options.agyRuntime, signal) };
    case "ollama-cloud": return { provider: "ollama-cloud", data: await readers.fetchOllamaCloudUsage(options.ollamaUsageCliPath, signal) };
    case "claude": return { provider: "claude", data: await readers.fetchClaudeUsage(profile?.configDir) };
    case "codex": return { provider: "codex", data: await (profile?.accountUsage ? profile.accountUsage(signal) : readers.fetchCodexUsage({ signal })) };
    case "copilot": return { provider: "copilot", data: await readers.fetchCopilotUsage(profile?.configDir, signal) };
    case "grok": return { provider: "grok", data: options.request ? await readers.fetchGrokUsageFromConnection(options.request, signal) : await readers.fetchGrokUsage(options.grokCliPath, signal) };
    default: throw new Error(`Agent '${agentId}' does not expose usage data`);
  }
}

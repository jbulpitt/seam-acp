import {
  fetchAgyUserStatus, fetchClaudeUsage, fetchCodexUsage, fetchCopilotUsage,
  fetchGrokUsage, fetchGrokUsageFromConnection, fetchOllamaCloudUsage,
  readAccountUsage, accountUsageProvider,
  type AccountUsageProfile, type ProviderUsage, type AgyLaunchRuntime,
} from "@seam/adapters";
import type { TurnBinding } from "../../plugins/turn-activity-registry.js";
import { isOllamaCloudAgentId } from "../parked-agents.js";

export type { ProviderUsage } from "@seam/adapters";
export interface UsageBinding extends TurnBinding {
  displayName: string;
  provider: ProviderUsage["provider"] | null;
  quotaAvailable: boolean;
  quotaLocation?: string;
  host?: string;
  trackingUnavailable?: string;
}
export interface UsageProviderPort {
  readUsage(binding: Readonly<TurnBinding>, signal?: AbortSignal): Promise<ProviderUsage>;
}

export type QuotaProfile = AccountUsageProfile;

/** Internal tier: account readers and live quota connections, never turn launchers. */
export function createUsageProviderPort(options: {
  profiles: readonly QuotaProfile[];
  agyRuntime?: AgyLaunchRuntime;
  grokCliPath?: string;
  ollamaUsageCliPath?: string;
  ollamaCloudEnabled?: boolean;
  liveRequest?: (sessionId: string) => ((method: string, params?: unknown) => Promise<unknown>) | undefined;
  controllerHost?: string;
  separateBindings?: () => Iterable<{ agentId: string; location: string }>;
  hostUsage?: { supports(location: string): boolean | undefined; read(location: string, agentId: string): Promise<ProviderUsage> };
}): UsageProviderPort & { bindings(): readonly Readonly<UsageBinding>[]; binding(agentId: string, sessionId?: string, location?: string): Readonly<UsageBinding> } {
  const profiles = new Map(options.profiles.map(profile => [profile.id, profile]));
  const binding = (agentId: string, sessionId?: string, location = "local"): Readonly<UsageBinding> => {
    const profile = profiles.get(agentId);
    const provider = accountUsageProvider(agentId);
    const separate = [...(options.separateBindings?.() ?? [])].some(b => b.agentId === agentId && b.location === location);
    const unsupported = options.hostUsage?.supports(location) === false;
    return Object.freeze({ agentId, displayName: profile?.displayName ?? agentId, location,
      account: profile?.runtime?.credentialScope ?? agentId, ...(sessionId ? { sessionId } : {}), provider,
      quotaAvailable: provider !== null && !(provider === "claude" && profile?.brand),
      ...(separate && !unsupported ? { quotaLocation: location, host: location } : options.controllerHost ? { host: options.controllerHost } : {}),
    });
  };
  return {
    binding,
    bindings: () => {
      const separate = [...(options.separateBindings?.() ?? [])];
      const globals = [...profiles.keys()].filter(id => options.ollamaCloudEnabled !== false || !isOllamaCloudAgentId(id)).map(id => {
        const unavailable = separate.filter(b => b.agentId === id && options.hostUsage?.supports(b.location) === false);
        // Global rows remain global even when local is explicitly separated.
        return { ...binding(id), quotaLocation: undefined, host: options.controllerHost,
          ...(unavailable.length ? { trackingUnavailable: `Separate tracking unavailable for ${unavailable.map(b => b.location).join(", ")}: bridge does not support account usage RPC; global tracking applies` } : {}) };
      });
      return [...globals, ...separate.filter(b => options.hostUsage?.supports(b.location) !== false).map(b => binding(b.agentId, undefined, b.location))];
    },
    readUsage: async (target, signal) => {
      const selected = "quotaLocation" in target ? target as UsageBinding : binding(target.agentId, target.sessionId, target.location);
      if (selected.quotaLocation) {
        if (!options.hostUsage) throw new Error(`Host usage reader unavailable for ${target.agentId}@${selected.quotaLocation}`);
        return options.hostUsage.read(selected.quotaLocation, target.agentId);
      }
      const request = accountUsageProvider(target.agentId) === "grok" && target.sessionId ? options.liveRequest?.(target.sessionId) : undefined;
      const result = await readAccountUsage({ agentId: target.agentId, profile: profiles.get(target.agentId), signal,
        agyRuntime: options.agyRuntime, grokCliPath: options.grokCliPath, ollamaUsageCliPath: options.ollamaUsageCliPath,
        request },
        { fetchAgyUserStatus, fetchClaudeUsage, fetchCodexUsage, fetchCopilotUsage, fetchGrokUsage, fetchGrokUsageFromConnection, fetchOllamaCloudUsage });
      return options.controllerHost ? { ...result, host: request ? target.location : options.controllerHost } : result;
    },
  };
}

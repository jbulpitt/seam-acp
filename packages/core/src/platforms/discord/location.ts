/**
 * Flattened host-prefixed agent picker (D10). Lives next to bridge.ts /
 * debug.ts so orchestrator.ts stays a thin switch.
 */
import type { AgentProfile } from "@seam/adapters";
import type { BridgeHostConfig, Config } from "../../config.js";
import { resolveThreadLocation } from "../../config.js";
import {
  formatAgentAtLocation,
  formatHostPrefixed,
  hostEmoji,
  listAgentLocationChoices,
  listHosts,
  LOCAL_LOCATION,
  parseAgentAtLocation,
  type AgentLocationChoice,
} from "../../core/location.js";

export interface PickerHostInput {
  bridges: Iterable<BridgeHostConfig>;
  connected?: ReadonlySet<string>;
  /** Installed agent ids per connected bridge (from hello inventory). */
  agentsByHost?: ReadonlyMap<string, ReadonlySet<string>>;
}

export function agentLocationPickerChoices(
  profiles: ReadonlyArray<Pick<AgentProfile, "id" | "displayName">>,
  hosts: PickerHostInput
): AgentLocationChoice[] {
  return listAgentLocationChoices({
    profiles,
    hosts: listHosts(hosts),
    ...(hosts.agentsByHost ? { agentsByHost: hosts.agentsByHost } : {}),
  });
}

export function currentAgentAtLocation(
  agentId: string,
  threadPresets: Pick<Config, "threadPresets">,
  threadId: string | undefined
): string {
  return formatAgentAtLocation(agentId, resolveThreadLocation(threadPresets, threadId));
}

export function currentHostPrefixedLabel(
  agentId: string,
  threadPresets: Pick<Config, "threadPresets">,
  threadId: string | undefined,
  bridges: ReadonlyMap<string, BridgeHostConfig>
): string {
  const location = resolveThreadLocation(threadPresets, threadId);
  const host = location === LOCAL_LOCATION ? undefined : bridges.get(location);
  return formatHostPrefixed(agentId, location, hostEmoji(host, location));
}

export { parseAgentAtLocation, LOCAL_LOCATION, formatAgentAtLocation };

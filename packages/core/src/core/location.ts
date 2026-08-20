/**
 * Location binding (D1 / D9 / D10 / #86).
 *
 * Addressable instances are `agentId@location` where
 * `location ∈ { "local", <bridgeId> }`. Omit / undefined / "" ⇒ `local`.
 */
import type { AgentProfile } from "@seam/adapters";
import type { BridgeHostConfig } from "../config.js";

export const LOCAL_LOCATION = "local";
export const LOCAL_HOST_EMOJI = "🏠";
export const REMOTE_HOST_EMOJI = "🖥️";

const BRIDGE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface AgentAtLocation {
  agentId: string;
  location: string;
  /** True when the caller wrote an explicit `@location` suffix. */
  explicit: boolean;
}

export interface HostInfo {
  id: string;
  emoji: string;
  shortName: string;
  ready: boolean;
  workspaceRoot?: string;
}

export function normalizeLocation(location: string | undefined | null): string {
  const trimmed = (location ?? "").trim();
  return trimmed.length > 0 ? trimmed : LOCAL_LOCATION;
}

export function isLocalLocation(location: string | undefined | null): boolean {
  return normalizeLocation(location) === LOCAL_LOCATION;
}

export function isValidLocationId(location: string): boolean {
  const loc = normalizeLocation(location);
  if (loc === LOCAL_LOCATION) return true;
  return BRIDGE_ID_RE.test(loc);
}

export function parseAgentAtLocation(raw: string): AgentAtLocation {
  const trimmed = raw.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) {
    return { agentId: trimmed, location: LOCAL_LOCATION, explicit: false };
  }
  const agentId = trimmed.slice(0, at);
  const location = normalizeLocation(trimmed.slice(at + 1));
  if (!agentId) {
    return { agentId: trimmed, location: LOCAL_LOCATION, explicit: false };
  }
  return { agentId, location, explicit: true };
}

export function formatAgentAtLocation(agentId: string, location?: string | null): string {
  return `${agentId}@${normalizeLocation(location)}`;
}

export function hostEmoji(host: Pick<BridgeHostConfig, "emoji"> | undefined, location: string): string {
  if (isLocalLocation(location)) return LOCAL_HOST_EMOJI;
  return host?.emoji?.trim() || REMOTE_HOST_EMOJI;
}

export function hostShortName(
  host: Pick<BridgeHostConfig, "shortName" | "id"> | undefined,
  location: string
): string {
  if (isLocalLocation(location)) return LOCAL_LOCATION;
  return host?.shortName?.trim() || host?.id || location;
}

export function listHosts(opts: {
  bridges: Iterable<BridgeHostConfig>;
  connected?: ReadonlySet<string>;
}): HostInfo[] {
  const hosts: HostInfo[] = [
    {
      id: LOCAL_LOCATION,
      emoji: LOCAL_HOST_EMOJI,
      shortName: LOCAL_LOCATION,
      ready: true,
    },
  ];
  for (const b of opts.bridges) {
    hosts.push({
      id: b.id,
      emoji: hostEmoji(b, b.id),
      shortName: hostShortName(b, b.id),
      ready: opts.connected?.has(b.id) === true,
      ...(b.workspaceRoot ? { workspaceRoot: b.workspaceRoot } : {}),
    });
  }
  return hosts;
}

export interface AgentLocationChoice {
  value: string;
  label: string;
  description: string;
}

/** Flattened picker entries: local = every control-plane profile; remote =
 *  only agent ids that host advertised as installed (hello inventory). */
export function listAgentLocationChoices(opts: {
  profiles: ReadonlyArray<Pick<AgentProfile, "id" | "displayName">>;
  hosts: ReadonlyArray<HostInfo>;
  /** bridgeId → installed agent ids. Omitted/empty for a remote host ⇒ no
   *  remote rows for that host (do not invent VPS agents on a Mac). */
  agentsByHost?: ReadonlyMap<string, ReadonlySet<string>>;
}): AgentLocationChoice[] {
  const out: AgentLocationChoice[] = [];
  for (const host of opts.hosts) {
    const remoteIds =
      host.id === LOCAL_LOCATION ? undefined : opts.agentsByHost?.get(host.id);
    const profiles =
      host.id === LOCAL_LOCATION
        ? opts.profiles
        : opts.profiles.filter((p) => remoteIds?.has(p.id));
    for (const p of profiles) {
      const value = formatAgentAtLocation(p.id, host.id);
      const offline = host.id !== LOCAL_LOCATION && !host.ready ? " (offline)" : "";
      out.push({
        value,
        label: `${host.emoji} ${p.displayName} @ ${host.shortName}`.slice(0, 100),
        description: `${value}${offline}`.slice(0, 100),
      });
    }
  }
  return out;
}

export function formatHostPrefixed(
  agentId: string,
  location: string | undefined,
  emoji: string
): string {
  return `${emoji} ${formatAgentAtLocation(agentId, location)}`;
}

export type DispatchWorkerTarget =
  | { kind: "thread"; threadId: string }
  | { kind: "named"; name: string; location?: string };

/**
 * Parse a handoff/dispatch worker. Discord snowflake → live thread.
 * `name@location` (explicit suffix) carries a host; bare names are
 * presets (or agent ids) on `local` unless the caller sets spec.location.
 */
export function parseDispatchWorker(worker: string): DispatchWorkerTarget {
  const trimmed = worker.trim();
  const parsed = parseAgentAtLocation(trimmed);
  if (!parsed.explicit && /^\d{15,}$/.test(parsed.agentId)) {
    return { kind: "thread", threadId: parsed.agentId };
  }
  if (parsed.explicit) {
    return {
      kind: "named",
      name: parsed.agentId,
      location: parsed.location,
    };
  }
  return { kind: "named", name: parsed.agentId };
}

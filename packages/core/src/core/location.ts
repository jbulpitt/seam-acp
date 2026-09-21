/**
 * Location binding (D1 / D9 / D10 / #86 / #474).
 *
 * Addressable instances are `agentId@location` where
 * `location ∈ { "local", <bridgeId> }`. Omit / undefined / "" ⇒ `local`.
 *
 * Availability at a location is a separate fact from registration (#474).
 * `AGENT_LOCATION_DENY=copilot@local` withholds that pair from pickers and
 * from spawn; the profile stays registered so `copilot@fhr-server` still
 * resolves. Same contract as `retired-agents.ts`: fail clearly, never
 * silently substitute. Adjacent to #468, which asks the same question from
 * the other end of the wire (does this bridge hold the adapter?).
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
 *  only agent ids that host advertised as installed (hello inventory).
 *  A deny-list entry is omitted rather than shown disabled — offering a
 *  choice that spawn will refuse is how the picker becomes decoration. */
export function listAgentLocationChoices(opts: {
  profiles: ReadonlyArray<Pick<AgentProfile, "id" | "displayName">>;
  hosts: ReadonlyArray<HostInfo>;
  /** bridgeId → installed agent ids. Omitted/empty for a remote host ⇒ no
   *  remote rows for that host (do not invent VPS agents on a Mac). */
  agentsByHost?: ReadonlyMap<string, ReadonlySet<string>>;
  /** `agentId@location` pairs withheld from this picker. */
  deny?: readonly AgentLocationDeny[];
}): AgentLocationChoice[] {
  const deny = opts.deny ?? [];
  const out: AgentLocationChoice[] = [];
  for (const host of opts.hosts) {
    const remoteIds =
      host.id === LOCAL_LOCATION ? undefined : opts.agentsByHost?.get(host.id);
    const profiles = host.id === LOCAL_LOCATION
      ? [...opts.profiles]
      : [
          ...opts.profiles.filter((p) => remoteIds?.has(p.id)),
          ...[...(remoteIds ?? [])]
            .filter((id) => !opts.profiles.some((profile) => profile.id === id))
            .sort()
            .map((id) => ({ id, displayName: id })),
        ];
    for (const p of profiles) {
      if (isAgentLocationDenied(p.id, host.id, deny)) continue;
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

/**
 * Host-scoped availability (#474).
 *
 * Registration and availability are different facts. `COPILOT_ENABLED=false`
 * removes the profile everywhere, including `copilot@fhr-server`. A deny list
 * withholds one `agentId@location` while the profile stays registered.
 *
 * #468 (bridge) asks "does this host hold this adapter?" and refuses a stated
 * id it cannot serve rather than substituting. This module asks the adjacent
 * controller question — "is this known agent allowed at this location?" —
 * and uses the same answer: refuse the slot, name what was asked for, never
 * substitute. The two are not one function (inventory vs policy) but they
 * share the failure mode they replace (blast radius 5, silently wrong).
 */

export interface AgentLocationDeny {
  agentId: string;
  location: string;
}

export type DeniedAgentLocationKind = "session" | "select" | "config";

/** Thrown so a caller that only pattern-matches the happy path cannot ignore it
 *  — the shape of mistake #468 extracted `UnknownAgentError` to prevent. */
export class DeniedAgentLocationError extends Error {
  readonly agentId: string;
  readonly location: string;
  constructor(agentId: string, location: string, kind: DeniedAgentLocationKind = "session") {
    super(deniedAgentLocationMessage(agentId, location, kind));
    this.name = "DeniedAgentLocationError";
    this.agentId = agentId;
    this.location = location;
  }
}

/**
 * Parse `AGENT_LOCATION_DENY`. Empty = nobody is withheld.
 * Each entry MUST be explicit `agentId@location` — a bare id would be a
 * global ban, which is `COPILOT_ENABLED=false`, not this list.
 */
export function parseAgentLocationDeny(raw: string): AgentLocationDeny[] {
  const out: AgentLocationDeny[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const parsed = parseAgentAtLocation(part);
    if (!parsed.explicit) {
      throw new Error(
        `Invalid configuration: AGENT_LOCATION_DENY entry "${part}" must be agentId@location ` +
          `(a bare id is a global ban — use COPILOT_ENABLED=false for that). ` +
          `seam-acp will not guess the location.`
      );
    }
    if (!isValidLocationId(parsed.location)) {
      throw new Error(
        `Invalid configuration: AGENT_LOCATION_DENY entry "${part}" has an invalid location id.`
      );
    }
    const key = formatAgentAtLocation(parsed.agentId, parsed.location);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ agentId: parsed.agentId, location: parsed.location });
  }
  return out;
}

export function isAgentLocationDenied(
  agentId: string,
  location: string | undefined | null,
  deny: readonly AgentLocationDeny[],
): boolean {
  if (deny.length === 0) return false;
  const loc = normalizeLocation(location);
  const id = agentId.trim();
  return deny.some((entry) => entry.agentId === id && entry.location === loc);
}

export function assertAgentLocationAllowed(
  agentId: string,
  location: string | undefined | null,
  deny: readonly AgentLocationDeny[],
  kind: DeniedAgentLocationKind = "session",
): void {
  const loc = normalizeLocation(location);
  if (isAgentLocationDenied(agentId, loc, deny)) {
    throw new DeniedAgentLocationError(agentId.trim(), loc, kind);
  }
}

export function deniedAgentLocationMessage(
  agentId: string,
  location: string,
  kind: DeniedAgentLocationKind = "session",
): string {
  const pair = formatAgentAtLocation(agentId, location);
  if (kind === "config") {
    return (
      `DEFAULT_AGENT="${agentId}" is not available at "${location}" ` +
      `(AGENT_LOCATION_DENY includes ${pair}). ` +
      `Set DEFAULT_AGENT to an agent allowed at local, or remove ${pair} from AGENT_LOCATION_DENY. ` +
      `seam-acp will not substitute one for you.`
    );
  }
  if (kind === "select") {
    return (
      `Agent "${agentId}" is not available at location "${location}" (AGENT_LOCATION_DENY). ` +
      `It is not offered in the picker.`
    );
  }
  return (
    `Agent "${agentId}" is not available at location "${location}" (AGENT_LOCATION_DENY). ` +
    `This thread is still bound to it, so it cannot start a turn. ` +
    `Move it with \`/seam config agent\` to a host where it is allowed, or remove \`${pair}\` from AGENT_LOCATION_DENY. ` +
    `Switching agents starts a fresh session — the previous conversation context is not carried over.`
  );
}

function denyCopyForAgent(
  agentId: string,
  deny: readonly AgentLocationDeny[],
  kind: DeniedAgentLocationKind,
): string | null {
  const hit = deny.find((entry) => entry.agentId === agentId.trim());
  if (!hit) return null;
  return deniedAgentLocationMessage(agentId.trim(), hit.location, kind);
}

/** Production picker callers live in orchestrator.ts (off-limits for #474).
 *  index.ts installs the parsed list here; `agentLocationPickerChoices` reads it. */
let installedDeny: readonly AgentLocationDeny[] = [];

export function setAgentLocationDeny(deny: readonly AgentLocationDeny[]): void {
  installedDeny = deny;
}

export function getAgentLocationDeny(): readonly AgentLocationDeny[] {
  return installedDeny;
}

/**
 * Local spawn is `profile.spawn`. Remote turns use `spawnFn` / `spawnRemoteSlot`,
 * so wrapping spawn refuses `agent@local` without touching `copilot@fhr-server`.
 * A deny list that only filters the picker is decoration; this is the spawn gate.
 */
export function guardLocalProfileSpawn<T extends Pick<AgentProfile, "id" | "spawn">>(
  profile: T,
  deny: readonly AgentLocationDeny[],
): T {
  if (!isAgentLocationDenied(profile.id, LOCAL_LOCATION, deny)) return profile;
  const spawn = profile.spawn.bind(profile);
  return {
    ...profile,
    spawn: ((...args: Parameters<AgentProfile["spawn"]>) => {
      assertAgentLocationAllowed(profile.id, LOCAL_LOCATION, deny);
      return spawn(...args);
    }) as T["spawn"],
  };
}

/**
 * Wire the deny list onto a SessionRouter without editing session-router.ts
 * (#448 is live there). getProfile returning undefined is what
 * `isAgentAvailable` and leftover-session planning consult; planRuntimeSpawn
 * is wrapped so a mutation that restores getProfile still cannot spawn.
 */
export function installAgentLocationDeny<R>(
  router: {
    getProfile: (id: string, location?: string) => unknown;
    planRuntimeSpawn: (record: R) => { agentId: string; location: string };
    unregisteredAgentMessage: (agentId: string, fallback: string) => string;
    unregisteredAgentSessionMessage: (agentId: string, fallback: string) => string;
  },
  deny: readonly AgentLocationDeny[],
): void {
  if (deny.length === 0) return;
  const origGet = router.getProfile.bind(router);
  router.getProfile = (id, location = LOCAL_LOCATION) => {
    if (isAgentLocationDenied(id, location, deny)) return undefined;
    return origGet(id, location);
  };
  const origPlan = router.planRuntimeSpawn.bind(router);
  router.planRuntimeSpawn = (record) => {
    const plan = origPlan(record);
    assertAgentLocationAllowed(plan.agentId, plan.location, deny);
    return plan;
  };
  const origSelect = router.unregisteredAgentMessage.bind(router);
  router.unregisteredAgentMessage = (agentId, fallback) =>
    denyCopyForAgent(agentId, deny, "select") ?? origSelect(agentId, fallback);
  const origSession = router.unregisteredAgentSessionMessage.bind(router);
  router.unregisteredAgentSessionMessage = (agentId, fallback) =>
    denyCopyForAgent(agentId, deny, "session") ?? origSession(agentId, fallback);
}

/**
 * Reverse index of thread→host assignment, for warm-set enumeration only (#446).
 *
 * ## Necessity (#307)
 *
 * Delete this on paper: inbound work still resolves a host. A Discord message
 * carries the channel ref, `resolveThreadLocation` looks it up, a missing
 * binding is a new session. `bindSessionLocation` → in-memory
 * `hub.markSessionBridge` is the right shape for that path and is not made
 * durable here.
 *
 * The failure this prevents is reachable, and it is exactly one case: warm-set
 * pre-load (#452). A host daemon must answer "which sessions am I responsible
 * for" with no message to key off. Without a reverse *read* of the assignment,
 * #452 cannot enumerate. That is the production call site; this module does
 * not start warming, does not opt a host in, and does not run at boot.
 *
 * The assignment fact already has an owner: `threadPresets[threadId].location`
 * in channel-presets.json. The manifesto is explicit that the daemon is not
 * authoritative for thread config. A `sessions.location` column, a new table,
 * or a daemon-local registry would be a second owner of the same fact — a
 * write path. A story on this epic passed every test and silently dropped 21
 * rows from a live table. This function does not write.
 *
 * Warm-set is opt-in at the caller (#452). Hosts that never call this are not
 * warmed, which is the right default for the tail (most hosts hold a handful
 * of threads; four of eight cannot be updated through rollout). Presence of
 * this query is not a foundation that turns warming on.
 */
import { normalizeLocation } from "./location.js";

export interface HostSessionInput {
  id: string;
  channelRef: string;
  agentId: string;
  updatedUtc: string;
}

export interface HostSessionBinding {
  sessionId: string;
  channelRef: string;
  agentId: string;
  location: string;
  updatedUtc: string;
  /** True when the preset wrote an explicit location, not the local default. */
  explicit: boolean;
}

export interface ThreadLocationPreset {
  location?: string;
}

/**
 * Same rule as `resolveThreadLocation`: omit / undefined / "" ⇒ local.
 * Kept here so the reverse index cannot drift from the forward lookup without
 * this helper changing — a fork would send warm-set at the wrong host.
 */
export function locationOfThread(
  presets: ReadonlyMap<string, ThreadLocationPreset>,
  channelRef: string,
): { location: string; explicit: boolean } {
  const raw = presets.get(channelRef)?.location;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return { location: normalizeLocation(undefined), explicit: false };
  return { location: normalizeLocation(trimmed), explicit: true };
}

function isIsolatedDispatch(sessionId: string): boolean {
  return sessionId.startsWith("dispatch:");
}

/**
 * Sessions this host would warm, newest activity first.
 *
 * Includes sessions with no preset (they resolve to local). Excludes isolated
 * `dispatch:` ids — those are ephemeral, have no transcript to resume, and
 * the fleet currently carries zero of them. Excludes a preset with no session
 * row: there is nothing to load.
 */
export function listSessionsForHost(
  location: string,
  opts: {
    threadPresets: ReadonlyMap<string, ThreadLocationPreset>;
    sessions: ReadonlyArray<HostSessionInput>;
  },
): HostSessionBinding[] {
  const wanted = normalizeLocation(location);
  const matched: HostSessionBinding[] = [];
  for (const session of opts.sessions) {
    if (isIsolatedDispatch(session.id)) continue;
    const resolved = locationOfThread(opts.threadPresets, session.channelRef);
    if (resolved.location !== wanted) continue;
    matched.push({
      sessionId: session.id,
      channelRef: session.channelRef,
      agentId: session.agentId,
      location: resolved.location,
      updatedUtc: session.updatedUtc,
      explicit: resolved.explicit,
    });
  }
  matched.sort((a, b) => {
    const byTime = b.updatedUtc.localeCompare(a.updatedUtc);
    return byTime !== 0 ? byTime : a.sessionId.localeCompare(b.sessionId);
  });
  return matched;
}

/**
 * Human wall-clock rendering for agent- and user-facing timestamps.
 *
 * Timestamps are STORED as UTC ISO (`...Z`) — correct. The bug was surfacing
 * those raw `...Z` strings to agents: the deployment runs in the operator's
 * local zone (e.g. America/Chicago), so an agent reading a UTC value reasoned
 * ~5h ahead of the real wall clock — producing wrong ETAs, "how long ago"
 * answers off by the UTC offset, and "you're working late" at midday.
 *
 * Render in the PROCESS-LOCAL timezone (the deployment's zone = the operator's
 * zone) with an explicit zone label, so there is no ambiguity. `tz` overrides
 * the zone (used by tests for determinism); omit it in production to use the
 * host zone. DST is handled by Intl. Invalid input passes through unchanged.
 */
export function formatLocalTime(
  value: string | number | Date,
  tz?: string
): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-US", {
    ...(tz ? { timeZone: tz } : {}),
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(d);
}

import {
  SERVICE_STATUS_LEVELS,
  type NormalizedBaseline,
  type ServiceStatusLevel,
} from "./types.js";

const RANK = new Map<ServiceStatusLevel, number>(
  SERVICE_STATUS_LEVELS.map((level, index) => [level, index])
);

export function statusRank(level: ServiceStatusLevel): number {
  const rank = RANK.get(level);
  if (rank === undefined) throw new Error(`unknown service status level: ${String(level)}`);
  return rank;
}

export function isServiceStatusLevel(value: unknown): value is ServiceStatusLevel {
  return typeof value === "string" && RANK.has(value as ServiceStatusLevel);
}

/** Worst of the given levels. Empty input is `operational` (nothing to report). */
export function worstStatus(levels: readonly ServiceStatusLevel[]): ServiceStatusLevel {
  let worst: ServiceStatusLevel = "operational";
  for (const level of levels) {
    if (statusRank(level) > statusRank(worst)) worst = level;
  }
  return worst;
}

export interface EffectiveStatusInput {
  baseline: NormalizedBaseline;
  components: readonly { status: ServiceStatusLevel; selected: boolean }[];
  activeIncidents: readonly { impact: ServiceStatusLevel }[];
}

/**
 * The one aggregation rule in the subsystem.
 *
 * Effective status is the worst of three *independently stored* inputs, so it
 * stays reconstructible after any incident is filtered out: dropping a stale
 * resolved incident removes exactly that incident's contribution and cannot
 * clear a genuine page-level or component-level outage, while a page-only
 * outage still shows even when every component reads operational.
 *
 * Only components in the configured relevant selection participate. Group
 * aggregation already happened in the adapter, so counting a group and its
 * children both is harmless (a maximum is idempotent).
 */
export function computeEffectiveStatus(input: EffectiveStatusInput): ServiceStatusLevel {
  const levels: ServiceStatusLevel[] = [input.baseline.status];
  for (const component of input.components) {
    if (component.selected) levels.push(component.status);
  }
  for (const incident of input.activeIncidents) {
    levels.push(incident.impact);
  }
  return worstStatus(levels);
}

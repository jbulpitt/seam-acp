import { createHash } from "node:crypto";
import {
  COMPONENT_REMOVED,
  type NewServiceStatusEvent,
  type NormalizedIncidentUpdate,
  type ServiceObservationHealth,
  type ServiceStatusIncident,
  type ServiceStatusSnapshot,
} from "./types.js";

/**
 * Material transition detection.
 *
 * The store records an event only where a *value changed*, so an unchanged poll
 * — the overwhelmingly common case — writes nothing at all and the history does
 * not grow. Everything in this module is a pure function of (previous
 * snapshot, next snapshot); there is no time-based or counter-based emission,
 * which is what makes "identical polls do not grow event history" provable
 * rather than merely likely.
 *
 * "Changed" is judged against a *canonical* form. Whitespace inside an advisory
 * is collapsed and update order is ignored, so a provider reflowing its own
 * prose, or emitting the same updates in a different order, is correctly seen
 * as no change at all. Anything that survives canonicalization — a new
 * advisory, a lifecycle step, a severity move — is a real transition and is
 * recorded even when the incident's impact is unchanged.
 *
 * The kinds are deliberately distinct rather than folded into one "status
 * changed" event, because they answer different questions:
 *
 *   - `source`            — the aggregate effective status moved.
 *   - `baseline`          — the provider's own page-level verdict moved.
 *   - `component_added`   — a component entered the provider's inventory.
 *   - `component`         — a known component's status moved.
 *   - `component_removed` — a component left the provider's inventory.
 *   - `incident`          — an incident appeared or materially progressed.
 *   - `fetch_health`      — Seam's ability to observe the source moved. This is
 *                           the independent axis and never masquerades as
 *                           provider health.
 */

export function diffSnapshots(
  previous: ServiceStatusSnapshot | null,
  next: ServiceStatusSnapshot,
  occurredAt: string
): NewServiceStatusEvent[] {
  const events: NewServiceStatusEvent[] = [];
  const base = { sourceId: next.sourceId, occurredAt };

  if (previous === null || previous.effectiveStatus !== next.effectiveStatus) {
    events.push({
      ...base,
      kind: "source",
      subjectId: null,
      subjectName: next.label,
      previous: previous?.effectiveStatus ?? null,
      current: next.effectiveStatus,
      detail: null,
    });
  }

  if (previous === null || previous.baseline.status !== next.baseline.status) {
    events.push({
      ...base,
      kind: "baseline",
      subjectId: null,
      subjectName: next.label,
      previous: previous?.baseline.status ?? null,
      current: next.baseline.status,
      detail: next.baseline.derived ? "derived by adapter" : next.baseline.description,
    });
  }

  events.push(...diffComponents(previous, next, base));
  events.push(...diffIncidents(previous, next, base));

  const previousHealth: ServiceObservationHealth | null = previous?.observation.health ?? null;
  if (previousHealth !== next.observation.health) {
    events.push({
      ...base,
      kind: "fetch_health",
      subjectId: null,
      subjectName: next.label,
      previous: previousHealth,
      current: next.observation.health,
      detail: next.observation.lastError,
    });
  }

  return events;
}

type EventBase = { sourceId: string; occurredAt: string };

/**
 * Additions, status changes and removals, in that order and each in the stored
 * component order, so the same pair of snapshots always produces the same event
 * sequence.
 */
function diffComponents(
  previous: ServiceStatusSnapshot | null,
  next: ServiceStatusSnapshot,
  base: EventBase
): NewServiceStatusEvent[] {
  const before = new Map((previous?.components ?? []).map((component) => [component.id, component]));
  const after = new Map(next.components.map((component) => [component.id, component]));

  const added: NewServiceStatusEvent[] = [];
  const changed: NewServiceStatusEvent[] = [];
  for (const component of next.components) {
    const prior = before.get(component.id);
    if (!prior) {
      // Material even when operational: the inventory itself changed.
      added.push({
        ...base,
        kind: "component_added",
        subjectId: component.id,
        subjectName: component.name,
        previous: null,
        current: component.status,
        detail: component.selected ? null : "not in the relevant component selection",
      });
      continue;
    }
    if (prior.status === component.status) continue;
    changed.push({
      ...base,
      kind: "component",
      subjectId: component.id,
      subjectName: component.name,
      previous: prior.status,
      current: component.status,
      detail: component.selected ? null : "not in the relevant component selection",
    });
  }

  const removed: NewServiceStatusEvent[] = [];
  for (const component of previous?.components ?? []) {
    if (after.has(component.id)) continue;
    removed.push({
      ...base,
      kind: "component_removed",
      subjectId: component.id,
      subjectName: component.name,
      previous: component.status,
      current: COMPONENT_REMOVED,
      detail: null,
    });
  }

  return [...added, ...changed, ...removed];
}

function diffIncidents(
  previous: ServiceStatusSnapshot | null,
  next: ServiceStatusSnapshot,
  base: EventBase
): NewServiceStatusEvent[] {
  const before = new Map((previous?.incidents ?? []).map((incident) => [incident.externalId, incident]));
  const events: NewServiceStatusEvent[] = [];

  // Only incidents present now are compared. An incident that disappears has
  // aged out of the retention window, which is a housekeeping detail rather
  // than a provider transition — unlike a component, which the provider itself
  // removed from its inventory. A genuine recurrence after expiry reappears
  // with no prior row and is recorded as first observed.
  for (const incident of next.incidents) {
    const prior = before.get(incident.externalId);
    const current = incidentSignature(incident);
    const priorSignature = prior ? incidentSignature(prior) : null;
    if (priorSignature === current) continue;
    events.push({
      ...base,
      kind: "incident",
      subjectId: incident.externalId,
      subjectName: incident.title,
      previous: priorSignature,
      current,
      detail: describeIncidentChange(prior, incident),
    });
  }

  return events;
}

/**
 * A canonical, comparable summary of everything about an incident that makes a
 * change material: its stage, its severity, the provider's lifecycle word, the
 * set of components it is scoped to, and the set of advisories attached to it.
 *
 * The readable fields come first so the stored value is still legible; the
 * trailing digests are what make a replaced advisory, or a change in which
 * components an incident covers, detectable when the counts alone would not
 * move.
 */
export function incidentSignature(incident: {
  stage: string;
  impact: string;
  lifecycle: string;
  componentIds: readonly string[];
  updates: readonly NormalizedIncidentUpdate[];
}): string {
  return [
    incident.stage,
    incident.impact,
    canonicalText(incident.lifecycle),
    `c${String(new Set(incident.componentIds).size)}-${componentsDigest(incident.componentIds)}`,
    `u${String(incident.updates.length)}-${updatesDigest(incident.updates)}`,
  ].join("/");
}

/**
 * Order-insensitive digest of the advisory set.
 *
 * `order` is excluded because it is positional: two polls that deliver the same
 * advisories in a different order describe the same incident. Bodies are
 * whitespace-canonicalized so a provider reflowing its own text is not mistaken
 * for a new advisory.
 */
function updatesDigest(updates: readonly NormalizedIncidentUpdate[]): string {
  if (updates.length === 0) return "empty";
  const canonical = updates
    .map((update) => [
      update.id,
      update.createdAt,
      canonicalText(update.lifecycle),
      canonicalText(update.body),
    ])
    .map((fields) => JSON.stringify(fields))
    .sort();
  return digest(canonical);
}

/**
 * Order-insensitive digest of the component scope. Which components an incident
 * covers is material — an outage widening from one component to three is a real
 * escalation — but the order the provider happens to list them in is not.
 */
function componentsDigest(componentIds: readonly string[]): string {
  if (componentIds.length === 0) return "empty";
  return digest([...new Set(componentIds)].sort());
}

/**
 * Hash a list of already-canonical strings.
 *
 * The list is JSON-encoded rather than joined on a separator: any separator
 * byte an upstream can also emit inside a value would let two different lists
 * hash alike, and there is no byte an upstream provably cannot emit.
 */
function digest(values: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 12);
}

function canonicalText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** A short, human-readable account of what actually moved. */
function describeIncidentChange(
  prior: ServiceStatusIncident | undefined,
  next: ServiceStatusIncident
): string {
  if (!prior) return "first observed";
  const parts: string[] = [];
  if (prior.stage !== next.stage) parts.push(`stage ${prior.stage} → ${next.stage}`);
  if (prior.impact !== next.impact) parts.push(`impact ${prior.impact} → ${next.impact}`);
  if (canonicalText(prior.lifecycle) !== canonicalText(next.lifecycle)) {
    parts.push(`lifecycle ${prior.lifecycle} → ${next.lifecycle}`);
  }
  const priorComponents = new Set(prior.componentIds).size;
  const nextComponents = new Set(next.componentIds).size;
  if (
    priorComponents !== nextComponents ||
    componentsDigest(prior.componentIds) !== componentsDigest(next.componentIds)
  ) {
    parts.push(`components ${String(priorComponents)} → ${String(nextComponents)}`);
  }

  const added = next.updates.length - prior.updates.length;
  if (added > 0) parts.push(`${String(added)} new update${added === 1 ? "" : "s"}`);
  else if (added < 0) parts.push(`${String(-added)} update${added === -1 ? "" : "s"} withdrawn`);
  else if (updatesDigest(prior.updates) !== updatesDigest(next.updates)) parts.push("updates revised");
  return parts.length > 0 ? parts.join(", ") : "changed";
}

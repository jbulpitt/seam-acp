import { failSchema } from "./http.js";
import { isServiceStatusLevel } from "./severity.js";
import {
  INCIDENT_STAGES,
  type NormalizedIncident,
  type ServiceStatusAdapterResult,
} from "./types.js";

export function requireRecord(
  label: string,
  value: unknown,
  what: string
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failSchema(label, `${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

export function requireArray(label: string, value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) failSchema(label, `${what} is not an array`);
  return value;
}

export function requireString(label: string, value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    failSchema(label, `${what} is not a non-empty string`);
  }
  return value;
}

export function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function requireNumber(label: string, value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    failSchema(label, `${what} is not a finite number`);
  }
  return value;
}

/**
 * Normalize any accepted timestamp shape to a canonical `toISOString()` value.
 * Canonical form matters: retention pruning and the exact 90-day boundary use
 * lexicographic comparison on these strings.
 */
export function requireTimestamp(label: string, value: unknown, what: string): string {
  const raw = typeof value === "string" ? value : value instanceof Date ? value.toISOString() : null;
  if (raw === null) failSchema(label, `${what} is not a timestamp`);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) failSchema(label, `${what} is not a parseable timestamp`);
  return parsed.toISOString();
}

export function optionalTimestamp(label: string, value: unknown, what: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  return requireTimestamp(label, value, what);
}

/**
 * The store boundary's timestamp invariant: an already-normalized value must be
 * in exact `Date#toISOString()` form.
 *
 * Every ordering, retention cutoff and monotonicity check in the store compares
 * these strings lexicographically, which is equivalent to comparing instants
 * *only* in canonical form. `2026-09-03T13:00:00+02:00` denotes 11:00Z but
 * sorts after `2026-09-03T12:00:00.000Z`, so an older record would win and a
 * live outage could be overwritten with a green one.
 *
 * Normalizing here instead of rejecting would mean deep-copying every result,
 * and the built-in adapters already emit canonical strings — they route every
 * provider value through {@link requireTimestamp}. So a non-canonical value
 * means an adapter is not normalizing, which is a defect to surface rather than
 * paper over.
 */
export function requireCanonicalTimestamp(label: string, value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    failSchema(label, `${what} is not a timestamp string`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) failSchema(label, `${what} is not a parseable timestamp`);
  const canonical = parsed.toISOString();
  if (value !== canonical) {
    failSchema(
      label,
      `${what} is not canonical: expected ${canonical}, received ${JSON.stringify(value)}`
    );
  }
  return canonical;
}

export function optionalCanonicalTimestamp(
  label: string,
  value: unknown,
  what: string
): string | null {
  if (value === null || value === undefined) return null;
  return requireCanonicalTimestamp(label, value, what);
}

/**
 * The store's pre-mutation gate. A refresh either passes this whole check and
 * commits, or throws before a single row is touched — there is no partially
 * valid write.
 */
export function validateAdapterResult(result: ServiceStatusAdapterResult): void {
  const label = `adapter result for ${String(result?.sourceId ?? "<unknown source>")}`;
  requireRecord(label, result, "result");
  requireString(label, result.sourceId, "sourceId");
  requireCanonicalTimestamp(label, result.fetchedAt, "fetchedAt");

  const baseline = requireRecord(label, result.baseline, "baseline");
  if (!isServiceStatusLevel(baseline.status)) {
    failSchema(label, `baseline.status ${JSON.stringify(baseline.status)} is not a known level`);
  }
  if (typeof baseline.derived !== "boolean") failSchema(label, "baseline.derived is not a boolean");

  requireArray(label, result.notes, "notes");
  for (const note of result.notes) requireString(label, note, "note");

  const componentIds = new Set<string>();
  for (const component of requireArray(label, result.components, "components")) {
    const record = requireRecord(label, component, "component");
    const id = requireString(label, record.id, "component.id");
    if (componentIds.has(id)) failSchema(label, `duplicate component id ${JSON.stringify(id)}`);
    componentIds.add(id);
    requireString(label, record.name, "component.name");
    if (!isServiceStatusLevel(record.status)) {
      failSchema(label, `component ${JSON.stringify(id)} has unknown status`);
    }
    if (typeof record.isGroup !== "boolean") failSchema(label, "component.isGroup is not a boolean");
    if (typeof record.selected !== "boolean") {
      failSchema(label, "component.selected is not a boolean");
    }
    if (record.groupId !== null && typeof record.groupId !== "string") {
      failSchema(label, "component.groupId is not a string or null");
    }
    optionalCanonicalTimestamp(label, record.updatedAt, "component.updatedAt");
  }

  const incidentIds = new Set<string>();
  for (const incident of requireArray(label, result.incidents, "incidents")) {
    validateIncident(label, incident, incidentIds);
  }
}

function validateIncident(label: string, value: unknown, seen: Set<string>): void {
  const record = requireRecord(label, value, "incident");
  const externalId = requireString(label, record.externalId, "incident.externalId");
  if (seen.has(externalId)) {
    failSchema(label, `duplicate incident externalId ${JSON.stringify(externalId)}`);
  }
  seen.add(externalId);

  requireString(label, record.title, "incident.title");
  requireString(label, record.lifecycle, "incident.lifecycle");
  const stage = record.stage;
  if (typeof stage !== "string" || !(INCIDENT_STAGES as readonly string[]).includes(stage)) {
    failSchema(label, `incident ${JSON.stringify(externalId)} has unknown stage`);
  }
  if (!isServiceStatusLevel(record.impact)) {
    failSchema(label, `incident ${JSON.stringify(externalId)} has unknown impact`);
  }
  if (record.url !== null && typeof record.url !== "string") {
    failSchema(label, `incident ${JSON.stringify(externalId)} url is not a string or null`);
  }

  requireCanonicalTimestamp(label, record.startedAt, "incident.startedAt");
  requireCanonicalTimestamp(label, record.updatedAt, "incident.updatedAt");
  const resolvedAt = optionalCanonicalTimestamp(label, record.resolvedAt, "incident.resolvedAt");
  if (stage === "active" && resolvedAt !== null) {
    failSchema(label, `incident ${JSON.stringify(externalId)} is active but carries a resolvedAt`);
  }

  // The component scope participates in the incident's change signature, so a
  // duplicated id would make an unchanged scope look different depending on how
  // the provider happened to repeat itself.
  const componentIds = new Set<string>();
  for (const componentId of requireArray(label, record.componentIds, "incident.componentIds")) {
    const id = requireString(label, componentId, "incident.componentIds entry");
    if (componentIds.has(id)) {
      failSchema(
        label,
        `incident ${JSON.stringify(externalId)} lists component ${JSON.stringify(id)} twice`
      );
    }
    componentIds.add(id);
  }

  const updateIds = new Set<string>();
  const updates = requireArray(label, record.updates, "incident.updates");
  let previousOrder = -1;
  for (const update of updates) {
    const updateRecord = requireRecord(label, update, "incident update");
    const id = requireString(label, updateRecord.id, "update.id");
    if (updateIds.has(id)) {
      failSchema(
        label,
        `incident ${JSON.stringify(externalId)} has duplicate update id ${JSON.stringify(id)}`
      );
    }
    updateIds.add(id);
    requireString(label, updateRecord.lifecycle, "update.lifecycle");
    if (typeof updateRecord.body !== "string") failSchema(label, "update.body is not a string");
    requireCanonicalTimestamp(label, updateRecord.createdAt, "update.createdAt");
    const order = requireNumber(label, updateRecord.order, "update.order");
    if (!Number.isInteger(order) || order <= previousOrder) {
      failSchema(
        label,
        `incident ${JSON.stringify(externalId)} updates are not in ascending order`
      );
    }
    previousOrder = order;
  }
}

/** The retention timestamp an incident is pruned against. */
export function retentionTimestamp(incident: NormalizedIncident): string {
  return incident.resolvedAt ?? incident.updatedAt ?? incident.startedAt;
}

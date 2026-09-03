import {
  fetchBoundedText,
  failSchema,
  parseJson,
  type BoundedFetchOptions,
} from "../http.js";
import { worstStatus } from "../severity.js";
import { maxTimestamp, orderUpdates } from "./shared.js";
import {
  optionalString,
  optionalTimestamp,
  requireArray,
  requireRecord,
  requireString,
  requireTimestamp,
} from "../validate.js";
import type {
  IncidentStage,
  NormalizedComponent,
  NormalizedIncident,
  NormalizedIncidentUpdate,
  ServiceStatusAdapterContext,
  ServiceStatusAdapterResult,
  ServiceStatusLevel,
} from "../types.js";

/**
 * Atlassian Statuspage adapter (GitHub, Anthropic, OpenAI).
 *
 * Two feeds are read per source and reconciled here, not in the store:
 *
 *   - `summary.json` carries the page indicator, the component list, and
 *     (usually) the currently unresolved incidents. OpenAI's page omits the
 *     `incidents` key entirely, so its absence is normal, not drift.
 *   - `incidents.json` carries incident history including recent resolutions.
 *
 * The two feeds are only merged after their `page.id` values match, and the
 * winner for a duplicated incident id is chosen by lifecycle and timestamp, so
 * a newer resolved history record always beats an older active summary copy no
 * matter which feed happened to be read first.
 */

const PAGE_INDICATORS: Readonly<Record<string, ServiceStatusLevel>> = {
  none: "operational",
  maintenance: "maintenance",
  minor: "degraded",
  major: "partial_outage",
  critical: "major_outage",
};

const COMPONENT_STATUSES: Readonly<Record<string, ServiceStatusLevel>> = {
  operational: "operational",
  under_maintenance: "maintenance",
  degraded_performance: "degraded",
  partial_outage: "partial_outage",
  major_outage: "major_outage",
};

const INCIDENT_IMPACTS: Readonly<Record<string, ServiceStatusLevel>> = {
  none: "operational",
  maintenance: "maintenance",
  minor: "degraded",
  major: "partial_outage",
  critical: "major_outage",
};

/** Statuspage incident and scheduled-maintenance lifecycles. */
const INCIDENT_LIFECYCLES: Readonly<Record<string, IncidentStage>> = {
  investigating: "active",
  identified: "active",
  monitoring: "active",
  resolved: "resolved",
  postmortem: "resolved",
  scheduled: "active",
  in_progress: "active",
  verifying: "active",
  completed: "resolved",
};

/**
 * Work bound, set well above what the live feeds return (fifty entries at
 * recording time). An over-length feed is rejected rather than truncated: a
 * silently dropped prefix could hide an active incident and still report
 * success. Resolved-history volume is bounded by the store's retention window,
 * not here.
 */
const MAX_FEED_INCIDENTS = 500;

export interface StatuspageSourceConfig {
  sourceId: string;
  label: string;
  summaryUrl: string;
  incidentsUrl: string;
  /**
   * Stable Statuspage component ids for the components Seam depends on.
   *
   * Ids, never names: Statuspage lets a page rename a component in place, and a
   * selection matched on the display string would silently stop covering the
   * component it was configured for — producing a green source while the thing
   * it watches is down. Every configured id must be present in the payload or
   * the refresh fails closed.
   *
   * An empty array means every component participates. It never means "none".
   */
  selectedComponentIds: readonly string[];
}

export interface StatuspageFeeds {
  summary: string;
  /** `null` when the history feed could not be read; the summary still stands. */
  incidents: string | null;
}

export function normalizeStatuspage(
  config: StatuspageSourceConfig,
  feeds: StatuspageFeeds,
  fetchedAt: Date
): ServiceStatusAdapterResult {
  const label = `${config.label} statuspage`;
  const notes: string[] = [];

  const summary = requireRecord(label, parseJson(label, feeds.summary), "summary");
  const summaryPage = requireRecord(label, summary.page, "summary.page");
  const pageId = requireString(label, summaryPage.id, "summary.page.id");

  const status = requireRecord(label, summary.status, "summary.status");
  const indicator = requireString(label, status.indicator, "summary.status.indicator");
  const baselineStatus = PAGE_INDICATORS[indicator];
  if (!baselineStatus) {
    failSchema(label, `unknown page indicator ${JSON.stringify(indicator)}`);
  }

  const components = normalizeComponents(
    label,
    requireArray(label, summary.components, "summary.components"),
    config.selectedComponentIds
  );

  const fromSummary = summary.incidents === undefined
    ? (notes.push("summary omitted `incidents`; history feed is the only incident source"), [])
    : parseIncidents(label, requireArray(label, summary.incidents, "summary.incidents"), "summary");

  let fromHistory: NormalizedIncident[] = [];
  if (feeds.incidents === null) {
    notes.push("incident history feed unavailable; summary incidents only");
  } else {
    const history = requireRecord(label, parseJson(label, feeds.incidents), "incidents feed");
    const historyPage = requireRecord(label, history.page, "incidents.page");
    const historyPageId = requireString(label, historyPage.id, "incidents.page.id");
    if (historyPageId !== pageId) {
      // Crossed feeds would silently attribute another page's incidents to this
      // source. There is no safe partial merge, so the whole refresh fails.
      failSchema(
        label,
        `page id mismatch between summary (${pageId}) and incident history (${historyPageId})`
      );
    }
    fromHistory = parseIncidents(
      label,
      requireArray(label, history.incidents, "incidents"),
      "incident history"
    );
  }

  const incidents = mergeIncidents(fromSummary, fromHistory);

  return {
    sourceId: config.sourceId,
    fetchedAt: fetchedAt.toISOString(),
    baseline: {
      status: baselineStatus,
      description: optionalString(status.description),
      derived: false,
    },
    components,
    incidents,
    notes,
  };
}

function normalizeComponents(
  label: string,
  raw: unknown[],
  selectedComponentIds: readonly string[]
): NormalizedComponent[] {
  const selection = new Set(selectedComponentIds);
  const selectAll = selection.size === 0;

  interface Parsed {
    id: string;
    name: string;
    reported: ServiceStatusLevel;
    description: string | null;
    groupId: string | null;
    isGroup: boolean;
    position: number;
    updatedAt: string | null;
  }

  const parsed: Parsed[] = [];
  for (const entry of raw) {
    const record = requireRecord(label, entry, "component");
    const id = requireString(label, record.id, "component.id");
    const name = requireString(label, record.name, "component.name");
    const statusValue = requireString(label, record.status, "component.status");
    const reported = COMPONENT_STATUSES[statusValue];
    if (!reported) {
      failSchema(label, `component ${JSON.stringify(name)} has unknown status ${JSON.stringify(statusValue)}`);
    }
    parsed.push({
      id,
      name,
      reported,
      description: optionalString(record.description),
      groupId: typeof record.group_id === "string" ? record.group_id : null,
      isGroup: record.group === true,
      position: typeof record.position === "number" ? record.position : Number.MAX_SAFE_INTEGER,
      updatedAt: optionalTimestamp(label, record.updated_at, "component.updated_at"),
    });
  }

  const childrenByGroup = new Map<string, Parsed[]>();
  for (const component of parsed) {
    if (!component.groupId) continue;
    const bucket = childrenByGroup.get(component.groupId);
    if (bucket) bucket.push(component);
    else childrenByGroup.set(component.groupId, [component]);
  }

  // Every configured id must exist on the page. If one has vanished we can no
  // longer prove what we are watching, so the refresh fails and the previous
  // last-known-good snapshot stands. Silently selecting fewer components — or
  // none at all — would publish a green source over an unwatched outage.
  const present = new Set(parsed.map((component) => component.id));
  for (const id of selection) {
    if (!present.has(id)) {
      failSchema(
        label,
        `configured component id ${JSON.stringify(id)} is absent from the page`
      );
    }
  }

  // Selection pass 1: ids configured by the operator. Selecting a group also
  // selects its children, so a group-level configuration is not silently empty.
  const selected = new Set<string>();
  for (const component of parsed) {
    if (selectAll || selection.has(component.id)) selected.add(component.id);
  }
  for (const component of parsed) {
    if (!component.isGroup || !selected.has(component.id)) continue;
    for (const child of childrenByGroup.get(component.id) ?? []) selected.add(child.id);
  }
  // Selection pass 2: a group whose child is selected must participate too, or
  // an aggregated group outage would drop out of the effective status.
  for (const component of parsed) {
    if (!component.isGroup) continue;
    const children = childrenByGroup.get(component.id) ?? [];
    if (children.some((child) => selected.has(child.id))) selected.add(component.id);
  }

  const ordered = [...parsed].sort(
    (a, b) => a.position - b.position || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  );

  return ordered.map((component) => ({
    id: component.id,
    name: component.name,
    // A group's reported status can lag its children, so aggregate explicitly.
    status: component.isGroup
      ? worstStatus([
          component.reported,
          ...(childrenByGroup.get(component.id) ?? []).map((child) => child.reported),
        ])
      : component.reported,
    description: component.description,
    groupId: component.groupId,
    isGroup: component.isGroup,
    selected: selected.has(component.id),
    updatedAt: component.updatedAt,
  }));
}

function parseIncidents(label: string, raw: unknown[], what: string): NormalizedIncident[] {
  if (raw.length > MAX_FEED_INCIDENTS) {
    failSchema(
      label,
      `${what} returned ${String(raw.length)} incidents, above the ${String(MAX_FEED_INCIDENTS)} cap`
    );
  }
  return raw.map((entry) => parseIncident(label, entry));
}

function parseIncident(label: string, entry: unknown): NormalizedIncident {
  const record = requireRecord(label, entry, "incident");
  const externalId = requireString(label, record.id, "incident.id");
  const lifecycle = requireString(label, record.status, "incident.status");
  const stage = INCIDENT_LIFECYCLES[lifecycle];
  if (!stage) {
    failSchema(label, `incident ${externalId} has unknown lifecycle ${JSON.stringify(lifecycle)}`);
  }

  const impactValue = requireString(label, record.impact, "incident.impact");
  const impact = INCIDENT_IMPACTS[impactValue];
  if (!impact) {
    failSchema(label, `incident ${externalId} has unknown impact ${JSON.stringify(impactValue)}`);
  }

  const createdAt = requireTimestamp(label, record.created_at, "incident.created_at");
  const startedAt = optionalTimestamp(label, record.started_at, "incident.started_at") ?? createdAt;
  const resolvedAt =
    stage === "resolved"
      ? optionalTimestamp(label, record.resolved_at, "incident.resolved_at")
      : null;

  const componentIds = new Set<string>();
  if (record.components !== undefined && record.components !== null) {
    for (const component of requireArray(label, record.components, "incident.components")) {
      const componentRecord = requireRecord(label, component, "incident component");
      componentIds.add(requireString(label, componentRecord.id, "incident component id"));
    }
  }

  const updates = parseUpdates(label, externalId, record.incident_updates, componentIds);
  const latestUpdateAt = updates.length > 0 ? updates[updates.length - 1]!.createdAt : null;
  const recordUpdatedAt = optionalTimestamp(label, record.updated_at, "incident.updated_at");
  const updatedAt = maxTimestamp([latestUpdateAt, recordUpdatedAt, createdAt]) ?? createdAt;

  return {
    externalId,
    title: requireString(label, record.name, "incident.name"),
    stage,
    lifecycle,
    impact,
    url: optionalString(record.shortlink),
    startedAt,
    updatedAt,
    resolvedAt,
    componentIds: [...componentIds].sort(),
    updates,
  };
}

function parseUpdates(
  label: string,
  incidentId: string,
  raw: unknown,
  componentIds: Set<string>
): NormalizedIncidentUpdate[] {
  if (raw === undefined || raw === null) return [];
  const entries = requireArray(label, raw, "incident.incident_updates");

  const parsed = entries.map((entry) => {
    const record = requireRecord(label, entry, "incident update");
    const id = requireString(label, record.id, "incident update id");
    const createdAt = requireTimestamp(label, record.created_at, "incident update created_at");
    const displayAt = optionalTimestamp(label, record.display_at, "incident update display_at");
    if (record.affected_components !== undefined && record.affected_components !== null) {
      for (const affected of requireArray(
        label,
        record.affected_components,
        "incident update affected_components"
      )) {
        const affectedRecord = requireRecord(label, affected, "affected component");
        const code = optionalString(affectedRecord.code);
        if (code) componentIds.add(code);
      }
    }
    return {
      id,
      lifecycle: requireString(label, record.status, "incident update status"),
      body: typeof record.body === "string" ? record.body : "",
      // `display_at` is the provider's own chosen timestamp for the update and
      // wins when present; `created_at` is the fallback.
      createdAt: displayAt ?? createdAt,
    };
  });

  return orderUpdates(parsed, `${label} incident ${incidentId}`);
}

/**
 * Pick the authoritative copy of each incident id across the two feeds.
 *
 * Ordering rule, applied in sequence: later `updatedAt` wins; then a resolved
 * record beats an active one; then the record with more updates wins; then the
 * history feed wins. Fetch order never participates.
 */
export function mergeIncidents(
  fromSummary: readonly NormalizedIncident[],
  fromHistory: readonly NormalizedIncident[]
): NormalizedIncident[] {
  const winners = new Map<string, { incident: NormalizedIncident; historyRank: number }>();
  const consider = (incident: NormalizedIncident, historyRank: number): void => {
    const existing = winners.get(incident.externalId);
    if (!existing || beats({ incident, historyRank }, existing)) {
      winners.set(incident.externalId, { incident, historyRank });
    }
  };
  for (const incident of fromSummary) consider(incident, 0);
  for (const incident of fromHistory) consider(incident, 1);

  // Every incident from both feeds is returned — nothing is dropped here. The
  // store's retention window is what bounds how much resolved history persists.
  return [...winners.values()]
    .map((entry) => entry.incident)
    .sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.externalId.localeCompare(b.externalId)
    );
}

function beats(
  candidate: { incident: NormalizedIncident; historyRank: number },
  incumbent: { incident: NormalizedIncident; historyRank: number }
): boolean {
  if (candidate.incident.updatedAt !== incumbent.incident.updatedAt) {
    return candidate.incident.updatedAt > incumbent.incident.updatedAt;
  }
  if (candidate.incident.stage !== incumbent.incident.stage) {
    return candidate.incident.stage === "resolved";
  }
  if (candidate.incident.updates.length !== incumbent.incident.updates.length) {
    return candidate.incident.updates.length > incumbent.incident.updates.length;
  }
  return candidate.historyRank > incumbent.historyRank;
}

export function createStatuspageAdapter(
  config: StatuspageSourceConfig
): (context: ServiceStatusAdapterContext) => Promise<ServiceStatusAdapterResult> {
  return async (context) => {
    const shared: Pick<BoundedFetchOptions, "expectContentType" | "fetchImpl" | "signal"> = {
      expectContentType: /application\/json/i,
      fetchImpl: context.fetchImpl,
      signal: context.signal,
    };
    const summary = await fetchBoundedText({
      ...shared,
      label: `${config.label} summary`,
      url: config.summaryUrl,
    });
    const incidents = await fetchBoundedText({
      ...shared,
      label: `${config.label} incident history`,
      url: config.incidentsUrl,
    });
    return normalizeStatuspage(
      config,
      { summary: summary.text, incidents: incidents.text },
      context.now()
    );
  };
}

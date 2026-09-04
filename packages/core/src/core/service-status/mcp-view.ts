import { aggregateOutcome, type ServiceStatusRefreshManager } from "./manager.js";
import { resolveQueryLimit, type ServiceStatusStore } from "./store.js";
import { statusRank } from "./severity.js";
import type {
  ServiceObservationHealth,
  ServiceSourceProvenance,
  ServiceStatusLevel,
  ServiceStatusSnapshot,
  ServiceStatusSourceDefinition,
} from "./types.js";

/**
 * The read/refresh projection behind the seam-MCP service-status tools (#184).
 *
 * It sits between the store/manager and the MCP server so that argument
 * validation and response shaping are testable without an HTTP round trip, and
 * so the tool layer holds no knowledge of the storage model.
 *
 * Two properties are deliberate and load-bearing:
 *
 *   - **No caller-supplied network surface.** Sources are resolved only against
 *     the static registry the process was constructed with. There is no way to
 *     pass a URL, a header, or a credential through these options, so a
 *     compromised or confused agent cannot turn the bot into a request proxy.
 *   - **Two axes stay separate.** `reportedStatus` is what the provider said;
 *     `observation` is how Seam's own fetching is going. A cached read of a
 *     source whose polling has been failing for an hour reports the provider's
 *     last-known-good status *and* `observationHealth: "fetch_error"`, so an
 *     agent can tell "the provider says it is down" from "we cannot currently
 *     tell".
 */

/** Per-field limits. Every list the tools return is bounded by one of these. */
export const SERVICE_STATUS_VIEW_LIMITS = {
  components: { fallback: 10, max: 50 },
  incidents: { fallback: 5, max: 25 },
  updates: { fallback: 3, max: 20 },
  history: { fallback: 10, max: 50 },
} as const;

export interface ServiceStatusReadOptions {
  /** Registered source ids. Omit for every registered source. */
  sourceIds?: readonly string[];
  includeComponents?: boolean;
  /** Include components outside the configured relevant selection. */
  includeAllComponents?: boolean;
  /** Active incidents. Defaults to true. */
  includeIncidents?: boolean;
  /** Also include recently resolved incidents still inside retention. */
  includeResolvedIncidents?: boolean;
  /** Recent material transitions for the source. Defaults to false. */
  includeHistory?: boolean;
  componentLimit?: number;
  incidentLimit?: number;
  /** Advisory updates returned per incident. */
  updateLimit?: number;
  historyLimit?: number;
}

export interface ServiceStatusComponentView {
  id: string;
  name: string;
  status: ServiceStatusLevel;
  selected: boolean;
  isGroup: boolean;
  updatedAt: string | null;
}

export interface ServiceStatusIncidentUpdateView {
  lifecycle: string;
  body: string;
  createdAt: string;
}

export interface ServiceStatusIncidentView {
  externalId: string;
  title: string;
  stage: string;
  lifecycle: string;
  impact: ServiceStatusLevel;
  url: string | null;
  startedAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolutionSource: string;
  componentIds: string[];
  updateCount: number;
  updates: ServiceStatusIncidentUpdateView[];
}

export interface ServiceStatusHistoryView {
  kind: string;
  subject: string | null;
  previous: string | null;
  current: string;
  detail: string | null;
  occurredAt: string;
}

export interface ServiceStatusObservationView {
  /** Seam's own fetch health — never the provider's verdict. */
  health: ServiceObservationHealth;
  /** True only when `health` is `ok`: the provider data below is current. */
  providerStatusIsCurrent: boolean;
  /** False when nothing has ever been fetched, so `reportedStatus` is a placeholder. */
  hasProviderData: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  lastDurationMs: number | null;
}

export interface ServiceStatusSourceView {
  sourceId: string;
  label: string;
  provenance: ServiceSourceProvenance;
  url: string;
  scopeNote: string;
  /** Provider-reported effective status: worst of page, components, incidents. */
  reportedStatus: ServiceStatusLevel;
  baseline: { status: ServiceStatusLevel; description: string | null; derived: boolean };
  /** When the provider payload behind `reportedStatus` was fetched. */
  fetchedAt: string | null;
  observation: ServiceStatusObservationView;
  activeIncidentCount: number;
  componentTotal: number;
  unhealthyComponentCount: number;
  notes: string[];
  components?: ServiceStatusComponentView[];
  componentsTruncated?: boolean;
  incidents?: ServiceStatusIncidentView[];
  incidentsTruncated?: boolean;
  history?: ServiceStatusHistoryView[];
}

export interface ServiceStatusReadResult {
  generatedAt: string;
  /** True when no network work was performed — always true for a cached read. */
  cached: true;
  sources: ServiceStatusSourceView[];
}

export interface ServiceStatusRefreshOptions {
  sourceIds?: readonly string[];
}

export interface ServiceStatusRefreshSourceView {
  sourceId: string;
  label: string;
  /** executed | coalesced | rate_limited | cancelled. */
  disposition: string;
  /** True only when this call itself caused an upstream fetch. */
  attempted: boolean;
  /** Null when the call produced no flight outcome (rate limited or cancelled). */
  succeeded: boolean | null;
  durationMs: number | null;
  error: string | null;
  reason: string | null;
  reportedStatus: ServiceStatusLevel | null;
  fetchedAt: string | null;
  observation: ServiceStatusObservationView | null;
  activeIncidentCount: number | null;
}

export interface ServiceStatusRefreshResult {
  startedAt: string;
  durationMs: number;
  /** succeeded | failed | mixed | skipped, over the sources that produced an outcome. */
  outcome: string;
  sources: ServiceStatusRefreshSourceView[];
}

export interface ServiceStatusMcpViewOptions {
  store: ServiceStatusStore;
  manager: ServiceStatusRefreshManager;
  sources: readonly ServiceStatusSourceDefinition[];
  now?: () => Date;
}

export class ServiceStatusMcpView {
  private readonly store: ServiceStatusStore;
  private readonly manager: ServiceStatusRefreshManager;
  private readonly definitions: Map<string, ServiceStatusSourceDefinition>;
  private readonly now: () => Date;

  constructor(options: ServiceStatusMcpViewOptions) {
    this.store = options.store;
    this.manager = options.manager;
    this.definitions = new Map(options.sources.map((source) => [source.id, source]));
    this.now = options.now ?? (() => new Date());
  }

  /** Every registered source id, for validation errors and tool help. */
  registeredSourceIds(): string[] {
    return [...this.definitions.keys()].sort();
  }

  /**
   * Cache-only read. Performs no network work of any kind: it reads the durable
   * snapshot the refresh manager last committed.
   */
  read(options: ServiceStatusReadOptions = {}): ServiceStatusReadResult {
    const at = this.now();
    const ids = this.resolveSourceIds(options.sourceIds);
    const componentLimit = limitFor(options.componentLimit, "components");
    const incidentLimit = limitFor(options.incidentLimit, "incidents");
    const updateLimit = limitFor(options.updateLimit, "updates");
    const historyLimit = limitFor(options.historyLimit, "history");

    const includeIncidents = options.includeIncidents ?? true;
    const sources: ServiceStatusSourceView[] = [];

    for (const sourceId of ids) {
      const snapshot = this.store.getSnapshot(sourceId, at);
      if (!snapshot) continue;
      const view = this.projectSource(snapshot, sourceId);

      if (options.includeComponents) {
        const candidates = snapshot.components.filter(
          (component) => options.includeAllComponents === true || component.selected
        );
        // Worst first, so a truncated list still shows what matters.
        const ordered = [...candidates].sort(
          (a, b) => statusRank(b.status) - statusRank(a.status) || a.position - b.position
        );
        view.components = ordered.slice(0, componentLimit).map((component) => ({
          id: component.id,
          name: component.name,
          status: component.status,
          selected: component.selected,
          isGroup: component.isGroup,
          updatedAt: component.updatedAt,
        }));
        view.componentsTruncated = ordered.length > componentLimit;
      }

      if (includeIncidents) {
        const candidates = snapshot.incidents.filter(
          (incident) =>
            incident.stage === "active" || options.includeResolvedIncidents === true
        );
        const ordered = [...candidates].sort(
          (a, b) =>
            Number(b.stage === "active") - Number(a.stage === "active") ||
            b.updatedAt.localeCompare(a.updatedAt)
        );
        view.incidents = ordered.slice(0, incidentLimit).map((incident) => ({
          externalId: incident.externalId,
          title: incident.title,
          stage: incident.stage,
          lifecycle: incident.lifecycle,
          impact: incident.impact,
          url: incident.url,
          startedAt: incident.startedAt,
          updatedAt: incident.updatedAt,
          resolvedAt: incident.resolvedAt,
          resolutionSource: incident.resolutionSource,
          componentIds: incident.componentIds,
          updateCount: incident.updates.length,
          // Newest advisories first, then bounded.
          updates: [...incident.updates]
            .reverse()
            .slice(0, updateLimit)
            .map((update) => ({
              lifecycle: update.lifecycle,
              body: update.body,
              createdAt: update.createdAt,
            })),
        }));
        view.incidentsTruncated = ordered.length > incidentLimit;
      }

      if (options.includeHistory) {
        view.history = this.store
          .listEvents({ sourceId, limit: historyLimit })
          .map((event) => ({
            kind: event.kind,
            subject: event.subjectName ?? event.subjectId,
            previous: event.previous,
            current: event.current,
            detail: event.detail,
            occurredAt: event.occurredAt,
          }));
      }

      sources.push(view);
    }

    return { generatedAt: at.toISOString(), cached: true, sources };
  }

  /**
   * Bounded live refresh. Awaits the real upstream attempts so the caller can
   * act on fresh data rather than the snapshot it already had.
   *
   * Every source goes through `refreshSource`, which is where the manager's
   * per-source single-flight and forced-refresh cooldown live — so parallel
   * callers share one in-flight attempt, and a caller that asks again too soon
   * is told `rate_limited` rather than being allowed to hammer a provider.
   * One slow or failing source never fails the others: results are collected
   * per source.
   */
  async refresh(options: ServiceStatusRefreshOptions = {}): Promise<ServiceStatusRefreshResult> {
    const ids = this.resolveSourceIds(options.sourceIds);
    const startedAt = this.now();

    const results = await Promise.all(
      ids.map((sourceId) => this.manager.refreshSource(sourceId, { force: true }))
    );

    const at = this.now();
    return {
      startedAt: startedAt.toISOString(),
      durationMs: at.getTime() - startedAt.getTime(),
      outcome: aggregateOutcome(results),
      sources: results.map((result) => {
        const snapshot = result.snapshot;
        return {
          sourceId: result.sourceId,
          label: this.definitions.get(result.sourceId)?.label ?? result.sourceId,
          disposition: result.disposition,
          attempted: result.attempted,
          succeeded: result.succeeded,
          durationMs: result.durationMs,
          error: result.error,
          reason: result.reason,
          reportedStatus: snapshot?.effectiveStatus ?? null,
          fetchedAt: snapshot?.reportedAt ?? null,
          observation: result.observation ? projectObservation(result.observation) : null,
          activeIncidentCount: snapshot
            ? snapshot.incidents.filter((incident) => incident.stage === "active").length
            : null,
        };
      }),
    };
  }

  /**
   * Resolve requested ids against the static registry.
   *
   * An unknown id is a validation error naming the registered ids, never a
   * silently empty result — an agent asking about a service that is not
   * monitored must not read that as "it is fine".
   */
  private resolveSourceIds(requested: readonly string[] | undefined): string[] {
    if (requested === undefined) return this.registeredSourceIds();
    if (!Array.isArray(requested)) {
      throw new TypeError("sourceIds must be an array of registered source ids");
    }
    const unique = [...new Set(requested)];
    if (unique.length === 0) return this.registeredSourceIds();
    const unknown = unique.filter((id) => !this.definitions.has(id));
    if (unknown.length > 0) {
      throw new RangeError(
        `unknown service status source id(s): ${unknown.map((id) => JSON.stringify(id)).join(", ")}. ` +
          `Registered ids: ${this.registeredSourceIds().join(", ")}`
      );
    }
    return unique.sort();
  }

  private projectSource(
    snapshot: ServiceStatusSnapshot,
    sourceId: string
  ): ServiceStatusSourceView {
    const definition = this.definitions.get(sourceId);
    return {
      sourceId,
      label: snapshot.label,
      provenance: snapshot.provenance,
      url: definition?.homepage ?? "",
      scopeNote: definition?.scopeNote ?? "",
      reportedStatus: snapshot.effectiveStatus,
      baseline: snapshot.baseline,
      fetchedAt: snapshot.reportedAt,
      observation: projectObservation(snapshot.observation, snapshot.reportedAt),
      activeIncidentCount: snapshot.incidents.filter((incident) => incident.stage === "active")
        .length,
      componentTotal: snapshot.components.length,
      unhealthyComponentCount: snapshot.components.filter(
        (component) => component.selected && component.status !== "operational"
      ).length,
      notes: snapshot.notes,
    };
  }
}

function projectObservation(
  observation: ServiceStatusSnapshot["observation"],
  reportedAt?: string | null
): ServiceStatusObservationView {
  return {
    health: observation.health,
    providerStatusIsCurrent: observation.health === "ok",
    hasProviderData: reportedAt !== undefined ? reportedAt !== null : observation.lastSuccessAt !== null,
    lastAttemptAt: observation.lastAttemptAt,
    lastSuccessAt: observation.lastSuccessAt,
    lastErrorAt: observation.lastErrorAt,
    lastError: observation.lastError,
    consecutiveFailures: observation.consecutiveFailures,
    lastDurationMs: observation.lastDurationMs,
  };
}

function limitFor(
  value: number | undefined,
  field: keyof typeof SERVICE_STATUS_VIEW_LIMITS
): number {
  const bounds = SERVICE_STATUS_VIEW_LIMITS[field];
  try {
    return resolveQueryLimit(value, bounds.max, bounds.fallback);
  } catch (error) {
    throw new RangeError(`${field} limit: ${(error as Error).message}`);
  }
}

export function createServiceStatusMcpView(
  options: ServiceStatusMcpViewOptions
): ServiceStatusMcpView {
  return new ServiceStatusMcpView(options);
}

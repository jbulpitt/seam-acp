/**
 * Normalized upstream service-status model (#182).
 *
 * Four invariants shape every type in this file. They are load-bearing: the
 * store, the event diff, and the refresh manager all assume them.
 *
 * 1. **Adapters own upstream meaning.** A source adapter turns a vendor payload
 *    into `ServiceStatusAdapterResult`. Nothing downstream re-derives vendor
 *    severity or lifecycle from partial fields — the store persists what the
 *    adapter decided and computes only the documented aggregation.
 *
 * 2. **Provider health and Seam observation health are independent axes.**
 *    `baseline` / `components` / `incidents` are what the provider reported.
 *    `ServiceObservation` is how Seam's own fetch went. Neither ever overwrites
 *    or impersonates the other: a failed poll updates the observation and
 *    leaves the last-known-good provider state untouched.
 *
 * 3. **The page/provider baseline is carried separately from components and
 *    incidents.** Effective status is always recomputed as the worst of
 *    (baseline, current selected components, current active incident impacts).
 *    Because the three inputs are stored apart, suppressing one stale incident
 *    neither leaves its severity behind nor hides a simultaneous page or
 *    component outage.
 *
 * 4. **Incident identity is `(sourceId, externalId)`.** Monotonicity — a
 *    resolved incident cannot reopen from a stale payload — is enforced on that
 *    key inside the retention window only.
 */

/**
 * Provider-reported health. Array order is the severity ranking (index =
 * rank), so `worstStatus` is a simple index maximum.
 *
 * `unknown` is deliberate: it means "the provider is reporting a non-normal
 * state we refuse to grade" — an unrecognized severity token, or a feed that
 * carries lifecycle but no severity at all. It is never a stand-in for
 * operational and is never invented from a lifecycle code.
 *
 * It ranks *above* `degraded` on purpose. An ungraded active incident might be
 * a full outage, so treating it as milder than a known degradation would let an
 * unfamiliar severity word quietly understate a real one. Placing it below
 * `partial_outage` keeps it from overstating in the other direction.
 */
export const SERVICE_STATUS_LEVELS = [
  "operational",
  "maintenance",
  "degraded",
  "unknown",
  "partial_outage",
  "major_outage",
] as const;

export type ServiceStatusLevel = (typeof SERVICE_STATUS_LEVELS)[number];

/** Seam's own fetch/freshness axis. Never mixed into {@link ServiceStatusLevel}. */
export const SERVICE_OBSERVATION_HEALTHS = [
  "never_fetched",
  "ok",
  "stale",
  "fetch_error",
] as const;

export type ServiceObservationHealth = (typeof SERVICE_OBSERVATION_HEALTHS)[number];

/**
 * Normalized incident lifecycle. Only two stages exist because only two are
 * needed to keep history monotonic; the provider's own lifecycle word is kept
 * verbatim in `lifecycle` for display.
 */
export const INCIDENT_STAGES = ["active", "resolved"] as const;
export type IncidentStage = (typeof INCIDENT_STAGES)[number];

/**
 * Whether a source is the vendor's own status surface or third-party evidence.
 * `external_synthetic` must never be presented as an official vendor status.
 */
export const SERVICE_SOURCE_PROVENANCES = ["official", "external_synthetic"] as const;
export type ServiceSourceProvenance = (typeof SERVICE_SOURCE_PROVENANCES)[number];

/**
 * Material transition kinds.
 *
 * Appearing and disappearing are separate from changing status on purpose: a
 * component entering or leaving a provider's inventory is material even when it
 * is operational at the time, and folding those into a status change would make
 * an inventory change indistinguishable from a health change.
 */
export const SERVICE_STATUS_EVENT_KINDS = [
  "source",
  "baseline",
  "component_added",
  "component",
  "component_removed",
  "incident",
  "fetch_health",
] as const;
export type ServiceStatusEventKind = (typeof SERVICE_STATUS_EVENT_KINDS)[number];

/** `current` value recorded when a component leaves the provider's inventory. */
export const COMPONENT_REMOVED = "removed";

/**
 * The provider/page-level status, kept apart from components and incidents.
 *
 * `derived` is true when the adapter had no page-level field to read and
 * concluded the baseline from the shape of the response (for example "the
 * incident feed parsed and lists no active incident"). Callers that need to
 * know how much the provider actually asserted can read this flag.
 */
export interface NormalizedBaseline {
  status: ServiceStatusLevel;
  description: string | null;
  derived: boolean;
}

export interface NormalizedComponent {
  /** Stable, unique within the source. Never derived from a mutable title. */
  id: string;
  name: string;
  status: ServiceStatusLevel;
  description: string | null;
  /** Parent group id when the provider models component groups. */
  groupId: string | null;
  isGroup: boolean;
  /** True when the component is in the configured relevant selection. */
  selected: boolean;
  updatedAt: string | null;
}

export interface NormalizedIncidentUpdate {
  /** Unique within the incident and stable across polls. */
  id: string;
  /** The provider's own lifecycle word for this update. */
  lifecycle: string;
  body: string;
  /** The update's own explicit timestamp — never the feed's publication time. */
  createdAt: string;
  /** Deterministic ascending index assigned by the adapter after sorting. */
  order: number;
}

export interface NormalizedIncident {
  /** Upstream identifier; unique within the source. */
  externalId: string;
  title: string;
  stage: IncidentStage;
  /** The provider's own lifecycle word (display only). */
  lifecycle: string;
  /** Provider-reported impact. `unknown` when the provider's grade is unreadable. */
  impact: ServiceStatusLevel;
  url: string | null;
  startedAt: string;
  /** Latest explicit update timestamp — not fetch order, not publication time. */
  updatedAt: string;
  /** Only an explicit upstream resolution time; never inferred. */
  resolvedAt: string | null;
  componentIds: string[];
  updates: NormalizedIncidentUpdate[];
}

/** Everything an adapter is responsible for deciding. */
export interface ServiceStatusAdapterResult {
  sourceId: string;
  /** When Seam observed the payload. */
  fetchedAt: string;
  baseline: NormalizedBaseline;
  components: NormalizedComponent[];
  incidents: NormalizedIncident[];
  /** Non-fatal normalization observations, surfaced for operators. */
  notes: string[];
}

export interface ServiceStatusAdapterContext {
  now: () => Date;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface ServiceStatusSourceDefinition {
  id: string;
  label: string;
  provenance: ServiceSourceProvenance;
  homepage: string;
  /**
   * What this source is and is not evidence for. Rendered by downstream
   * surfaces so a third-party probe is never read as vendor truth.
   */
  scopeNote: string;
  fetch: (context: ServiceStatusAdapterContext) => Promise<ServiceStatusAdapterResult>;
}

export interface ServiceObservation {
  health: ServiceObservationHealth;
  /** Every attempt, successful or not. */
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  /** Sanitized: never contains URLs with query strings, keys, or tokens. */
  lastError: string | null;
  consecutiveFailures: number;
  lastDurationMs: number | null;
}

export interface ServiceStatusComponent extends NormalizedComponent {
  position: number;
}

/**
 * How a stored incident came to be resolved.
 *
 * `upstream` means the provider itself declared it resolved. `not_reported`
 * means Seam inferred it, because a successful payload stopped listing an
 * incident it had previously listed as active. The distinction is load-bearing:
 * only an upstream-declared resolution is monotonic. An inference Seam made
 * must yield the moment the provider reports the incident as active again,
 * otherwise one transiently truncated payload could pin a live outage as
 * "resolved" for the rest of the retention window.
 */
export const INCIDENT_RESOLUTION_SOURCES = ["none", "upstream", "not_reported"] as const;
export type IncidentResolutionSource = (typeof INCIDENT_RESOLUTION_SOURCES)[number];

export interface ServiceStatusIncident extends NormalizedIncident {
  sourceId: string;
  resolutionSource: IncidentResolutionSource;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ServiceStatusSnapshot {
  sourceId: string;
  label: string;
  provenance: ServiceSourceProvenance;
  /** Provider/page baseline, independent of components and incidents. */
  baseline: NormalizedBaseline;
  /** worst(baseline, selected components, active incident impacts). */
  effectiveStatus: ServiceStatusLevel;
  /** `fetchedAt` of the last-known-good provider payload. */
  reportedAt: string | null;
  observation: ServiceObservation;
  components: ServiceStatusComponent[];
  incidents: ServiceStatusIncident[];
  notes: string[];
}

export interface ServiceStatusEvent {
  id: number;
  sourceId: string;
  kind: ServiceStatusEventKind;
  subjectId: string | null;
  subjectName: string | null;
  previous: string | null;
  current: string;
  detail: string | null;
  occurredAt: string;
}

export type NewServiceStatusEvent = Omit<ServiceStatusEvent, "id">;

export const SERVICE_STATUS_DEFAULTS = {
  /** Hard per-source fetch bound, honoured even by adapters that ignore abort. */
  fetchTimeoutMs: 10_000,
  maxResponseBytes: 2_000_000,
  normalIntervalMs: 5 * 60_000,
  incidentIntervalMs: 60_000,
  /** Forced refreshes bypass cadence but not this per-source hard cooldown. */
  forcedCooldownMs: 30_000,
  staleAfterMs: 15 * 60_000,
  historyRetentionDays: 90,
  backoffBaseMs: 5_000,
  backoffMaxMs: 2 * 60_000,
  backoffJitterRatio: 0.2,
  /**
   * Consecutive failures after which a source stops being retried on the fast
   * backoff schedule and falls back to the ordinary polling cadence. A source
   * that has been down for this many attempts is not going to be rescued by
   * another retry a minute later.
   */
  maxBackoffAttempts: 6,
  defaultQueryLimit: 50,
  maxQueryLimit: 500,
} as const;

export const HISTORY_RETENTION_MS =
  SERVICE_STATUS_DEFAULTS.historyRetentionDays * 24 * 60 * 60 * 1000;

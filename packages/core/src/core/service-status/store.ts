import Database from "better-sqlite3";
import { diffSnapshots } from "./events.js";
import { describeError } from "./http.js";
import { computeEffectiveStatus } from "./severity.js";
import { applyServiceStatusSchema } from "./store-schema.js";
import { retentionTimestamp, validateAdapterResult } from "./validate.js";
import {
  HISTORY_RETENTION_MS,
  SERVICE_STATUS_DEFAULTS,
  type IncidentResolutionSource,
  type IncidentStage,
  type NewServiceStatusEvent,
  type NormalizedIncidentUpdate,
  type ServiceObservation,
  type ServiceObservationHealth,
  type ServiceSourceProvenance,
  type ServiceStatusAdapterResult,
  type ServiceStatusComponent,
  type ServiceStatusEvent,
  type ServiceStatusEventKind,
  type ServiceStatusIncident,
  type ServiceStatusLevel,
  type ServiceStatusSnapshot,
} from "./types.js";

export interface RegisteredSource {
  id: string;
  label: string;
  provenance: ServiceSourceProvenance;
}

export interface ServiceStatusStoreOptions {
  /** How long a successful observation stays fresh before it reads as stale. */
  staleAfterMs?: number;
  /** Resolved-incident and event retention window. */
  retentionMs?: number;
}

export interface RecordSuccessInput {
  source: RegisteredSource;
  result: ServiceStatusAdapterResult;
  durationMs: number | null;
  observedAt: Date;
}

export interface RecordFailureInput {
  source: RegisteredSource;
  error: unknown;
  durationMs: number | null;
  observedAt: Date;
}

export interface RecordOutcome {
  snapshot: ServiceStatusSnapshot;
  events: NewServiceStatusEvent[];
  /** Incident ids whose upstream copy was rejected as a stale reopen. */
  suppressedReopens: string[];
  /**
   * Incident ids the payload still carries but which fall outside the
   * retention window, so they were not stored.
   */
  skippedExpired: string[];
  /**
   * Incident ids whose upstream copy was older than the record already stored,
   * so it was not allowed to overwrite it.
   */
  skippedStale: string[];
}

export interface EventQuery {
  sourceId?: string;
  kinds?: readonly ServiceStatusEventKind[];
  since?: Date;
  limit?: number;
}

export interface IncidentQuery {
  sourceId?: string;
  stage?: IncidentStage;
  since?: Date;
  limit?: number;
}

interface SourceRow {
  source_id: string;
  label: string;
  provenance: string;
  baseline_status: string;
  baseline_description: string | null;
  baseline_derived: number;
  effective_status: string;
  reported_at: string | null;
  notes_json: string;
  last_outcome: string;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  last_duration_ms: number | null;
}

interface ComponentRow {
  component_id: string;
  name: string;
  status: string;
  description: string | null;
  group_id: string | null;
  is_group: number;
  selected: number;
  position: number;
  updated_at: string | null;
}

interface IncidentRow {
  source_id: string;
  external_id: string;
  title: string;
  stage: string;
  lifecycle: string;
  resolution_source: string;
  impact: string;
  url: string | null;
  started_at: string;
  updated_at: string;
  resolved_at: string | null;
  retention_at: string;
  component_ids_json: string;
  updates_json: string;
  first_seen_at: string;
  last_seen_at: string;
}

interface EventRow {
  id: number;
  source_id: string;
  kind: string;
  subject_id: string | null;
  subject_name: string | null;
  previous: string | null;
  current: string;
  detail: string | null;
  occurred_at: string;
}

/**
 * Durable service-status state.
 *
 * Three properties are the reason this class exists in the shape it does:
 *
 * 1. **A refresh is one transaction.** Retention pruning, incident
 *    reconciliation, component replacement, the source row, and the emitted
 *    events all commit together or not at all. The adapter result is validated
 *    in full *before* the transaction opens, so an invalid payload can never
 *    leave a half-applied snapshot behind.
 *
 * 2. **Provider state and observation state are separate columns.** A failed
 *    refresh writes only the observation columns; `baseline_*`,
 *    `effective_status`, `reported_at`, components and incidents keep their
 *    last-known-good values, which is what makes a cold boot immediately useful
 *    and what stops a transient network error from looking like a recovery.
 *
 * 3. **Resolved incidents are monotonic inside the retention window.** The
 *    prune runs *before* the suppression set is built, so an id whose resolved
 *    row has aged out is genuinely eligible to recur, while an id still inside
 *    the window cannot be reopened by a stale payload.
 */
export class ServiceStatusStore {
  private readonly db: Database.Database;
  private readonly staleAfterMs: number;
  private readonly retentionMs: number;

  constructor(dbPath: string, options: ServiceStatusStoreOptions = {}) {
    this.db = new Database(dbPath);
    applyServiceStatusSchema(this.db);
    this.staleAfterMs = options.staleAfterMs ?? SERVICE_STATUS_DEFAULTS.staleAfterMs;
    this.retentionMs = options.retentionMs ?? HISTORY_RETENTION_MS;
  }

  /**
   * Make sources visible before anything has been fetched, so a cold boot lists
   * every configured source with an honest `never_fetched` observation rather
   * than silently omitting it.
   */
  registerSources(sources: readonly RegisteredSource[]): void {
    const register = this.db.transaction((entries: readonly RegisteredSource[]) => {
      for (const source of entries) this.upsertRegistration(source);
    });
    register(sources);
  }

  recordSuccess(input: RecordSuccessInput): RecordOutcome {
    // Validate everything up front: past this point the transaction only fails
    // for genuinely exceptional reasons, never for a malformed payload.
    validateAdapterResult(input.result);
    if (input.result.sourceId !== input.source.id) {
      throw new Error(
        `adapter result source ${JSON.stringify(input.result.sourceId)} does not match ` +
          `registered source ${JSON.stringify(input.source.id)}`
      );
    }

    const commit = this.db.transaction((): RecordOutcome => {
      const { source, result, observedAt } = input;
      const at = observedAt.toISOString();
      this.upsertRegistration(source);
      const previous = this.readSnapshot(source.id, observedAt);

      // Retention first: the suppression set must be built from rows that are
      // still inside the window, otherwise an expired incident would keep
      // blocking its own legitimate recurrence.
      const cutoff = new Date(observedAt.getTime() - this.retentionMs).toISOString();
      this.pruneIncidents(source.id, cutoff);
      this.pruneEvents(cutoff);

      const persisted = new Map(
        this.readIncidentRows(source.id, observedAt).map((row) => [row.external_id, row])
      );
      const suppressedReopens: string[] = [];
      const skippedExpired: string[] = [];
      const skippedStale: string[] = [];

      // Feeds routinely publish years of history. Storing an already-expired
      // incident only to prune it on the next refresh would re-emit its
      // "incident appeared" event every single poll, so it is never stored at
      // all. Active incidents are never expired.
      const storable = result.incidents.filter((incident) => {
        if (incident.stage === "active") return true;
        if (retentionTimestamp(incident) >= cutoff) return true;
        skippedExpired.push(incident.externalId);
        return false;
      });
      const incoming = new Map(storable.map((incident) => [incident.externalId, incident]));

      const touchLastSeen = this.db.prepare(
        `UPDATE service_status_incidents SET last_seen_at = ?
         WHERE source_id = ? AND external_id = ?`
      );

      for (const incident of storable) {
        const existing = persisted.get(incident.externalId);
        const decision = decideIncidentWrite(existing, incident);
        if (decision !== "apply") {
          // Either an upstream-declared resolution being reopened by a stale
          // payload, or a record older than the one already stored. Both keep
          // the persisted row authoritative; we only note that upstream is
          // still publishing the incident.
          touchLastSeen.run(at, source.id, incident.externalId);
          if (decision === "suppress-reopen") suppressedReopens.push(incident.externalId);
          else skippedStale.push(incident.externalId);
          continue;
        }
        this.upsertIncident(source.id, incident, existing, at);
      }

      for (const row of persisted.values()) {
        if (row.stage !== "active" || incoming.has(row.external_id)) continue;
        // A successful payload is authoritative about what is currently active.
        // Retaining a vanished incident as active would let a stale row mask the
        // provider's own verdict; no resolution time is invented for it.
        // The retention clock restarts at this observation. An incident that
        // ran for a hundred days has an `updated_at` far outside the window, so
        // leaving `retention_at` alone would prune it on this very refresh
        // instead of keeping it queryable for the full ninety days after it
        // stopped being reported. `resolved_at` stays null: no upstream
        // resolution time exists to record.
        this.db
          .prepare(
            `UPDATE service_status_incidents
             SET stage = 'resolved', lifecycle = 'no_longer_reported',
                 resolution_source = 'not_reported', retention_at = ?
             WHERE source_id = ? AND external_id = ?`
          )
          .run(at, source.id, row.external_id);
      }

      this.db.prepare(`DELETE FROM service_status_components WHERE source_id = ?`).run(source.id);
      const insertComponent = this.db.prepare(
        `INSERT INTO service_status_components
           (source_id, component_id, name, status, description, group_id, is_group, selected, position, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      result.components.forEach((component, position) => {
        insertComponent.run(
          source.id,
          component.id,
          component.name,
          component.status,
          component.description,
          component.groupId,
          component.isGroup ? 1 : 0,
          component.selected ? 1 : 0,
          position,
          component.updatedAt
        );
      });

      const activeIncidents = this.readIncidentRows(source.id, observedAt).filter((row) => row.stage === "active");
      const effectiveStatus = computeEffectiveStatus({
        baseline: result.baseline,
        components: result.components,
        activeIncidents: activeIncidents.map((row) => ({
          impact: row.impact as ServiceStatusLevel,
        })),
      });

      this.db
        .prepare(
          `UPDATE service_status_sources SET
             baseline_status = ?, baseline_description = ?, baseline_derived = ?,
             effective_status = ?, reported_at = ?, notes_json = ?,
             last_outcome = 'success', last_attempt_at = ?, last_success_at = ?,
             consecutive_failures = 0, last_duration_ms = ?
           WHERE source_id = ?`
        )
        .run(
          result.baseline.status,
          result.baseline.description,
          result.baseline.derived ? 1 : 0,
          effectiveStatus,
          result.fetchedAt,
          JSON.stringify(result.notes),
          at,
          at,
          input.durationMs,
          source.id
        );

      const snapshot = this.readSnapshot(source.id, observedAt)!;
      const events = diffSnapshots(previous, snapshot, at);
      this.insertEvents(events);
      return { snapshot, events, suppressedReopens, skippedExpired, skippedStale };
    });

    return commit();
  }

  recordFailure(input: RecordFailureInput): RecordOutcome {
    const commit = this.db.transaction((): RecordOutcome => {
      const { source, observedAt } = input;
      const at = observedAt.toISOString();
      this.upsertRegistration(source);
      const previous = this.readSnapshot(source.id, observedAt);

      this.db
        .prepare(
          `UPDATE service_status_sources SET
             last_outcome = 'failure', last_attempt_at = ?, last_error_at = ?, last_error = ?,
             consecutive_failures = consecutive_failures + 1, last_duration_ms = ?
           WHERE source_id = ?`
        )
        .run(at, at, describeError(input.error), input.durationMs, source.id);

      // Retention is enforced on every poll, not only successful ones: a source
      // that fails for months must still age its resolved history out. Only
      // expired *resolved* rows are removed, so the last-known-good provider
      // status, its components and every active incident are untouched — and it
      // shares this transaction, so it commits or rolls back with the rest.
      const cutoff = this.retentionCutoff(observedAt);
      this.pruneIncidents(source.id, cutoff);
      this.pruneEvents(cutoff);

      const snapshot = this.readSnapshot(source.id, observedAt)!;
      const events = diffSnapshots(previous, snapshot, at);
      this.insertEvents(events);
      return { snapshot, events, suppressedReopens: [], skippedExpired: [], skippedStale: [] };
    });

    return commit();
  }

  getSnapshot(sourceId: string, at: Date = new Date()): ServiceStatusSnapshot | null {
    return this.readSnapshot(sourceId, at);
  }

  listSnapshots(at: Date = new Date()): ServiceStatusSnapshot[] {
    const rows = this.db
      .prepare<[], { source_id: string }>(
        `SELECT source_id FROM service_status_sources ORDER BY source_id`
      )
      .all();
    return rows.map((row) => this.readSnapshot(row.source_id, at)!);
  }

  hasActiveIncident(sourceId?: string): boolean {
    const row = sourceId
      ? this.db
          .prepare<[string], { n: number }>(
            `SELECT COUNT(*) AS n FROM service_status_incidents WHERE stage = 'active' AND source_id = ?`
          )
          .get(sourceId)
      : this.db
          .prepare<[], { n: number }>(
            `SELECT COUNT(*) AS n FROM service_status_incidents WHERE stage = 'active'`
          )
          .get();
    return (row?.n ?? 0) > 0;
  }

  listEvents(query: EventQuery = {}): ServiceStatusEvent[] {
    const limit = resolveQueryLimit(query.limit);
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (query.sourceId !== undefined) {
      clauses.push("source_id = ?");
      params.push(query.sourceId);
    }
    if (query.kinds && query.kinds.length > 0) {
      clauses.push(`kind IN (${query.kinds.map(() => "?").join(", ")})`);
      params.push(...query.kinds);
    }
    if (query.since !== undefined) {
      clauses.push("occurred_at >= ?");
      params.push(query.since.toISOString());
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare<(string | number)[], EventRow>(
        `SELECT * FROM service_status_events ${where} ORDER BY occurred_at DESC, id DESC LIMIT ?`
      )
      .all(...params, limit);
    return rows.map((row) => ({
      id: row.id,
      sourceId: row.source_id,
      kind: row.kind as ServiceStatusEventKind,
      subjectId: row.subject_id,
      subjectName: row.subject_name,
      previous: row.previous,
      current: row.current,
      detail: row.detail,
      occurredAt: row.occurred_at,
    }));
  }

  listIncidents(query: IncidentQuery = {}, at: Date = new Date()): ServiceStatusIncident[] {
    const limit = resolveQueryLimit(query.limit);
    // Retention is a property of the data, not of when a prune last ran. If no
    // poll has succeeded for months — or every poll has failed — an expired
    // resolved incident must still be invisible here.
    const clauses: string[] = ["(stage != 'resolved' OR retention_at >= ?)"];
    const params: (string | number)[] = [this.retentionCutoff(at)];
    if (query.sourceId !== undefined) {
      clauses.push("source_id = ?");
      params.push(query.sourceId);
    }
    if (query.stage !== undefined) {
      clauses.push("stage = ?");
      params.push(query.stage);
    }
    if (query.since !== undefined) {
      clauses.push("updated_at >= ?");
      params.push(query.since.toISOString());
    }
    const rows = this.db
      .prepare<(string | number)[], IncidentRow>(
        `SELECT * FROM service_status_incidents WHERE ${clauses.join(" AND ")}
         ORDER BY updated_at DESC, external_id ASC LIMIT ?`
      )
      .all(...params, limit);
    return rows.map(toIncident);
  }

  /** Resolved incidents at or after this instant are retained; older are not. */
  private retentionCutoff(at: Date): string {
    return new Date(at.getTime() - this.retentionMs).toISOString();
  }

  close(): void {
    this.db.close();
  }

  private upsertRegistration(source: RegisteredSource): void {
    this.db
      .prepare(
        `INSERT INTO service_status_sources
           (source_id, label, provenance, baseline_status, baseline_description, baseline_derived,
            effective_status, reported_at, notes_json, last_outcome, last_attempt_at,
            last_success_at, last_error_at, last_error, consecutive_failures, last_duration_ms)
         VALUES (?, ?, ?, 'unknown', NULL, 1, 'unknown', NULL, '[]', 'none', NULL, NULL, NULL, NULL, 0, NULL)
         ON CONFLICT(source_id) DO UPDATE SET label = excluded.label, provenance = excluded.provenance`
      )
      .run(source.id, source.label, source.provenance);
  }

  /**
   * Write an incident, never letting a monotonic clock run backwards.
   *
   * `decideIncidentWrite` has already established that this record is at least
   * as new as the stored one, but "newer overall" does not mean every field is
   * newer: a provider can re-publish a record whose `resolvedAt` is absent or
   * earlier than one we already hold. Resolution and retention times are
   * therefore clamped to the later of the two, so a resolved incident can never
   * have its retention window rewound and pruned early.
   */
  private upsertIncident(
    sourceId: string,
    incident: ServiceStatusAdapterResult["incidents"][number],
    existing: IncidentRow | undefined,
    at: string
  ): void {
    this.writeIncident(sourceId, incident, {
      firstSeenAt: existing?.first_seen_at ?? at,
      at,
      ...incidentClocks(incident, existing),
    });
  }

  private writeIncident(
    sourceId: string,
    incident: ServiceStatusAdapterResult["incidents"][number],
    times: { firstSeenAt: string; at: string; resolvedAt: string | null; retentionAt: string }
  ): void {
    const { firstSeenAt, at: lastSeenAt, resolvedAt, retentionAt } = times;
    // Invariant: an active row never carries a resolution time. It is enforced
    // here, in the single write path, rather than as a schema CHECK, because
    // adding one to an existing table needs a rebuild. A violation aborts the
    // surrounding transaction rather than persisting an incoherent row.
    if (incident.stage === "active" && resolvedAt !== null) {
      throw new Error(
        `refusing to store active incident ${JSON.stringify(incident.externalId)} with a resolved_at`
      );
    }
    this.db
      .prepare(
        `INSERT INTO service_status_incidents
           (source_id, external_id, title, stage, lifecycle, resolution_source, impact, url,
            started_at, updated_at, resolved_at, retention_at, component_ids_json, updates_json,
            first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_id, external_id) DO UPDATE SET
           title = excluded.title, stage = excluded.stage, lifecycle = excluded.lifecycle,
           resolution_source = excluded.resolution_source,
           impact = excluded.impact, url = excluded.url, started_at = excluded.started_at,
           updated_at = excluded.updated_at, resolved_at = excluded.resolved_at,
           retention_at = excluded.retention_at, component_ids_json = excluded.component_ids_json,
           updates_json = excluded.updates_json, last_seen_at = excluded.last_seen_at`
      )
      .run(
        sourceId,
        incident.externalId,
        incident.title,
        incident.stage,
        incident.lifecycle,
        incident.stage === "resolved" ? "upstream" : "none",
        incident.impact,
        incident.url,
        incident.startedAt,
        incident.updatedAt,
        resolvedAt,
        retentionAt,
        JSON.stringify(incident.componentIds),
        JSON.stringify(incident.updates),
        firstSeenAt,
        lastSeenAt
      );
  }

  /**
   * Strictly older than the cutoff is pruned; exactly at the cutoff is
   * retained. Active incidents are never pruned — a long-running outage must
   * not disappear because it started more than a retention window ago.
   *
   * Scoped to the source being written so a refresh only ever mutates its own
   * incident rows; another source's history changing underneath it would make
   * its next diff non-deterministic.
   */
  private pruneIncidents(sourceId: string, cutoff: string): void {
    this.db
      .prepare(
        `DELETE FROM service_status_incidents
         WHERE source_id = ? AND stage = 'resolved' AND retention_at < ?`
      )
      .run(sourceId, cutoff);
  }

  /** Events carry no identity to re-insert, so pruning them globally is safe. */
  private pruneEvents(cutoff: string): void {
    this.db.prepare(`DELETE FROM service_status_events WHERE occurred_at < ?`).run(cutoff);
  }

  private insertEvents(events: readonly NewServiceStatusEvent[]): void {
    if (events.length === 0) return;
    const insert = this.db.prepare(
      `INSERT INTO service_status_events
         (source_id, kind, subject_id, subject_name, previous, current, detail, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const event of events) {
      insert.run(
        event.sourceId,
        event.kind,
        event.subjectId,
        event.subjectName,
        event.previous,
        event.current,
        event.detail,
        event.occurredAt
      );
    }
  }

  /**
   * Rows for one source, with the same retention invariant every other read
   * applies: an expired resolved incident is invisible whether or not a prune
   * has run since it aged out.
   */
  private readIncidentRows(sourceId: string, at: Date): IncidentRow[] {
    return this.db
      .prepare<[string, string], IncidentRow>(
        `SELECT * FROM service_status_incidents
         WHERE source_id = ? AND (stage != 'resolved' OR retention_at >= ?)
         ORDER BY updated_at DESC, external_id ASC`
      )
      .all(sourceId, this.retentionCutoff(at));
  }

  private readSnapshot(sourceId: string, at: Date): ServiceStatusSnapshot | null {
    const row = this.db
      .prepare<[string], SourceRow>(`SELECT * FROM service_status_sources WHERE source_id = ?`)
      .get(sourceId);
    if (!row) return null;

    const components = this.db
      .prepare<[string], ComponentRow>(
        `SELECT * FROM service_status_components WHERE source_id = ? ORDER BY position`
      )
      .all(sourceId)
      .map(
        (component): ServiceStatusComponent => ({
          id: component.component_id,
          name: component.name,
          status: component.status as ServiceStatusLevel,
          description: component.description,
          groupId: component.group_id,
          isGroup: component.is_group === 1,
          selected: component.selected === 1,
          position: component.position,
          updatedAt: component.updated_at,
        })
      );

    const incidents = this.readIncidentRows(sourceId, at).map(toIncident);

    return {
      sourceId: row.source_id,
      label: row.label,
      provenance: row.provenance as ServiceSourceProvenance,
      baseline: {
        status: row.baseline_status as ServiceStatusLevel,
        description: row.baseline_description,
        derived: row.baseline_derived === 1,
      },
      effectiveStatus: row.effective_status as ServiceStatusLevel,
      reportedAt: row.reported_at,
      observation: this.deriveObservation(row, at),
      components,
      incidents,
      notes: JSON.parse(row.notes_json) as string[],
    };
  }

  /**
   * Derive the observation axis from stored facts rather than storing a
   * pre-computed verdict, so freshness is always evaluated against the caller's
   * clock.
   *
   * Precedence is deliberate:
   *   - a source never attempted is `never_fetched`;
   *   - a failing last attempt is `fetch_error`, which also covers a source
   *     that has *never* succeeded — repeated first-time failures are reported
   *     as errors and are never dressed up as stale data we do not have;
   *   - otherwise a successful but old observation is `stale`;
   *   - otherwise `ok`.
   */
  private deriveObservation(row: SourceRow, at: Date): ServiceObservation {
    let health: ServiceObservationHealth;
    if (row.last_outcome === "none") {
      health = "never_fetched";
    } else if (row.last_outcome === "failure" || row.last_success_at === null) {
      health = "fetch_error";
    } else if (at.getTime() - new Date(row.last_success_at).getTime() > this.staleAfterMs) {
      health = "stale";
    } else {
      health = "ok";
    }
    return {
      health,
      lastAttemptAt: row.last_attempt_at,
      lastSuccessAt: row.last_success_at,
      lastErrorAt: row.last_error_at,
      lastError: row.last_error,
      consecutiveFailures: row.consecutive_failures,
      lastDurationMs: row.last_duration_ms,
    };
  }
}

type IncidentWriteDecision = "apply" | "stale" | "suppress-reopen";

/**
 * Decide whether an upstream incident record may replace the stored one.
 *
 * Feeds re-publish history, and a cached or lagging copy can arrive after a
 * newer one. Without this, an older *same-stage* record would overwrite a newer
 * one field for field — turning a stored `active / major_outage / monitoring`
 * into `active / operational / investigating` and publishing a false green, or
 * rewinding a resolved incident's resolution time so its retention window
 * expires early and a stale active copy can then reopen it.
 *
 * The rules, in order:
 *
 *   1. An upstream-declared resolution inside the retention window is
 *      monotonic: no active record reopens it, whatever its timestamp. A
 *      resolution Seam merely *inferred* (`not_reported`) carries no such
 *      claim — the provider never said it was resolved — so it may reopen.
 *   2. A strictly older record never replaces a newer one.
 *   3. On equal timestamps the resolved-beats-active tie belongs to rule 1 and
 *      is settled there. It is deliberately *not* re-applied to an inferred
 *      resolution: a provider that transiently omits an incident and then
 *      republishes it byte for byte does not advance its `updatedAt`, so
 *      treating that tie as "resolved wins" would hold the incident green until
 *      the provider happened to touch its clock.
 *
 * Only this incident is affected; a rejected record never suppresses unrelated
 * component or page degradation, which is recomputed from its own inputs.
 */
export function decideIncidentWrite(
  existing: { stage: string; updated_at: string; resolution_source: string } | undefined,
  incoming: { stage: string; updatedAt: string }
): IncidentWriteDecision {
  if (!existing) return "apply";
  if (
    existing.stage === "resolved" &&
    existing.resolution_source === "upstream" &&
    incoming.stage === "active"
  ) {
    return "suppress-reopen";
  }
  if (incoming.updatedAt < existing.updated_at) return "stale";
  if (incoming.updatedAt > existing.updated_at) return "apply";

  // Equal timestamps. The only resolved row that can still be here is one Seam
  // inferred from a disappearance — an upstream-declared resolution was already
  // settled above — and that is bookkeeping, not a provider claim. The same
  // unchanged incident reappearing means the omission was transient, so it
  // reopens. An incoming resolved record applies too, so a resolution recorded
  // at the same instant is never lost.
  return "apply";
}

/** The later of two canonical timestamps, treating `null` as "no opinion". */
function laterOf(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left > right ? left : right;
}

/**
 * The resolution and retention clocks to store, from the incoming record and
 * the row it replaces.
 *
 * Clamping is deliberately stage- and resolution-source-aware rather than a
 * blanket "keep the later value":
 *
 *   - An **active** record has no resolution, so `resolved_at` is cleared
 *     outright. Carrying a stored value forward would leave an active row
 *     claiming it was resolved — the exact incoherence a naive clamp produces
 *     when a Seam-inferred resolution legitimately reopens. Retention restarts
 *     from the incident's own timestamp; active rows are never pruned, so the
 *     value is only a floor for whenever it does resolve.
 *   - A **resolved** record may only move the clocks forward. `resolved_at` is
 *     clamped against a previous *upstream-declared* resolution — the only kind
 *     that asserts a real resolution time — and retention against whatever the
 *     row already had, so a re-published record naming an earlier time can
 *     never shorten the window and expire the incident early.
 */
export function incidentClocks(
  incident: { stage: string; updatedAt: string; resolvedAt: string | null },
  existing:
    | { resolved_at: string | null; retention_at: string; resolution_source: string }
    | undefined
): { resolvedAt: string | null; retentionAt: string } {
  if (incident.stage === "active") {
    return { resolvedAt: null, retentionAt: incident.updatedAt };
  }
  const priorUpstreamResolution =
    existing?.resolution_source === "upstream" ? existing.resolved_at : null;
  const resolvedAt = laterOf(priorUpstreamResolution, incident.resolvedAt);
  const retentionAt =
    laterOf(existing?.retention_at ?? null, resolvedAt ?? incident.updatedAt) ??
    incident.updatedAt;
  return { resolvedAt, retentionAt };
}

function toIncident(row: IncidentRow): ServiceStatusIncident {
  return {
    sourceId: row.source_id,
    externalId: row.external_id,
    title: row.title,
    stage: row.stage as IncidentStage,
    lifecycle: row.lifecycle,
    resolutionSource: row.resolution_source as IncidentResolutionSource,
    impact: row.impact as ServiceStatusLevel,
    url: row.url,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    componentIds: JSON.parse(row.component_ids_json) as string[],
    updates: JSON.parse(row.updates_json) as NormalizedIncidentUpdate[],
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

/**
 * Bounded query limits. A caller that asks for something nonsensical gets a
 * `RangeError` rather than an unbounded scan; a caller that asks for more than
 * the ceiling is clamped to it.
 */
export function resolveQueryLimit(
  limit: number | undefined,
  max: number = SERVICE_STATUS_DEFAULTS.maxQueryLimit,
  fallback: number = SERVICE_STATUS_DEFAULTS.defaultQueryLimit
): number {
  if (limit === undefined) return fallback;
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    throw new RangeError(`query limit must be a finite number, received ${String(limit)}`);
  }
  if (!Number.isInteger(limit)) {
    throw new RangeError(`query limit must be an integer, received ${String(limit)}`);
  }
  if (limit <= 0) {
    throw new RangeError(`query limit must be greater than zero, received ${String(limit)}`);
  }
  return Math.min(limit, max);
}

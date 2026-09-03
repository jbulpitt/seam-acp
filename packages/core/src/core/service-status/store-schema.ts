import type Database from "better-sqlite3";

/**
 * Schema for the service-status subsystem (#182).
 *
 * Four tables, one responsibility each:
 *
 *   - `service_status_sources`    one row per registered source: the provider
 *                                 baseline, the computed effective status, and
 *                                 — in separate columns that never overwrite
 *                                 the provider fields — Seam's observation
 *                                 bookkeeping.
 *   - `service_status_components` the current component rows for a source.
 *                                 Replaced wholesale inside the refresh
 *                                 transaction.
 *   - `service_status_incidents`  active incidents *and* resolved history
 *                                 inside the retention window, keyed by
 *                                 (source, upstream id). `retention_at` is the
 *                                 single column the 90-day prune compares, and
 *                                 `resolution_source` records whether a
 *                                 resolution was declared upstream or inferred
 *                                 by Seam — only the former is monotonic.
 *   - `service_status_events`     material transitions only.
 *
 * All timestamps are canonical `Date#toISOString()` strings, which makes
 * lexicographic comparison equivalent to chronological comparison — the
 * retention boundary and every ordering depend on that.
 */
const DDL = `
CREATE TABLE IF NOT EXISTS service_status_sources (
  source_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  provenance TEXT NOT NULL,
  baseline_status TEXT NOT NULL,
  baseline_description TEXT,
  baseline_derived INTEGER NOT NULL,
  effective_status TEXT NOT NULL,
  reported_at TEXT,
  notes_json TEXT NOT NULL,
  last_outcome TEXT NOT NULL,
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_error_at TEXT,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL,
  last_duration_ms INTEGER
);

CREATE TABLE IF NOT EXISTS service_status_components (
  source_id TEXT NOT NULL,
  component_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  description TEXT,
  group_id TEXT,
  is_group INTEGER NOT NULL,
  selected INTEGER NOT NULL,
  position INTEGER NOT NULL,
  updated_at TEXT,
  PRIMARY KEY (source_id, component_id)
);

CREATE TABLE IF NOT EXISTS service_status_incidents (
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  stage TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  resolution_source TEXT NOT NULL,
  impact TEXT NOT NULL,
  url TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  retention_at TEXT NOT NULL,
  component_ids_json TEXT NOT NULL,
  updates_json TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (source_id, external_id)
);

CREATE TABLE IF NOT EXISTS service_status_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject_id TEXT,
  subject_name TEXT,
  previous TEXT,
  current TEXT NOT NULL,
  detail TEXT,
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_service_status_components_source
  ON service_status_components(source_id, position);
CREATE INDEX IF NOT EXISTS idx_service_status_incidents_source
  ON service_status_incidents(source_id, stage, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_status_incidents_retention
  ON service_status_incidents(stage, retention_at);
CREATE INDEX IF NOT EXISTS idx_service_status_events_source
  ON service_status_events(source_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_service_status_events_time
  ON service_status_events(occurred_at DESC, id DESC);
`;

/**
 * Columns added after a release that already shipped the table.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op against an existing database, so a
 * new column has to arrive by `ALTER TABLE`. Adding an entry here — rather than
 * only editing `DDL` — is what lets an already-deployed database gain the
 * column instead of silently running without it. The registry is empty because
 * the schema has not changed since it was introduced; the mechanism that
 * applies it is exercised by `ensureColumns`.
 */
const ADDED_COLUMNS: Readonly<Record<string, Readonly<Record<string, string>>>> = {};

/**
 * Add any of `columns` that the table does not already have. Column
 * definitions must be nullable or carry a default, since existing rows cannot
 * be back-filled here.
 */
export function ensureColumns(
  db: Database.Database,
  table: string,
  columns: Readonly<Record<string, string>>
): string[] {
  const names = Object.keys(columns);
  if (names.length === 0) return [];
  const existing = new Set(
    db.prepare<[], { name: string }>(`PRAGMA table_info(${table})`).all().map((row) => row.name)
  );
  const added: string[] = [];
  for (const column of names) {
    if (existing.has(column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${columns[column]!}`);
    added.push(column);
  }
  return added;
}

export function applyServiceStatusSchema(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.exec(DDL);
  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    ensureColumns(db, table, columns);
  }
}

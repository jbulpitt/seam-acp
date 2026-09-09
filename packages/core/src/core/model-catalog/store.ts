import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  assertCatalogSemantics,
  catalogContentChecksum,
  catalogReductionFingerprint,
  normalizeCatalogCandidate,
  validateCatalogEvidence,
  type AdapterCatalogCandidate,
} from "@seam/adapters";

export interface StoredCatalogSnapshot {
  scopeKey: string;
  generation: number;
  checksum: string;
  candidate: AdapterCatalogCandidate;
  publishedAt: string;
}

export interface CatalogObservationRow {
  bindingKey: string;
  agentId: string;
  location: string;
  scopeKey: string;
  checksum: string;
  adapterVersion: number;
  schemaVersion: number;
  cliVersion: string | null;
  sourceVersion: string | null;
  source: string;
  fetchedAt: string;
  drift: string | null;
}

export interface CatalogRefreshStatusRow {
  bindingKey: string;
  attemptedAt: string;
  result: string;
  error: string | null;
  source: string | null;
  candidateChecksum: string | null;
}

export interface CatalogReductionQuarantineRow {
  bindingKey: string;
  scopeKey: string;
  /** The generation the reduction was assessed AGAINST. */
  priorGeneration: number;
  rule: string;
  removed: string[];
  /** Substantive fingerprint, excluding volatile observation timestamps. */
  fingerprint: string;
  observedAt: string;
}

export type CatalogBindingMigrationStatus = "pending-proof" | "complete";

export interface CatalogBindingMigrationRow {
  migrationId: string;
  sourceBindingKey: string;
  targetBindingKey: string;
  scopeKey: string | null;
  source: string;
  activeGeneration: number | null;
  activeChecksum: string | null;
  continuityFingerprint: string | null;
  status: CatalogBindingMigrationStatus;
  createdAt: string;
  completedAt: string | null;
}

export type PrepareCatalogBindingMigrationResult =
  | "fresh"
  | "renamed"
  | "pending-proof"
  | "already-complete"
  | "already-pending-proof";

/**
 * Exact nonvolatile identity required for a renamed binding to prove that its
 * first fresh candidate is the active publisher's catalog. Observation times
 * may advance; source/runtime/schema/evidence/model/default semantics may not.
 */
export function catalogBindingContinuityFingerprint(candidate: AdapterCatalogCandidate): string {
  return createHash("sha256").update(JSON.stringify({
    catalog: catalogReductionFingerprint(candidate),
    source: candidate.source,
    sourceVersion: candidate.sourceVersion ?? null,
    cliVersion: candidate.cliVersion ?? null,
    adapterVersion: candidate.adapterVersion,
    schemaVersion: candidate.schemaVersion,
  })).digest("hex");
}

export class ModelCatalogStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS model_catalog_generations (
        generation INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_key TEXT NOT NULL,
        checksum TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        published_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS model_catalog_scopes (
        scope_key TEXT PRIMARY KEY,
        active_generation INTEGER NOT NULL REFERENCES model_catalog_generations(generation),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS model_catalog_observations (
        binding_key TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        location TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        checksum TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        adapter_version INTEGER NOT NULL,
        cli_version TEXT,
        source_version TEXT,
        source TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        drift TEXT
      );
      CREATE TABLE IF NOT EXISTS model_catalog_refresh_status (
        binding_key TEXT PRIMARY KEY,
        attempted_at TEXT NOT NULL,
        result TEXT NOT NULL,
        error TEXT,
        source TEXT,
        candidate_checksum TEXT
      );
      -- #236: typed reduction-confirmation state. Deliberately its own table
      -- rather than reusing refresh_status.candidate_checksum, which is written
      -- by every attempt of any kind: a confirmation must only ever be honoured
      -- when the PREVIOUS attempt was a reduction quarantine of the SAME
      -- reduction against the SAME prior generation.
      CREATE TABLE IF NOT EXISTS model_catalog_reduction_quarantine (
        binding_key TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        prior_generation INTEGER NOT NULL,
        rule TEXT NOT NULL,
        removed_json TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
      -- Durable, narrowly-scoped identity continuity. This does not grant a
      -- publisher role by itself: a pending target must freshly reproduce the
      -- active generation's nonvolatile catalog identity before the service
      -- consumes this single-use proof.
      CREATE TABLE IF NOT EXISTS model_catalog_binding_migrations (
        migration_id TEXT PRIMARY KEY,
        source_binding_key TEXT NOT NULL,
        target_binding_key TEXT NOT NULL,
        scope_key TEXT,
        source TEXT NOT NULL,
        active_generation INTEGER,
        active_checksum TEXT,
        continuity_fingerprint TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending-proof','complete')),
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_model_catalog_generations_scope
        ON model_catalog_generations(scope_key, generation DESC);
      CREATE INDEX IF NOT EXISTS idx_model_catalog_observations_scope
        ON model_catalog_observations(scope_key);
    `);
    this.migrateGenerationDedupConstraint();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_model_catalog_generations_scope
        ON model_catalog_generations(scope_key, generation DESC);
    `);
    this.ensureColumn("model_catalog_observations", "schema_version", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("model_catalog_observations", "source_version", "TEXT");
  }

  loadActive(): StoredCatalogSnapshot[] {
    const rows = this.db.prepare(`
      SELECT g.scope_key, g.generation, g.checksum, g.snapshot_json, g.published_at
      FROM model_catalog_scopes s
      JOIN model_catalog_generations g ON g.generation = s.active_generation
      ORDER BY g.scope_key
    `).all() as Array<Record<string, unknown>>;
    return rows.flatMap((row) => {
      try {
        return [{
          scopeKey: String(row.scope_key),
          generation: Number(row.generation),
          checksum: String(row.checksum),
          candidate: JSON.parse(String(row.snapshot_json)) as AdapterCatalogCandidate,
          publishedAt: String(row.published_at),
        }];
      } catch {
        return [];
      }
    });
  }

  loadObservations(): CatalogObservationRow[] {
    const rows = this.db.prepare("SELECT * FROM model_catalog_observations ORDER BY binding_key").all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      bindingKey: String(row.binding_key),
      agentId: String(row.agent_id),
      location: String(row.location),
      scopeKey: String(row.scope_key),
      checksum: String(row.checksum),
      adapterVersion: Number(row.adapter_version),
      schemaVersion: Number(row.schema_version),
      cliVersion: row.cli_version == null ? null : String(row.cli_version),
      sourceVersion: row.source_version == null ? null : String(row.source_version),
      source: String(row.source),
      fetchedAt: String(row.fetched_at),
      drift: row.drift == null ? null : String(row.drift),
    }));
  }

  getRefreshStatus(bindingKey: string): CatalogRefreshStatusRow | null {
    const row = this.db.prepare("SELECT * FROM model_catalog_refresh_status WHERE binding_key = ?").get(bindingKey) as Record<string, unknown> | undefined;
    return row ? {
      bindingKey: String(row.binding_key), attemptedAt: String(row.attempted_at),
      result: String(row.result), error: row.error == null ? null : String(row.error),
      source: row.source == null ? null : String(row.source),
      candidateChecksum: row.candidate_checksum == null ? null : String(row.candidate_checksum),
    } : null;
  }

  bindingMigration(migrationId: string): CatalogBindingMigrationRow | null {
    const row = this.db.prepare(
      "SELECT * FROM model_catalog_binding_migrations WHERE migration_id = ?"
    ).get(migrationId) as Record<string, unknown> | undefined;
    return row ? this.mapBindingMigration(row) : null;
  }

  pendingBindingMigration(targetBindingKey: string): CatalogBindingMigrationRow | null {
    const rows = this.db.prepare(
      `SELECT * FROM model_catalog_binding_migrations
       WHERE target_binding_key = ? AND status = 'pending-proof'
       ORDER BY migration_id`
    ).all(targetBindingKey) as Array<Record<string, unknown>>;
    if (rows.length > 1) throw new Error(`multiple pending catalog binding migrations for ${targetBindingKey}`);
    return rows[0] ? this.mapBindingMigration(rows[0]) : null;
  }

  /**
   * Prepare a versioned binding rename without inventing an observation.
   *
   * A healthy old binding is renamed atomically. If a failed deployment has
   * already overwritten that row, only a pending proof is stored; the service
   * must compare a NEW candidate with the immutable active generation before
   * the target becomes authoritative.
   */
  prepareBindingMigration(input: {
    migrationId: string;
    sourceBinding: { agentId: string; location: string };
    targetBinding: { agentId: string; location: string };
    scopeKey: string;
    source: string;
    now?: string;
  }): PrepareCatalogBindingMigrationResult {
    return this.db.transaction(() => {
      const existing = this.bindingMigration(input.migrationId);
      if (existing) {
        return existing.status === "complete" ? "already-complete" : "already-pending-proof";
      }
      const sourceBindingKey = `${input.sourceBinding.agentId}@${input.sourceBinding.location}`;
      const targetBindingKey = `${input.targetBinding.agentId}@${input.targetBinding.location}`;
      const now = input.now ?? new Date().toISOString();
      const active = this.db.prepare(`
        SELECT g.generation, g.checksum, g.snapshot_json
        FROM model_catalog_scopes s
        JOIN model_catalog_generations g ON g.generation = s.active_generation
        WHERE s.scope_key = ?
      `).get(input.scopeKey) as { generation: number; checksum: string; snapshot_json: string } | undefined;

      if (!active) {
        this.insertBindingMigration({
          migrationId: input.migrationId,
          sourceBindingKey,
          targetBindingKey,
          scopeKey: null,
          source: input.source,
          activeGeneration: null,
          activeChecksum: null,
          continuityFingerprint: null,
          status: "complete",
          createdAt: now,
          completedAt: now,
        });
        return "fresh";
      }

      let activeCandidate: AdapterCatalogCandidate;
      try {
        activeCandidate = normalizeCatalogCandidate(
          JSON.parse(active.snapshot_json) as AdapterCatalogCandidate
        );
        validateCatalogEvidence(activeCandidate);
        assertCatalogSemantics(activeCandidate);
      } catch {
        throw new Error("catalog binding migration found malformed active generation");
      }
      if (
        `scope:${activeCandidate.scope?.fingerprint ?? ""}` !== input.scopeKey ||
        activeCandidate.source !== input.source ||
        catalogContentChecksum(activeCandidate) !== String(active.checksum)
      ) {
        throw new Error("catalog binding migration active generation does not match expected identity");
      }

      const sourceObservation = this.db.prepare(
        "SELECT * FROM model_catalog_observations WHERE binding_key = ?"
      ).get(sourceBindingKey) as Record<string, unknown> | undefined;
      const targetObservation = this.db.prepare(
        "SELECT * FROM model_catalog_observations WHERE binding_key = ?"
      ).get(targetBindingKey) as Record<string, unknown> | undefined;
      if (targetObservation && (
        String(targetObservation.scope_key) !== input.scopeKey ||
        String(targetObservation.source) !== input.source ||
        String(targetObservation.agent_id) !== input.targetBinding.agentId ||
        String(targetObservation.location) !== input.targetBinding.location
      )) {
        throw new Error("ambiguous catalog binding migration target ownership");
      }

      const sourceIsActive = Boolean(
        sourceObservation &&
        String(sourceObservation.agent_id) === input.sourceBinding.agentId &&
        String(sourceObservation.location) === input.sourceBinding.location &&
        String(sourceObservation.scope_key) === input.scopeKey &&
        String(sourceObservation.checksum) === String(active.checksum) &&
        String(sourceObservation.source) === input.source &&
        sourceObservation.drift == null
      );
      const targetIsActive = Boolean(
        targetObservation &&
        String(targetObservation.checksum) === String(active.checksum) &&
        targetObservation.drift == null
      );
      const status: CatalogBindingMigrationStatus = (sourceIsActive && !targetObservation) || targetIsActive
        ? "complete"
        : "pending-proof";
      this.insertBindingMigration({
        migrationId: input.migrationId,
        sourceBindingKey,
        targetBindingKey,
        scopeKey: input.scopeKey,
        source: input.source,
        activeGeneration: Number(active.generation),
        activeChecksum: String(active.checksum),
        continuityFingerprint: catalogBindingContinuityFingerprint(activeCandidate),
        status,
        createdAt: now,
        completedAt: status === "complete" ? now : null,
      });

      if (sourceIsActive && !targetObservation) {
        this.db.prepare(`UPDATE model_catalog_observations
          SET binding_key = ?, agent_id = ?, location = ? WHERE binding_key = ?`)
          .run(targetBindingKey, input.targetBinding.agentId, input.targetBinding.location, sourceBindingKey);
        for (const table of ["model_catalog_refresh_status", "model_catalog_reduction_quarantine"]) {
          const targetExists = this.db.prepare(`SELECT 1 FROM ${table} WHERE binding_key = ?`).get(targetBindingKey);
          if (!targetExists) this.db.prepare(`UPDATE ${table} SET binding_key = ? WHERE binding_key = ?`)
            .run(targetBindingKey, sourceBindingKey);
        }
        return "renamed";
      }
      return status === "complete" ? "already-complete" : "pending-proof";
    })();
  }

  completeBindingMigrationProof(input: {
    migrationId: string;
    targetBindingKey: string;
    scopeKey: string;
    activeGeneration: number;
    activeChecksum: string;
    completedAt: string;
  }): boolean {
    return this.db.prepare(`UPDATE model_catalog_binding_migrations
      SET status = 'complete', completed_at = ?
      WHERE migration_id = ? AND target_binding_key = ? AND scope_key = ?
        AND active_generation = ? AND active_checksum = ? AND status = 'pending-proof'`)
      .run(
        input.completedAt,
        input.migrationId,
        input.targetBindingKey,
        input.scopeKey,
        input.activeGeneration,
        input.activeChecksum,
      ).changes === 1;
  }

  publish(input: {
    scopeKey: string;
    checksum: string;
    candidate: AdapterCatalogCandidate;
    publishedAt: string;
    observation: CatalogObservationRow;
    bindingMigrationProof?: Parameters<ModelCatalogStore["completeBindingMigrationProof"]>[0];
  }): StoredCatalogSnapshot {
    return this.db.transaction(() => {
      const inserted = this.db.prepare(`
        INSERT INTO model_catalog_generations(scope_key, checksum, snapshot_json, published_at)
        VALUES (?, ?, ?, ?)
      `).run(input.scopeKey, input.checksum, JSON.stringify(input.candidate), input.publishedAt);
      const generation = Number(inserted.lastInsertRowid);
      this.db.prepare(`
        INSERT INTO model_catalog_scopes(scope_key, active_generation, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(scope_key) DO UPDATE SET active_generation=excluded.active_generation, updated_at=excluded.updated_at
      `).run(input.scopeKey, generation, input.publishedAt);
      this.upsertObservation(input.observation);
      if (input.bindingMigrationProof && !this.completeBindingMigrationProof(input.bindingMigrationProof)) {
        throw new Error("catalog binding migration proof was already consumed or changed");
      }
      return { scopeKey: input.scopeKey, generation, checksum: input.checksum, candidate: input.candidate, publishedAt: input.publishedAt };
    })();
  }

  recordObservation(
    row: CatalogObservationRow,
    bindingMigrationProof?: Parameters<ModelCatalogStore["completeBindingMigrationProof"]>[0],
  ): void {
    this.db.transaction(() => {
      this.upsertObservation(row);
      if (bindingMigrationProof && !this.completeBindingMigrationProof(bindingMigrationProof)) {
        throw new Error("catalog binding migration proof was already consumed or changed");
      }
    })();
  }

  private upsertObservation(row: CatalogObservationRow): void {
    this.db.prepare(`
      INSERT INTO model_catalog_observations(
        binding_key, agent_id, location, scope_key, checksum, adapter_version,
        schema_version, cli_version, source_version, source, fetched_at, drift
      ) VALUES (@bindingKey, @agentId, @location, @scopeKey, @checksum, @adapterVersion,
        @schemaVersion, @cliVersion, @sourceVersion, @source, @fetchedAt, @drift)
      ON CONFLICT(binding_key) DO UPDATE SET
        agent_id=excluded.agent_id, location=excluded.location, scope_key=excluded.scope_key,
        checksum=excluded.checksum, adapter_version=excluded.adapter_version,
        schema_version=excluded.schema_version, cli_version=excluded.cli_version,
        source_version=excluded.source_version, source=excluded.source,
        fetched_at=excluded.fetched_at, drift=excluded.drift
    `).run(row);
  }

  /** The reduction quarantine a confirmation must match, if any. */
  getReductionQuarantine(bindingKey: string): CatalogReductionQuarantineRow | null {
    const row = this.db
      .prepare("SELECT * FROM model_catalog_reduction_quarantine WHERE binding_key = ?")
      .get(bindingKey) as Record<string, unknown> | undefined;
    if (!row) return null;
    let removed: string[] = [];
    try {
      const parsed: unknown = JSON.parse(String(row.removed_json));
      if (Array.isArray(parsed)) removed = parsed.map(String);
    } catch { return null; }
    return {
      bindingKey: String(row.binding_key),
      scopeKey: String(row.scope_key),
      priorGeneration: Number(row.prior_generation),
      rule: String(row.rule),
      removed,
      fingerprint: String(row.fingerprint),
      observedAt: String(row.observed_at),
    };
  }

  recordReductionQuarantine(row: CatalogReductionQuarantineRow): void {
    this.db.prepare(`
      INSERT INTO model_catalog_reduction_quarantine(
        binding_key, scope_key, prior_generation, rule, removed_json, fingerprint, observed_at
      ) VALUES (@bindingKey, @scopeKey, @priorGeneration, @rule, @removedJson, @fingerprint, @observedAt)
      ON CONFLICT(binding_key) DO UPDATE SET
        scope_key=excluded.scope_key, prior_generation=excluded.prior_generation,
        rule=excluded.rule, removed_json=excluded.removed_json,
        fingerprint=excluded.fingerprint, observed_at=excluded.observed_at
    `).run({ ...row, removedJson: JSON.stringify(row.removed) });
  }

  /** Called on EVERY attempt that is not an identical repeat of the quarantine. */
  clearReductionQuarantine(bindingKey: string): void {
    this.db.prepare("DELETE FROM model_catalog_reduction_quarantine WHERE binding_key = ?").run(bindingKey);
  }

  recordAttempt(row: CatalogRefreshStatusRow): void {
    this.db.prepare(`
      INSERT INTO model_catalog_refresh_status(binding_key, attempted_at, result, error, source, candidate_checksum)
      VALUES (@bindingKey, @attemptedAt, @result, @error, @source, @candidateChecksum)
      ON CONFLICT(binding_key) DO UPDATE SET attempted_at=excluded.attempted_at,
        result=excluded.result, error=excluded.error, source=excluded.source,
        candidate_checksum=excluded.candidate_checksum
    `).run(row);
  }

  private insertBindingMigration(row: CatalogBindingMigrationRow): void {
    this.db.prepare(`INSERT INTO model_catalog_binding_migrations(
      migration_id, source_binding_key, target_binding_key, scope_key, source,
      active_generation, active_checksum, continuity_fingerprint, status,
      created_at, completed_at
    ) VALUES (
      @migrationId, @sourceBindingKey, @targetBindingKey, @scopeKey, @source,
      @activeGeneration, @activeChecksum, @continuityFingerprint, @status,
      @createdAt, @completedAt
    )`).run(row);
  }

  private mapBindingMigration(row: Record<string, unknown>): CatalogBindingMigrationRow {
    return {
      migrationId: String(row.migration_id),
      sourceBindingKey: String(row.source_binding_key),
      targetBindingKey: String(row.target_binding_key),
      scopeKey: row.scope_key == null ? null : String(row.scope_key),
      source: String(row.source),
      activeGeneration: row.active_generation == null ? null : Number(row.active_generation),
      activeChecksum: row.active_checksum == null ? null : String(row.active_checksum),
      continuityFingerprint: row.continuity_fingerprint == null ? null : String(row.continuity_fingerprint),
      status: String(row.status) as CatalogBindingMigrationStatus,
      createdAt: String(row.created_at),
      completedAt: row.completed_at == null ? null : String(row.completed_at),
    };
  }

  private ensureColumn(table: string, column: string, declaration: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((entry) => entry.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
    }
  }

  /**
   * Early #229 builds de-duplicated (scope, checksum), which let A→B→A point
   * the active scope backwards to generation 1. Rebuild the table once so
   * every publication is a new immutable, strictly increasing generation.
   */
  private migrateGenerationDedupConstraint(): void {
    const row = this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='model_catalog_generations'"
    ).get() as { sql?: string } | undefined;
    if (!row?.sql || !/UNIQUE\s*\(\s*scope_key\s*,\s*checksum\s*\)/i.test(row.sql)) return;
    const foreignKeys = Number(this.db.pragma("foreign_keys", { simple: true })) === 1;
    if (foreignKeys) this.db.pragma("foreign_keys = OFF");
    try {
      this.db.transaction(() => {
        this.db.exec(`
        CREATE TABLE model_catalog_generations_next (
          generation INTEGER PRIMARY KEY AUTOINCREMENT,
          scope_key TEXT NOT NULL,
          checksum TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          published_at TEXT NOT NULL
        );
        INSERT INTO model_catalog_generations_next(
          generation, scope_key, checksum, snapshot_json, published_at
        )
        SELECT generation, scope_key, checksum, snapshot_json, published_at
        FROM model_catalog_generations
        ORDER BY generation;
        DROP TABLE model_catalog_generations;
        ALTER TABLE model_catalog_generations_next RENAME TO model_catalog_generations;
        `);
      })();
    } finally {
      if (foreignKeys) this.db.pragma("foreign_keys = ON");
    }
  }

  close(): void { this.db.close(); }
}

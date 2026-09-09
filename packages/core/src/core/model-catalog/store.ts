import Database from "better-sqlite3";
import type { AdapterCatalogCandidate } from "@seam/adapters";

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

  publish(input: {
    scopeKey: string;
    checksum: string;
    candidate: AdapterCatalogCandidate;
    publishedAt: string;
    observation: CatalogObservationRow;
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
      return { scopeKey: input.scopeKey, generation, checksum: input.checksum, candidate: input.candidate, publishedAt: input.publishedAt };
    })();
  }

  recordObservation(row: CatalogObservationRow): void { this.upsertObservation(row); }

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

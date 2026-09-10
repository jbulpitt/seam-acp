import Database from "better-sqlite3";
import type { MetadataSourceModel, ModelMetadata } from "../model-metadata/types.js";
import type { CopilotPricing, ModelValueScenario, ModelValueSnapshotRow } from "../model-value/types.js";

export type IntelligenceSourceName = "artificial-analysis" | "github-copilot-pricing";
export const MODEL_INTELLIGENCE_SOURCE_HISTORY_LIMIT = 96;
export const MODEL_INTELLIGENCE_GENERATION_HISTORY_LIMIT = 96;
export const MODEL_INTELLIGENCE_SCHEMA_VERSION = 1;

export interface IntelligenceSourceSnapshot<T = unknown> {
  id: number;
  source: IntelligenceSourceName;
  sourceUrl: string;
  parserVersion: string;
  attemptedAt: string;
  fetchedAt: string | null;
  status: "success" | "failure";
  records: T[];
  error: string | null;
}

export interface IntelligenceGeneration {
  generation: number;
  schemaVersion: number;
  matchingPolicyVersion: string;
  publishedAt: string;
  catalogSignature: string;
  sourceSnapshots: Record<IntelligenceSourceName, number | null>;
  scenario: ModelValueScenario;
  diagnostics: string[];
  metadata: ModelMetadata[];
  values: ModelValueSnapshotRow[];
}

export interface IntelligenceRefreshAttempt {
  id: number;
  attemptedAt: string;
  completedAt: string;
  forceSources: boolean;
  result: "published" | "unchanged" | "retained";
  generation: number | null;
  diagnostics: string[];
}

export class ModelIntelligenceStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS model_intelligence_source_snapshots (
        snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        source_url TEXT NOT NULL,
        parser_version TEXT NOT NULL,
        attempted_at TEXT NOT NULL,
        fetched_at TEXT,
        status TEXT NOT NULL CHECK(status IN ('success','failure')),
        records_json TEXT NOT NULL,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_model_intelligence_source_latest
        ON model_intelligence_source_snapshots(source, snapshot_id DESC);
      CREATE TABLE IF NOT EXISTS model_intelligence_generations (
        generation INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_version INTEGER NOT NULL,
        matching_policy_version TEXT NOT NULL,
        published_at TEXT NOT NULL,
        catalog_signature TEXT NOT NULL,
        source_snapshots_json TEXT NOT NULL,
        scenario_json TEXT NOT NULL,
        diagnostics_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        values_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS model_intelligence_active (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        generation INTEGER NOT NULL REFERENCES model_intelligence_generations(generation)
      );
      CREATE TABLE IF NOT EXISTS model_intelligence_refresh_attempts (
        attempt_id INTEGER PRIMARY KEY AUTOINCREMENT,
        attempted_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        force_sources INTEGER NOT NULL,
        result TEXT NOT NULL,
        generation INTEGER,
        diagnostics_json TEXT NOT NULL
      );
    `);
    this.ensureColumn("model_intelligence_generations", "schema_version", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("model_intelligence_generations", "matching_policy_version", "TEXT NOT NULL DEFAULT 'legacy-unknown'");
    this.migrateLegacySnapshot();
  }

  recordSourceSuccess<T>(input: {
    source: IntelligenceSourceName; sourceUrl: string; parserVersion: string;
    attemptedAt: string; fetchedAt: string; records: T[];
  }): IntelligenceSourceSnapshot<T> {
    if (input.records.length === 0) throw new Error(`${input.source} snapshot is empty`);
    return this.db.transaction(() => {
      const result = this.db.prepare(`
        INSERT INTO model_intelligence_source_snapshots
          (source, source_url, parser_version, attempted_at, fetched_at, status, records_json, error)
        VALUES (?, ?, ?, ?, ?, 'success', ?, NULL)
      `).run(input.source, input.sourceUrl, input.parserVersion, input.attemptedAt, input.fetchedAt, JSON.stringify(input.records));
      this.pruneHistory();
      return { id: Number(result.lastInsertRowid), status: "success" as const, error: null, ...input };
    })();
  }

  recordSourceFailure(input: {
    source: IntelligenceSourceName; sourceUrl: string; parserVersion: string;
    attemptedAt: string; error: string;
  }): void {
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO model_intelligence_source_snapshots
          (source, source_url, parser_version, attempted_at, fetched_at, status, records_json, error)
        VALUES (?, ?, ?, ?, NULL, 'failure', '[]', ?)
      `).run(input.source, input.sourceUrl, input.parserVersion, input.attemptedAt, input.error);
      this.pruneHistory();
    })();
  }

  latestSourceSuccess<T>(source: IntelligenceSourceName): IntelligenceSourceSnapshot<T> | null {
    const row = this.db.prepare(`
      SELECT * FROM model_intelligence_source_snapshots
      WHERE source = ? AND status = 'success' ORDER BY snapshot_id DESC LIMIT 1
    `).get(source) as Record<string, unknown> | undefined;
    return row ? mapSource<T>(row) : null;
  }

  latestSourceAttempt<T>(source: IntelligenceSourceName): IntelligenceSourceSnapshot<T> | null {
    const row = this.db.prepare(`
      SELECT * FROM model_intelligence_source_snapshots
      WHERE source = ? ORDER BY snapshot_id DESC LIMIT 1
    `).get(source) as Record<string, unknown> | undefined;
    return row ? mapSource<T>(row) : null;
  }

  sourceSnapshot<T>(id: number): IntelligenceSourceSnapshot<T> | null {
    const row = this.db.prepare(`SELECT * FROM model_intelligence_source_snapshots WHERE snapshot_id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapSource<T>(row) : null;
  }

  publish(input: Omit<IntelligenceGeneration, "generation" | "schemaVersion">): IntelligenceGeneration {
    if (input.metadata.length === 0) throw new Error("refusing to publish empty model intelligence generation");
    if (new Set(input.metadata.map((row) => row.variant_id ?? row.id)).size !== input.metadata.length) {
      throw new Error("model intelligence generation contains duplicate variant ids");
    }
    if (new Set(input.values.map((row) => row.variantId ?? row.copilotModel)).size !== input.values.length) {
      throw new Error("model intelligence generation contains duplicate value variant ids");
    }
    const metadataVariants = new Set(input.metadata.map((row) => row.variant_id ?? row.id));
    if (input.values.some((row) => !metadataVariants.has(row.variantId ?? row.copilotModel))) {
      throw new Error("model intelligence value row has no matching metadata variant");
    }
    for (const [source, id] of Object.entries(input.sourceSnapshots) as Array<[IntelligenceSourceName, number | null]>) {
      if (id === null) continue;
      const snapshot = this.sourceSnapshot(id);
      if (!snapshot || snapshot.status !== "success" || snapshot.source !== source) {
        throw new Error(`model intelligence generation references invalid ${source} source snapshot ${id}`);
      }
    }
    return this.db.transaction(() => {
      const inserted = this.db.prepare(`
        INSERT INTO model_intelligence_generations
          (schema_version, matching_policy_version, published_at, catalog_signature, source_snapshots_json, scenario_json,
           diagnostics_json, metadata_json, values_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(MODEL_INTELLIGENCE_SCHEMA_VERSION, input.matchingPolicyVersion,
        input.publishedAt, input.catalogSignature, JSON.stringify(input.sourceSnapshots),
        JSON.stringify(input.scenario), JSON.stringify(input.diagnostics),
        JSON.stringify(input.metadata), JSON.stringify(input.values));
      const generation = Number(inserted.lastInsertRowid);
      const metadata = input.metadata.map((row) => ({ ...row, enrichment_generation: generation }));
      const values = input.values.map((row) => ({ ...row, enrichmentGeneration: generation }));
      this.db.prepare(`UPDATE model_intelligence_generations SET metadata_json = ?, values_json = ? WHERE generation = ?`)
        .run(JSON.stringify(metadata), JSON.stringify(values), generation);
      this.db.prepare(`
        INSERT INTO model_intelligence_active(singleton, generation) VALUES (1, ?)
        ON CONFLICT(singleton) DO UPDATE SET generation = excluded.generation
      `).run(generation);
      this.pruneHistory();
      return { generation, schemaVersion: MODEL_INTELLIGENCE_SCHEMA_VERSION, ...input, metadata, values };
    })();
  }

  active(): IntelligenceGeneration | null {
    const row = this.db.prepare(`
      SELECT g.* FROM model_intelligence_generations g
      JOIN model_intelligence_active a ON a.generation = g.generation
      WHERE a.singleton = 1
    `).get() as Record<string, unknown> | undefined;
    return row ? mapGeneration(row) : null;
  }

  recordRefreshAttempt(input: Omit<IntelligenceRefreshAttempt, "id">): IntelligenceRefreshAttempt {
    const result = this.db.prepare(`
      INSERT INTO model_intelligence_refresh_attempts
        (attempted_at, completed_at, force_sources, result, generation, diagnostics_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(input.attemptedAt, input.completedAt, input.forceSources ? 1 : 0,
      input.result, input.generation, JSON.stringify(input.diagnostics));
    this.pruneHistory();
    return { id: Number(result.lastInsertRowid), ...input };
  }

  latestRefreshAttempt(): IntelligenceRefreshAttempt | null {
    const row = this.db.prepare(`
      SELECT * FROM model_intelligence_refresh_attempts ORDER BY attempt_id DESC LIMIT 1
    `).get() as Record<string, unknown> | undefined;
    return row ? {
      id: Number(row.attempt_id), attemptedAt: String(row.attempted_at), completedAt: String(row.completed_at),
      forceSources: Number(row.force_sources) === 1,
      result: String(row.result) as IntelligenceRefreshAttempt["result"],
      generation: row.generation === null ? null : Number(row.generation),
      diagnostics: JSON.parse(String(row.diagnostics_json)) as string[],
    } : null;
  }

  close(): void { this.db.close(); }

  private ensureColumn(table: string, column: string, declaration: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((entry) => entry.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
    }
  }

  private pruneHistory(): void {
    const active = this.db.prepare("SELECT generation FROM model_intelligence_active WHERE singleton = 1")
      .get() as { generation: number } | undefined;
    const generations = this.db.prepare("SELECT generation FROM model_intelligence_generations ORDER BY generation DESC")
      .all() as Array<{ generation: number }>;
    const keepGenerations = new Set(generations.slice(0, MODEL_INTELLIGENCE_GENERATION_HISTORY_LIMIT)
      .map((row) => row.generation));
    if (active) keepGenerations.add(active.generation);
    const deleteGeneration = this.db.prepare("DELETE FROM model_intelligence_generations WHERE generation = ?");
    for (const row of generations) if (!keepGenerations.has(row.generation)) deleteGeneration.run(row.generation);

    const referencedSources = new Set<number>();
    const sourceRefs = this.db.prepare("SELECT source_snapshots_json FROM model_intelligence_generations").all() as Array<{
      source_snapshots_json: string;
    }>;
    for (const row of sourceRefs) {
      const parsed = JSON.parse(row.source_snapshots_json) as Record<string, number | null>;
      for (const id of Object.values(parsed)) if (typeof id === "number") referencedSources.add(id);
    }
    const attempts = this.db.prepare(`
      SELECT snapshot_id, source FROM model_intelligence_source_snapshots
      ORDER BY source, snapshot_id DESC
    `).all() as Array<{ snapshot_id: number; source: IntelligenceSourceName }>;
    const retainedPerSource = new Map<IntelligenceSourceName, number>();
    const deleteSource = this.db.prepare("DELETE FROM model_intelligence_source_snapshots WHERE snapshot_id = ?");
    for (const row of attempts) {
      const retained = retainedPerSource.get(row.source) ?? 0;
      if (retained < MODEL_INTELLIGENCE_SOURCE_HISTORY_LIMIT) {
        retainedPerSource.set(row.source, retained + 1);
      } else if (!referencedSources.has(row.snapshot_id)) {
        deleteSource.run(row.snapshot_id);
      }
    }
    const refreshAttempts = this.db.prepare(`
      SELECT attempt_id FROM model_intelligence_refresh_attempts ORDER BY attempt_id DESC
    `).all() as Array<{ attempt_id: number }>;
    const deleteRefresh = this.db.prepare("DELETE FROM model_intelligence_refresh_attempts WHERE attempt_id = ?");
    for (const row of refreshAttempts.slice(MODEL_INTELLIGENCE_GENERATION_HISTORY_LIMIT)) {
      deleteRefresh.run(row.attempt_id);
    }
  }

  /** Non-destructive bridge from #130/#134: retain their tables for rollback. */
  private migrateLegacySnapshot(): void {
    const active = this.db.prepare("SELECT generation FROM model_intelligence_active WHERE singleton = 1").get();
    if (active) return;
    const tables = new Set((this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name: string}>).map((r) => r.name));
    if (!tables.has("model_metadata") && !tables.has("model_value_snapshot")) return;
    // Legacy rows are intentionally tagged unknown rather than pretending that
    // their independent fetch timestamps were a coordinated generation.
    const metadata = tables.has("model_metadata")
      ? this.db.prepare("SELECT model_id, name, fetched_at FROM model_metadata ORDER BY model_id").all() as Array<{
          model_id: string; name: string; fetched_at: string;
        }>
      : [];
    if (metadata.length === 0) return;
    const publishedAt = new Date(0).toISOString();
    this.publish({
      publishedAt, catalogSignature: "legacy-unknown",
      matchingPolicyVersion: "legacy-unknown",
      sourceSnapshots: { "artificial-analysis": null, "github-copilot-pricing": null },
      scenario: { uncached_input_tokens: 8_000, cached_input_tokens: 0, cache_write_tokens: 0, output_tokens: 2_000, long_context_threshold_tokens: 200_000 },
      diagnostics: ["legacy snapshot provenance is unknown"],
      metadata: metadata.map((row) => ({
        id: row.model_id, name: row.name, aliases: [], slug: null,
        source_id: null, source_name: null, provider: null, creator: null, agents: [], agent_models: [],
        context_window: null, intelligence_index: null, benchmarks: {}, pricing: null, released_at: null,
        description: null, evidence: [], source: "legacy-unknown", fetched_at: row.fetched_at,
      })),
      values: [],
    });
  }
}

function mapSource<T>(row: Record<string, unknown>): IntelligenceSourceSnapshot<T> {
  return {
    id: Number(row.snapshot_id), source: String(row.source) as IntelligenceSourceName,
    sourceUrl: String(row.source_url), parserVersion: String(row.parser_version),
    attemptedAt: String(row.attempted_at), fetchedAt: row.fetched_at ? String(row.fetched_at) : null,
    status: String(row.status) as "success" | "failure", records: JSON.parse(String(row.records_json)) as T[],
    error: row.error ? String(row.error) : null,
  };
}

function mapGeneration(row: Record<string, unknown>): IntelligenceGeneration {
  return {
    generation: Number(row.generation), schemaVersion: Number(row.schema_version),
    matchingPolicyVersion: String(row.matching_policy_version),
    publishedAt: String(row.published_at), catalogSignature: String(row.catalog_signature),
    sourceSnapshots: JSON.parse(String(row.source_snapshots_json)), scenario: JSON.parse(String(row.scenario_json)),
    diagnostics: JSON.parse(String(row.diagnostics_json)), metadata: JSON.parse(String(row.metadata_json)),
    values: JSON.parse(String(row.values_json)),
  };
}

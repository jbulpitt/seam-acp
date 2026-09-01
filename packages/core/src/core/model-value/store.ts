import Database from "better-sqlite3";
import { rankSnapshotRows } from "./ranking.js";
import {
  DEFAULT_MODEL_VALUE_BENCHMARK,
  type ModelValueRankingsResult,
  type ModelValueSnapshotRow,
  type ModelValueTier,
} from "./types.js";

interface DbRow {
  copilot_model: string;
  aa_slug: string | null;
  tier: ModelValueTier | null;
  intelligence_index: number | null;
  benchmarks_json: string;
  input_rate: number | null;
  cached_input_rate: number | null;
  cache_write_rate: number | null;
  output_rate: number | null;
  credits_per_task: number | null;
  value_score: number | null;
  valid_effort_tiers_json: string;
  price_category: string | null;
  fetched_at: string;
}

export class ModelValueStore {
  private readonly db: Database.Database;
  private readonly inputTokens: number;
  private readonly outputTokens: number;

  constructor(dbPath: string, standardTask: { inputTokens: number; outputTokens: number }) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.inputTokens = standardTask.inputTokens;
    this.outputTokens = standardTask.outputTokens;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS model_value_snapshot (
        copilot_model TEXT NOT NULL,
        aa_slug TEXT,
        tier TEXT,
        intelligence_index REAL,
        benchmarks_json TEXT NOT NULL,
        input_rate REAL,
        cached_input_rate REAL,
        cache_write_rate REAL,
        output_rate REAL,
        credits_per_task REAL,
        value_score REAL,
        valid_effort_tiers_json TEXT NOT NULL,
        price_category TEXT,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (fetched_at, copilot_model)
      );
      CREATE INDEX IF NOT EXISTS idx_model_value_snapshot_latest
        ON model_value_snapshot(fetched_at DESC);
    `);
  }

  saveSnapshot(rows: ModelValueSnapshotRow[]): void {
    if (rows.length === 0) throw new Error("refusing to persist an empty model value snapshot");
    const fetchedAt = rows[0]!.fetchedAt;
    if (rows.some((row) => row.fetchedAt !== fetchedAt)) {
      throw new Error("model value snapshot rows have inconsistent fetchedAt values");
    }
    const insert = this.db.prepare(`
      INSERT INTO model_value_snapshot (
        copilot_model, aa_slug, tier, intelligence_index, benchmarks_json,
        input_rate, cached_input_rate, cache_write_rate, output_rate,
        credits_per_task, value_score, valid_effort_tiers_json,
        price_category, fetched_at
      ) VALUES (
        @copilot_model, @aa_slug, @tier, @intelligence_index, @benchmarks_json,
        @input_rate, @cached_input_rate, @cache_write_rate, @output_rate,
        @credits_per_task, @value_score, @valid_effort_tiers_json,
        @price_category, @fetched_at
      )
    `);
    this.db.transaction((snapshot: ModelValueSnapshotRow[]) => {
      this.db.prepare("DELETE FROM model_value_snapshot WHERE fetched_at = ?").run(fetchedAt);
      for (const row of snapshot) {
        insert.run({
          copilot_model: row.copilotModel,
          aa_slug: row.aaSlug,
          tier: row.tier,
          intelligence_index: row.intelligenceIndex,
          benchmarks_json: JSON.stringify(row.benchmarks),
          input_rate: row.inputRate,
          cached_input_rate: row.cachedInputRate,
          cache_write_rate: row.cacheWriteRate,
          output_rate: row.outputRate,
          credits_per_task: row.creditsPerTask,
          value_score: row.valueScore,
          valid_effort_tiers_json: JSON.stringify(row.validEffortTiers),
          price_category: row.priceCategory,
          fetched_at: row.fetchedAt,
        });
      }
    })(rows);
  }

  getLatestRows(): ModelValueSnapshotRow[] {
    const latest = this.db
      .prepare("SELECT MAX(fetched_at) AS fetched_at FROM model_value_snapshot")
      .get() as { fetched_at: string | null } | undefined;
    if (!latest?.fetched_at) return [];
    const rows = this.db
      .prepare("SELECT * FROM model_value_snapshot WHERE fetched_at = ?")
      .all(latest.fetched_at) as DbRow[];
    return rows.map((row) => ({
      copilotModel: row.copilot_model,
      aaSlug: row.aa_slug,
      tier: row.tier,
      intelligenceIndex: row.intelligence_index,
      benchmarks: parseNumberMap(row.benchmarks_json),
      inputRate: row.input_rate,
      cachedInputRate: row.cached_input_rate,
      cacheWriteRate: row.cache_write_rate,
      outputRate: row.output_rate,
      creditsPerTask: row.credits_per_task,
      valueScore: row.value_score,
      validEffortTiers: parseStringArray(row.valid_effort_tiers_json),
      priceCategory: row.price_category,
      fetchedAt: row.fetched_at,
    }));
  }

  getRankings(options: { tier?: string; benchmark?: string } = {}): ModelValueRankingsResult {
    if (options.tier && !["flagship", "balanced", "flash"].includes(options.tier)) {
      throw new Error(`unknown model value tier: ${options.tier}`);
    }
    const rows = this.getLatestRows();
    const benchmark = options.benchmark?.trim() || DEFAULT_MODEL_VALUE_BENCHMARK;
    let rankings = rankSnapshotRows(rows, benchmark);
    if (options.tier) rankings = rankings.filter((row) => row.tier === options.tier);
    return {
      benchmark: benchmark === "intelligence_index" ? DEFAULT_MODEL_VALUE_BENCHMARK : benchmark,
      fetched_at: rows[0]?.fetchedAt ?? null,
      standard_task: { input_tokens: this.inputTokens, output_tokens: this.outputTokens },
      rankings,
    };
  }

  close(): void {
    this.db.close();
  }
}

function parseNumberMap(value: string): Record<string, number> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, number] =>
        typeof entry[1] === "number" && Number.isFinite(entry[1])
      )
    );
  } catch {
    return {};
  }
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

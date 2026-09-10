import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import type { ScheduledPrompt } from "./types.js";

export interface ScheduledOccurrenceKey { id: string; scheduledFor: string | null }
export const scheduledOccurrenceKey = (scheduleId: string, scheduledFor?: string): ScheduledOccurrenceKey => ({
  id: `scheduled-${scheduledFor ? createHash("sha256").update(JSON.stringify([scheduleId, scheduledFor])).digest("hex") : randomUUID()}`,
  scheduledFor: scheduledFor ?? null,
});
export interface ScheduledExecutionIdentity {
  agentId: string; location: string; model: string; effort: string | null; cwd: string; fingerprint: string;
}
export interface ScheduledOccurrence extends ScheduledOccurrenceKey {
  scheduleId: string; row: ScheduledPrompt; execution: ScheduledExecutionIdentity | null; settled: boolean;
}
export type PreparedScheduledOccurrence = ScheduledOccurrence & { execution: ScheduledExecutionIdentity };

/** Admission/linkage for #250's shared attempt store, not another job engine.
 * Frozen snapshots are private; diagnostics may project selected metadata only. */
export class ScheduledOccurrenceStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS scheduled_occurrences (
      id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, scheduled_for TEXT,
      snapshot_json TEXT NOT NULL, execution_json TEXT NOT NULL, settled INTEGER NOT NULL DEFAULT 0
    ); CREATE INDEX IF NOT EXISTS idx_scheduled_occurrence_pending ON scheduled_occurrences(schedule_id,settled);`);
  }
  get(id: string): ScheduledOccurrence | null {
    const r = this.db.prepare("SELECT * FROM scheduled_occurrences WHERE id=?").get(id) as
      { id: string; schedule_id: string; scheduled_for: string | null; snapshot_json: string; execution_json: string; settled: number } | undefined;
    return r ? { id: r.id, scheduleId: r.schedule_id, scheduledFor: r.scheduled_for,
      row: JSON.parse(r.snapshot_json), execution: JSON.parse(r.execution_json), settled: r.settled === 1 } : null;
  }
  /** Per-schedule durable overlap guard, preserving skip-not-stack policy. */
  reserve(key: ScheduledOccurrenceKey, row: ScheduledPrompt, execution: ScheduledExecutionIdentity | null = null): ScheduledOccurrence | null {
    return this.db.transaction(() => {
      const old = this.get(key.id);
      if (old) return old.scheduleId === row.id ? old : null;
      if (this.db.prepare("SELECT 1 FROM scheduled_occurrences WHERE schedule_id=? AND settled=0").get(row.id)) return null;
      this.db.prepare("INSERT INTO scheduled_occurrences VALUES (?,?,?,?,?,0)")
        .run(key.id, row.id, key.scheduledFor, JSON.stringify(row), JSON.stringify(execution));
      return this.get(key.id)!;
    }).immediate();
  }
  /** Commit intent before fallible resolution. JSON null is an admitted but
   * non-runnable occurrence, never evidence that submitted work can be replayed.
   * Existing ready snapshots are immutable; unknown prior execution fails closed. */
  prepare(key: ScheduledOccurrenceKey, row: ScheduledPrompt,
    resolve: (row: ScheduledPrompt) => ScheduledExecutionIdentity): PreparedScheduledOccurrence | null {
    const occurrence = this.reserve(key, row);
    if (!occurrence) return null;
    if (occurrence.execution) return occurrence as PreparedScheduledOccurrence;
    if (occurrence.settled || this.db.prepare("SELECT 1 FROM turn_attempts WHERE id=?").get(key.id)) return null;
    const execution = resolve(occurrence.row);
    this.db.prepare(`UPDATE scheduled_occurrences SET execution_json=?
      WHERE id=? AND execution_json='null' AND settled=0
      AND NOT EXISTS (SELECT 1 FROM turn_attempts WHERE id=?)`)
      .run(JSON.stringify(execution), key.id, key.id);
    const saved = this.get(key.id);
    return saved?.execution ? saved as PreparedScheduledOccurrence : null;
  }
  pending(): ScheduledOccurrence[] {
    return (this.db.prepare("SELECT id FROM scheduled_occurrences WHERE settled=0 ORDER BY rowid").all() as { id: string }[])
      .map(r => this.get(r.id)!);
  }
  settle(id: string): void { this.db.prepare("UPDATE scheduled_occurrences SET settled=1 WHERE id=?").run(id); }
}

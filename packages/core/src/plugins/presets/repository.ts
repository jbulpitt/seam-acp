import Database from "better-sqlite3";
import { parseStatusCardStyle, type Preset, type PermissionPolicyMode } from "../../core/types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS presets (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  project_ref   TEXT,
  description   TEXT,
  agent_id      TEXT,
  model         TEXT,
  effort        TEXT,
  repo_path     TEXT,
  role          TEXT,
  disable_thread_prefix INTEGER,
  permission    TEXT,
  tools_json    TEXT,
  instructions  TEXT,
  status_card_style TEXT,
  created_by    TEXT NOT NULL,
  created_utc   TEXT NOT NULL,
  updated_utc   TEXT NOT NULL
);
-- The per-scope unique index (idx_presets_name_scope) is created in
-- migratePresetsScope(), not here: on a legacy DB the presets table predates the
-- project_ref column, so the index must wait until that column has been added.
`;

interface PresetRow {
  id: string;
  name: string;
  project_ref: string | null;
  description: string | null;
  agent_id: string | null;
  model: string | null;
  effort: string | null;
  repo_path: string | null;
  role: string | null;
  disable_thread_prefix: number | null;
  permission: string | null;
  tools_json: string | null;
  instructions: string | null;
  status_card_style: string | null;
  created_by: string;
  created_utc: string;
  updated_utc: string;
}

const mapPreset = (r: PresetRow): Preset => {
  let toolsAllow: string[] | null = null;
  let toolsExclude: string[] | null = null;
  if (r.tools_json) {
    try {
      const parsed = JSON.parse(r.tools_json) as {
        allow?: string[];
        exclude?: string[];
      };
      if (parsed.allow) toolsAllow = parsed.allow;
      if (parsed.exclude) toolsExclude = parsed.exclude;
    } catch {
      /* corrupt json — treat as "no tool overrides" rather than failing the read */
    }
  }
  return {
    id: r.id,
    name: r.name,
    projectRef: r.project_ref,
    description: r.description,
    agentId: r.agent_id,
    model: r.model,
    effort: r.effort,
    repoPath: r.repo_path,
    role: r.role,
    disableThreadPrefix:
      r.disable_thread_prefix === null ? null : r.disable_thread_prefix !== 0,
    permission: r.permission as PermissionPolicyMode | null,
    toolsAllow,
    toolsExclude,
    instructions: r.instructions,
    statusCardStyle: parseStatusCardStyle(r.status_card_style) ?? null,
    createdBy: r.created_by,
    createdUtc: r.created_utc,
    updatedUtc: r.updated_utc,
  };
};


/** Owns the legacy preset table; the host retains its database path. */
export class PresetRepository {
  constructor(private readonly db: Database.Database) {
    db.exec(SCHEMA);
    this.migratePresetStatusCardStyle();
    this.migratePresetsScope();
    this.migratePresetRole();
  }


  private migratePresetStatusCardStyle(): void {
    try {
      this.db.exec("ALTER TABLE presets ADD COLUMN status_card_style TEXT");
    } catch {
      /* column already exists */
    }
  }

  private migratePresetsScope(): void {
    // 1. Add the scope column if an older schema lacks it.
    try {
      this.db.exec("ALTER TABLE presets ADD COLUMN project_ref TEXT");
    } catch { /* column already exists */ }

    // 2. Rebuild the table only if it still carries the legacy global-unique
    //    `name` constraint (matched from the stored CREATE TABLE text).
    const row = this.db
      .prepare<[], { sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'presets'"
      )
      .get();
    if (row && /\bname\b\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(row.sql)) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE presets__migrate (
            id            TEXT PRIMARY KEY,
            name          TEXT NOT NULL,
            project_ref   TEXT,
            description   TEXT,
            agent_id      TEXT,
            model         TEXT,
            effort        TEXT,
            repo_path     TEXT,
            permission    TEXT,
            tools_json    TEXT,
            instructions  TEXT,
            status_card_style TEXT,
            created_by    TEXT NOT NULL,
            created_utc   TEXT NOT NULL,
            updated_utc   TEXT NOT NULL
          );
          INSERT INTO presets__migrate
            (id, name, project_ref, description, agent_id, model, effort,
             repo_path, permission, tools_json, instructions, status_card_style,
             created_by, created_utc, updated_utc)
          SELECT id, name, project_ref, description, agent_id, model, effort,
                 repo_path, permission, tools_json, instructions, status_card_style,
                 created_by, created_utc, updated_utc
          FROM presets;
          DROP TABLE presets;
          ALTER TABLE presets__migrate RENAME TO presets;
        `);
      })();
    }

    // 3. Retire the legacy name-only index; ensure the per-scope unique index.
    this.db.exec("DROP INDEX IF EXISTS idx_presets_name");
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_presets_name_scope " +
        "ON presets(name COLLATE NOCASE, IFNULL(project_ref, ''))"
    );
  }

  private migratePresetRole(): void {
    for (const ddl of [
      "ALTER TABLE presets ADD COLUMN role TEXT",
      "ALTER TABLE presets ADD COLUMN disable_thread_prefix INTEGER",
    ]) {
      try {
        this.db.exec(ddl);
      } catch {
        /* column already exists */
      }
    }
  }

  upsertPreset(p: Preset): void {
    const toolsJson =
      p.toolsAllow || p.toolsExclude
        ? JSON.stringify({
            allow: p.toolsAllow ?? undefined,
            exclude: p.toolsExclude ?? undefined,
          })
        : null;
    this.db
      .prepare(
        `INSERT INTO presets
           (id, name, project_ref, description, agent_id, model, effort,
            repo_path, role, disable_thread_prefix, permission, tools_json, instructions, status_card_style,
            created_by, created_utc, updated_utc)
         VALUES
           (@id, @name, @projectRef, @description, @agentId, @model, @effort,
            @repoPath, @role, @disableThreadPrefix, @permission, @toolsJson, @instructions, @statusCardStyle,
            @createdBy, @createdUtc, @updatedUtc)
         ON CONFLICT(id) DO UPDATE SET
           name         = excluded.name,
           project_ref  = excluded.project_ref,
           description  = excluded.description,
           agent_id     = excluded.agent_id,
           model        = excluded.model,
           effort       = excluded.effort,
           repo_path    = excluded.repo_path,
           role         = excluded.role,
           disable_thread_prefix = excluded.disable_thread_prefix,
           permission   = excluded.permission,
           tools_json   = excluded.tools_json,
           instructions = excluded.instructions,
           status_card_style = excluded.status_card_style,
           updated_utc  = excluded.updated_utc`
      )
      .run({
        id: p.id,
        name: p.name,
        projectRef: p.projectRef ?? null,
        description: p.description,
        agentId: p.agentId,
        model: p.model,
        effort: p.effort,
        repoPath: p.repoPath,
        role: p.role ?? null,
        disableThreadPrefix:
          p.disableThreadPrefix === null ? null : p.disableThreadPrefix ? 1 : 0,
        permission: p.permission,
        toolsJson,
        instructions: p.instructions,
        statusCardStyle: p.statusCardStyle ?? null,
        createdBy: p.createdBy,
        createdUtc: p.createdUtc,
        updatedUtc: p.updatedUtc,
      });
  }

  getPreset(id: string): Preset | null {
    const row = this.db
      .prepare<[string], PresetRow>("SELECT * FROM presets WHERE id = ?")
      .get(id);
    return row ? mapPreset(row) : null;
  }

  getPresetByName(name: string): Preset | null {
    // Names are no longer globally unique (#21); when several scopes share a
    // name, prefer the global one so this method's historical semantics hold.
    const row = this.db
      .prepare<[string], PresetRow>(
        "SELECT * FROM presets WHERE name = ? COLLATE NOCASE " +
          "ORDER BY (project_ref IS NULL) DESC LIMIT 1"
      )
      .get(name);
    return row ? mapPreset(row) : null;
  }

  /**
   * Resolve a preset by name for a project scope (#21).
   *
   * - A bare `name` prefers a preset scoped to `projectRef`, else falls back to
   *   a global (`project_ref IS NULL`) preset of that name.
   * - A qualified `otherProject/name` targets that explicit project's preset,
   *   still falling back to a global of the same bare name if it has none.
   *
   * `projectRef` is the current interaction's project (its channel/parentRef);
   * pass `null` when there is no project context (global-only lookup).
   */
  getPresetByNameScoped(name: string, projectRef: string | null): Preset | null {
    let scope = projectRef;
    let bare = name;
    const slash = name.indexOf("/");
    if (slash > 0) {
      scope = name.slice(0, slash);
      bare = name.slice(slash + 1);
    }
    if (scope) {
      const scoped = this.db
        .prepare<[string, string], PresetRow>(
          "SELECT * FROM presets WHERE name = ? COLLATE NOCASE AND project_ref = ?"
        )
        .get(bare, scope);
      if (scoped) return mapPreset(scoped);
    }
    const global = this.db
      .prepare<[string], PresetRow>(
        "SELECT * FROM presets WHERE name = ? COLLATE NOCASE AND project_ref IS NULL"
      )
      .get(bare);
    return global ? mapPreset(global) : null;
  }

  listPresets(): Preset[] {
    return this.db
      .prepare<[], PresetRow>("SELECT * FROM presets ORDER BY name ASC")
      .all()
      .map(mapPreset);
  }

  /**
   * Presets visible in a project: its own scoped presets plus all globals (#21).
   * Passing `null` returns globals only. Project presets sort before globals of
   * the same name so the shadowing winner is listed first.
   */
  listPresetsForProject(projectRef: string | null): Preset[] {
    return this.db
      .prepare<[string | null], PresetRow>(
        "SELECT * FROM presets WHERE project_ref IS NULL OR project_ref = ? " +
          "ORDER BY name ASC, (project_ref IS NULL) ASC"
      )
      .all(projectRef)
      .map(mapPreset);
  }

  deletePreset(id: string): void {
    this.db.prepare("DELETE FROM presets WHERE id = ?").run(id);
  }

}

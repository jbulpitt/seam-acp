import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  defaultSessionConfig,
  type ActiveProject,
  type Chain,
  type ChainCreateInput,
  type ChainStatus,
  type PermissionPolicyMode,
  type Preset,
  DELEGATION_ACTIVE_STATUSES,
  PROMPT_PREVIEW_MAX,
  type DelegationKind,
  type DelegationStatus,
  type LedgerEntry,
  type LedgerEntryInput,
  type LedgerPatch,
  type ConfigAuditEntry,
  type ConfigAuditInput,
  type SessionConfigState,
  type SessionRecord,
} from "./types.js";
import type { ScheduledPrompt } from "./scheduled-prompts/types.js";
import type { WakeEvent } from "./wake/types.js";
import type { WatchEvent } from "./watch/types.js";
import { INBOX_MAX_PER_SESSION, type InboxMessage } from "./inbox/types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  platform        TEXT NOT NULL,
  channel_ref     TEXT NOT NULL,
  parent_ref      TEXT,
  agent_id        TEXT NOT NULL,
  acp_session_id  TEXT NOT NULL,
  repo_path       TEXT,
  config_json     TEXT NOT NULL,
  created_utc     TEXT NOT NULL,
  updated_utc     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_platform_channel
  ON sessions(platform, channel_ref);
CREATE INDEX IF NOT EXISTS idx_sessions_platform_parent
  ON sessions(platform, parent_ref);

CREATE TABLE IF NOT EXISTS scheduled_prompts (
  id                 TEXT PRIMARY KEY,
  platform           TEXT NOT NULL,
  channel_ref        TEXT NOT NULL,
  parent_ref         TEXT,
  name               TEXT NOT NULL,
  prompt_text        TEXT NOT NULL,
  cron               TEXT NOT NULL,
  timezone           TEXT NOT NULL,
  model              TEXT,
  cwd                TEXT,
  target_channel     TEXT,
  output_type        TEXT NOT NULL DEFAULT 'card',
  session_mode       TEXT NOT NULL DEFAULT 'isolated',
  catchup_seconds    INTEGER NOT NULL DEFAULT 7200,
  enabled            INTEGER NOT NULL DEFAULT 1,
  attachments_json   TEXT NOT NULL DEFAULT '[]',
  created_by         TEXT NOT NULL,
  created_utc        TEXT NOT NULL,
  updated_utc        TEXT NOT NULL,
  last_run_utc       TEXT,
  last_status        TEXT,
  next_run_utc       TEXT,
  pinned_session_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_scheduled_channel
  ON scheduled_prompts(platform, channel_ref);
CREATE INDEX IF NOT EXISTS idx_scheduled_enabled
  ON scheduled_prompts(enabled);

CREATE TABLE IF NOT EXISTS presets (
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
  created_by    TEXT NOT NULL,
  created_utc   TEXT NOT NULL,
  updated_utc   TEXT NOT NULL
);
-- The per-scope unique index (idx_presets_name_scope) is created in
-- migratePresetsScope(), not here: on a legacy DB the presets table predates the
-- project_ref column, so the index must wait until that column has been added.
`;

interface Row {
  id: string;
  platform: string;
  channel_ref: string;
  parent_ref: string | null;
  agent_id: string;
  acp_session_id: string;
  repo_path: string | null;
  config_json: string;
  created_utc: string;
  updated_utc: string;
}

const mapRow = (r: Row): SessionRecord => ({
  id: r.id,
  platform: r.platform,
  channelRef: r.channel_ref,
  parentRef: r.parent_ref,
  agentId: r.agent_id,
  acpSessionId: r.acp_session_id,
  repoPath: r.repo_path,
  configJson: r.config_json,
  createdUtc: r.created_utc,
  updatedUtc: r.updated_utc,
});

export function makeSessionId(platform: string, channelRef: string): string {
  return `${platform}:${channelRef}`;
}

interface ScheduledRow {
  id: string;
  platform: string;
  channel_ref: string;
  parent_ref: string | null;
  name: string;
  prompt_text: string;
  cron: string;
  timezone: string;
  model: string | null;
  cwd: string | null;
  target_channel: string | null;
  output_type: string;
  session_mode: string;
  catchup_seconds: number;
  enabled: number;
  attachments_json: string;
  created_by: string;
  created_utc: string;
  updated_utc: string;
  last_run_utc: string | null;
  last_status: string | null;
  next_run_utc: string | null;
  pinned_session_id: string | null;
}

const mapScheduled = (r: ScheduledRow): ScheduledPrompt => {
  let attachments: ScheduledPrompt["attachments"] = [];
  try {
    const parsed = JSON.parse(r.attachments_json);
    if (Array.isArray(parsed)) attachments = parsed;
  } catch { /* keep empty */ }
  return {
    id: r.id,
    platform: r.platform,
    channelRef: r.channel_ref,
    parentRef: r.parent_ref,
    name: r.name,
    promptText: r.prompt_text,
    cron: r.cron,
    timezone: r.timezone,
    model: r.model,
    cwd: r.cwd,
    targetChannel: r.target_channel,
    outputType: r.output_type === "messages" ? "messages" : "card",
    sessionMode: r.session_mode === "live" ? "live" : "isolated",
    catchupSeconds: r.catchup_seconds,
    enabled: r.enabled !== 0,
    attachments,
    createdBy: r.created_by,
    createdUtc: r.created_utc,
    updatedUtc: r.updated_utc,
    lastRunUtc: r.last_run_utc,
    lastStatus: r.last_status,
    nextRunUtc: r.next_run_utc,
    pinnedSessionId: r.pinned_session_id,
  };
};

interface PresetRow {
  id: string;
  name: string;
  project_ref: string | null;
  description: string | null;
  agent_id: string | null;
  model: string | null;
  effort: string | null;
  repo_path: string | null;
  permission: string | null;
  tools_json: string | null;
  instructions: string | null;
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
    permission: r.permission as PermissionPolicyMode | null,
    toolsAllow,
    toolsExclude,
    instructions: r.instructions,
    createdBy: r.created_by,
    createdUtc: r.created_utc,
    updatedUtc: r.updated_utc,
  };
};

export class SessionStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.db.exec(DELEGATION_SCHEMA);
    this.migrateReportBackDedupIndex();
    this.db.exec(CONFIG_AUDIT_SCHEMA);
    this.db.exec(ACTIVE_PROJECTS_SCHEMA);
    this.db.exec(CHAINS_SCHEMA);
    this.db.exec(WAKE_EVENTS_SCHEMA);
    this.db.exec(WATCHES_SCHEMA);
    this.db.exec(INBOX_SCHEMA);
    // Defensive column adds for tables created by an earlier schema version
    // (no migration framework). Ignored if the column already exists.
    for (const ddl of [
      "ALTER TABLE scheduled_prompts ADD COLUMN model TEXT",
      "ALTER TABLE scheduled_prompts ADD COLUMN cwd TEXT",
      "ALTER TABLE scheduled_prompts ADD COLUMN target_channel TEXT",
      "ALTER TABLE scheduled_prompts ADD COLUMN output_type TEXT NOT NULL DEFAULT 'card'",
      "ALTER TABLE scheduled_prompts ADD COLUMN session_mode TEXT NOT NULL DEFAULT 'isolated'",
    ]) {
      try { this.db.exec(ddl); } catch { /* column exists */ }
    }
    this.migrateWakeFireOnStartup();
    this.migrateInboxPriority();
    this.migratePresetsScope();
  }

  /**
   * Additive unique index so a correlation can have at most one `report_back`
   * ledger row (#77). The crash window (report-back already queued, original
   * still in `running/`) re-runs the worker; this index is the durable claim
   * that makes the second enqueue a no-op. Partial: only `report_back` rows
   * with a correlation are unique, so a handoff + its report-back can still
   * share a correlation, and chain hops can still share `kind=forward`.
   * try/catch: a pre-#77 DB that already has duplicate report-backs must not
   * fail boot — the query-side `WHERE NOT EXISTS` still dedups new writes.
   */
  private migrateReportBackDedupIndex(): void {
    try {
      this.db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_delegation_report_back_correlation
           ON delegation_log(correlation_id)
           WHERE kind = 'report_back' AND correlation_id IS NOT NULL`
      );
    } catch {
      /* leftover duplicates from the pre-#77 crash window */
    }
  }

  /**
   * Additive migration for boot-triggered wakes (#59 extension): the prod DB
   * already has `wake_events` without `fire_on_startup`. Add it idempotently —
   * a PRAGMA guard makes this a no-op once the column exists, so boot never
   * throws on an already-migrated (or freshly-created) DB, and no data is lost.
   */
  private migrateWakeFireOnStartup(): void {
    const hasColumn = this.db
      .prepare<[], { name: string }>("PRAGMA table_info(wake_events)")
      .all()
      .some((c) => c.name === "fire_on_startup");
    if (!hasColumn) {
      this.db.exec(
        "ALTER TABLE wake_events ADD COLUMN fire_on_startup INTEGER NOT NULL DEFAULT 0"
      );
    }
  }

  /**
   * Additive migration for priority inbox messages (#66): the prod DB already
   * has an `inbox` table without `priority`. Add it idempotently — a PRAGMA
   * guard makes this a no-op once the column exists (and on a freshly-created DB
   * whose CREATE TABLE already carries it), so boot never throws and no queued
   * message is lost. Mirrors `migrateWakeFireOnStartup`.
   */
  private migrateInboxPriority(): void {
    const hasColumn = this.db
      .prepare<[], { name: string }>("PRAGMA table_info(inbox)")
      .all()
      .some((c) => c.name === "priority");
    if (!hasColumn) {
      this.db.exec(
        "ALTER TABLE inbox ADD COLUMN priority INTEGER NOT NULL DEFAULT 0"
      );
    }
  }

  /**
   * Additive migration for project-scoped presets (#21). Safe to run on every
   * open; each step is a no-op once applied.
   *
   * Legacy DBs created `presets.name` with a column-level UNIQUE (global name
   * uniqueness) plus an `idx_presets_name` index. Project scoping moves that
   * uniqueness to per-(name, scope). SQLite cannot drop a column-level UNIQUE in
   * place, so where the legacy constraint is still present we rebuild the table
   * without it. Existing rows keep `project_ref = NULL`, i.e. they stay global.
   */
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
            created_by    TEXT NOT NULL,
            created_utc   TEXT NOT NULL,
            updated_utc   TEXT NOT NULL
          );
          INSERT INTO presets__migrate
            (id, name, project_ref, description, agent_id, model, effort,
             repo_path, permission, tools_json, instructions, created_by,
             created_utc, updated_utc)
          SELECT id, name, project_ref, description, agent_id, model, effort,
                 repo_path, permission, tools_json, instructions, created_by,
                 created_utc, updated_utc
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

  close(): void {
    this.db.close();
  }

  get(id: string): SessionRecord | null {
    const row = this.db
      .prepare<[string], Row>("SELECT * FROM sessions WHERE id = ?")
      .get(id);
    return row ? mapRow(row) : null;
  }

  getByChannel(platform: string, channelRef: string): SessionRecord | null {
    const row = this.db
      .prepare<[string, string], Row>(
        "SELECT * FROM sessions WHERE platform = ? AND channel_ref = ?"
      )
      .get(platform, channelRef);
    return row ? mapRow(row) : null;
  }

  list(limit = 100): SessionRecord[] {
    const rows = this.db
      .prepare<[number], Row>(
        "SELECT * FROM sessions ORDER BY updated_utc DESC LIMIT ?"
      )
      .all(limit);
    return rows.map(mapRow);
  }

  /**
   * Every session whose thread hangs off `parentRef` in `platform`, newest
   * activity first, capped at `limit` (#73). Filtering happens IN SQL, unlike
   * `list(100)` which caps at the newest-100 sessions GLOBALLY: an in-memory
   * `.filter(parentRef)` over that would silently drop a quiet-but-bound thread
   * that has slipped past the global cap — precisely the teammate a discovery
   * tool must still surface. This query only ever sees this one channel's
   * threads, so recency-capping is safe. Backed by idx_sessions_platform_parent.
   */
  listSessionsByParent(
    platform: string,
    parentRef: string,
    limit = 100
  ): SessionRecord[] {
    const rows = this.db
      .prepare<[string, string, number], Row>(
        "SELECT * FROM sessions WHERE platform = ? AND parent_ref = ? " +
          "ORDER BY updated_utc DESC LIMIT ?"
      )
      .all(platform, parentRef, limit);
    return rows.map(mapRow);
  }

  upsert(record: SessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO sessions
           (id, platform, channel_ref, parent_ref, agent_id, acp_session_id,
            repo_path, config_json, created_utc, updated_utc)
         VALUES
           (@id, @platform, @channelRef, @parentRef, @agentId, @acpSessionId,
            @repoPath, @configJson, @createdUtc, @updatedUtc)
         ON CONFLICT(id) DO UPDATE SET
           platform        = excluded.platform,
           channel_ref     = excluded.channel_ref,
           parent_ref      = excluded.parent_ref,
           agent_id        = excluded.agent_id,
           acp_session_id  = excluded.acp_session_id,
           repo_path       = excluded.repo_path,
           config_json     = excluded.config_json,
           updated_utc     = excluded.updated_utc`
      )
      .run(record);
  }

  // --- scheduled prompts ----------------------------------------------------

  upsertScheduled(s: ScheduledPrompt): void {
    this.db
      .prepare(
        `INSERT INTO scheduled_prompts
           (id, platform, channel_ref, parent_ref, name, prompt_text, cron,
            timezone, model, cwd, target_channel, output_type, session_mode,
            catchup_seconds,
            enabled, attachments_json, created_by,
            created_utc, updated_utc, last_run_utc, last_status, next_run_utc,
            pinned_session_id)
         VALUES
           (@id, @platform, @channelRef, @parentRef, @name, @promptText, @cron,
            @timezone, @model, @cwd, @targetChannel, @outputType, @sessionMode,
            @catchupSeconds,
            @enabled, @attachmentsJson, @createdBy,
            @createdUtc, @updatedUtc, @lastRunUtc, @lastStatus, @nextRunUtc,
            @pinnedSessionId)
         ON CONFLICT(id) DO UPDATE SET
           name             = excluded.name,
           prompt_text      = excluded.prompt_text,
           cron             = excluded.cron,
           timezone         = excluded.timezone,
           model            = excluded.model,
           cwd              = excluded.cwd,
           target_channel   = excluded.target_channel,
           output_type      = excluded.output_type,
           session_mode     = excluded.session_mode,
           catchup_seconds  = excluded.catchup_seconds,
           enabled          = excluded.enabled,
           attachments_json = excluded.attachments_json,
           updated_utc      = excluded.updated_utc,
           last_run_utc     = excluded.last_run_utc,
           last_status      = excluded.last_status,
           next_run_utc     = excluded.next_run_utc,
           pinned_session_id = excluded.pinned_session_id`
      )
      .run({
        id: s.id,
        platform: s.platform,
        channelRef: s.channelRef,
        parentRef: s.parentRef,
        name: s.name,
        promptText: s.promptText,
        cron: s.cron,
        timezone: s.timezone,
        model: s.model,
        cwd: s.cwd,
        targetChannel: s.targetChannel,
        outputType: s.outputType,
        sessionMode: s.sessionMode,
        catchupSeconds: s.catchupSeconds,
        enabled: s.enabled ? 1 : 0,
        attachmentsJson: JSON.stringify(s.attachments ?? []),
        createdBy: s.createdBy,
        createdUtc: s.createdUtc,
        updatedUtc: s.updatedUtc,
        lastRunUtc: s.lastRunUtc,
        lastStatus: s.lastStatus,
        nextRunUtc: s.nextRunUtc,
        pinnedSessionId: s.pinnedSessionId,
      });
  }

  getScheduled(id: string): ScheduledPrompt | null {
    const row = this.db
      .prepare<[string], ScheduledRow>("SELECT * FROM scheduled_prompts WHERE id = ?")
      .get(id);
    return row ? mapScheduled(row) : null;
  }

  listScheduledByChannel(platform: string, channelRef: string): ScheduledPrompt[] {
    return this.db
      .prepare<[string, string], ScheduledRow>(
        "SELECT * FROM scheduled_prompts WHERE platform = ? AND channel_ref = ? ORDER BY created_utc ASC"
      )
      .all(platform, channelRef)
      .map(mapScheduled);
  }

  listScheduledEnabled(): ScheduledPrompt[] {
    return this.db
      .prepare<[], ScheduledRow>("SELECT * FROM scheduled_prompts WHERE enabled = 1")
      .all()
      .map(mapScheduled);
  }

  listAllScheduled(): ScheduledPrompt[] {
    return this.db
      .prepare<[], ScheduledRow>("SELECT * FROM scheduled_prompts ORDER BY created_utc ASC")
      .all()
      .map(mapScheduled);
  }

  deleteScheduled(id: string): void {
    this.db.prepare("DELETE FROM scheduled_prompts WHERE id = ?").run(id);
  }

  readConfig(record: SessionRecord): SessionConfigState {
    if (!record.configJson) return {};
    try {
      const parsed = JSON.parse(record.configJson) as SessionConfigState;
      return parsed ?? {};
    } catch {
      return {};
    }
  }

  writeConfig(cfg: SessionConfigState): string {
    return JSON.stringify(cfg, null, 2);
  }

  // --- presets ---------------------------------------------------------------

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
            repo_path, permission, tools_json, instructions, created_by,
            created_utc, updated_utc)
         VALUES
           (@id, @name, @projectRef, @description, @agentId, @model, @effort,
            @repoPath, @permission, @toolsJson, @instructions, @createdBy,
            @createdUtc, @updatedUtc)
         ON CONFLICT(id) DO UPDATE SET
           name         = excluded.name,
           project_ref  = excluded.project_ref,
           description  = excluded.description,
           agent_id     = excluded.agent_id,
           model        = excluded.model,
           effort       = excluded.effort,
           repo_path    = excluded.repo_path,
           permission   = excluded.permission,
           tools_json   = excluded.tools_json,
           instructions = excluded.instructions,
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
        permission: p.permission,
        toolsJson,
        instructions: p.instructions,
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

  // --- active projects (DB-backed channel activation, #22) ------------------

  upsertActiveProject(p: ActiveProject): void {
    this.db
      .prepare(
        `INSERT INTO active_projects
           (channel_ref, enabled, config_json, created_utc, updated_utc)
         VALUES
           (@channelRef, @enabled, @configJson, @createdUtc, @updatedUtc)
         ON CONFLICT(channel_ref) DO UPDATE SET
           enabled     = excluded.enabled,
           config_json = excluded.config_json,
           updated_utc = excluded.updated_utc`
      )
      .run({
        channelRef: p.channelRef,
        enabled: p.enabled ? 1 : 0,
        configJson: p.configJson,
        createdUtc: p.createdUtc,
        updatedUtc: p.updatedUtc,
      });
  }

  getActiveProject(channelRef: string): ActiveProject | null {
    const row = this.db
      .prepare<[string], ActiveProjectRow>(
        "SELECT * FROM active_projects WHERE channel_ref = ?"
      )
      .get(channelRef);
    return row ? mapActiveProject(row) : null;
  }

  listActiveProjects(): ActiveProject[] {
    return this.db
      .prepare<[], ActiveProjectRow>(
        "SELECT * FROM active_projects ORDER BY created_utc ASC"
      )
      .all()
      .map(mapActiveProject);
  }

  setProjectEnabled(channelRef: string, enabled: boolean): void {
    this.db
      .prepare(
        "UPDATE active_projects SET enabled = ?, updated_utc = ? WHERE channel_ref = ?"
      )
      .run(enabled ? 1 : 0, new Date().toISOString(), channelRef);
  }

  removeActiveProject(channelRef: string): void {
    this.db.prepare("DELETE FROM active_projects WHERE channel_ref = ?").run(channelRef);
  }

  /** True when `ref` has an enabled activation row. The additive half of the
   *  channel gate — OR'd with the env allowlist, never replacing it. */
  isChannelActive(ref: string): boolean {
    const row = this.db
      .prepare<[string], { one: number }>(
        "SELECT 1 AS one FROM active_projects WHERE channel_ref = ? AND enabled = 1"
      )
      .get(ref);
    return row !== undefined;
  }

  static defaultConfig(
    defaultModel: string,
    defaultPolicy?: import("./types.js").PermissionPolicyMode
  ): SessionConfigState {
    return defaultSessionConfig(defaultModel, defaultPolicy);
  }

  // --- delegation ledger ----------------------------------------------------

  /**
   * Insert one ledger row. `status` defaults to "dispatched" and the
   * timestamps to now. `promptPreview` is truncated to `PROMPT_PREVIEW_MAX`
   * so the column can never grow into a full prompt copy. Returns the row as
   * persisted, so the caller sees the stamped defaults.
   */
  recordDelegation(entry: LedgerEntryInput): LedgerEntry {
    const now = new Date().toISOString();
    const createdUtc = entry.createdUtc ?? now;
    const row: LedgerEntry = {
      id: entry.id,
      sourceRef: entry.sourceRef ?? null,
      targetRef: entry.targetRef ?? null,
      worker: entry.worker ?? null,
      kind: entry.kind,
      promptPreview: truncatePreview(entry.promptPreview ?? null),
      correlationId: entry.correlationId ?? null,
      status: entry.status ?? "dispatched",
      createdUtc,
      updatedUtc: entry.updatedUtc ?? createdUtc,
    };
    this.db
      .prepare(
        `INSERT INTO delegation_log
           (id, source_ref, target_ref, worker, kind, prompt_preview,
            correlation_id, status, created_utc, updated_utc)
         VALUES
           (@id, @sourceRef, @targetRef, @worker, @kind, @promptPreview,
            @correlationId, @status, @createdUtc, @updatedUtc)`
      )
      .run(row);
    return row;
  }

  // --- config-mutation audit (#58 P2/P3, D6) -------------------------------

  /** Append one immutable config-mutation audit row (actor / scope / before /
   *  after / correlation). Called only on a confirmed, applied change. */
  recordConfigMutation(entry: ConfigAuditInput): ConfigAuditEntry {
    const row: ConfigAuditEntry = {
      id: entry.id,
      tier: entry.tier,
      actorId: entry.actorId ?? null,
      actorName: entry.actorName ?? null,
      scope: entry.scope,
      summary: entry.summary,
      beforeJson: entry.beforeJson,
      afterJson: entry.afterJson,
      correlationId: entry.correlationId ?? null,
      appliedUtc: entry.appliedUtc ?? new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO config_audit
           (id, tier, actor_id, actor_name, scope, summary, before_json,
            after_json, correlation_id, applied_utc)
         VALUES
           (@id, @tier, @actorId, @actorName, @scope, @summary, @beforeJson,
            @afterJson, @correlationId, @appliedUtc)`
      )
      .run(row);
    return row;
  }

  /** Most-recent config-mutation audit rows, newest first. */
  listConfigMutations(limit = 50): ConfigAuditEntry[] {
    return this.db
      .prepare<[number], ConfigAuditRow>(
        `SELECT * FROM config_audit
         ORDER BY applied_utc DESC, rowid DESC LIMIT ?`
      )
      .all(limit)
      .map(mapConfigAudit);
  }

  /**
   * Move a row to a new status, re-stamping `updated_utc`. `patch` may amend
   * the mutable fields in the same write — e.g. attaching the resolved
   * `targetRef` when a dispatched handoff starts running. Unknown ids are a
   * silent no-op (the ledger is observability, never a control path).
   */
  updateDelegationStatus(
    id: string,
    status: DelegationStatus,
    patch?: LedgerPatch
  ): void {
    const sets = ["status = @status", "updated_utc = @updatedUtc"];
    const params: Record<string, string | null> = {
      id,
      status,
      updatedUtc: new Date().toISOString(),
    };
    for (const [key, column] of Object.entries(LEDGER_PATCH_COLUMNS) as Array<
      [keyof LedgerPatch, string]
    >) {
      if (!patch || !(key in patch)) continue;
      const value = patch[key] ?? null;
      sets.push(`${column} = @${key}`);
      params[key] = key === "promptPreview" ? truncatePreview(value) : value;
    }
    this.db
      .prepare(`UPDATE delegation_log SET ${sets.join(", ")} WHERE id = @id`)
      .run(params);
  }

  /**
   * The originating row for a correlation id. A correlation identifies one
   * logical delegation whose single row is mutated through its lifecycle; if
   * rows ever share one, the earliest-created wins so the answer is stable.
   */
  getDelegationByCorrelation(correlationId: string): LedgerEntry | null {
    const row = this.db
      .prepare<[string], LedgerRow>(
        `SELECT * FROM delegation_log WHERE correlation_id = ?
         ORDER BY created_utc ASC, rowid ASC LIMIT 1`
      )
      .get(correlationId);
    return row ? mapLedger(row) : null;
  }

  /**
   * The `report_back` row for a correlation, if one has been claimed.
   * Distinct from {@link getDelegationByCorrelation}, which returns the
   * earliest row of any kind (typically the originating handoff).
   */
  getReportBackByCorrelation(correlationId: string): LedgerEntry | null {
    const row = this.db
      .prepare<[string], LedgerRow>(
        `SELECT * FROM delegation_log
         WHERE kind = 'report_back' AND correlation_id = ?
         ORDER BY created_utc ASC, rowid ASC LIMIT 1`
      )
      .get(correlationId);
    return row ? mapLedger(row) : null;
  }

  /**
   * Atomically claim a `report_back` ledger row for `entry.correlationId`.
   * Returns the persisted row when this call wins the claim, or `null` when
   * a report-back for that correlation already exists (the #77 crash-window
   * dedup). The unique index + `WHERE NOT EXISTS` make the check-then-write
   * a single SQLite statement, so a re-run after a crash sees the claim.
   *
   * `entry.kind` must be `"report_back"`. A missing correlation falls through
   * to a plain insert (nothing to dedup on).
   */
  tryRecordReportBack(entry: LedgerEntryInput): LedgerEntry | null {
    if (entry.kind !== "report_back") {
      throw new Error("tryRecordReportBack requires kind=\"report_back\"");
    }
    const now = new Date().toISOString();
    const createdUtc = entry.createdUtc ?? now;
    const row: LedgerEntry = {
      id: entry.id,
      sourceRef: entry.sourceRef ?? null,
      targetRef: entry.targetRef ?? null,
      worker: entry.worker ?? null,
      kind: "report_back",
      promptPreview: truncatePreview(entry.promptPreview ?? null),
      correlationId: entry.correlationId ?? null,
      status: entry.status ?? "dispatched",
      createdUtc,
      updatedUtc: entry.updatedUtc ?? createdUtc,
    };
    try {
      const info = this.db
        .prepare(
          `INSERT INTO delegation_log
             (id, source_ref, target_ref, worker, kind, prompt_preview,
              correlation_id, status, created_utc, updated_utc)
           SELECT
             @id, @sourceRef, @targetRef, @worker, @kind, @promptPreview,
             @correlationId, @status, @createdUtc, @updatedUtc
           WHERE @correlationId IS NULL OR NOT EXISTS (
             SELECT 1 FROM delegation_log
              WHERE kind = 'report_back' AND correlation_id = @correlationId
           )`
        )
        .run(row);
      if (info.changes === 0) return null;
      return row;
    } catch (err) {
      // PK / unique-index collision: another writer claimed this correlation
      // (or this id) first. Treat as "already claimed".
      const code = (err as { code?: string }).code ?? "";
      if (code.startsWith("SQLITE_CONSTRAINT")) return null;
      throw err;
    }
  }

  /** Rows still in flight, oldest first — the order a watchdog wants. */
  listActiveDelegations(): LedgerEntry[] {
    const placeholders = DELEGATION_ACTIVE_STATUSES.map(() => "?").join(", ");
    return this.db
      .prepare<string[], LedgerRow>(
        `SELECT * FROM delegation_log WHERE status IN (${placeholders})
         ORDER BY created_utc ASC, rowid ASC`
      )
      .all(...DELEGATION_ACTIVE_STATUSES)
      .map(mapLedger);
  }

  listRecentDelegations(limit = 50): LedgerEntry[] {
    return this.db
      .prepare<[number], LedgerRow>(
        `SELECT * FROM delegation_log
         ORDER BY created_utc DESC, rowid DESC LIMIT ?`
      )
      .all(limit)
      .map(mapLedger);
  }

  listDelegationsBySource(sourceRef: string): LedgerEntry[] {
    return this.db
      .prepare<[string], LedgerRow>(
        `SELECT * FROM delegation_log WHERE source_ref = ?
         ORDER BY created_utc DESC, rowid DESC`
      )
      .all(sourceRef)
      .map(mapLedger);
  }

  // --- durable multi-hop chains (#25) ---------------------------------------

  /**
   * Insert one chain row. `hops` is stored as the *remaining* worker list (the
   * hop about to be dispatched should be popped with `advanceChain`). `status`
   * defaults to "running", `currentIndex` to 0, and the timestamps to now.
   * `promptPreview` is truncated like the ledger's. Returns the row as
   * persisted, so the caller sees the stamped defaults.
   */
  createChain(input: ChainCreateInput): Chain {
    const now = new Date().toISOString();
    const createdUtc = input.createdUtc ?? now;
    const chain: Chain = {
      id: input.id,
      hops: [...input.hops],
      originRef: input.originRef,
      promptPreview: truncatePreview(input.promptPreview ?? null),
      status: input.status ?? "running",
      currentIndex: input.currentIndex ?? 0,
      createdUtc,
      updatedUtc: input.updatedUtc ?? createdUtc,
    };
    this.db
      .prepare(
        `INSERT INTO chains
           (id, hops_json, origin_ref, prompt_preview, status,
            current_index, created_utc, updated_utc)
         VALUES
           (@id, @hopsJson, @originRef, @promptPreview, @status,
            @currentIndex, @createdUtc, @updatedUtc)`
      )
      .run({
        id: chain.id,
        hopsJson: JSON.stringify(chain.hops),
        originRef: chain.originRef,
        promptPreview: chain.promptPreview,
        status: chain.status,
        currentIndex: chain.currentIndex,
        createdUtc: chain.createdUtc,
        updatedUtc: chain.updatedUtc,
      });
    return chain;
  }

  getChain(id: string): Chain | null {
    const row = this.db
      .prepare<[string], ChainRow>("SELECT * FROM chains WHERE id = ?")
      .get(id);
    return row ? mapChain(row) : null;
  }

  /**
   * Pop the next hop to dispatch off the front of the remaining list, bump
   * `currentIndex`, and re-stamp `updated_utc`. Returns the updated chain plus
   * the popped worker string (`nextHop`), or `nextHop: null` when the chain is
   * drained — the caller then delivers the final output to `originRef`. An
   * unknown id or a chain that is no longer "running" returns `null` (a no-op),
   * which keeps an at-least-once double-completion from advancing twice into a
   * terminal chain. The row is the source of truth, so advancing happens only at
   * a hop's completion — a restart mid-hop re-runs that hop and re-reads this
   * state, advancing exactly once.
   */
  advanceChain(id: string): { chain: Chain; nextHop: string | null } | null {
    const current = this.getChain(id);
    if (!current || current.status !== "running") return null;
    const hops = [...current.hops];
    const nextHop = hops.length > 0 ? hops.shift()! : null;
    const updated: Chain = {
      ...current,
      hops,
      currentIndex: nextHop !== null ? current.currentIndex + 1 : current.currentIndex,
      updatedUtc: new Date().toISOString(),
    };
    this.db
      .prepare(
        `UPDATE chains
           SET hops_json = @hopsJson, current_index = @currentIndex,
               updated_utc = @updatedUtc
         WHERE id = @id`
      )
      .run({
        id: updated.id,
        hopsJson: JSON.stringify(updated.hops),
        currentIndex: updated.currentIndex,
        updatedUtc: updated.updatedUtc,
      });
    return { chain: updated, nextHop };
  }

  /** Mark a chain terminal (default "completed"), re-stamping `updated_utc`.
   *  Unknown ids are a silent no-op. */
  completeChain(id: string, status: Exclude<ChainStatus, "running"> = "completed"): void {
    this.db
      .prepare(
        "UPDATE chains SET status = @status, updated_utc = @updatedUtc WHERE id = @id"
      )
      .run({ id, status, updatedUtc: new Date().toISOString() });
  }

  /** Chains still running, oldest first — the order a resume sweep wants. */
  listActiveChains(): Chain[] {
    return this.db
      .prepare<[], ChainRow>(
        `SELECT * FROM chains WHERE status = 'running'
         ORDER BY created_utc ASC, rowid ASC`
      )
      .all()
      .map(mapChain);
  }

  // --- agent-scheduled wake events (#59) ------------------------------------

  /** Insert (or replace) a wake row. Wakes are write-once in practice — the
   *  sweeper deletes them on fire — but ON CONFLICT keeps the id idempotent. */
  upsertWake(w: WakeEvent): void {
    this.db
      .prepare(
        `INSERT INTO wake_events
           (id, platform, channel_ref, parent_ref, fire_at_utc, prompt, reason,
            created_by, correlation_id, chain_depth, catchup_seconds,
            fire_on_startup, created_utc)
         VALUES
           (@id, @platform, @channelRef, @parentRef, @fireAtUtc, @prompt, @reason,
            @createdBy, @correlationId, @chainDepth, @catchupSeconds,
            @fireOnStartup, @createdUtc)
         ON CONFLICT(id) DO UPDATE SET
           fire_at_utc     = excluded.fire_at_utc,
           prompt          = excluded.prompt,
           reason          = excluded.reason,
           correlation_id  = excluded.correlation_id,
           chain_depth     = excluded.chain_depth,
           catchup_seconds = excluded.catchup_seconds,
           fire_on_startup = excluded.fire_on_startup`
      )
      .run({
        id: w.id,
        platform: w.platform,
        channelRef: w.channelRef,
        parentRef: w.parentRef,
        fireAtUtc: w.fireAtUtc,
        prompt: w.prompt,
        reason: w.reason,
        createdBy: w.createdBy,
        correlationId: w.correlationId,
        chainDepth: w.chainDepth,
        catchupSeconds: w.catchupSeconds,
        fireOnStartup: w.fireOnStartup ? 1 : 0,
        createdUtc: w.createdUtc,
      });
  }

  getWake(id: string): WakeEvent | null {
    const row = this.db
      .prepare<[string], WakeRow>("SELECT * FROM wake_events WHERE id = ?")
      .get(id);
    return row ? mapWake(row) : null;
  }

  /** Wakes whose fire time has arrived (`fire_at_utc <= now`), soonest first —
   *  the order the sweeper fires them. Boot-triggered wakes (`fire_on_startup`)
   *  are EXCLUDED: they wait for a process boot, not the clock, so the time
   *  sweep must never pick them up (they'd otherwise fire immediately on their
   *  nominal `fire_at_utc`). */
  listDueWakes(nowIso: string): WakeEvent[] {
    return this.db
      .prepare<[string], WakeRow>(
        "SELECT * FROM wake_events WHERE fire_at_utc <= ? AND fire_on_startup = 0 ORDER BY fire_at_utc ASC, rowid ASC"
      )
      .all(nowIso)
      .map(mapWake);
  }

  /** Boot-triggered wakes (`fire_on_startup = 1`), oldest first — the set
   *  `WakeManager.start()` fires once on the next process boot (D1 one-shot).
   *  Independent of `fire_at_utc`: a startup wake fires on boot regardless of
   *  how long the process was down. */
  listStartupWakes(): WakeEvent[] {
    return this.db
      .prepare<[], WakeRow>(
        "SELECT * FROM wake_events WHERE fire_on_startup = 1 ORDER BY created_utc ASC, rowid ASC"
      )
      .all()
      .map(mapWake);
  }

  /** Pending wakes for one thread, soonest first — the D6 visibility surface. */
  listWakesByChannel(platform: string, channelRef: string): WakeEvent[] {
    return this.db
      .prepare<[string, string], WakeRow>(
        "SELECT * FROM wake_events WHERE platform = ? AND channel_ref = ? ORDER BY fire_at_utc ASC, rowid ASC"
      )
      .all(platform, channelRef)
      .map(mapWake);
  }

  /** How many wakes are currently pending for a thread — the per-thread cap
   *  (D8) reads this before arming a new one. */
  countPendingWakesByChannel(platform: string, channelRef: string): number {
    const row = this.db
      .prepare<[string, string], { n: number }>(
        "SELECT COUNT(*) AS n FROM wake_events WHERE platform = ? AND channel_ref = ?"
      )
      .get(platform, channelRef);
    return row?.n ?? 0;
  }

  deleteWake(id: string): void {
    this.db.prepare("DELETE FROM wake_events WHERE id = ?").run(id);
  }

  // --- agent-defined watches (#60) ------------------------------------------

  /** Insert (or replace) a watch row. ON CONFLICT keeps the id idempotent. */
  upsertWatch(w: WatchEvent): void {
    this.db
      .prepare(
        `INSERT INTO watches
           (id, platform, channel_ref, parent_ref, kind, spec, match_expr,
            interval_seconds, prompt, reason, mode, max_fires, fire_count,
            last_checked_utc, last_fired_utc, last_observed, expires_at_utc,
            created_by, correlation_id, created_utc)
         VALUES
           (@id, @platform, @channelRef, @parentRef, @kind, @spec, @match,
            @intervalSeconds, @prompt, @reason, @mode, @maxFires, @fireCount,
            @lastCheckedUtc, @lastFiredUtc, @lastObserved, @expiresAtUtc,
            @createdBy, @correlationId, @createdUtc)
         ON CONFLICT(id) DO UPDATE SET
           spec             = excluded.spec,
           match_expr       = excluded.match_expr,
           interval_seconds = excluded.interval_seconds,
           prompt           = excluded.prompt,
           reason           = excluded.reason,
           mode             = excluded.mode,
           max_fires        = excluded.max_fires,
           fire_count       = excluded.fire_count,
           last_checked_utc = excluded.last_checked_utc,
           last_fired_utc   = excluded.last_fired_utc,
           last_observed    = excluded.last_observed,
           expires_at_utc   = excluded.expires_at_utc`
      )
      .run({
        id: w.id,
        platform: w.platform,
        channelRef: w.channelRef,
        parentRef: w.parentRef,
        kind: w.kind,
        spec: w.spec,
        match: w.match,
        intervalSeconds: w.intervalSeconds,
        prompt: w.prompt,
        reason: w.reason,
        mode: w.mode,
        maxFires: w.maxFires,
        fireCount: w.fireCount,
        lastCheckedUtc: w.lastCheckedUtc,
        lastFiredUtc: w.lastFiredUtc,
        lastObserved: w.lastObserved,
        expiresAtUtc: w.expiresAtUtc,
        createdBy: w.createdBy,
        correlationId: w.correlationId,
        createdUtc: w.createdUtc,
      });
  }

  getWatch(id: string): WatchEvent | null {
    const row = this.db
      .prepare<[string], WatchRow>("SELECT * FROM watches WHERE id = ?")
      .get(id);
    return row ? mapWatch(row) : null;
  }

  /** Every live watch, oldest first — the WatchManager sweeper's work list. */
  listAllWatches(): WatchEvent[] {
    return this.db
      .prepare<[], WatchRow>("SELECT * FROM watches ORDER BY rowid ASC")
      .all()
      .map(mapWatch);
  }

  /** Pending watches for one thread, newest first — the D7 visibility surface. */
  listWatchesByChannel(platform: string, channelRef: string): WatchEvent[] {
    return this.db
      .prepare<[string, string], WatchRow>(
        "SELECT * FROM watches WHERE platform = ? AND channel_ref = ? ORDER BY created_utc DESC, rowid DESC"
      )
      .all(platform, channelRef)
      .map(mapWatch);
  }

  /** How many watches are currently pending for a thread — the per-thread cap
   *  (D5) reads this before arming a new one. */
  countWatchesByChannel(platform: string, channelRef: string): number {
    const row = this.db
      .prepare<[string, string], { n: number }>(
        "SELECT COUNT(*) AS n FROM watches WHERE platform = ? AND channel_ref = ?"
      )
      .get(platform, channelRef);
    return row?.n ?? 0;
  }

  /** Record an evaluation: set the last-checked time and the new change-detection
   *  snapshot (both without touching fire bookkeeping). */
  markWatchChecked(id: string, checkedUtc: string, observed: string | null): void {
    this.db
      .prepare("UPDATE watches SET last_checked_utc = ?, last_observed = ? WHERE id = ?")
      .run(checkedUtc, observed, id);
  }

  /** A non-terminal `each` fire: bump the counter and stamp the fire time. */
  incrementWatchFire(id: string, firedUtc: string): void {
    this.db
      .prepare(
        "UPDATE watches SET fire_count = fire_count + 1, last_fired_utc = ? WHERE id = ?"
      )
      .run(firedUtc, id);
  }

  deleteWatch(id: string): void {
    this.db.prepare("DELETE FROM watches WHERE id = ?").run(id);
  }

  // --- agent inbox (#61) ----------------------------------------------------

  /**
   * Push one message into a session's durable inbox and return the stored row.
   * `sessionRef` is the OWNING session key (`record.id`, i.e. `platform:channel`
   * — never `acpSessionId`). Enforces the per-session cap by DROP-OLDEST: after
   * inserting, any rows beyond `INBOX_MAX_PER_SESSION` (oldest first) are pruned,
   * so an unpolled inbox is bounded and the newest messages always survive.
   */
  pushInbox(
    sessionRef: string,
    fromRef: string | null,
    body: string,
    priority = false
  ): InboxMessage {
    const row: InboxMessage = {
      id: randomUUID(),
      sessionRef,
      fromRef,
      body,
      priority,
      createdUtc: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO inbox (id, session_ref, from_ref, body, priority, created_utc)
         VALUES (@id, @sessionRef, @fromRef, @body, @priority, @createdUtc)`
      )
      .run({
        id: row.id,
        sessionRef: row.sessionRef,
        fromRef: row.fromRef,
        body: row.body,
        priority: priority ? 1 : 0,
        createdUtc: row.createdUtc,
      });
    // Drop-oldest overflow: keep only the newest INBOX_MAX_PER_SESSION rows for
    // this session. rowid is monotonic insertion order, so ORDER BY rowid DESC
    // LIMIT -1 OFFSET N leaves the N newest and selects the rest for deletion.
    this.db
      .prepare(
        `DELETE FROM inbox WHERE id IN (
           SELECT id FROM inbox WHERE session_ref = ?
           ORDER BY rowid DESC LIMIT -1 OFFSET ?
         )`
      )
      .run(sessionRef, INBOX_MAX_PER_SESSION);
    return row;
  }

  /**
   * Drain a session's inbox: read every queued message (oldest first) AND delete
   * them in one transaction, returning the coalesced list. Deliver-once — a
   * second drain returns nothing. Self-scope is the caller's responsibility (it
   * passes its OWN `record.id`); this never reads another session's rows.
   */
  drainInbox(sessionRef: string): InboxMessage[] {
    const drain = this.db.transaction((ref: string): InboxMessage[] => {
      const rows = this.db
        .prepare<[string], InboxRow>(
          "SELECT * FROM inbox WHERE session_ref = ? ORDER BY rowid ASC"
        )
        .all(ref)
        .map(mapInbox);
      if (rows.length > 0) {
        this.db.prepare("DELETE FROM inbox WHERE session_ref = ?").run(ref);
      }
      return rows;
    });
    return drain(sessionRef);
  }

  /** Read a session's queued messages WITHOUT deleting them (oldest first). */
  listInbox(sessionRef: string): InboxMessage[] {
    return this.db
      .prepare<[string], InboxRow>(
        "SELECT * FROM inbox WHERE session_ref = ? ORDER BY rowid ASC"
      )
      .all(sessionRef)
      .map(mapInbox);
  }

  /** How many messages are currently queued for a session. */
  countInbox(sessionRef: string): number {
    const row = this.db
      .prepare<[string], { n: number }>(
        "SELECT COUNT(*) AS n FROM inbox WHERE session_ref = ?"
      )
      .get(sessionRef);
    return row?.n ?? 0;
  }
}

// --- active projects schema + row mapping (#22) -----------------------------

const ACTIVE_PROJECTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS active_projects (
  channel_ref  TEXT PRIMARY KEY,
  enabled      INTEGER NOT NULL DEFAULT 1,
  config_json  TEXT,
  created_utc  TEXT NOT NULL,
  updated_utc  TEXT NOT NULL
);
`;

interface ActiveProjectRow {
  channel_ref: string;
  enabled: number;
  config_json: string | null;
  created_utc: string;
  updated_utc: string;
}

const mapActiveProject = (r: ActiveProjectRow): ActiveProject => ({
  channelRef: r.channel_ref,
  enabled: r.enabled !== 0,
  configJson: r.config_json,
  createdUtc: r.created_utc,
  updatedUtc: r.updated_utc,
});

// --- delegation ledger schema + row mapping ---------------------------------

const DELEGATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS delegation_log (
  id              TEXT PRIMARY KEY,
  source_ref      TEXT,
  target_ref      TEXT,
  worker          TEXT,
  kind            TEXT NOT NULL,
  prompt_preview  TEXT,
  correlation_id  TEXT,
  status          TEXT NOT NULL,
  created_utc     TEXT NOT NULL,
  updated_utc     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_delegation_correlation
  ON delegation_log(correlation_id);
CREATE INDEX IF NOT EXISTS idx_delegation_source
  ON delegation_log(source_ref);
`;

interface LedgerRow {
  id: string;
  source_ref: string | null;
  target_ref: string | null;
  worker: string | null;
  kind: string;
  prompt_preview: string | null;
  correlation_id: string | null;
  status: string;
  created_utc: string;
  updated_utc: string;
}

const mapLedger = (r: LedgerRow): LedgerEntry => ({
  id: r.id,
  sourceRef: r.source_ref,
  targetRef: r.target_ref,
  worker: r.worker,
  kind: r.kind as DelegationKind,
  promptPreview: r.prompt_preview,
  correlationId: r.correlation_id,
  status: r.status as DelegationStatus,
  createdUtc: r.created_utc,
  updatedUtc: r.updated_utc,
});

// --- conversational config-mutation audit (#58 P2/P3, D6) ------------------

const CONFIG_AUDIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS config_audit (
  id              TEXT PRIMARY KEY,
  tier            TEXT NOT NULL,
  actor_id        TEXT,
  actor_name      TEXT,
  scope           TEXT NOT NULL,
  summary         TEXT NOT NULL,
  before_json     TEXT NOT NULL,
  after_json      TEXT NOT NULL,
  correlation_id  TEXT,
  applied_utc     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_config_audit_scope
  ON config_audit(scope);
CREATE INDEX IF NOT EXISTS idx_config_audit_correlation
  ON config_audit(correlation_id);
`;

interface ConfigAuditRow {
  id: string;
  tier: string;
  actor_id: string | null;
  actor_name: string | null;
  scope: string;
  summary: string;
  before_json: string;
  after_json: string;
  correlation_id: string | null;
  applied_utc: string;
}

const mapConfigAudit = (r: ConfigAuditRow): ConfigAuditEntry => ({
  id: r.id,
  tier: r.tier,
  actorId: r.actor_id,
  actorName: r.actor_name,
  scope: r.scope,
  summary: r.summary,
  beforeJson: r.before_json,
  afterJson: r.after_json,
  correlationId: r.correlation_id,
  appliedUtc: r.applied_utc,
});

// --- chains schema + row mapping (#25) --------------------------------------

const CHAINS_SCHEMA = `
CREATE TABLE IF NOT EXISTS chains (
  id             TEXT PRIMARY KEY,
  hops_json      TEXT NOT NULL,
  origin_ref     TEXT NOT NULL,
  prompt_preview TEXT,
  status         TEXT NOT NULL,
  current_index  INTEGER NOT NULL,
  created_utc    TEXT NOT NULL,
  updated_utc    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chains_status ON chains(status);
`;

interface ChainRow {
  id: string;
  hops_json: string;
  origin_ref: string;
  prompt_preview: string | null;
  status: string;
  current_index: number;
  created_utc: string;
  updated_utc: string;
}

const mapChain = (r: ChainRow): Chain => ({
  id: r.id,
  hops: parseHops(r.hops_json),
  originRef: r.origin_ref,
  promptPreview: r.prompt_preview,
  status: r.status as ChainStatus,
  currentIndex: r.current_index,
  createdUtc: r.created_utc,
  updatedUtc: r.updated_utc,
});

// --- wake events schema + row mapping (#59) ---------------------------------

const WAKE_EVENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS wake_events (
  id              TEXT PRIMARY KEY,
  platform        TEXT NOT NULL,
  channel_ref     TEXT NOT NULL,
  parent_ref      TEXT,
  fire_at_utc     TEXT NOT NULL,
  prompt          TEXT NOT NULL,
  reason          TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  correlation_id  TEXT,
  chain_depth     INTEGER NOT NULL DEFAULT 0,
  catchup_seconds INTEGER NOT NULL DEFAULT 900,
  fire_on_startup INTEGER NOT NULL DEFAULT 0,
  created_utc     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wake_fire ON wake_events(fire_at_utc);
CREATE INDEX IF NOT EXISTS idx_wake_channel ON wake_events(platform, channel_ref);
`;

interface WakeRow {
  id: string;
  platform: string;
  channel_ref: string;
  parent_ref: string | null;
  fire_at_utc: string;
  prompt: string;
  reason: string;
  created_by: string;
  correlation_id: string | null;
  chain_depth: number;
  catchup_seconds: number;
  fire_on_startup: number;
  created_utc: string;
}

const mapWake = (r: WakeRow): WakeEvent => ({
  id: r.id,
  platform: r.platform,
  channelRef: r.channel_ref,
  parentRef: r.parent_ref,
  fireAtUtc: r.fire_at_utc,
  prompt: r.prompt,
  reason: r.reason,
  createdBy: r.created_by,
  correlationId: r.correlation_id,
  chainDepth: r.chain_depth,
  catchupSeconds: r.catchup_seconds,
  fireOnStartup: r.fire_on_startup !== 0,
  createdUtc: r.created_utc,
});

// --- watches schema + row mapping (#60) -------------------------------------

const WATCHES_SCHEMA = `
CREATE TABLE IF NOT EXISTS watches (
  id               TEXT PRIMARY KEY,
  platform         TEXT NOT NULL,
  channel_ref      TEXT NOT NULL,
  parent_ref       TEXT,
  kind             TEXT NOT NULL,
  spec             TEXT NOT NULL,
  match_expr       TEXT,
  interval_seconds INTEGER NOT NULL,
  prompt           TEXT NOT NULL,
  reason           TEXT NOT NULL,
  mode             TEXT NOT NULL DEFAULT 'once',
  max_fires        INTEGER NOT NULL DEFAULT 1,
  fire_count       INTEGER NOT NULL DEFAULT 0,
  last_checked_utc TEXT,
  last_fired_utc   TEXT,
  last_observed    TEXT,
  expires_at_utc   TEXT NOT NULL,
  created_by       TEXT NOT NULL,
  correlation_id   TEXT,
  created_utc      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_watch_channel ON watches(platform, channel_ref);
`;

interface WatchRow {
  id: string;
  platform: string;
  channel_ref: string;
  parent_ref: string | null;
  kind: string;
  spec: string;
  match_expr: string | null;
  interval_seconds: number;
  prompt: string;
  reason: string;
  mode: string;
  max_fires: number;
  fire_count: number;
  last_checked_utc: string | null;
  last_fired_utc: string | null;
  last_observed: string | null;
  expires_at_utc: string;
  created_by: string;
  correlation_id: string | null;
  created_utc: string;
}

const mapWatch = (r: WatchRow): WatchEvent => ({
  id: r.id,
  platform: r.platform,
  channelRef: r.channel_ref,
  parentRef: r.parent_ref,
  kind: r.kind as WatchEvent["kind"],
  spec: r.spec,
  match: r.match_expr,
  intervalSeconds: r.interval_seconds,
  prompt: r.prompt,
  reason: r.reason,
  mode: r.mode as WatchEvent["mode"],
  maxFires: r.max_fires,
  fireCount: r.fire_count,
  lastCheckedUtc: r.last_checked_utc,
  lastFiredUtc: r.last_fired_utc,
  lastObserved: r.last_observed,
  expiresAtUtc: r.expires_at_utc,
  createdBy: r.created_by,
  correlationId: r.correlation_id,
  createdUtc: r.created_utc,
});

// --- agent inbox schema + row mapping (#61) ---------------------------------

const INBOX_SCHEMA = `
CREATE TABLE IF NOT EXISTS inbox (
  id           TEXT PRIMARY KEY,
  session_ref  TEXT NOT NULL,
  from_ref     TEXT,
  body         TEXT NOT NULL,
  priority     INTEGER NOT NULL DEFAULT 0,
  created_utc  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inbox_session ON inbox(session_ref);
`;

interface InboxRow {
  id: string;
  session_ref: string;
  from_ref: string | null;
  body: string;
  priority: number;
  created_utc: string;
}

const mapInbox = (r: InboxRow): InboxMessage => ({
  id: r.id,
  sessionRef: r.session_ref,
  fromRef: r.from_ref,
  body: r.body,
  priority: r.priority !== 0,
  createdUtc: r.created_utc,
});

/** Defensive parse of the stored hops array — a corrupt row degrades to an
 *  empty (drained) chain rather than throwing on every read. */
function parseHops(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((h): h is string => typeof h === "string") : [];
  } catch {
    return [];
  }
}

/** Column whitelist for `updateDelegationStatus` — keeps the dynamic SET
 *  clause free of caller-supplied identifiers. */
const LEDGER_PATCH_COLUMNS: Record<keyof LedgerPatch, string> = {
  sourceRef: "source_ref",
  targetRef: "target_ref",
  worker: "worker",
  promptPreview: "prompt_preview",
  correlationId: "correlation_id",
};

function truncatePreview(text: string | null): string | null {
  if (text === null) return null;
  return text.length <= PROMPT_PREVIEW_MAX
    ? text
    : text.slice(0, PROMPT_PREVIEW_MAX);
}

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import {
  defaultSessionConfig,
  type Preset,
  type ThreadAlias,
  type PermissionPolicyMode,
  type SessionConfigState,
  type SessionRecord,
} from "./types.js";
import type { ScheduledPrompt } from "./scheduled-prompts/types.js";

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
  catchup_seconds    INTEGER NOT NULL DEFAULT 900,
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
  name          TEXT NOT NULL UNIQUE,
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_presets_name ON presets(name);

CREATE TABLE IF NOT EXISTS thread_aliases (
  alias        TEXT PRIMARY KEY,
  channel_ref  TEXT NOT NULL,
  description  TEXT,
  created_by   TEXT NOT NULL,
  created_utc  TEXT NOT NULL
);
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
      const parsed = JSON.parse(r.tools_json);
      if (parsed.allow) toolsAllow = parsed.allow;
      if (parsed.exclude) toolsExclude = parsed.exclude;
    } catch { /* keep null */ }
  }
  return {
    id: r.id,
    name: r.name,
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

interface AliasRow {
  alias: string;
  channel_ref: string;
  description: string | null;
  created_by: string;
  created_utc: string;
}

const mapAlias = (r: AliasRow): ThreadAlias => ({
  alias: r.alias,
  channelRef: r.channel_ref,
  description: r.description,
  createdBy: r.created_by,
  createdUtc: r.created_utc,
});

export class SessionStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    // Defensive column adds for tables created by an earlier schema version
    // (no migration framework). Ignored if the column already exists.
    for (const ddl of [
      "ALTER TABLE scheduled_prompts ADD COLUMN model TEXT",
      "ALTER TABLE scheduled_prompts ADD COLUMN cwd TEXT",
      "ALTER TABLE scheduled_prompts ADD COLUMN target_channel TEXT",
      "ALTER TABLE scheduled_prompts ADD COLUMN output_type TEXT NOT NULL DEFAULT 'card'",
    ]) {
      try { this.db.exec(ddl); } catch { /* column exists */ }
    }
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
            timezone, model, cwd, target_channel, output_type, catchup_seconds,
            enabled, attachments_json, created_by,
            created_utc, updated_utc, last_run_utc, last_status, next_run_utc,
            pinned_session_id)
         VALUES
           (@id, @platform, @channelRef, @parentRef, @name, @promptText, @cron,
            @timezone, @model, @cwd, @targetChannel, @outputType, @catchupSeconds,
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
    const toolsJson = (p.toolsAllow || p.toolsExclude)
      ? JSON.stringify({ allow: p.toolsAllow ?? undefined, exclude: p.toolsExclude ?? undefined })
      : null;
    this.db
      .prepare(
        `INSERT INTO presets
           (id, name, description, agent_id, model, effort, repo_path,
            permission, tools_json, instructions, created_by,
            created_utc, updated_utc)
         VALUES
           (@id, @name, @description, @agentId, @model, @effort, @repoPath,
            @permission, @toolsJson, @instructions, @createdBy,
            @createdUtc, @updatedUtc)
         ON CONFLICT(id) DO UPDATE SET
           name         = excluded.name,
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
        description: p.description,
        agentId: p.agentId,
        model: p.model,
        effort: p.effort,
        repoPath: p.repoPath,
        permission: p.permission,
        toolsJson: toolsJson,
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
    const row = this.db
      .prepare<[string], PresetRow>("SELECT * FROM presets WHERE name = ? COLLATE NOCASE")
      .get(name);
    return row ? mapPreset(row) : null;
  }

  listPresets(): Preset[] {
    return this.db
      .prepare<[], PresetRow>("SELECT * FROM presets ORDER BY name ASC")
      .all()
      .map(mapPreset);
  }

  deletePreset(id: string): void {
    this.db.prepare("DELETE FROM presets WHERE id = ?").run(id);
  }

  // --- thread aliases --------------------------------------------------------

  upsertAlias(a: ThreadAlias): void {
    this.db
      .prepare(
        `INSERT INTO thread_aliases (alias, channel_ref, description, created_by, created_utc)
         VALUES (@alias, @channelRef, @description, @createdBy, @createdUtc)
         ON CONFLICT(alias) DO UPDATE SET
           channel_ref = excluded.channel_ref,
           description = excluded.description`
      )
      .run({
        alias: a.alias,
        channelRef: a.channelRef,
        description: a.description,
        createdBy: a.createdBy,
        createdUtc: a.createdUtc,
      });
  }

  getAlias(alias: string): ThreadAlias | null {
    const row = this.db
      .prepare<[string], AliasRow>("SELECT * FROM thread_aliases WHERE alias = ? COLLATE NOCASE")
      .get(alias);
    return row ? mapAlias(row) : null;
  }

  listAliases(): ThreadAlias[] {
    return this.db
      .prepare<[], AliasRow>("SELECT * FROM thread_aliases ORDER BY alias ASC")
      .all()
      .map(mapAlias);
  }

  deleteAlias(alias: string): void {
    this.db.prepare("DELETE FROM thread_aliases WHERE alias = ? COLLATE NOCASE").run(alias);
  }

  static defaultConfig(
    defaultModel: string,
    defaultPolicy?: import("./types.js").PermissionPolicyMode
  ): SessionConfigState {
    return defaultSessionConfig(defaultModel, defaultPolicy);
  }
}

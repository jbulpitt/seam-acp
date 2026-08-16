import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { defaultSessionConfig, DELEGATION_ACTIVE_STATUSES, PROMPT_PREVIEW_MAX, } from "./types.js";
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
`;
const mapRow = (r) => ({
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
export function makeSessionId(platform, channelRef) {
    return `${platform}:${channelRef}`;
}
const mapScheduled = (r) => {
    let attachments = [];
    try {
        const parsed = JSON.parse(r.attachments_json);
        if (Array.isArray(parsed))
            attachments = parsed;
    }
    catch { /* keep empty */ }
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
const mapPreset = (r) => {
    let toolsAllow = null;
    let toolsExclude = null;
    if (r.tools_json) {
        try {
            const parsed = JSON.parse(r.tools_json);
            if (parsed.allow)
                toolsAllow = parsed.allow;
            if (parsed.exclude)
                toolsExclude = parsed.exclude;
        }
        catch {
            /* corrupt json — treat as "no tool overrides" rather than failing the read */
        }
    }
    return {
        id: r.id,
        name: r.name,
        description: r.description,
        agentId: r.agent_id,
        model: r.model,
        effort: r.effort,
        repoPath: r.repo_path,
        permission: r.permission,
        toolsAllow,
        toolsExclude,
        instructions: r.instructions,
        createdBy: r.created_by,
        createdUtc: r.created_utc,
        updatedUtc: r.updated_utc,
    };
};
export class SessionStore {
    db;
    constructor(dbPath) {
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        this.db = new Database(dbPath);
        this.db.pragma("journal_mode = WAL");
        this.db.exec(SCHEMA);
        this.db.exec(DELEGATION_SCHEMA);
        // Defensive column adds for tables created by an earlier schema version
        // (no migration framework). Ignored if the column already exists.
        for (const ddl of [
            "ALTER TABLE scheduled_prompts ADD COLUMN model TEXT",
            "ALTER TABLE scheduled_prompts ADD COLUMN cwd TEXT",
            "ALTER TABLE scheduled_prompts ADD COLUMN target_channel TEXT",
            "ALTER TABLE scheduled_prompts ADD COLUMN output_type TEXT NOT NULL DEFAULT 'card'",
        ]) {
            try {
                this.db.exec(ddl);
            }
            catch { /* column exists */ }
        }
    }
    close() {
        this.db.close();
    }
    get(id) {
        const row = this.db
            .prepare("SELECT * FROM sessions WHERE id = ?")
            .get(id);
        return row ? mapRow(row) : null;
    }
    getByChannel(platform, channelRef) {
        const row = this.db
            .prepare("SELECT * FROM sessions WHERE platform = ? AND channel_ref = ?")
            .get(platform, channelRef);
        return row ? mapRow(row) : null;
    }
    list(limit = 100) {
        const rows = this.db
            .prepare("SELECT * FROM sessions ORDER BY updated_utc DESC LIMIT ?")
            .all(limit);
        return rows.map(mapRow);
    }
    upsert(record) {
        this.db
            .prepare(`INSERT INTO sessions
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
           updated_utc     = excluded.updated_utc`)
            .run(record);
    }
    // --- scheduled prompts ----------------------------------------------------
    upsertScheduled(s) {
        this.db
            .prepare(`INSERT INTO scheduled_prompts
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
           pinned_session_id = excluded.pinned_session_id`)
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
    getScheduled(id) {
        const row = this.db
            .prepare("SELECT * FROM scheduled_prompts WHERE id = ?")
            .get(id);
        return row ? mapScheduled(row) : null;
    }
    listScheduledByChannel(platform, channelRef) {
        return this.db
            .prepare("SELECT * FROM scheduled_prompts WHERE platform = ? AND channel_ref = ? ORDER BY created_utc ASC")
            .all(platform, channelRef)
            .map(mapScheduled);
    }
    listScheduledEnabled() {
        return this.db
            .prepare("SELECT * FROM scheduled_prompts WHERE enabled = 1")
            .all()
            .map(mapScheduled);
    }
    listAllScheduled() {
        return this.db
            .prepare("SELECT * FROM scheduled_prompts ORDER BY created_utc ASC")
            .all()
            .map(mapScheduled);
    }
    deleteScheduled(id) {
        this.db.prepare("DELETE FROM scheduled_prompts WHERE id = ?").run(id);
    }
    readConfig(record) {
        if (!record.configJson)
            return {};
        try {
            const parsed = JSON.parse(record.configJson);
            return parsed ?? {};
        }
        catch {
            return {};
        }
    }
    writeConfig(cfg) {
        return JSON.stringify(cfg, null, 2);
    }
    // --- presets ---------------------------------------------------------------
    upsertPreset(p) {
        const toolsJson = p.toolsAllow || p.toolsExclude
            ? JSON.stringify({
                allow: p.toolsAllow ?? undefined,
                exclude: p.toolsExclude ?? undefined,
            })
            : null;
        this.db
            .prepare(`INSERT INTO presets
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
           updated_utc  = excluded.updated_utc`)
            .run({
            id: p.id,
            name: p.name,
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
    getPreset(id) {
        const row = this.db
            .prepare("SELECT * FROM presets WHERE id = ?")
            .get(id);
        return row ? mapPreset(row) : null;
    }
    getPresetByName(name) {
        const row = this.db
            .prepare("SELECT * FROM presets WHERE name = ? COLLATE NOCASE")
            .get(name);
        return row ? mapPreset(row) : null;
    }
    listPresets() {
        return this.db
            .prepare("SELECT * FROM presets ORDER BY name ASC")
            .all()
            .map(mapPreset);
    }
    deletePreset(id) {
        this.db.prepare("DELETE FROM presets WHERE id = ?").run(id);
    }
    static defaultConfig(defaultModel, defaultPolicy) {
        return defaultSessionConfig(defaultModel, defaultPolicy);
    }
    // --- delegation ledger ----------------------------------------------------
    /**
     * Insert one ledger row. `status` defaults to "dispatched" and the
     * timestamps to now. `promptPreview` is truncated to `PROMPT_PREVIEW_MAX`
     * so the column can never grow into a full prompt copy. Returns the row as
     * persisted, so the caller sees the stamped defaults.
     */
    recordDelegation(entry) {
        const now = new Date().toISOString();
        const createdUtc = entry.createdUtc ?? now;
        const row = {
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
            .prepare(`INSERT INTO delegation_log
           (id, source_ref, target_ref, worker, kind, prompt_preview,
            correlation_id, status, created_utc, updated_utc)
         VALUES
           (@id, @sourceRef, @targetRef, @worker, @kind, @promptPreview,
            @correlationId, @status, @createdUtc, @updatedUtc)`)
            .run(row);
        return row;
    }
    /**
     * Move a row to a new status, re-stamping `updated_utc`. `patch` may amend
     * the mutable fields in the same write — e.g. attaching the resolved
     * `targetRef` when a dispatched handoff starts running. Unknown ids are a
     * silent no-op (the ledger is observability, never a control path).
     */
    updateDelegationStatus(id, status, patch) {
        const sets = ["status = @status", "updated_utc = @updatedUtc"];
        const params = {
            id,
            status,
            updatedUtc: new Date().toISOString(),
        };
        for (const [key, column] of Object.entries(LEDGER_PATCH_COLUMNS)) {
            if (!patch || !(key in patch))
                continue;
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
    getDelegationByCorrelation(correlationId) {
        const row = this.db
            .prepare(`SELECT * FROM delegation_log WHERE correlation_id = ?
         ORDER BY created_utc ASC, rowid ASC LIMIT 1`)
            .get(correlationId);
        return row ? mapLedger(row) : null;
    }
    /** Rows still in flight, oldest first — the order a watchdog wants. */
    listActiveDelegations() {
        const placeholders = DELEGATION_ACTIVE_STATUSES.map(() => "?").join(", ");
        return this.db
            .prepare(`SELECT * FROM delegation_log WHERE status IN (${placeholders})
         ORDER BY created_utc ASC, rowid ASC`)
            .all(...DELEGATION_ACTIVE_STATUSES)
            .map(mapLedger);
    }
    listRecentDelegations(limit = 50) {
        return this.db
            .prepare(`SELECT * FROM delegation_log
         ORDER BY created_utc DESC, rowid DESC LIMIT ?`)
            .all(limit)
            .map(mapLedger);
    }
    listDelegationsBySource(sourceRef) {
        return this.db
            .prepare(`SELECT * FROM delegation_log WHERE source_ref = ?
         ORDER BY created_utc DESC, rowid DESC`)
            .all(sourceRef)
            .map(mapLedger);
    }
}
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
const mapLedger = (r) => ({
    id: r.id,
    sourceRef: r.source_ref,
    targetRef: r.target_ref,
    worker: r.worker,
    kind: r.kind,
    promptPreview: r.prompt_preview,
    correlationId: r.correlation_id,
    status: r.status,
    createdUtc: r.created_utc,
    updatedUtc: r.updated_utc,
});
/** Column whitelist for `updateDelegationStatus` — keeps the dynamic SET
 *  clause free of caller-supplied identifiers. */
const LEDGER_PATCH_COLUMNS = {
    sourceRef: "source_ref",
    targetRef: "target_ref",
    worker: "worker",
    promptPreview: "prompt_preview",
    correlationId: "correlation_id",
};
function truncatePreview(text) {
    if (text === null)
        return null;
    return text.length <= PROMPT_PREVIEW_MAX
        ? text
        : text.slice(0, PROMPT_PREVIEW_MAX);
}
//# sourceMappingURL=session-store.js.map
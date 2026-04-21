import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import {
  defaultSessionConfig,
  type SessionConfigState,
  type SessionRecord,
} from "./types.js";

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

export class SessionStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
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

  static defaultConfig(
    defaultModel: string,
    defaultPolicy?: import("./types.js").PermissionPolicyMode
  ): SessionConfigState {
    return defaultSessionConfig(defaultModel, defaultPolicy);
  }
}

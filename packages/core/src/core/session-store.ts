import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  defaultSessionConfig,
  type ActiveProject,
  type Chain,
  type ChainCreateInput,
  type ChainStatus,
  type PermissionPolicyMode,
  type Preset,
  parseStatusCardStyle,
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
import type {
  ChoiceCard,
  ChoiceCardStatus,
  ChoiceOption,
  ChoiceResultRow,
  ChoiceResultStatus,
  ChoiceTarget,
} from "./choice/types.js";
import type { IngestEndpoint, IngestEndpointStatus } from "./choice/endpoint.js";
import type { LiveHelpSession, LiveHelpStatus } from "./live-help/types.js";
import {
  composeThreadVoicePrompt,
  newThreadVoiceDispatchId,
  newThreadVoiceSegmentId,
  type ThreadVoiceBatch,
  type ThreadVoicePendingStats,
  type ThreadVoiceSegment,
  type ThreadVoiceSegmentState,
  type ThreadVoiceSession,
  type ThreadVoiceSessionStatus,
} from "./thread-voice/types.js";
import {
  composeVoiceConsolePrompt,
  assertVoiceConsoleAuthorityId,
  newVoiceConsoleCaptureId,
  newVoiceConsoleFanoutGroupId,
  newVoiceConsoleId,
  normalizeVoiceConsoleAlias,
  sanitizeVoiceConsoleFailureMessage,
  sanitizeVoiceConsoleSpeakerName,
  type AddVoiceConsoleBindingInput,
  type CreateVoiceConsoleInput,
  type ThreadVoiceBinding,
  type VoiceConsoleAddInteraction,
  type VoiceConsoleBatch,
  type VoiceConsoleBindingStatus,
  type VoiceConsoleCaptureCommitResult,
  type VoiceConsoleCaptureIdentity,
  type VoiceConsoleCaptureTerminal,
  type VoiceConsoleCaptureTerminalOutcome,
  type VoiceConsoleDropCaptureInput,
  type VoiceConsoleCaptureSnapshot,
  type VoiceConsoleFinalCapture,
  type VoiceConsoleInputTarget,
  type VoiceConsoleMutationFailure,
  type VoiceConsoleMutationOutcome,
  type VoiceConsoleMutationResult,
  type VoiceConsoleQuarantinedDispatch,
  type VoiceConsoleSegment,
  type VoiceConsoleSession,
  type VoiceConsoleStatus,
  type VoiceConsoleUpgradeDefaults,
} from "./voice-console/types.js";
import { INBOX_MAX_PER_SESSION, type InboxMessage } from "./inbox/types.js";
import type { ParkedAttachment, ParkedPrompt } from "./parked-prompts/types.js";

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
  name_prefix     TEXT,
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
  -- LEGACY (#158): scheduled-prompt attachments were removed. Kept readable
  -- only so pre-removal rows can be detected and quarantined; new rows are
  -- always '[]'. Drop the column in a later migration once no rows carry
  -- entries. See scheduled-prompts/quarantine.ts.
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

interface Row {
  id: string;
  platform: string;
  channel_ref: string;
  parent_ref: string | null;
  agent_id: string;
  acp_session_id: string;
  repo_path: string | null;
  config_json: string;
  name_prefix: string | null;
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
  namePrefix: r.name_prefix,
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
  // #158: attachments are gone. The column is still read (never written except
  // to clear) so legacy rows can be identified and quarantined; a corrupt or
  // non-array value degrades to "no legacy attachments" rather than throwing.
  let legacyAttachmentCount = 0;
  try {
    const parsed = JSON.parse(r.attachments_json);
    if (Array.isArray(parsed)) legacyAttachmentCount = parsed.length;
  } catch { /* keep 0 */ }
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
    legacyAttachmentCount,
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

/**
 * Deterministic ids for the child a chain-hop completion plans (#174), so a
 * replay reuses the SAME child instead of minting a second one.
 */
export const CHAIN_HOP_ID_PREFIX = "chain_hop:";
export const CHAIN_DELIVERY_ID_PREFIX = "chain_delivery:";
const CHAIN_CHILD_ID_DIGEST_HEX_LENGTH = 64;
export const MAX_CHAIN_CHILD_DISPATCH_ID_LENGTH =
  CHAIN_DELIVERY_ID_PREFIX.length + CHAIN_CHILD_ID_DIGEST_HEX_LENGTH;

/**
 * Build a deterministic, filesystem-safe id for a chain completion's child.
 *
 * The id deliberately depends on logical chain position rather than the
 * completing dispatch id. Prefixing each child with its parent's id made the
 * filename grow once per hop until ordinary long chains hit NAME_MAX.
 */
export function plannedChainChildDispatchId(input: {
  chainId: string;
  currentIndex: number;
  kind: "hop" | "delivery";
}): string {
  if (!Number.isSafeInteger(input.currentIndex) || input.currentIndex < 0) {
    throw new Error(`invalid chain current index: ${input.currentIndex}`);
  }
  const prefix = input.kind === "hop" ? CHAIN_HOP_ID_PREFIX : CHAIN_DELIVERY_ID_PREFIX;
  const digest = createHash("sha256")
    .update(input.kind)
    .update("\0")
    .update(input.chainId)
    .update("\0")
    .update(String(input.currentIndex))
    .digest("hex");
  return `${prefix}${digest}`;
}

/**
 * Whether a stored `chain_advance:` claim's `targetRef` is a planned child id
 * this code wrote, rather than a legacy value that only LOOKS usable.
 *
 * The #77 claim used the same row id and stored the hop's target THREAD there.
 * A replay that trusted it would dispatch under a Discord thread id and, worse,
 * read the row's `worker` — the completed hop's OWN preset — as the next hop,
 * paying for that worker a second time.
 */
export function isPlannedChainChildId(id: string | null | undefined): id is string {
  return (
    typeof id === "string" &&
    (id.startsWith(CHAIN_HOP_ID_PREFIX) || id.startsWith(CHAIN_DELIVERY_ID_PREFIX))
  );
}

export class SessionStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.db.exec(DELEGATION_SCHEMA);
    this.migrateReportBackDedupIndex();
    this.migrateDelegationAcpSessionId();
    this.db.exec(CONFIG_AUDIT_SCHEMA);
    this.db.exec(ACTIVE_PROJECTS_SCHEMA);
    this.db.exec(CHAINS_SCHEMA);
    this.db.exec(WAKE_EVENTS_SCHEMA);
    this.db.exec(WATCHES_SCHEMA);
    this.db.exec(INBOX_SCHEMA);
    this.db.exec(PARKED_PROMPTS_SCHEMA);
    this.migrateParkedKind();
    this.db.exec(CHOICE_CARDS_SCHEMA);
    this.migrateChoiceIngest();
    this.migrateChoiceSelect();
    this.db.exec(INGEST_ENDPOINTS_SCHEMA);
    this.migrateIngestEndpointPreset();
    this.db.exec(LIVE_HELP_SCHEMA);
    this.db.exec(THREAD_VOICE_SCHEMA);
    this.db.exec(VOICE_CONSOLE_SCHEMA);
    this.migrateVoiceConsoleV2();
    this.migrateVoiceConsoleInteractionOutcomes();
    this.migrateVoiceConsoleCaptureIdentity();
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
    this.migratePresetStatusCardStyle();
    this.migratePresetsScope();
    this.migratePresetRole();
    try { this.db.exec("ALTER TABLE sessions ADD COLUMN name_prefix TEXT"); } catch { /* exists */ }
  }

  /** Additive V2 migration over the shipped V1 compatibility tables. */
  private migrateVoiceConsoleV2(): void {
    for (const ddl of [
      "ALTER TABLE thread_voice_sessions ADD COLUMN console_id TEXT",
      "ALTER TABLE thread_voice_sessions ADD COLUMN alias TEXT",
      "ALTER TABLE thread_voice_sessions ADD COLUMN alias_normalized TEXT",
      "ALTER TABLE thread_voice_sessions ADD COLUMN tts_voice TEXT",
      "ALTER TABLE thread_voice_sessions ADD COLUMN tts_pace TEXT",
      "ALTER TABLE thread_voice_sessions ADD COLUMN tts_style TEXT",
      "ALTER TABLE thread_voice_sessions ADD COLUMN profile_updated_utc TEXT",
      "ALTER TABLE thread_voice_sessions ADD COLUMN output_enabled INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE thread_voice_sessions ADD COLUMN output_generation INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE thread_voice_segments ADD COLUMN capture_id TEXT",
      "ALTER TABLE thread_voice_segments ADD COLUMN fanout_group_id TEXT",
      "ALTER TABLE thread_voice_segments ADD COLUMN author_name TEXT",
    ]) {
      try {
        this.db.exec(ddl);
      } catch {
        /* column already exists */
      }
    }
    // V1 owned the guild exclusivity on its binding row. V2 moves it to the
    // console row while retaining a unique active home-thread binding.
    this.db.exec("DROP INDEX IF EXISTS idx_thread_voice_active_guild");
    this.db.exec("DROP INDEX IF EXISTS idx_thread_voice_active_thread");
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_voice_active_thread
        ON thread_voice_sessions(platform, channel_ref)
        WHERE status IN ('starting','ready','stopping','adding','active','removing');
      CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_voice_active_v1_guild
        ON thread_voice_sessions(guild_id)
        WHERE console_id IS NULL AND status IN ('starting','ready','stopping');
      CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_console_active_guild
        ON voice_console_sessions(guild_id)
        WHERE status IN ('starting','ready','stopping');
      CREATE INDEX IF NOT EXISTS idx_voice_console_active_owner
        ON voice_console_sessions(guild_id, owner_user_id, status);
      CREATE INDEX IF NOT EXISTS idx_voice_console_active_vc
        ON voice_console_sessions(voice_channel_id, status);
      CREATE INDEX IF NOT EXISTS idx_thread_voice_active_console
        ON thread_voice_sessions(console_id, status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_voice_active_alias
        ON thread_voice_sessions(console_id, alias_normalized)
        WHERE console_id IS NOT NULL
          AND status IN ('adding','active','removing');
      CREATE INDEX IF NOT EXISTS idx_thread_voice_segments_capture
        ON thread_voice_segments(capture_id);
    `);
  }

  private migrateVoiceConsoleInteractionOutcomes(): void {
    const columns = this.db
      .prepare<[], { name: string }>("PRAGMA table_info(voice_console_mutations)")
      .all()
      .map((row) => row.name);
    if (!columns.includes("action")) {
      this.db.exec(
        "ALTER TABLE voice_console_mutations ADD COLUMN action TEXT NOT NULL DEFAULT 'legacy'"
      );
    }
    if (!columns.includes("input_fingerprint")) {
      this.db.exec("ALTER TABLE voice_console_mutations ADD COLUMN input_fingerprint TEXT");
    }
  }

  /** Backfill ordered capture ownership while quarantining malformed legacy groups. */
  private migrateVoiceConsoleCaptureIdentity(): void {
    const terminalColumns = this.db
      .prepare<[], { name: string }>("PRAGMA table_info(voice_console_capture_terminals)")
      .all()
      .map((row) => row.name);
    for (const [name, ddl] of [
      ["speaker_id", "ALTER TABLE voice_console_capture_terminals ADD COLUMN speaker_id TEXT"],
      ["captured_started_utc", "ALTER TABLE voice_console_capture_terminals ADD COLUMN captured_started_utc TEXT"],
      ["target_fingerprint", "ALTER TABLE voice_console_capture_terminals ADD COLUMN target_fingerprint TEXT"],
      ["forwarded_audio_ms", "ALTER TABLE voice_console_capture_terminals ADD COLUMN forwarded_audio_ms REAL"],
    ] as const) {
      if (!terminalColumns.includes(name)) this.db.exec(ddl);
    }
    const reservationColumns = this.db
      .prepare<[], { name: string }>("PRAGMA table_info(voice_console_capture_reservations)")
      .all()
      .map((row) => row.name);
    for (const [name, ddl] of [
      ["identity_version", "ALTER TABLE voice_console_capture_reservations ADD COLUMN identity_version INTEGER NOT NULL DEFAULT 1"],
      ["identity_valid", "ALTER TABLE voice_console_capture_reservations ADD COLUMN identity_valid INTEGER NOT NULL DEFAULT 1"],
      ["invalid_reason", "ALTER TABLE voice_console_capture_reservations ADD COLUMN invalid_reason TEXT"],
    ] as const) {
      if (!reservationColumns.includes(name)) this.db.exec(ddl);
    }

    const migrate = this.db.transaction(() => {
      const captureIds = this.db
        .prepare<[], { capture_id: string }>(
          `SELECT capture_id FROM thread_voice_segments WHERE capture_id IS NOT NULL
           UNION SELECT capture_id FROM voice_console_capture_reservations
           UNION SELECT capture_id FROM voice_console_capture_terminals
           ORDER BY capture_id`
        )
        .all();
      for (const { capture_id: captureId } of captureIds) {
        try {
          this.migrateVoiceConsoleCaptureIdentityOne(captureId);
        } catch (err) {
          this.invalidateLegacyVoiceConsoleCapture(
            captureId,
            err instanceof Error ? err.message : String(err)
          );
        }
      }
    });
    migrate();
  }

  private migrateVoiceConsoleCaptureIdentityOne(captureId: string): void {
    if (this.isVoiceConsoleCaptureQuarantined(captureId)) {
      this.applyVoiceConsoleCaptureQuarantine(
        captureId,
        "capture id was previously quarantined",
        new Date().toISOString()
      );
      return;
    }
    assertVoiceConsoleAuthorityId(captureId, "Voice Console capture id");
    const rows = this.voiceConsoleCaptureRows(captureId);
    const terminal = this.getVoiceConsoleCaptureTerminal(captureId);
    const existing = this.getVoiceConsoleCaptureReservation(captureId);
    if (existing?.identity_valid === 0) {
      this.invalidateLegacyVoiceConsoleCapture(
        captureId,
        existing.invalid_reason ?? "capture identity was previously quarantined"
      );
      return;
    }
    const explicit = this.listVoiceConsoleCaptureTargets(captureId);
    if (rows.length === 0) {
      if (!existing || !terminal || explicit.length === 0) {
        throw new Error("capture identity has no reservation rows");
      }
      const ordinalsValid = explicit.every((target, ordinal) => target.target_ordinal === ordinal);
      const ordered = orderedCaptureTargets(
        explicit.map((target) => ({ bindingId: target.binding_id, sequence: target.sequence }))
      );
      if (!ordinalsValid) throw new Error("capture ordered target identity is malformed");
      const fingerprint = captureTargetFingerprint(ordered);
      if (existing.identity_version >= 2 && existing.target_fingerprint !== fingerprint) {
        throw new Error("capture target fingerprint conflicts with ordered identity");
      }
      this.db
        .prepare(
          `UPDATE voice_console_capture_reservations
              SET target_fingerprint = ?, identity_version = 2, identity_valid = 1,
                  invalid_reason = NULL WHERE capture_id = ?`
        )
        .run(fingerprint, captureId);
      this.db
        .prepare(
          `UPDATE voice_console_capture_terminals
              SET speaker_id = COALESCE(speaker_id, ?),
                  captured_started_utc = COALESCE(captured_started_utc, ?),
                  target_fingerprint = ? WHERE capture_id = ?`
        )
        .run(existing.speaker_id, existing.captured_started_utc, fingerprint, captureId);
      this.repairLegacyVoiceConsoleCaptureTerminal(captureId);
      return;
    }

    const first = rows[0]!;
    const binding = this.getVoiceConsoleBinding(first.session_id);
    if (!binding) throw new Error("capture target binding is missing");
    const identityKey = `${binding.consoleId}\u0000${first.author_id}\u0000${first.captured_started_utc}`;
    const fanoutIds = new Set(rows.map((row) => row.fanout_group_id ?? ""));
    if (fanoutIds.size !== 1) throw new Error("capture fan-out identity is inconsistent");
    for (const row of rows) {
      assertVoiceConsoleAuthorityId(row.session_id, "Voice Console capture binding id");
      const targetBinding = this.getVoiceConsoleBinding(row.session_id);
      if (!targetBinding) throw new Error("capture target binding is missing");
      const rowIdentity = `${targetBinding.consoleId}\u0000${row.author_id}\u0000${row.captured_started_utc}`;
      if (rowIdentity !== identityKey) throw new Error("capture speaker or console identity is inconsistent");
    }
    const derived = orderedCaptureTargets(
      rows.map((row) => ({ bindingId: row.session_id, sequence: row.sequence }))
    );

    let ordered = explicit.map((target) => ({
      bindingId: target.binding_id,
      sequence: target.sequence,
    }));
    const needsTargetBackfill = explicit.length === 0;
    if (explicit.length === 0) {
      if (existing && existing.identity_version >= 2) {
        throw new Error("capture ordered target identity is missing");
      }
      ordered = derived;
    } else {
      const ordinalsValid = explicit.every((target, ordinal) => target.target_ordinal === ordinal);
      const derivedKeys = new Set(derived.map(captureTargetKey));
      const explicitKeys = new Set(orderedCaptureTargets(ordered).map(captureTargetKey));
      if (
        !ordinalsValid ||
        explicit.length !== derived.length ||
        explicitKeys.size !== derivedKeys.size ||
        [...explicitKeys].some((key) => !derivedKeys.has(key))
      ) {
        throw new Error("capture ordered target identity conflicts with reservation rows");
      }
    }
    ordered = orderedCaptureTargets(ordered);
    const fingerprint = captureTargetFingerprint(ordered);

    if (existing) {
      if (
        existing.console_id !== binding.consoleId ||
        existing.speaker_id !== first.author_id ||
        existing.captured_started_utc !== first.captured_started_utc
      ) {
        throw new Error("capture reservation identity conflicts with reservation rows");
      }
      if (existing.identity_version >= 2 && existing.target_fingerprint !== fingerprint) {
        throw new Error("capture target fingerprint conflicts with ordered identity");
      }
      this.db
        .prepare(
          `UPDATE voice_console_capture_reservations
              SET target_fingerprint = ?, identity_version = 2, identity_valid = 1,
                  invalid_reason = NULL WHERE capture_id = ?`
        )
        .run(fingerprint, captureId);
    } else {
      this.db
        .prepare(
          `INSERT INTO voice_console_capture_reservations
             (capture_id, console_id, speaker_id, speaker_name, captured_started_utc,
              fanout_group_id, target_fingerprint, identity_version, identity_valid,
              invalid_reason, created_utc)
           VALUES (?, ?, ?, ?, ?, ?, ?, 2, 1, NULL, ?)`
        )
        .run(
          captureId,
          binding.consoleId,
          first.author_id,
          first.author_name ?? first.author_id,
          first.captured_started_utc,
          first.fanout_group_id,
          fingerprint,
          first.created_utc
        );
    }
    if (needsTargetBackfill) this.insertVoiceConsoleCaptureTargets(captureId, ordered);
    this.db
      .prepare(
        `UPDATE voice_console_capture_terminals
            SET speaker_id = COALESCE(speaker_id, ?),
                captured_started_utc = COALESCE(captured_started_utc, ?),
                target_fingerprint = ?
          WHERE capture_id = ?`
      )
      .run(first.author_id, first.captured_started_utc, fingerprint, captureId);
    this.repairLegacyVoiceConsoleCaptureTerminal(captureId);
  }

  private invalidateLegacyVoiceConsoleCapture(captureId: string, detail: string): void {
    this.applyVoiceConsoleCaptureQuarantine(captureId, detail, new Date().toISOString());
  }

  quarantineVoiceConsoleCapture(
    captureId: string,
    detail: string,
    quarantinedUtc = new Date().toISOString()
  ): { captureId: string; reason: string; dispatchIds: string[] } {
    const quarantine = this.db.transaction(() =>
      this.applyVoiceConsoleCaptureQuarantine(captureId, detail, quarantinedUtc)
    );
    return quarantine();
  }

  private applyVoiceConsoleCaptureQuarantine(
    captureId: string,
    detail: string,
    quarantinedUtc: string
  ): { captureId: string; reason: string; dispatchIds: string[] } {
    const reason = sanitizeVoiceConsoleAuditReason(
      detail.startsWith("invalid legacy capture identity:")
        ? detail
        : `invalid legacy capture identity: ${detail}`
    );
    this.db
      .prepare(
        `INSERT OR IGNORE INTO voice_console_invalid_captures
           (capture_id, reason, recovered_utc) VALUES (?, ?, ?)`
      )
      .run(captureId, reason, quarantinedUtc);
    const durableReason = this.db
      .prepare<[string], { reason: string }>(
        "SELECT reason FROM voice_console_invalid_captures WHERE capture_id = ?"
      )
      .get(captureId)?.reason ?? reason;
    this.db
      .prepare(
        `UPDATE voice_console_capture_reservations
            SET identity_valid = 0, invalid_reason = ? WHERE capture_id = ?`
      )
      .run(durableReason, captureId);
    const claimed = this.db
      .prepare<[string], { dispatch_id: string; session_id: string }>(
        `SELECT DISTINCT dispatch_id, session_id FROM thread_voice_segments
          WHERE capture_id = ? AND dispatch_id IS NOT NULL
            AND state IN ('batched','dispatched')`
      )
      .all(captureId);
    const insertDispatch = this.db.prepare(
      `INSERT OR IGNORE INTO voice_console_quarantined_dispatches
         (dispatch_id, capture_id, binding_id, reason, artifact_state,
          quarantined_utc, reconciled_utc)
       VALUES (?, ?, ?, ?, 'unknown', ?, NULL)`
    );
    for (const row of claimed) {
      insertDispatch.run(
        row.dispatch_id,
        captureId,
        row.session_id,
        durableReason,
        quarantinedUtc
      );
    }
    this.db
      .prepare(
        `UPDATE thread_voice_segments SET transcript = '', state = 'capture_dropped',
           error = ?, updated_utc = ?
         WHERE capture_id = ? AND (
           state IN ('capturing','finalizing','pending')
           OR (state IN ('batched','dispatched') AND dispatch_id IS NULL)
         )`
      )
      .run(durableReason, quarantinedUtc, captureId);
    return {
      captureId,
      reason: durableReason,
      dispatchIds: [...new Set(claimed.map((row) => row.dispatch_id))],
    };
  }

  private repairLegacyVoiceConsoleCaptureTerminal(captureId: string): void {
    const terminal = this.getVoiceConsoleCaptureTerminal(captureId);
    if (!terminal) return;
    const recoveryState = terminal.outcome === "failed" ? "transcribe_failed" : "capture_dropped";
    const recoveryReason =
      terminal.reason ??
      (terminal.outcome === "committed"
        ? "legacy committed capture is missing finalized transcript state"
        : "legacy capture terminal recovered");
    this.db
      .prepare(
        `UPDATE thread_voice_segments SET transcript = '', state = ?, error = ?,
           captured_ended_utc = ?, updated_utc = ?
         WHERE capture_id = ? AND state IN ('capturing','finalizing')`
      )
      .run(
        recoveryState,
        recoveryReason,
        terminal.capturedEndedUtc,
        terminal.capturedEndedUtc,
        captureId
      );
  }

  /** #145: role + naming opt-out. Legacy thread_slug is deliberately ignored. */
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

  /** #96: additive status_card_style on presets. Null = preset does not pin it. */
  private migratePresetStatusCardStyle(): void {
    try {
      this.db.exec("ALTER TABLE presets ADD COLUMN status_card_style TEXT");
    } catch {
      /* column already exists */
    }
  }

  /** #92: ingest token + result waiter tables. Idempotent ALTERs. */
  private migrateChoiceIngest(): void {
    for (const ddl of [
      "ALTER TABLE choice_cards ADD COLUMN ingest_token_hash TEXT",
      "ALTER TABLE choice_cards ADD COLUMN ingest_option_index INTEGER",
      "ALTER TABLE choice_cards ADD COLUMN result_schema_json TEXT",
      "ALTER TABLE choice_cards ADD COLUMN ingest_wrapper TEXT",
      "ALTER TABLE choice_cards ADD COLUMN ingest_cors_json TEXT",
      "ALTER TABLE choice_cards ADD COLUMN last_option_index INTEGER",
    ]) {
      try {
        this.db.exec(ddl);
      } catch {
        /* column exists */
      }
    }
    try {
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_choice_ingest_hash ON choice_cards(ingest_token_hash) WHERE ingest_token_hash IS NOT NULL"
      );
    } catch {
      /* ignore */
    }
    this.db.exec(CHOICE_RESULTS_SCHEMA);
  }

  /**
   * Additive multi-select bounds (#94). Fresh DBs get the columns from
   * CREATE TABLE; existing DBs hit this PRAGMA-guarded ALTER. Idempotent.
   */
  private migrateChoiceSelect(): void {
    const names = new Set(
      this.db
        .prepare<[], { name: string }>("PRAGMA table_info(choice_cards)")
        .all()
        .map((c) => c.name)
    );
    if (!names.has("select_min")) {
      this.db.exec("ALTER TABLE choice_cards ADD COLUMN select_min INTEGER");
    }
    if (!names.has("select_max")) {
      this.db.exec("ALTER TABLE choice_cards ADD COLUMN select_max INTEGER");
    }
    if (!names.has("last_option_indices_json")) {
      this.db.exec("ALTER TABLE choice_cards ADD COLUMN last_option_indices_json TEXT");
    }
  }

  /** #95: named preset resolved at fire. Fresh DBs get it from CREATE TABLE. */
  private migrateIngestEndpointPreset(): void {
    try {
      const names = new Set(
        this.db
          .prepare<[], { name: string }>("PRAGMA table_info(ingest_endpoints)")
          .all()
          .map((c) => c.name)
      );
      if (!names.has("preset")) {
        this.db.exec("ALTER TABLE ingest_endpoints ADD COLUMN preset TEXT");
      }
    } catch {
      /* table missing — CREATE TABLE runs first */
    }
  }

  /**
   * Additive column so a dispatch can persist the ACP session it is running
   * in (#75). Fresh DBs get the column from CREATE TABLE; prod DBs opened
   * after upgrade hit this PRAGMA-guarded ALTER. Idempotent: a no-op once
   * the column exists. Does not touch the #77 report-back unique index.
   */
  private migrateDelegationAcpSessionId(): void {
    const hasColumn = this.db
      .prepare<[], { name: string }>("PRAGMA table_info(delegation_log)")
      .all()
      .some((c) => c.name === "acp_session_id");
    if (!hasColumn) {
      this.db.exec("ALTER TABLE delegation_log ADD COLUMN acp_session_id TEXT");
    }
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
   * Additive column so a parked row can distinguish #88 (bridge offline) from
   * #89 (`/seam queue` while a turn is running). Fresh DBs get it from CREATE
   * TABLE; prod DBs opened after upgrade hit this PRAGMA-guarded ALTER.
   * Existing rows default to `bridge_offline` (they were all #88).
   */
  private migrateParkedKind(): void {
    const hasColumn = this.db
      .prepare<[], { name: string }>("PRAGMA table_info(parked_prompts)")
      .all()
      .some((c) => c.name === "kind");
    if (!hasColumn) {
      this.db.exec(
        "ALTER TABLE parked_prompts ADD COLUMN kind TEXT NOT NULL DEFAULT 'bridge_offline'"
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

  /** Total session rows — uncapped, unlike {@link list}. */
  countSessions(): number {
    const row = this.db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM sessions").get();
    return row?.n ?? 0;
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

  /** All channel siblings in durable creation order for #145 recompaction. */
  listSessionsByParentInCreationOrder(
    platform: string,
    parentRef: string
  ): SessionRecord[] {
    return this.db
      .prepare<[string, string], Row>(
        "SELECT * FROM sessions WHERE platform = ? AND parent_ref = ? " +
          "ORDER BY created_utc ASC, id ASC"
      )
      .all(platform, parentRef)
      .map(mapRow);
  }

  upsert(record: SessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO sessions
           (id, platform, channel_ref, parent_ref, agent_id, acp_session_id,
            repo_path, config_json, name_prefix, created_utc, updated_utc)
         VALUES
           (@id, @platform, @channelRef, @parentRef, @agentId, @acpSessionId,
            @repoPath, @configJson, @namePrefix, @createdUtc, @updatedUtc)
         ON CONFLICT(id) DO UPDATE SET
           platform        = excluded.platform,
           channel_ref     = excluded.channel_ref,
           parent_ref      = excluded.parent_ref,
           agent_id        = excluded.agent_id,
           acp_session_id  = excluded.acp_session_id,
           repo_path       = excluded.repo_path,
           config_json     = excluded.config_json,
           name_prefix     = excluded.name_prefix,
           updated_utc     = excluded.updated_utc`
      )
      .run({ ...record, namePrefix: record.namePrefix ?? null });
  }

  setNamePrefix(id: string, prefix: string | null): void {
    this.db
      .prepare("UPDATE sessions SET name_prefix = ?, updated_utc = ? WHERE id = ?")
      .run(prefix, new Date().toISOString(), id);
  }

  // --- scheduled prompts ----------------------------------------------------

  /**
   * #158: `attachments_json` is legacy. New rows insert `'[]'`; an UPDATE never
   * overwrites what is stored unless the caller explicitly passes
   * `legacyAttachmentCount: 0` on a row that had entries — the deliberate
   * "this schedule has been revised" act that lifts the quarantine. Anything
   * built by spreading an existing row therefore keeps its legacy manifest, so
   * a routine toggle/status patch can't silently erase the evidence.
   */
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
           attachments_json = CASE WHEN @clearLegacyAttachments = 1
                                THEN '[]'
                                ELSE scheduled_prompts.attachments_json END,
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
        // Inserts always start clean; the UPDATE arm only clears when asked.
        attachmentsJson: "[]",
        clearLegacyAttachments: (s.legacyAttachmentCount ?? 0) === 0 ? 1 : 0,
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
      acpSessionId: entry.acpSessionId ?? null,
      status: entry.status ?? "dispatched",
      createdUtc,
      updatedUtc: entry.updatedUtc ?? createdUtc,
    };
    this.db
      .prepare(
        `INSERT INTO delegation_log
           (id, source_ref, target_ref, worker, kind, prompt_preview,
            correlation_id, acp_session_id, status, created_utc, updated_utc)
         VALUES
           (@id, @sourceRef, @targetRef, @worker, @kind, @promptPreview,
            @correlationId, @acpSessionId, @status, @createdUtc, @updatedUtc)`
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

  /** One ledger row by primary key, or null if absent. */
  getDelegation(id: string): LedgerEntry | null {
    const row = this.db
      .prepare<[string], LedgerRow>(`SELECT * FROM delegation_log WHERE id = ?`)
      .get(id);
    return row ? mapLedger(row) : null;
  }

  /**
   * Mark every still-in-flight ledger row as `interrupted` and stamp
   * `updated_utc`. Called once at boot so a crash cannot leave phantom
   * `dispatched`/`running` work that `/seam workflows` and the watchdog
   * would treat as live. Terminal rows (completed / failed / timed_out)
   * and deliberately-parked rows are untouched. Target, correlation, and
   * `acp_session_id` are preserved so resume (#76) can act on them.
   *
   * Returns the number of rows flipped. Does not delete any ACP session.
   */
  reconcileOrphanedDelegations(nowUtc = new Date().toISOString()): number {
    const placeholders = DELEGATION_ACTIVE_STATUSES.map(() => "?").join(", ");
    const info = this.db
      .prepare(
        `UPDATE delegation_log
            SET status = 'interrupted', updated_utc = ?
          WHERE status IN (${placeholders})`
      )
      .run(nowUtc, ...DELEGATION_ACTIVE_STATUSES);
    return info.changes;
  }

  /**
   * Terminalize only `running` rows whose last heartbeat predates `cutoffUtc`.
   * This runs before the boot orphan pass (so fresh crash leftovers remain
   * resumable as `interrupted`) and periodically while the process is live.
   * Metadata and ACP session ids are retained for operator audit.
   */
  abandonStaleRunningDelegations(
    cutoffUtc: string,
    nowUtc = new Date().toISOString()
  ): number {
    const info = this.db
      .prepare(
        `UPDATE delegation_log
            SET status = 'abandoned', updated_utc = ?
          WHERE status = 'running' AND updated_utc < ?`
      )
      .run(nowUtc, cutoffUtc);
    return info.changes;
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
      acpSessionId: entry.acpSessionId ?? null,
      status: entry.status ?? "dispatched",
      createdUtc,
      updatedUtc: entry.updatedUtc ?? createdUtc,
    };
    try {
      const info = this.db
        .prepare(
          `INSERT INTO delegation_log
             (id, source_ref, target_ref, worker, kind, prompt_preview,
              correlation_id, acp_session_id, status, created_utc, updated_utc)
           SELECT
             @id, @sourceRef, @targetRef, @worker, @kind, @promptPreview,
             @correlationId, @acpSessionId, @status, @createdUtc, @updatedUtc
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

  /** Ledger rows in the given statuses, oldest first — resume inventory (#76). */
  listDelegationsByStatus(statuses: readonly DelegationStatus[]): LedgerEntry[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(", ");
    return this.db
      .prepare<string[], LedgerRow>(
        `SELECT * FROM delegation_log WHERE status IN (${placeholders})
         ORDER BY updated_utc ASC, rowid ASC`
      )
      .all(...statuses)
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

  /**
   * Atomically plan one completed chain hop and, when applicable, pop the next
   * worker. The synthetic report_back row is a durable outbox plan:
   * `targetRef` stores the deterministic child dispatch id and `worker` stores
   * the next worker (null means terminal delivery). Replays read this row
   * instead of inferring progress from the already-mutated chain.
   *
   * A pre-existing claim is only READ BACK when `isPlannedChainChildId` accepts
   * its `targetRef`. The #77 claim this replaced used the same
   * row id but stored the hop's TARGET THREAD in `targetRef` and the hop's OWN
   * preset in `worker` — so trusting an old row would replay it as "dispatch
   * worker `<this hop's preset>` under id `<a Discord thread id>`", re-running
   * a hop that has already been paid for. Refusing (null) leaves the ledger row
   * non-terminal and operator-visible instead, which is recoverable.
   */
  planChainHopCompletion(input: {
    dispatchId: string;
    chainId: string;
    failed: boolean;
    promptPreview?: string | null;
  }): { dispatchId: string; nextHop: string | null; originRef: string; created: boolean } | null {
    const run = this.db.transaction(() => {
      const existing = this.getReportBackByCorrelation(input.dispatchId);
      const chain = this.getChain(input.chainId);
      if (existing) {
        if (!chain || !isPlannedChainChildId(existing.targetRef)) return null;
        return {
          dispatchId: existing.targetRef,
          nextHop: existing.worker,
          originRef: chain.originRef,
          created: false,
        };
      }
      if (!chain || chain.status !== "running") return null;

      const nextHop = input.failed ? null : (chain.hops[0] ?? null);
      const dispatchId = plannedChainChildDispatchId({
        chainId: input.chainId,
        currentIndex: chain.currentIndex,
        kind: nextHop ? "hop" : "delivery",
      });
      const claim = this.tryRecordReportBack({
        id: `chain_advance:${input.dispatchId}`,
        kind: "report_back",
        sourceRef: input.chainId,
        targetRef: dispatchId,
        worker: nextHop,
        promptPreview: input.promptPreview ?? null,
        correlationId: input.dispatchId,
        status: "completed",
      });
      if (!claim) return null;
      if (nextHop) {
        const advanced = this.advanceChain(input.chainId);
        if (!advanced || advanced.nextHop !== nextHop) {
          throw new Error(`chain ${input.chainId} changed while planning ${input.dispatchId}`);
        }
      }
      return { dispatchId, nextHop, originRef: chain.originRef, created: true };
    });
    return run();
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

  /** All pending wakes bot-wide (the server-status card). */
  countPendingWakes(): number {
    const row = this.db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM wake_events").get();
    return row?.n ?? 0;
  }

  deleteWake(id: string): void {
    this.db.prepare("DELETE FROM wake_events WHERE id = ?").run(id);
  }

  // --- parked prompts (#88) -------------------------------------------------

  /** Insert or replace the single parked prompt for this thread (D1). */
  upsertParked(p: ParkedPrompt): void {
    this.db
      .prepare(
        `INSERT INTO parked_prompts
           (id, platform, channel_ref, parent_ref, location, kind, prompt,
            author_id, author_name, notice_message_id, attachments_json, created_utc)
         VALUES
           (@id, @platform, @channelRef, @parentRef, @location, @kind, @prompt,
            @authorId, @authorName, @noticeMessageId, @attachmentsJson, @createdUtc)
         ON CONFLICT(platform, channel_ref) DO UPDATE SET
           id                 = excluded.id,
           parent_ref         = excluded.parent_ref,
           location           = excluded.location,
           kind               = excluded.kind,
           prompt             = excluded.prompt,
           author_id          = excluded.author_id,
           author_name        = excluded.author_name,
           notice_message_id  = excluded.notice_message_id,
           attachments_json   = excluded.attachments_json,
           created_utc        = excluded.created_utc`
      )
      .run({
        id: p.id,
        platform: p.platform,
        channelRef: p.channelRef,
        parentRef: p.parentRef,
        location: p.location,
        kind: p.kind === "user_queue" ? "user_queue" : "bridge_offline",
        prompt: p.prompt,
        authorId: p.authorId,
        authorName: p.authorName,
        noticeMessageId: p.noticeMessageId,
        attachmentsJson: JSON.stringify(p.attachments),
        createdUtc: p.createdUtc,
      });
  }

  getParked(id: string): ParkedPrompt | null {
    const row = this.db
      .prepare<[string], ParkedRow>("SELECT * FROM parked_prompts WHERE id = ?")
      .get(id);
    return row ? mapParked(row) : null;
  }

  getParkedByChannel(platform: string, channelRef: string): ParkedPrompt | null {
    const row = this.db
      .prepare<[string, string], ParkedRow>(
        "SELECT * FROM parked_prompts WHERE platform = ? AND channel_ref = ?"
      )
      .get(platform, channelRef);
    return row ? mapParked(row) : null;
  }

  listParked(): ParkedPrompt[] {
    return this.db
      .prepare<[], ParkedRow>("SELECT * FROM parked_prompts ORDER BY created_utc ASC, rowid ASC")
      .all()
      .map(mapParked);
  }

  listParkedByLocation(location: string): ParkedPrompt[] {
    return this.db
      .prepare<[string], ParkedRow>(
        "SELECT * FROM parked_prompts WHERE location = ? ORDER BY created_utc ASC, rowid ASC"
      )
      .all(location)
      .map(mapParked);
  }

  countParkedByLocation(location: string): number {
    const row = this.db
      .prepare<[string], { n: number }>(
        "SELECT COUNT(*) AS n FROM parked_prompts WHERE location = ?"
      )
      .get(location);
    return row?.n ?? 0;
  }

  deleteParked(id: string): void {
    this.db.prepare("DELETE FROM parked_prompts WHERE id = ?").run(id);
  }

  deleteParkedByChannel(platform: string, channelRef: string): ParkedPrompt | null {
    const existing = this.getParkedByChannel(platform, channelRef);
    if (!existing) return null;
    this.deleteParked(existing.id);
    return existing;
  }

  deleteAllParked(): ParkedPrompt[] {
    const rows = this.listParked();
    this.db.prepare("DELETE FROM parked_prompts").run();
    return rows;
  }

  // --- frozen choice cards (#91) --------------------------------------------

  insertChoiceCard(c: ChoiceCard): void {
    this.db
      .prepare(
        `INSERT INTO choice_cards
           (id, platform, channel_ref, parent_ref, message_id, title, body,
            max_clicks, target_user_id, default_target_json, options_json,
            click_count, status, last_clicker_id, last_clicker_name,
            created_by, created_utc,
            ingest_token_hash, ingest_option_index, result_schema_json,
            ingest_wrapper, ingest_cors_json,
            select_min, select_max, last_option_indices_json)
         VALUES
           (@id, @platform, @channelRef, @parentRef, @messageId, @title, @body,
            @maxClicks, @targetUserId, @defaultTargetJson, @optionsJson,
            @clickCount, @status, @lastClickerId, @lastClickerName,
            @createdBy, @createdUtc,
            @ingestTokenHash, @ingestOptionIndex, @resultSchemaJson,
            @ingestWrapper, @ingestCorsJson,
            @selectMin, @selectMax, @lastOptionIndicesJson)`
      )
      .run({
        id: c.id,
        platform: c.platform,
        channelRef: c.channelRef,
        parentRef: c.parentRef,
        messageId: c.messageId,
        title: c.title,
        body: c.body,
        maxClicks: c.maxClicks,
        targetUserId: c.targetUserId,
        defaultTargetJson: JSON.stringify(c.defaultTarget),
        optionsJson: JSON.stringify(c.options),
        clickCount: c.clickCount,
        status: c.status,
        lastClickerId: c.lastClickerId,
        lastClickerName: c.lastClickerName,
        createdBy: c.createdBy,
        createdUtc: c.createdUtc,
        ingestTokenHash: c.ingestTokenHash,
        ingestOptionIndex: c.ingestOptionIndex,
        resultSchemaJson: c.resultSchema == null ? null : JSON.stringify(c.resultSchema),
        ingestWrapper: c.ingestWrapper,
        ingestCorsJson: c.ingestCors == null ? null : JSON.stringify(c.ingestCors),
        selectMin: c.select?.min ?? null,
        selectMax: c.select?.max ?? null,
        lastOptionIndicesJson:
          c.lastOptionIndices == null ? null : JSON.stringify(c.lastOptionIndices),
      });
  }

  getChoiceCard(id: string): ChoiceCard | null {
    const row = this.db
      .prepare<[string], ChoiceRow>("SELECT * FROM choice_cards WHERE id = ?")
      .get(id);
    return row ? mapChoice(row) : null;
  }

  setChoiceMessageId(id: string, messageId: string): void {
    this.db.prepare("UPDATE choice_cards SET message_id = ? WHERE id = ?").run(messageId, id);
  }

  listOpenChoiceCards(platform: string, channelRef: string): ChoiceCard[] {
    return this.db
      .prepare<[string, string], ChoiceRow>(
        "SELECT * FROM choice_cards WHERE platform = ? AND channel_ref = ? AND status = 'open' ORDER BY created_utc ASC"
      )
      .all(platform, channelRef)
      .map(mapChoice);
  }

  /**
   * Atomic first claim (D10): insert (choice_id, user_id) and increment
   * click_count, or abort. Unique PK makes double-click a loser.
   */
  claimChoiceClick(opts: {
    choiceId: string;
    userId: string;
    userName: string;
    optionIndex: number;
    /** Full multi-select pick list (#94). Single-select omits this. */
    optionIndices?: number[];
  }):
    | { ok: true; card: ChoiceCard }
    | { ok: false; reason: "missing" | "not-open" | "exhausted" | "already-clicked" } {
    const run = this.db.transaction(() => {
      const row = this.db
        .prepare<[string], ChoiceRow>("SELECT * FROM choice_cards WHERE id = ?")
        .get(opts.choiceId);
      if (!row) return { ok: false as const, reason: "missing" as const };
      if (row.status !== "open") return { ok: false as const, reason: "not-open" as const };
      if (row.click_count >= row.max_clicks) {
        return { ok: false as const, reason: "exhausted" as const };
      }
      try {
        this.db
          .prepare(
            `INSERT INTO choice_clicks (choice_id, user_id, option_index, created_utc)
             VALUES (?, ?, ?, ?)`
          )
          .run(opts.choiceId, opts.userId, opts.optionIndex, new Date().toISOString());
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "SQLITE_CONSTRAINT_PRIMARYKEY" || code === "SQLITE_CONSTRAINT_UNIQUE") {
          return { ok: false as const, reason: "already-clicked" as const };
        }
        throw err;
      }
      const nextCount = row.click_count + 1;
      const status: ChoiceCardStatus = nextCount >= row.max_clicks ? "exhausted" : "open";
      this.db
        .prepare(
          `UPDATE choice_cards
             SET click_count = ?, status = ?, last_clicker_id = ?, last_clicker_name = ?,
                 last_option_index = ?, last_option_indices_json = ?
           WHERE id = ?`
        )
        .run(
          nextCount,
          status,
          opts.userId,
          opts.userName,
          opts.optionIndex,
          opts.optionIndices == null ? null : JSON.stringify(opts.optionIndices),
          opts.choiceId
        );
      const updated = this.db
        .prepare<[string], ChoiceRow>("SELECT * FROM choice_cards WHERE id = ?")
        .get(opts.choiceId)!;
      return { ok: true as const, card: mapChoice(updated) };
    });
    return run();
  }

  setChoiceClickDelivery(choiceId: string, userId: string, deliveryId: string): void {
    this.db
      .prepare("UPDATE choice_clicks SET delivery_id = ? WHERE choice_id = ? AND user_id = ?")
      .run(deliveryId, choiceId, userId);
  }

  cancelChoiceCard(id: string, channelRef: string): boolean {
    const info = this.db
      .prepare("UPDATE choice_cards SET status = 'cancelled' WHERE id = ? AND channel_ref = ? AND status = 'open'")
      .run(id, channelRef);
    return info.changes > 0;
  }

  getChoiceCardByIngestHash(tokenHash: string): ChoiceCard | null {
    const row = this.db
      .prepare<[string], ChoiceRow>("SELECT * FROM choice_cards WHERE ingest_token_hash = ?")
      .get(tokenHash);
    return row ? mapChoice(row) : null;
  }

  // --- headless ingest endpoints (#95) --------------------------------------

  insertIngestEndpoint(e: IngestEndpoint): void {
    this.db
      .prepare(
        `INSERT INTO ingest_endpoints
           (id, token_hash, name, cwd, agent_id, model, effort, wrapper,
            result_schema_json, cors_json, unique_student, notify_thread, preset,
            status, created_by, created_utc, authoring_channel_ref,
            authoring_parent_ref, platform)
         VALUES
           (@id, @tokenHash, @name, @cwd, @agentId, @model, @effort, @wrapper,
            @resultSchemaJson, @corsJson, @uniqueStudent, @notifyThread, @preset,
            @status, @createdBy, @createdUtc, @authoringChannelRef,
            @authoringParentRef, @platform)`
      )
      .run({
        id: e.id,
        tokenHash: e.tokenHash,
        name: e.name,
        cwd: e.cwd,
        agentId: e.agentId,
        model: e.model,
        effort: e.effort,
        wrapper: e.wrapper,
        resultSchemaJson: e.resultSchema == null ? null : JSON.stringify(e.resultSchema),
        corsJson: e.corsOrigins == null ? null : JSON.stringify(e.corsOrigins),
        uniqueStudent: e.uniqueStudent ? 1 : 0,
        notifyThread: e.notifyThread,
        preset: e.preset,
        status: e.status,
        createdBy: e.createdBy,
        createdUtc: e.createdUtc,
        authoringChannelRef: e.authoringChannelRef,
        authoringParentRef: e.authoringParentRef,
        platform: e.platform,
      });
  }

  getIngestEndpoint(id: string): IngestEndpoint | null {
    const row = this.db
      .prepare<[string], IngestEndpointRow>("SELECT * FROM ingest_endpoints WHERE id = ?")
      .get(id);
    return row ? mapIngestEndpoint(row) : null;
  }

  getIngestEndpointByTokenHash(tokenHash: string): IngestEndpoint | null {
    const row = this.db
      .prepare<[string], IngestEndpointRow>("SELECT * FROM ingest_endpoints WHERE token_hash = ?")
      .get(tokenHash);
    return row ? mapIngestEndpoint(row) : null;
  }

  listOpenIngestEndpoints(platform: string, channelRef: string): IngestEndpoint[] {
    return this.db
      .prepare<[string, string], IngestEndpointRow>(
        `SELECT * FROM ingest_endpoints
          WHERE platform = ? AND authoring_channel_ref = ? AND status = 'open'
          ORDER BY created_utc ASC`
      )
      .all(platform, channelRef)
      .map(mapIngestEndpoint);
  }

  revokeIngestEndpoint(id: string, channelRef: string): boolean {
    const info = this.db
      .prepare(
        "UPDATE ingest_endpoints SET status = 'revoked' WHERE id = ? AND authoring_channel_ref = ? AND status = 'open'"
      )
      .run(id, channelRef);
    return info.changes > 0;
  }

  /**
   * One-shot exam path. Empty studentId is not claimed (anonymous retries stay
   * allowed). Duplicate (ingest_id, student_id) → already-claimed.
   */
  insertLiveHelp(s: LiveHelpSession): void {
    this.db
      .prepare(
        `INSERT INTO live_help_sessions
           (id, voice_channel_id, guild_id, channel_name, system, history_summary,
            notify_thread, preset, authoring_channel_ref, authoring_parent_ref,
            platform, status, created_by, created_utc, ended_utc, end_reason)
         VALUES
           (@id, @voiceChannelId, @guildId, @channelName, @system, @historySummary,
            @notifyThread, @preset, @authoringChannelRef, @authoringParentRef,
            @platform, @status, @createdBy, @createdUtc, @endedUtc, @endReason)`
      )
      .run({
        id: s.id,
        voiceChannelId: s.voiceChannelId,
        guildId: s.guildId,
        channelName: s.channelName,
        system: s.system,
        historySummary: s.historySummary,
        notifyThread: s.notifyThread,
        preset: s.preset,
        authoringChannelRef: s.authoringChannelRef,
        authoringParentRef: s.authoringParentRef,
        platform: s.platform,
        status: s.status,
        createdBy: s.createdBy,
        createdUtc: s.createdUtc,
        endedUtc: s.endedUtc,
        endReason: s.endReason,
      });
  }

  getLiveHelp(id: string): LiveHelpSession | null {
    const row = this.db
      .prepare<[string], LiveHelpRow>("SELECT * FROM live_help_sessions WHERE id = ?")
      .get(id);
    return row ? mapLiveHelp(row) : null;
  }

  getActiveLiveHelpForVoiceChannel(voiceChannelId: string): LiveHelpSession | null {
    const row = this.db
      .prepare<[string], LiveHelpRow>(
        `SELECT * FROM live_help_sessions
          WHERE voice_channel_id = ? AND status IN ('starting','live')
          ORDER BY created_utc DESC LIMIT 1`
      )
      .get(voiceChannelId);
    return row ? mapLiveHelp(row) : null;
  }

  getActiveLiveHelpForGuild(guildId: string): LiveHelpSession | null {
    const row = this.db
      .prepare<[string], LiveHelpRow>(
        `SELECT * FROM live_help_sessions
          WHERE guild_id = ? AND status IN ('starting','live')
          ORDER BY created_utc DESC LIMIT 1`
      )
      .get(guildId);
    return row ? mapLiveHelp(row) : null;
  }

  listLiveHelpForThread(platform: string, channelRef: string): LiveHelpSession[] {
    return this.db
      .prepare<[string, string], LiveHelpRow>(
        `SELECT * FROM live_help_sessions
          WHERE platform = ? AND authoring_channel_ref = ?
          ORDER BY created_utc DESC LIMIT 50`
      )
      .all(platform, channelRef)
      .map(mapLiveHelp);
  }

  listActiveLiveHelp(): LiveHelpSession[] {
    return this.db
      .prepare<[], LiveHelpRow>(
        `SELECT * FROM live_help_sessions
          WHERE status IN ('starting','live')
          ORDER BY created_utc ASC`
      )
      .all()
      .map(mapLiveHelp);
  }

  updateLiveHelp(
    id: string,
    patch: {
      status?: LiveHelpStatus;
      endedUtc?: string | null;
      endReason?: string | null;
      guildId?: string | null;
      channelName?: string | null;
    }
  ): void {
    const cur = this.getLiveHelp(id);
    if (!cur) return;
    const next: LiveHelpSession = {
      ...cur,
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.endedUtc !== undefined ? { endedUtc: patch.endedUtc } : {}),
      ...(patch.endReason !== undefined ? { endReason: patch.endReason } : {}),
      ...(patch.guildId !== undefined ? { guildId: patch.guildId } : {}),
      ...(patch.channelName !== undefined ? { channelName: patch.channelName } : {}),
    };
    this.db
      .prepare(
        `UPDATE live_help_sessions SET
           status = @status, ended_utc = @endedUtc, end_reason = @endReason,
           guild_id = @guildId, channel_name = @channelName
         WHERE id = @id`
      )
      .run({
        id,
        status: next.status,
        endedUtc: next.endedUtc,
        endReason: next.endReason,
        guildId: next.guildId,
        channelName: next.channelName,
      });
  }

  markInFlightLiveHelpEnded(reason: string): number {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `UPDATE live_help_sessions
            SET status = 'ended', ended_utc = ?, end_reason = ?
          WHERE status IN ('starting','live')`
      )
      .run(now, reason);
    return info.changes;
  }

  // --- Voice Console V2 --------------------------------------------------

  createVoiceConsole(input: CreateVoiceConsoleInput): VoiceConsoleMutationResult {
    const create = this.db.transaction((): VoiceConsoleMutationResult => {
      const { console, binding } = input;
      if (binding.consoleId !== console.id) {
        throw new Error("Voice Console binding does not belong to the console.");
      }
      if (console.cardChannelId !== console.voiceChannelId) {
        throw new Error("Voice Console card channel must equal its voice channel.");
      }
      if (binding.guildId !== console.guildId || binding.voiceChannelId !== console.voiceChannelId) {
        throw new Error("Voice Console binding guild/voice channel does not match its console.");
      }
      const normalized = normalizeBinding(binding);
      this.insertVoiceConsoleRow(console);
      this.insertVoiceConsoleBindingRow(normalized);
      if (input.selectBinding !== false) {
        this.db
          .prepare(
            `INSERT INTO voice_console_input_targets
               (console_id, binding_id, ordinal, selected_utc)
             VALUES (?, ?, 0, ?)`
          )
          .run(console.id, binding.id, console.createdUtc);
      }
      return this.requireVoiceConsoleMutationResult(console.id, true, false);
    });
    return create();
  }

  getVoiceConsole(id: string): VoiceConsoleSession | null {
    const row = this.db
      .prepare<[string], VoiceConsoleRow>("SELECT * FROM voice_console_sessions WHERE id = ?")
      .get(id);
    return row ? mapVoiceConsole(row) : null;
  }

  getActiveVoiceConsoleForGuild(guildId: string): VoiceConsoleSession | null {
    const row = this.db
      .prepare<[string], VoiceConsoleRow>(
        `SELECT * FROM voice_console_sessions
          WHERE guild_id = ? AND status IN ('starting','ready','stopping')
          ORDER BY created_utc DESC LIMIT 1`
      )
      .get(guildId);
    return row ? mapVoiceConsole(row) : null;
  }

  getActiveVoiceConsoleForOwner(guildId: string, ownerUserId: string): VoiceConsoleSession | null {
    const row = this.db
      .prepare<[string, string], VoiceConsoleRow>(
        `SELECT * FROM voice_console_sessions
          WHERE guild_id = ? AND owner_user_id = ?
            AND status IN ('starting','ready','stopping')
          ORDER BY created_utc DESC LIMIT 1`
      )
      .get(guildId, ownerUserId);
    return row ? mapVoiceConsole(row) : null;
  }

  getActiveVoiceConsoleForVoiceChannel(voiceChannelId: string): VoiceConsoleSession | null {
    const row = this.db
      .prepare<[string], VoiceConsoleRow>(
        `SELECT * FROM voice_console_sessions
          WHERE voice_channel_id = ? AND status IN ('starting','ready','stopping')
          ORDER BY created_utc DESC LIMIT 1`
      )
      .get(voiceChannelId);
    return row ? mapVoiceConsole(row) : null;
  }

  listActiveVoiceConsoles(): VoiceConsoleSession[] {
    return this.db
      .prepare<[], VoiceConsoleRow>(
        `SELECT * FROM voice_console_sessions
          WHERE status IN ('starting','ready','stopping') ORDER BY created_utc ASC`
      )
      .all()
      .map(mapVoiceConsole);
  }

  listTerminalVoiceConsoleCardsForVoiceChannel(voiceChannelId: string): VoiceConsoleSession[] {
    return this.db
      .prepare<[string], VoiceConsoleRow>(
        `SELECT * FROM voice_console_sessions
          WHERE voice_channel_id = ? AND status IN ('ended','failed')
            AND card_message_id IS NOT NULL
          ORDER BY created_utc ASC`
      )
      .all(voiceChannelId)
      .map(mapVoiceConsole);
  }

  getVoiceConsoleBinding(id: string): ThreadVoiceBinding | null {
    const row = this.db
      .prepare<[string], VoiceConsoleBindingRow>(
        "SELECT * FROM thread_voice_sessions WHERE id = ? AND console_id IS NOT NULL"
      )
      .get(id);
    return row ? mapVoiceConsoleBinding(row) : null;
  }

  getActiveVoiceConsoleBindingForThread(
    platform: string,
    channelRef: string
  ): ThreadVoiceBinding | null {
    const row = this.db
      .prepare<[string, string], VoiceConsoleBindingRow>(
        `SELECT * FROM thread_voice_sessions
          WHERE platform = ? AND channel_ref = ? AND console_id IS NOT NULL
            AND status = 'active'
          ORDER BY created_utc DESC LIMIT 1`
      )
      .get(platform, channelRef);
    return row ? mapVoiceConsoleBinding(row) : null;
  }

  /** Constraint/lifecycle lookup; callers needing capture/control use the strict active API above. */
  getNonTerminalVoiceConsoleBindingForThread(
    platform: string,
    channelRef: string
  ): ThreadVoiceBinding | null {
    const row = this.db
      .prepare<[string, string], VoiceConsoleBindingRow>(
        `SELECT * FROM thread_voice_sessions
          WHERE platform = ? AND channel_ref = ? AND console_id IS NOT NULL
            AND status IN ('adding','active','removing')
          ORDER BY created_utc DESC LIMIT 1`
      )
      .get(platform, channelRef);
    return row ? mapVoiceConsoleBinding(row) : null;
  }

  listVoiceConsoleBindings(
    consoleId: string,
    opts: { includeTerminal?: boolean } = {}
  ): ThreadVoiceBinding[] {
    const sql = opts.includeTerminal
      ? `SELECT * FROM thread_voice_sessions WHERE console_id = ? ORDER BY created_utc ASC, id ASC`
      : `SELECT * FROM thread_voice_sessions WHERE console_id = ?
           AND status IN ('adding','active','removing') ORDER BY created_utc ASC, id ASC`;
    return this.db
      .prepare<[string], VoiceConsoleBindingRow>(sql)
      .all(consoleId)
      .map(mapVoiceConsoleBinding);
  }

  listVoiceConsoleInputTargets(consoleId: string): VoiceConsoleInputTarget[] {
    return this.db
      .prepare<[string], VoiceConsoleInputTargetRow>(
        `SELECT * FROM voice_console_input_targets
          WHERE console_id = ? ORDER BY ordinal ASC`
      )
      .all(consoleId)
      .map(mapVoiceConsoleInputTarget);
  }

  getVoiceConsoleAddInteraction(
    consoleId: string,
    interactionId: string
  ): VoiceConsoleAddInteraction | null {
    const row = this.db
      .prepare<[string, string], VoiceConsoleAddInteractionRow>(
        `SELECT * FROM voice_console_add_interactions
          WHERE console_id = ? AND interaction_id = ?`
      )
      .get(consoleId, interactionId);
    return row ? mapVoiceConsoleAddInteraction(row) : null;
  }

  addVoiceConsoleBinding(input: AddVoiceConsoleBindingInput): VoiceConsoleMutationOutcome {
    const fingerprint = voiceConsoleAddFingerprint(input);
    const add = this.db.transaction((): VoiceConsoleMutationOutcome => {
      const consoleId = input.binding.consoleId;
      const createdUtc = input.binding.updatedUtc;
      if (input.interactionId) {
        const existing = this.getVoiceConsoleAddInteraction(consoleId, input.interactionId);
        if (existing) return this.replayVoiceConsoleAddInteraction(existing, fingerprint);
        const generic = this.getVoiceConsoleMutationRecord(consoleId, input.interactionId);
        if (generic) {
          if (generic.action === "legacy") {
            return {
              ok: true,
              value: this.requireVoiceConsoleMutationResult(consoleId, false, true),
            };
          }
          return interactionCollisionFailure();
        }
        this.db
          .prepare(
            `INSERT INTO voice_console_add_interactions
               (console_id, interaction_id, binding_id, input_fingerprint, status,
                failure_code, failure_message, failure_as_exception, created_utc, updated_utc)
             VALUES (?, ?, ?, ?, 'pending', NULL, NULL, 0, ?, ?)`
          )
          .run(
            consoleId,
            input.interactionId,
            input.binding.id,
            fingerprint,
            createdUtc,
            createdUtc
          );
      }

      const fail = (outcome: Extract<VoiceConsoleMutationOutcome, { ok: false }>) => {
        this.finalizeVoiceConsoleAddInteractionFailure(
          consoleId,
          input.interactionId,
          outcome.reason,
          outcome.error,
          false,
          createdUtc
        );
        return outcome;
      };
      const console = this.getVoiceConsole(consoleId);
      if (!console) return fail(mutationFailure("not-found", "Voice Console does not exist."));
      if (!isActiveConsole(console)) {
        return fail(mutationFailure("inactive", "Voice Console is not active."));
      }
      if (console.revision !== input.expectedRevision) return fail(staleConsoleFailure());
      if (this.listVoiceConsoleBindings(console.id).length >= 10) {
        return fail(mutationFailure("binding-limit", "Voice Console already has ten active bindings."));
      }
      if (
        input.claim !== false &&
        console.fanoutArmed &&
        this.listVoiceConsoleInputTargets(console.id).length >= 5
      ) {
        return fail(mutationFailure("invalid-targets", "Voice Console fan-out target limit is five."));
      }
      let binding: ThreadVoiceBinding;
      try {
        binding = normalizeBinding({ ...input.binding, status: "adding" });
      } catch (err) {
        return fail(
          mutationFailure("invalid-targets", sanitizeVoiceConsoleFailureMessage(errorText(err)))
        );
      }
      if (binding.guildId !== console.guildId || binding.voiceChannelId !== console.voiceChannelId) {
        return fail(
          mutationFailure("inactive", "Binding guild/voice channel does not match its console.")
        );
      }
      if (this.getNonTerminalVoiceConsoleBindingForThread(binding.platform, binding.channelRef)) {
        return fail(mutationFailure("duplicate-thread", "That thread already has an active binding."));
      }
      const alias = this.db
        .prepare<[string, string], { id: string }>(
          `SELECT id FROM thread_voice_sessions WHERE console_id = ? AND alias_normalized = ?
            AND status IN ('adding','active','removing') LIMIT 1`
        )
        .get(console.id, binding.aliasNormalized);
      if (alias) return fail(mutationFailure("duplicate-alias", "That alias is already in use."));
      try {
        this.insertVoiceConsoleBindingRow(binding);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code?.startsWith("SQLITE_CONSTRAINT")) {
          return fail(
            mutationFailure("duplicate-thread", "Binding conflicts with active console state.")
          );
        }
        throw err;
      }
      this.bumpVoiceConsoleRevision(console.id, binding.updatedUtc);
      return { ok: true, value: this.requireVoiceConsoleMutationResult(console.id, true, false) };
    });
    try {
      return add();
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code?.startsWith("SQLITE_CONSTRAINT")) {
        return mutationFailure("duplicate-thread", "Binding conflicts with active console state.");
      }
      throw err;
    }
  }

  /** Host attachment succeeds before an adding binding becomes selectable. */
  activateVoiceConsoleBinding(
    bindingId: string,
    input: {
      expectedRevision: number;
      claim?: boolean;
      interactionId?: string;
      updatedUtc?: string;
    }
  ): VoiceConsoleMutationOutcome {
    const activate = this.db.transaction((): VoiceConsoleMutationOutcome => {
      const binding = this.getVoiceConsoleBinding(bindingId);
      if (!binding) return mutationFailure("not-found", "Voice Console binding does not exist.");
      const console = this.getVoiceConsole(binding.consoleId);
      if (!console || !isActiveConsole(console)) {
        return mutationFailure("inactive", "Voice Console is not active.");
      }
      if (console.revision !== input.expectedRevision) return staleConsoleFailure();
      if (binding.status === "active") {
        return {
          ok: true,
          value: this.requireVoiceConsoleMutationResult(binding.consoleId, false, true),
        };
      }
      if (binding.status !== "adding") {
        return mutationFailure("inactive", "Voice Console binding is not awaiting activation.");
      }
      const now = input.updatedUtc ?? new Date().toISOString();
      this.db
        .prepare(
          `UPDATE thread_voice_sessions SET status = 'active', updated_utc = ?
            WHERE id = ? AND status = 'adding'`
        )
        .run(now, bindingId);
      if (input.claim !== false) {
        const current = this.listVoiceConsoleInputTargets(console.id).map((target) => target.bindingId);
        const next = console.fanoutArmed ? [...current, bindingId] : [bindingId];
        if (next.length > 5) throw new Error("Voice Console fan-out target limit is five.");
        this.replaceVoiceConsoleTargetsRows(console.id, next, now);
      }
      this.bumpVoiceConsoleRevision(console.id, now);
      if (input.interactionId) {
        const finalized = this.db
          .prepare(
            `UPDATE voice_console_add_interactions
                SET status = 'succeeded', failure_code = NULL, failure_message = NULL,
                    failure_as_exception = 0, updated_utc = ?
              WHERE console_id = ? AND interaction_id = ? AND binding_id = ? AND status = 'pending'`
          )
          .run(now, console.id, input.interactionId, bindingId);
        if (finalized.changes !== 1) {
          throw new Error("Voice Console add interaction is not durably pending.");
        }
      }
      return {
        ok: true,
        value: this.requireVoiceConsoleMutationResult(console.id, true, false),
      };
    });
    return activate();
  }

  /**
   * Cleanup authority for a binding whose host attachment/activation failed.
   * This intentionally has no caller revision precondition: the staged row
   * must become terminal even when activation lost a revision race.
   */
  failStagedVoiceConsoleBinding(
    bindingId: string,
    reason: string,
    failedUtc = new Date().toISOString(),
    interaction?: {
      interactionId: string;
      failureCode: VoiceConsoleMutationFailure;
      failureAsException: boolean;
    }
  ): ThreadVoiceBinding | null {
    const fail = this.db.transaction((): ThreadVoiceBinding | null => {
      const binding = this.getVoiceConsoleBinding(bindingId);
      if (binding?.status === "adding") {
        this.db.prepare("DELETE FROM voice_console_input_targets WHERE binding_id = ?").run(bindingId);
        const changed = this.db
          .prepare(
            `UPDATE thread_voice_sessions SET status = 'failed', updated_utc = ?, ended_utc = ?,
               end_reason = ? WHERE id = ? AND console_id IS NOT NULL AND status = 'adding'`
          )
          .run(failedUtc, failedUtc, reason, bindingId);
        if (changed.changes > 0) this.bumpVoiceConsoleRevision(binding.consoleId, failedUtc);
      }
      if (binding && interaction) {
        this.finalizeVoiceConsoleAddInteractionFailure(
          binding.consoleId,
          interaction.interactionId,
          interaction.failureCode,
          reason,
          interaction.failureAsException,
          failedUtc
        );
      }
      return this.getVoiceConsoleBinding(bindingId);
    });
    return fail();
  }

  finalizeVoiceConsoleAddInteractionFailure(
    consoleId: string,
    interactionId: string | undefined,
    failureCode: VoiceConsoleMutationFailure,
    failureMessage: string,
    failureAsException: boolean,
    failedUtc = new Date().toISOString()
  ): VoiceConsoleAddInteraction | null {
    if (!interactionId) return null;
    const message = sanitizeVoiceConsoleFailureMessage(failureMessage);
    this.db
      .prepare(
        `UPDATE voice_console_add_interactions
            SET status = 'failed', failure_code = ?, failure_message = ?,
                failure_as_exception = ?, updated_utc = ?
          WHERE console_id = ? AND interaction_id = ? AND status = 'pending'`
      )
      .run(failureCode, message, failureAsException ? 1 : 0, failedUtc, consoleId, interactionId);
    return this.getVoiceConsoleAddInteraction(consoleId, interactionId);
  }

  recoverPendingVoiceConsoleAddInteractions(
    recoveredUtc = new Date().toISOString()
  ): number {
    const recover = this.db.transaction(() => {
      const pending = this.db
        .prepare<[], VoiceConsoleAddInteractionRow>(
          "SELECT * FROM voice_console_add_interactions WHERE status = 'pending'"
        )
        .all();
      const message = "Voice Console binding add was interrupted before completion.";
      for (const row of pending) {
        this.db.prepare("DELETE FROM voice_console_input_targets WHERE binding_id = ?").run(row.binding_id);
        const changed = this.db
          .prepare(
            `UPDATE thread_voice_sessions SET status = 'failed', updated_utc = ?, ended_utc = ?,
               end_reason = ? WHERE id = ? AND console_id IS NOT NULL AND status IN ('adding','active')`
          )
          .run(recoveredUtc, recoveredUtc, message, row.binding_id);
        if (changed.changes > 0) this.bumpVoiceConsoleRevision(row.console_id, recoveredUtc);
        this.finalizeVoiceConsoleAddInteractionFailure(
          row.console_id,
          row.interaction_id,
          "recovered-pending",
          message,
          false,
          recoveredUtc
        );
      }
      return pending.length;
    });
    return recover();
  }

  replaceVoiceConsoleInputTargets(
    consoleId: string,
    input: {
      bindingIds: readonly string[];
      fanoutArmed: boolean;
      expectedRevision: number;
      interactionId?: string;
      updatedUtc?: string;
    }
  ): VoiceConsoleMutationOutcome {
    const mutate = this.db.transaction((): VoiceConsoleMutationOutcome => {
      const fingerprint = voiceConsoleMutationFingerprint({
        action: "replace-input-targets",
        bindingIds: [...input.bindingIds],
        fanoutArmed: input.fanoutArmed,
        expectedRevision: input.expectedRevision,
      });
      if (this.getVoiceConsoleMutation(consoleId, input.interactionId, "replace-input-targets", fingerprint)) {
        return { ok: true, value: this.requireVoiceConsoleMutationResult(consoleId, false, true) };
      }
      const console = this.getVoiceConsole(consoleId);
      if (!console) return mutationFailure("not-found", "Voice Console does not exist.");
      if (!isActiveConsole(console)) return mutationFailure("inactive", "Voice Console is not active.");
      if (console.revision !== input.expectedRevision) return staleConsoleFailure();
      const ids = [...new Set(input.bindingIds)];
      if (ids.length !== input.bindingIds.length || ids.length > 5 || (!input.fanoutArmed && ids.length > 1)) {
        return mutationFailure("invalid-targets", "Invalid Voice Console input target selection.");
      }
      if (!this.areActiveBindingsOwnedByConsole(consoleId, ids)) {
        return mutationFailure("invalid-targets", "Every input target must be an active binding in this console.");
      }
      const now = input.updatedUtc ?? new Date().toISOString();
      this.replaceVoiceConsoleTargetsRows(consoleId, ids, now);
      this.db
        .prepare(
          `UPDATE voice_console_sessions
              SET fanout_armed = ?, revision = revision + 1, updated_utc = ? WHERE id = ?`
        )
        .run(input.fanoutArmed ? 1 : 0, now, consoleId);
      this.recordVoiceConsoleMutation(consoleId, input.interactionId, now, "replace-input-targets", fingerprint);
      return { ok: true, value: this.requireVoiceConsoleMutationResult(consoleId, true, false) };
    });
    return mutate();
  }

  setVoiceConsoleOutputBindings(
    consoleId: string,
    input: {
      enabledBindingIds: readonly string[];
      expectedRevision: number;
      interactionId?: string;
      updatedUtc?: string;
    }
  ): VoiceConsoleMutationOutcome {
    const mutate = this.db.transaction((): VoiceConsoleMutationOutcome => {
      const fingerprint = voiceConsoleMutationFingerprint({
        action: "set-output-bindings",
        enabledBindingIds: [...input.enabledBindingIds].sort(),
        expectedRevision: input.expectedRevision,
      });
      if (this.getVoiceConsoleMutation(consoleId, input.interactionId, "set-output-bindings", fingerprint)) {
        return { ok: true, value: this.requireVoiceConsoleMutationResult(consoleId, false, true) };
      }
      const console = this.getVoiceConsole(consoleId);
      if (!console) return mutationFailure("not-found", "Voice Console does not exist.");
      if (!isActiveConsole(console)) return mutationFailure("inactive", "Voice Console is not active.");
      if (console.revision !== input.expectedRevision) return staleConsoleFailure();
      const enabled = [...new Set(input.enabledBindingIds)];
      if (enabled.length !== input.enabledBindingIds.length || !this.areActiveBindingsOwnedByConsole(consoleId, enabled)) {
        return mutationFailure("invalid-targets", "Every output target must be an active binding in this console.");
      }
      const now = input.updatedUtc ?? new Date().toISOString();
      const enabledSet = new Set(enabled);
      for (const binding of this.listVoiceConsoleBindings(consoleId)) {
        const next = enabledSet.has(binding.id);
        if (next === binding.outputEnabled) continue;
        this.db
          .prepare(
            `UPDATE thread_voice_sessions SET output_enabled = ?,
               output_generation = output_generation + 1, updated_utc = ? WHERE id = ?`
          )
          .run(next ? 1 : 0, now, binding.id);
      }
      this.bumpVoiceConsoleRevision(consoleId, now);
      this.recordVoiceConsoleMutation(consoleId, input.interactionId, now, "set-output-bindings", fingerprint);
      return { ok: true, value: this.requireVoiceConsoleMutationResult(consoleId, true, false) };
    });
    return mutate();
  }

  updateVoiceConsoleBinding(
    bindingId: string,
    input: {
      expectedRevision: number;
      alias?: string;
      ttsVoice?: string;
      ttsPace?: string | null;
      ttsStyle?: string | null;
      noticeMessageId?: string | null;
      interactionId?: string;
      updatedUtc?: string;
    }
  ): VoiceConsoleMutationOutcome {
    const mutate = this.db.transaction((): VoiceConsoleMutationOutcome => {
      const binding = this.getVoiceConsoleBinding(bindingId);
      if (!binding) return mutationFailure("not-found", "Voice Console binding does not exist.");
      const fingerprint = voiceConsoleMutationFingerprint({
        action: "update-binding",
        bindingId,
        expectedRevision: input.expectedRevision,
        alias: input.alias,
        ttsVoice: input.ttsVoice,
        ttsPace: input.ttsPace,
        ttsStyle: input.ttsStyle,
        noticeMessageId: input.noticeMessageId,
      });
      if (this.getVoiceConsoleMutation(binding.consoleId, input.interactionId, "update-binding", fingerprint)) {
        return { ok: true, value: this.requireVoiceConsoleMutationResult(binding.consoleId, false, true) };
      }
      const console = this.getVoiceConsole(binding.consoleId);
      if (!console || !isActiveConsole(console)) return mutationFailure("inactive", "Voice Console is not active.");
      if (console.revision !== input.expectedRevision) return staleConsoleFailure();
      const alias = input.alias === undefined ? binding.alias : validateVoiceConsoleAlias(input.alias);
      const aliasNormalized = normalizeVoiceConsoleAlias(alias);
      const collision = this.db
        .prepare<[string, string, string], { id: string }>(
          `SELECT id FROM thread_voice_sessions WHERE console_id = ? AND alias_normalized = ?
             AND id <> ? AND status IN ('adding','active','removing') LIMIT 1`
        )
        .get(binding.consoleId, aliasNormalized, bindingId);
      if (collision) return mutationFailure("duplicate-alias", "That alias is already in use.");
      const now = input.updatedUtc ?? new Date().toISOString();
      const profileChanged = input.ttsVoice !== undefined || input.ttsPace !== undefined || input.ttsStyle !== undefined;
      this.db
        .prepare(
          `UPDATE thread_voice_sessions SET alias = ?, alias_normalized = ?, tts_voice = ?,
             tts_pace = ?, tts_style = ?, profile_updated_utc = ?, notice_message_id = ?, updated_utc = ?
           WHERE id = ?`
        )
        .run(
          alias,
          aliasNormalized,
          input.ttsVoice ?? binding.ttsVoice,
          input.ttsPace === undefined ? binding.ttsPace : input.ttsPace,
          input.ttsStyle === undefined ? binding.ttsStyle : input.ttsStyle,
          profileChanged ? now : binding.profileUpdatedUtc,
          input.noticeMessageId === undefined ? binding.noticeMessageId : input.noticeMessageId,
          now,
          bindingId
        );
      this.bumpVoiceConsoleRevision(binding.consoleId, now);
      this.recordVoiceConsoleMutation(binding.consoleId, input.interactionId, now, "update-binding", fingerprint);
      return { ok: true, value: this.requireVoiceConsoleMutationResult(binding.consoleId, true, false) };
    });
    return mutate();
  }

  updateVoiceConsoleCard(
    consoleId: string,
    input: {
      expectedRevision: number;
      cardMessageId?: string | null;
      cardPage?: number;
      interactionId?: string;
      updatedUtc?: string;
    }
  ): VoiceConsoleMutationOutcome {
    const mutate = this.db.transaction((): VoiceConsoleMutationOutcome => {
      const fingerprint = voiceConsoleMutationFingerprint({
        action: "update-card",
        expectedRevision: input.expectedRevision,
        cardMessageId: input.cardMessageId,
        cardPage: input.cardPage,
      });
      if (this.getVoiceConsoleMutation(consoleId, input.interactionId, "update-card", fingerprint)) {
        return { ok: true, value: this.requireVoiceConsoleMutationResult(consoleId, false, true) };
      }
      const console = this.getVoiceConsole(consoleId);
      if (!console) return mutationFailure("not-found", "Voice Console does not exist.");
      if (console.revision !== input.expectedRevision) return staleConsoleFailure();
      const now = input.updatedUtc ?? new Date().toISOString();
      this.db
        .prepare(
          `UPDATE voice_console_sessions SET card_message_id = ?, card_page = ?,
             revision = revision + 1, updated_utc = ? WHERE id = ?`
        )
        .run(
          input.cardMessageId === undefined ? console.cardMessageId : input.cardMessageId,
          Math.max(0, Math.trunc(input.cardPage ?? console.cardPage)),
          now,
          consoleId
        );
      this.recordVoiceConsoleMutation(consoleId, input.interactionId, now, "update-card", fingerprint);
      return { ok: true, value: this.requireVoiceConsoleMutationResult(consoleId, true, false) };
    });
    return mutate();
  }

  markVoiceConsoleReady(
    consoleId: string,
    updatedUtc = new Date().toISOString()
  ): VoiceConsoleSession | null {
    const ready = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE thread_voice_sessions SET status = 'active', updated_utc = ?
            WHERE console_id = ? AND status = 'adding'`
        )
        .run(updatedUtc, consoleId);
      this.db
        .prepare(
          `UPDATE voice_console_sessions SET status = 'ready', revision = revision + 1,
             updated_utc = ?, ended_utc = NULL, end_reason = NULL
           WHERE id = ? AND status = 'starting'`
        )
        .run(updatedUtc, consoleId);
      return this.getVoiceConsole(consoleId);
    });
    return ready();
  }

  /** Capture host marks activity-end before awaiting its final transcript. */
  markVoiceConsoleCaptureFinalizing(
    captureId: string,
    updatedUtc = new Date().toISOString()
  ): number {
    return this.db
      .prepare(
        `UPDATE thread_voice_segments SET state = 'finalizing', updated_utc = ?
          WHERE capture_id = ? AND state = 'capturing'
            AND NOT EXISTS (
              SELECT 1 FROM voice_console_invalid_captures invalid
               WHERE invalid.capture_id = thread_voice_segments.capture_id
            )`
      )
      .run(updatedUtc, captureId).changes;
  }

  /**
   * No STT process survives a boot. Terminal metadata-only rows unblock later
   * binding sequences; selecting only unfinished states makes this idempotent.
   */
  recoverUnfinishedVoiceConsoleCaptures(
    reason: string,
    recoveredUtc = new Date().toISOString()
  ): VoiceConsoleSegment[] {
    const captureIds = this.db
      .prepare<[], { capture_id: string }>(
        `SELECT DISTINCT segment.capture_id FROM thread_voice_segments segment
           JOIN thread_voice_sessions binding ON binding.id = segment.session_id
          WHERE binding.console_id IS NOT NULL AND segment.capture_id IS NOT NULL
            AND segment.state IN ('capturing','finalizing')
            AND NOT EXISTS (
              SELECT 1 FROM voice_console_invalid_captures invalid
               WHERE invalid.capture_id = segment.capture_id
            )
          ORDER BY segment.capture_id ASC`
      )
      .all()
      .map((row) => row.capture_id);
    return captureIds.flatMap((captureId) =>
      this.dropVoiceConsoleCapture({
        ...this.voiceConsoleCaptureIdentity(captureId),
        reason,
        capturedEndedUtc: recoveredUtc,
        audioMs: 0,
        forwardedAudioMs: 0,
        outcome: "dropped",
      }).dropped
    );
  }

  beginVoiceConsoleBindingRemoval(
    bindingId: string,
    input: {
      expectedRevision: number;
      interactionId?: string;
      discardPending: boolean;
      reason: string;
      updatedUtc?: string;
    }
  ): VoiceConsoleMutationOutcome {
    const mutate = this.db.transaction((): VoiceConsoleMutationOutcome => {
      const binding = this.getVoiceConsoleBinding(bindingId);
      if (!binding) return mutationFailure("not-found", "Voice Console binding does not exist.");
      const fingerprint = voiceConsoleMutationFingerprint({
        action: "remove-binding",
        bindingId,
        discardPending: input.discardPending,
        expectedRevision: input.expectedRevision,
        reason: input.reason,
      });
      try {
        if (this.getVoiceConsoleMutation(binding.consoleId, input.interactionId, "remove-binding", fingerprint)) {
          return { ok: true, value: this.requireVoiceConsoleMutationResult(binding.consoleId, false, true) };
        }
      } catch {
        return interactionCollisionFailure();
      }
      const console = this.getVoiceConsole(binding.consoleId);
      if (!console || !isActiveConsole(console)) return mutationFailure("inactive", "Voice Console is not active.");
      if (console.revision !== input.expectedRevision) return staleConsoleFailure();
      const now = input.updatedUtc ?? new Date().toISOString();
      this.db.prepare("DELETE FROM voice_console_input_targets WHERE binding_id = ?").run(bindingId);
      this.db
        .prepare(
          `UPDATE thread_voice_segments SET state = 'capture_dropped', transcript = '',
             captured_ended_utc = ?, updated_utc = ?, error = ?
           WHERE session_id = ? AND state IN ('capturing','finalizing')`
        )
        .run(now, now, "binding removed before capture final", bindingId);
      this.db
        .prepare(
          `UPDATE thread_voice_sessions SET status = 'removing', updated_utc = ?, end_reason = ?
            WHERE id = ? AND status IN ('adding','active')`
        )
        .run(now, input.reason, bindingId);
      this.bumpVoiceConsoleRevision(binding.consoleId, now);
      this.recordVoiceConsoleMutation(binding.consoleId, input.interactionId, now, "remove-binding", fingerprint);
      return { ok: true, value: this.requireVoiceConsoleMutationResult(binding.consoleId, true, false) };
    });
    return mutate();
  }

  finishVoiceConsoleBindingRemoval(
    bindingId: string,
    status: "ended" | "failed",
    reason: string,
    endedUtc = new Date().toISOString()
  ): ThreadVoiceBinding | null {
    this.db
      .prepare(
        `UPDATE thread_voice_sessions SET status = ?, updated_utc = ?, ended_utc = ?, end_reason = ?
          WHERE id = ? AND console_id IS NOT NULL AND status IN ('adding','active','removing')`
      )
      .run(status, endedUtc, endedUtc, reason, bindingId);
    return this.getVoiceConsoleBinding(bindingId);
  }

  beginVoiceConsoleStop(
    consoleId: string,
    input: {
      expectedRevision?: number;
      interactionId?: string;
      discardPending: boolean;
      reason: string;
      updatedUtc?: string;
    }
  ): VoiceConsoleMutationOutcome {
    const mutate = this.db.transaction((): VoiceConsoleMutationOutcome => {
      const fingerprint = voiceConsoleMutationFingerprint({
        action: "stop-console",
        discardPending: input.discardPending,
        expectedRevision: input.expectedRevision,
        reason: input.reason,
      });
      if (this.getVoiceConsoleMutation(consoleId, input.interactionId, "stop-console", fingerprint)) {
        return { ok: true, value: this.requireVoiceConsoleMutationResult(consoleId, false, true) };
      }
      const console = this.getVoiceConsole(consoleId);
      if (!console) return mutationFailure("not-found", "Voice Console does not exist.");
      if (!isActiveConsole(console)) return mutationFailure("inactive", "Voice Console is not active.");
      if (input.expectedRevision !== undefined && console.revision !== input.expectedRevision) {
        return staleConsoleFailure();
      }
      const now = input.updatedUtc ?? new Date().toISOString();
      this.db.prepare("DELETE FROM voice_console_input_targets WHERE console_id = ?").run(consoleId);
      this.db
        .prepare(
          `UPDATE thread_voice_segments SET state = 'capture_dropped', transcript = '',
             captured_ended_utc = ?, updated_utc = ?, error = ?
           WHERE session_id IN (SELECT id FROM thread_voice_sessions WHERE console_id = ?)
             AND state IN ('capturing','finalizing')`
        )
        .run(now, now, "console stopped before capture final", consoleId);
      this.db
        .prepare(
          `UPDATE thread_voice_sessions SET status = 'removing', updated_utc = ?, end_reason = ?
            WHERE console_id = ? AND status IN ('adding','active')`
        )
        .run(now, input.reason, consoleId);
      this.db
        .prepare(
          `UPDATE voice_console_sessions SET status = 'stopping', revision = revision + 1,
             updated_utc = ?, end_reason = ? WHERE id = ?`
        )
        .run(now, input.reason, consoleId);
      this.recordVoiceConsoleMutation(consoleId, input.interactionId, now, "stop-console", fingerprint);
      return { ok: true, value: this.requireVoiceConsoleMutationResult(consoleId, true, false) };
    });
    return mutate();
  }

  finishVoiceConsoleStop(
    consoleId: string,
    status: "ended" | "failed",
    reason: string,
    endedUtc = new Date().toISOString()
  ): VoiceConsoleSession | null {
    const finish = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE thread_voice_sessions SET status = ?, updated_utc = ?, ended_utc = ?, end_reason = ?
            WHERE console_id = ? AND status IN ('adding','active','removing')`
        )
        .run(status, endedUtc, endedUtc, reason, consoleId);
      this.db
        .prepare(
          `UPDATE voice_console_sessions SET status = ?, updated_utc = ?, ended_utc = ?, end_reason = ?
            WHERE id = ? AND status IN ('starting','ready','stopping')`
        )
        .run(status, endedUtc, endedUtc, reason, consoleId);
      return this.getVoiceConsole(consoleId);
    });
    return finish();
  }

  allocateVoiceConsoleCapture(input: {
    consoleId: string;
    speakerId: string;
    speakerName: string;
    capturedStartedUtc?: string;
    captureId?: string;
  }): VoiceConsoleCaptureSnapshot | null {
    const allocate = this.db.transaction((): VoiceConsoleCaptureSnapshot | null => {
      const captureId = input.captureId ?? newVoiceConsoleCaptureId();
      assertVoiceConsoleAuthorityId(captureId, "Voice Console capture id");
      if (this.isVoiceConsoleCaptureQuarantined(captureId)) {
        throw new Error("Voice Console capture id is permanently quarantined.");
      }
      const prior = this.getVoiceConsoleCaptureReservation(captureId);
      if (prior) return this.replayVoiceConsoleCaptureAllocation(prior, input);
      if (this.getVoiceConsoleCaptureTerminal(captureId)) {
        throw new Error("Voice Console capture id is already terminal without a replayable allocation identity.");
      }
      const console = this.getVoiceConsole(input.consoleId);
      if (!console || (console.status !== "starting" && console.status !== "ready")) return null;
      const targetRows = this.listVoiceConsoleInputTargets(console.id);
      if (targetRows.length === 0) return null;
      const bindings = new Map(this.listVoiceConsoleBindings(console.id).map((row) => [row.id, row]));
      const selected = targetRows.map((target) => bindings.get(target.bindingId)).filter(
        (binding): binding is ThreadVoiceBinding => binding?.status === "active"
      );
      if (selected.length !== targetRows.length) return null;
      const fanoutGroupId = selected.length > 1 ? newVoiceConsoleFanoutGroupId() : null;
      const started = input.capturedStartedUtc ?? new Date().toISOString();
      const speakerName = sanitizeVoiceConsoleSpeakerName(input.speakerName);
      const assignments = selected.map((binding) => {
        const sequence = this.nextThreadVoiceSequence(binding.id);
        const segmentId = newThreadVoiceSegmentId();
        this.db
          .prepare(
            `INSERT INTO thread_voice_segments
               (id, session_id, sequence, author_id, author_name, transcript, state, audio_ms,
                dispatch_id, capture_id, fanout_group_id, captured_started_utc,
                captured_ended_utc, created_utc, updated_utc, error)
             VALUES (?, ?, ?, ?, ?, '', 'capturing', 0, NULL, ?, ?, ?, ?, ?, ?, NULL)`
          )
          .run(
            segmentId,
            binding.id,
            sequence,
            input.speakerId,
            speakerName,
            captureId,
            fanoutGroupId,
            started,
            started,
            started,
            started
          );
        return { bindingId: binding.id, sequence, segmentId };
      });
      const captureTargets = orderedCaptureTargets(assignments);
      this.db
        .prepare(
          `INSERT INTO voice_console_capture_reservations
             (capture_id, console_id, speaker_id, speaker_name, captured_started_utc,
              fanout_group_id, target_fingerprint, identity_version, identity_valid,
              invalid_reason, created_utc)
           VALUES (?, ?, ?, ?, ?, ?, ?, 2, 1, NULL, ?)`
        )
        .run(
          captureId,
          console.id,
          input.speakerId,
          speakerName,
          started,
          fanoutGroupId,
          captureTargetFingerprint(captureTargets),
          started
        );
      this.insertVoiceConsoleCaptureTargets(captureId, captureTargets);
      this.db
        .prepare(
          `UPDATE voice_console_sessions SET utterance_count = utterance_count + 1,
             updated_utc = ? WHERE id = ?`
        )
        .run(started, console.id);
      return {
        captureId,
        fanoutGroupId,
        consoleId: console.id,
        consoleRevision: console.revision,
        speakerId: input.speakerId,
        speakerName,
        capturedStartedUtc: started,
        assignments,
      };
    });
    return allocate();
  }

  private getVoiceConsoleCaptureReservation(
    captureId: string
  ): VoiceConsoleCaptureReservationRow | null {
    return (
      this.db
        .prepare<[string], VoiceConsoleCaptureReservationRow>(
          "SELECT * FROM voice_console_capture_reservations WHERE capture_id = ?"
        )
        .get(captureId) ?? null
    );
  }

  private listVoiceConsoleCaptureTargets(captureId: string): VoiceConsoleCaptureTargetRow[] {
    return this.db
      .prepare<[string], VoiceConsoleCaptureTargetRow>(
        `SELECT * FROM voice_console_capture_targets
          WHERE capture_id = ? ORDER BY target_ordinal ASC`
      )
      .all(captureId);
  }

  private insertVoiceConsoleCaptureTargets(
    captureId: string,
    targets: readonly { bindingId: string; sequence: number }[]
  ): void {
    const insert = this.db.prepare(
      `INSERT INTO voice_console_capture_targets
         (capture_id, target_ordinal, binding_id, sequence) VALUES (?, ?, ?, ?)`
    );
    orderedCaptureTargets(targets).forEach((target, ordinal) =>
      insert.run(captureId, ordinal, target.bindingId, target.sequence)
    );
  }

  private replayVoiceConsoleCaptureAllocation(
    reservation: VoiceConsoleCaptureReservationRow,
    input: {
      consoleId: string;
      speakerId: string;
      speakerName: string;
      capturedStartedUtc?: string;
      captureId?: string;
    }
  ): VoiceConsoleCaptureSnapshot {
    const rows = this.voiceConsoleCaptureRows(reservation.capture_id);
    const byTarget = new Map(rows.map((row) => [captureTargetKey({ bindingId: row.session_id, sequence: row.sequence }), row]));
    const targetIdentity = this.listVoiceConsoleCaptureTargets(reservation.capture_id);
    const assignments = targetIdentity.map((target) => {
      const row = byTarget.get(captureTargetKey({ bindingId: target.binding_id, sequence: target.sequence }));
      if (!row) throw new Error("Voice Console capture ordered target is missing its reservation row.");
      return { bindingId: target.binding_id, sequence: target.sequence, segmentId: row.id };
    });
    const selectedBindingIds = this.listVoiceConsoleInputTargets(reservation.console_id)
      .map((target) => target.bindingId);
    const reservedBindingIds = assignments.map((target) => target.bindingId);
    const exact =
      reservation.identity_valid === 1 &&
      reservation.identity_version >= 2 &&
      reservation.console_id === input.consoleId &&
      reservation.speaker_id === input.speakerId &&
      reservation.speaker_name === sanitizeVoiceConsoleSpeakerName(input.speakerName) &&
      input.capturedStartedUtc !== undefined &&
      reservation.captured_started_utc === input.capturedStartedUtc &&
      JSON.stringify(selectedBindingIds) === JSON.stringify(reservedBindingIds) &&
      reservation.target_fingerprint === captureTargetFingerprint(assignments);
    if (!exact || assignments.length === 0) {
      throw new Error("Voice Console capture id collision: allocation identity does not match.");
    }
    const console = this.getVoiceConsole(reservation.console_id);
    if (!console) throw new Error("Voice Console capture reservation references a missing console.");
    return {
      captureId: reservation.capture_id,
      fanoutGroupId: reservation.fanout_group_id,
      consoleId: reservation.console_id,
      consoleRevision: console.revision,
      speakerId: reservation.speaker_id,
      speakerName: reservation.speaker_name,
      capturedStartedUtc: reservation.captured_started_utc,
      assignments,
    };
  }

  getVoiceConsoleCaptureTerminal(captureId: string): VoiceConsoleCaptureTerminal | null {
    const row = this.db
      .prepare<[string], VoiceConsoleCaptureTerminalRow>(
        "SELECT * FROM voice_console_capture_terminals WHERE capture_id = ?"
      )
      .get(captureId);
    return row ? mapVoiceConsoleCaptureTerminal(row) : null;
  }

  /**
   * Atomically settles every fan-out reservation and the capture-level usage
   * counters. A stable capture id has one durable winner across retries/reopen.
   */
  finalizeVoiceConsoleCapture(final: VoiceConsoleFinalCapture): VoiceConsoleCaptureCommitResult {
    const settle = this.db.transaction((): VoiceConsoleCaptureCommitResult => {
      const audioMs = requireNonNegativeFiniteNumber(final.audioMs, "audioMs");
      const forwardedAudioMs = requireNonNegativeFiniteNumber(
        final.forwardedAudioMs,
        "forwardedAudioMs"
      );
      const reservation = this.requireVoiceConsoleCaptureIdentity(final);
      const prior = this.getVoiceConsoleCaptureTerminal(final.captureId);
      if (prior) {
        this.assertVoiceConsoleTerminalIdentity(prior, reservation);
        return this.buildVoiceConsoleCaptureResult(final.captureId, prior, true);
      }
      const rows = this.voiceConsoleCaptureRows(final.captureId);
      if (rows.length === 0) return this.emptyVoiceConsoleCaptureResult(final.captureId);
      const consoleId = this.voiceConsoleCaptureConsoleId(rows);
      if (!consoleId) return this.emptyVoiceConsoleCaptureResult(final.captureId);
      if (consoleId !== reservation.console_id) {
        throw new Error("Voice Console capture allocation console does not match its reservation.");
      }

      const transcript = final.transcript.trim();
      const finalSpeakerName = sanitizeVoiceConsoleSpeakerName(final.speakerName);
      const speakerMatches = rows.every(
        (row) => row.author_id === final.speakerId && (row.author_name ?? "") === finalSpeakerName
      );
      for (const row of rows) {
        if (row.state !== "capturing" && row.state !== "finalizing") continue;
        const target = this.getVoiceConsoleBinding(row.session_id);
        const targetValid = target?.status === "active" && target.consoleId === consoleId;
        const accept =
          final.speakerAuthorized &&
          speakerMatches &&
          targetValid &&
          transcript.length > 0 &&
          !final.error;
        const state: ThreadVoiceSegmentState = accept
          ? "pending"
          : final.error
            ? "transcribe_failed"
            : "capture_dropped";
        const error = accept
          ? null
          : final.error ??
            (!final.speakerAuthorized
              ? "speaker authorization revoked"
              : !speakerMatches
                ? "speaker identity mismatch"
                : !targetValid
                  ? "binding removed before capture final"
                  : "empty capture");
        this.db
          .prepare(
            `UPDATE thread_voice_segments SET transcript = ?, state = ?, audio_ms = ?,
               captured_ended_utc = ?, updated_utc = ?, error = ?
             WHERE id = ? AND state IN ('capturing','finalizing')`
          )
          .run(
            accept ? transcript : "",
            state,
            audioMs,
            final.capturedEndedUtc,
            final.capturedEndedUtc,
            error,
            row.id
          );
      }
      // Removal/stop may have already terminalized one reservation while other
      // fan-out targets continued. Preserve that decision but attach the one
      // final capture-duration measurement to every reservation.
      this.db
        .prepare(
          `UPDATE thread_voice_segments SET audio_ms = ?, captured_ended_utc = ?, updated_utc = ?
            WHERE capture_id = ? AND state IN ('capture_dropped','transcribe_failed')`
        )
        .run(audioMs, final.capturedEndedUtc, final.capturedEndedUtc, final.captureId);

      const accepted = this.voiceConsoleCaptureRows(final.captureId).some((row) =>
        ["pending", "batched", "dispatched"].includes(row.state)
      );
      const outcome: VoiceConsoleCaptureTerminalOutcome = accepted
        ? "committed"
        : final.error
          ? "failed"
          : "dropped";
      const reason = accepted
        ? null
        : final.error ??
          (!final.speakerAuthorized
            ? "speaker authorization revoked"
            : !speakerMatches
              ? "speaker identity mismatch"
              : transcript.length === 0
                ? "empty capture"
                : "capture targets unavailable");
      const terminal = this.insertVoiceConsoleCaptureTerminal({
        captureId: final.captureId,
        consoleId,
        speakerId: reservation.speaker_id,
        capturedStartedUtc: reservation.captured_started_utc,
        targetFingerprint: reservation.target_fingerprint,
        outcome,
        reason,
        resultSource: final.resultSource ?? null,
        audioMs,
        forwardedAudioMs,
        capturedEndedUtc: final.capturedEndedUtc,
        createdUtc: final.capturedEndedUtc,
      });
      this.incrementVoiceConsoleCaptureCounters(terminal);
      return this.buildVoiceConsoleCaptureResult(final.captureId, terminal, false);
    });
    return settle();
  }

  /** First terminal winner for one capture; never mutates a prior commit/drop. */
  dropVoiceConsoleCapture(input: VoiceConsoleDropCaptureInput): VoiceConsoleCaptureCommitResult {
    const settle = this.db.transaction((): VoiceConsoleCaptureCommitResult => {
      const audioMs = requireNonNegativeFiniteNumber(input.audioMs, "audioMs");
      const forwardedAudioMs = requireNonNegativeFiniteNumber(
        input.forwardedAudioMs,
        "forwardedAudioMs"
      );
      const reservation = this.requireVoiceConsoleCaptureIdentity(input);
      const prior = this.getVoiceConsoleCaptureTerminal(input.captureId);
      if (prior) {
        this.assertVoiceConsoleTerminalIdentity(prior, reservation);
        return this.buildVoiceConsoleCaptureResult(input.captureId, prior, true);
      }
      const rows = this.voiceConsoleCaptureRows(input.captureId);
      if (rows.length === 0) return this.emptyVoiceConsoleCaptureResult(input.captureId);
      const consoleId = this.voiceConsoleCaptureConsoleId(rows);
      if (!consoleId) return this.emptyVoiceConsoleCaptureResult(input.captureId);
      const precommitted = rows.some((row) =>
        ["pending", "batched", "dispatched"].includes(row.state)
      );
      const outcome: VoiceConsoleCaptureTerminalOutcome = precommitted
        ? "committed"
        : input.outcome ?? "dropped";
      if (!precommitted) {
        this.db
          .prepare(
            `UPDATE thread_voice_segments SET transcript = '', state = ?, audio_ms = ?,
               captured_ended_utc = ?, updated_utc = ?, error = ?
             WHERE capture_id = ? AND state IN ('capturing','finalizing')`
          )
          .run(
            outcome === "failed" ? "transcribe_failed" : "capture_dropped",
            audioMs,
            input.capturedEndedUtc,
            input.capturedEndedUtc,
            input.reason,
            input.captureId
          );
        this.db
          .prepare(
            `UPDATE thread_voice_segments SET audio_ms = ?, captured_ended_utc = ?, updated_utc = ?
              WHERE capture_id = ? AND state IN ('capture_dropped','transcribe_failed')`
          )
          .run(audioMs, input.capturedEndedUtc, input.capturedEndedUtc, input.captureId);
      }
      const terminal = this.insertVoiceConsoleCaptureTerminal({
        captureId: input.captureId,
        consoleId,
        speakerId: reservation.speaker_id,
        capturedStartedUtc: reservation.captured_started_utc,
        targetFingerprint: reservation.target_fingerprint,
        outcome,
        reason: precommitted ? null : input.reason,
        resultSource: input.resultSource ?? null,
        audioMs,
        forwardedAudioMs,
        capturedEndedUtc: input.capturedEndedUtc,
        createdUtc: input.capturedEndedUtc,
      });
      this.incrementVoiceConsoleCaptureCounters(terminal);
      return this.buildVoiceConsoleCaptureResult(input.captureId, terminal, false);
    });
    return settle();
  }

  private voiceConsoleCaptureRows(captureId: string): VoiceConsoleSegmentRow[] {
    return this.db
      .prepare<[string], VoiceConsoleSegmentRow>(
        "SELECT * FROM thread_voice_segments WHERE capture_id = ? ORDER BY session_id, sequence"
      )
      .all(captureId);
  }

  private requireVoiceConsoleCaptureIdentity(
    identity: VoiceConsoleCaptureIdentity
  ): VoiceConsoleCaptureReservationRow {
    const reservation = this.getVoiceConsoleCaptureReservation(identity.captureId);
    if (!reservation) {
      throw new Error("Voice Console capture has no durable allocation identity.");
    }
    const fingerprint = captureTargetFingerprint(identity.targets);
    const persistedTargets = this.listVoiceConsoleCaptureTargets(identity.captureId).map((target) => ({
      bindingId: target.binding_id,
      sequence: target.sequence,
    }));
    if (
      reservation.identity_valid !== 1 ||
      reservation.identity_version < 2 ||
      reservation.console_id !== identity.consoleId ||
      reservation.speaker_id !== identity.speakerId ||
      reservation.captured_started_utc !== identity.capturedStartedUtc ||
      reservation.target_fingerprint !== fingerprint ||
      JSON.stringify(orderedCaptureTargets(identity.targets)) !== JSON.stringify(persistedTargets)
    ) {
      throw new Error("Voice Console capture id collision: terminal identity does not match allocation.");
    }
    return reservation;
  }

  getVoiceConsoleCaptureIdentity(captureId: string): VoiceConsoleCaptureIdentity | null {
    const reservation = this.getVoiceConsoleCaptureReservation(captureId);
    if (!reservation || reservation.identity_valid !== 1 || reservation.identity_version < 2) return null;
    return {
      captureId,
      consoleId: reservation.console_id,
      speakerId: reservation.speaker_id,
      capturedStartedUtc: reservation.captured_started_utc,
      targets: this.listVoiceConsoleCaptureTargets(captureId).map((target) => ({
        bindingId: target.binding_id,
        sequence: target.sequence,
      })),
    };
  }

  private voiceConsoleCaptureIdentity(captureId: string): VoiceConsoleCaptureIdentity {
    const identity = this.getVoiceConsoleCaptureIdentity(captureId);
    if (!identity) throw new Error("Voice Console capture has no durable allocation identity.");
    return identity;
  }

  private assertVoiceConsoleTerminalIdentity(
    terminal: VoiceConsoleCaptureTerminal,
    reservation: VoiceConsoleCaptureReservationRow
  ): void {
    if (
      terminal.speakerId === null ||
      terminal.capturedStartedUtc === null ||
      terminal.targetFingerprint === null
    ) {
      throw new Error("Legacy Voice Console capture terminal cannot be safely replayed.");
    }
    if (
      terminal.consoleId !== reservation.console_id ||
      terminal.speakerId !== reservation.speaker_id ||
      terminal.capturedStartedUtc !== reservation.captured_started_utc ||
      terminal.targetFingerprint !== reservation.target_fingerprint
    ) {
      throw new Error("Voice Console capture terminal does not match the winning allocation identity.");
    }
  }

  private voiceConsoleCaptureConsoleId(rows: readonly VoiceConsoleSegmentRow[]): string | null {
    let consoleId: string | null = null;
    for (const row of rows) {
      const binding = this.getVoiceConsoleBinding(row.session_id);
      if (!binding) return null;
      if (consoleId !== null && consoleId !== binding.consoleId) {
        throw new Error("Voice Console capture spans more than one console.");
      }
      consoleId = binding.consoleId;
    }
    return consoleId;
  }

  private insertVoiceConsoleCaptureTerminal(
    terminal: VoiceConsoleCaptureTerminal
  ): VoiceConsoleCaptureTerminal {
    this.db
      .prepare(
        `INSERT INTO voice_console_capture_terminals
           (capture_id, console_id, speaker_id, captured_started_utc, target_fingerprint,
            outcome, reason, result_source, audio_ms, forwarded_audio_ms,
            captured_ended_utc, created_utc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        terminal.captureId,
        terminal.consoleId,
        terminal.speakerId,
        terminal.capturedStartedUtc,
        terminal.targetFingerprint,
        terminal.outcome,
        terminal.reason,
        terminal.resultSource,
        terminal.audioMs,
        terminal.forwardedAudioMs,
        terminal.capturedEndedUtc,
        terminal.createdUtc
      );
    return terminal;
  }

  private incrementVoiceConsoleCaptureCounters(terminal: VoiceConsoleCaptureTerminal): void {
    if (terminal.forwardedAudioMs === null) {
      throw new Error("Voice Console capture terminal is missing forwarded audio telemetry.");
    }
    this.db
      .prepare(
        `UPDATE voice_console_sessions SET
           forwarded_audio_ms = forwarded_audio_ms + ?,
           live_final_count = live_final_count + ?,
           unary_fallback_count = unary_fallback_count + ?,
           dropped_count = dropped_count + ?,
           stt_failure_count = stt_failure_count + ?,
           updated_utc = ? WHERE id = ?`
      )
      .run(
        terminal.forwardedAudioMs,
        terminal.outcome === "committed" && terminal.resultSource === "live" ? 1 : 0,
        terminal.outcome === "committed" && terminal.resultSource === "unary" ? 1 : 0,
        terminal.outcome === "committed" ? 0 : 1,
        terminal.outcome === "failed" ? 1 : 0,
        terminal.capturedEndedUtc,
        terminal.consoleId
      );
  }

  private emptyVoiceConsoleCaptureResult(captureId: string): VoiceConsoleCaptureCommitResult {
    return {
      captureId,
      terminal: null,
      duplicate: false,
      committed: [],
      dropped: [],
      failures: [],
    };
  }

  private buildVoiceConsoleCaptureResult(
    captureId: string,
    terminal: VoiceConsoleCaptureTerminal,
    duplicate: boolean
  ): VoiceConsoleCaptureCommitResult {
    const committed: VoiceConsoleSegment[] = [];
    const dropped: VoiceConsoleSegment[] = [];
    const failures: Array<{ bindingId: string; error: string }> = [];
    for (const row of this.voiceConsoleCaptureRows(captureId)) {
      const segment = mapVoiceConsoleSegment(row);
      if (
        ["pending", "batched", "dispatched"].includes(segment.state) ||
        (segment.state === "discarded" && terminal.outcome === "committed")
      ) {
        committed.push(segment);
      } else if (["capture_dropped", "transcribe_failed", "discarded"].includes(segment.state)) {
        dropped.push(segment);
      } else {
        failures.push({
          bindingId: segment.bindingId,
          error: `capture terminal ${terminal.outcome} left segment in ${segment.state}`,
        });
      }
    }
    return { captureId, terminal, duplicate, committed, dropped, failures };
  }

  dropActiveVoiceConsoleCaptures(
    consoleId: string,
    reason: string,
    droppedUtc = new Date().toISOString()
  ): VoiceConsoleSegment[] {
    const captureIds = this.db
      .prepare<[string], { capture_id: string }>(
        `SELECT DISTINCT segment.capture_id FROM thread_voice_segments segment
           JOIN thread_voice_sessions binding ON binding.id = segment.session_id
          WHERE binding.console_id = ? AND segment.capture_id IS NOT NULL
            AND segment.state IN ('capturing','finalizing')
            AND NOT EXISTS (
              SELECT 1 FROM voice_console_invalid_captures invalid
               WHERE invalid.capture_id = segment.capture_id
            )
          ORDER BY segment.capture_id ASC`
      )
      .all(consoleId)
      .map((row) => row.capture_id);
    return captureIds.flatMap((captureId) =>
      this.dropVoiceConsoleCapture({
        ...this.voiceConsoleCaptureIdentity(captureId),
        reason,
        capturedEndedUtc: droppedUtc,
        audioMs: 0,
        forwardedAudioMs: 0,
        outcome: "dropped",
      }).dropped
    );
  }

  getVoiceConsoleSegment(id: string): VoiceConsoleSegment | null {
    const row = this.db
      .prepare<[string], VoiceConsoleSegmentRow>("SELECT * FROM thread_voice_segments WHERE id = ?")
      .get(id);
    return row ? mapVoiceConsoleSegment(row) : null;
  }

  listVoiceConsoleSegments(bindingId: string): VoiceConsoleSegment[] {
    return this.db
      .prepare<[string], VoiceConsoleSegmentRow>(
        "SELECT * FROM thread_voice_segments WHERE session_id = ? ORDER BY sequence ASC"
      )
      .all(bindingId)
      .map(mapVoiceConsoleSegment);
  }

  isVoiceConsoleCaptureQuarantined(captureId: string): boolean {
    return Boolean(
      this.db
        .prepare<[string], { found: number }>(
          "SELECT 1 AS found FROM voice_console_invalid_captures WHERE capture_id = ?"
        )
        .get(captureId)
    );
  }

  isVoiceConsoleDispatchQuarantined(dispatchId: string): boolean {
    return Boolean(
      this.db
        .prepare<[string], { found: number }>(
          `SELECT 1 AS found FROM voice_console_quarantined_dispatches
            WHERE dispatch_id = ? AND reconciled_utc IS NULL LIMIT 1`
        )
        .get(dispatchId)
    );
  }

  listVoiceConsoleQuarantinedDispatches(
    options: { includeReconciled?: boolean } = {}
  ): VoiceConsoleQuarantinedDispatch[] {
    const rows = this.db
      .prepare<[number], VoiceConsoleQuarantinedDispatchRow>(
        `SELECT * FROM voice_console_quarantined_dispatches
          WHERE (? = 1 OR reconciled_utc IS NULL)
          ORDER BY quarantined_utc, dispatch_id, capture_id`
      )
      .all(options.includeReconciled ? 1 : 0);
    const grouped = new Map<string, VoiceConsoleQuarantinedDispatch>();
    for (const row of rows) {
      const existing = grouped.get(row.dispatch_id);
      if (existing) {
        existing.captureIds.push(row.capture_id);
        continue;
      }
      grouped.set(row.dispatch_id, {
        dispatchId: row.dispatch_id,
        bindingId: row.binding_id,
        captureIds: [row.capture_id],
        reason: row.reason,
        artifactState: row.artifact_state as VoiceConsoleQuarantinedDispatch["artifactState"],
        quarantinedUtc: row.quarantined_utc,
        reconciledUtc: row.reconciled_utc,
      });
    }
    return [...grouped.values()];
  }

  recordVoiceConsoleQuarantinedArtifactState(
    dispatchId: string,
    artifactState: "missing" | "pending" | "running" | "done"
  ): number {
    return this.db
      .prepare(
        `UPDATE voice_console_quarantined_dispatches SET artifact_state = ?
          WHERE dispatch_id = ? AND reconciled_utc IS NULL`
      )
      .run(artifactState, dispatchId).changes;
  }

  finalizeVoiceConsoleQuarantinedDispatch(
    dispatchId: string,
    artifactState: "missing" | "pending" | "running" | "done",
    reconciledUtc = new Date().toISOString()
  ): number {
    const finalize = this.db.transaction(() => {
      const reason = this.db
        .prepare<[string], { reason: string }>(
          `SELECT reason FROM voice_console_quarantined_dispatches
            WHERE dispatch_id = ? AND reconciled_utc IS NULL LIMIT 1`
        )
        .get(dispatchId)?.reason;
      if (!reason) return 0;
      const changed = this.db
        .prepare(
          `UPDATE thread_voice_segments SET transcript = '', state = 'capture_dropped',
             error = ?, updated_utc = ? WHERE dispatch_id = ?`
        )
        .run(reason, reconciledUtc, dispatchId).changes;
      this.db
        .prepare(
          `UPDATE voice_console_quarantined_dispatches
              SET artifact_state = ?, reconciled_utc = ?
            WHERE dispatch_id = ? AND reconciled_utc IS NULL`
        )
        .run(artifactState, reconciledUtc, dispatchId);
      return changed;
    });
    return finalize();
  }

  claimPendingVoiceConsoleBatch(
    bindingId: string,
    dispatchId = newThreadVoiceDispatchId(),
    claimedUtc = new Date().toISOString()
  ): VoiceConsoleBatch | null {
    const claim = this.db.transaction((): VoiceConsoleBatch | null => {
      const binding = this.getVoiceConsoleBinding(bindingId);
      if (!binding) return null;
      const existing = this.db
        .prepare<[string, string], { dispatch_id: string }>(
          `SELECT segment.dispatch_id FROM thread_voice_segments segment
             JOIN thread_voice_sessions binding ON binding.id = segment.session_id
            WHERE binding.platform = ? AND binding.channel_ref = ?
              AND segment.state = 'batched' AND segment.dispatch_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM voice_console_invalid_captures invalid
                 WHERE invalid.capture_id = segment.capture_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM voice_console_quarantined_dispatches quarantine
                 WHERE quarantine.dispatch_id = segment.dispatch_id
                   AND quarantine.reconciled_utc IS NULL
              )
            LIMIT 1`
        )
        .get(binding.platform, binding.channelRef);
      if (existing) return null;
      if (
        this.db
          .prepare<[string], { found: number }>(
            `SELECT 1 AS found FROM voice_console_quarantined_dispatches quarantine
              JOIN thread_voice_segments segment ON segment.dispatch_id = quarantine.dispatch_id
             WHERE segment.session_id = ? AND quarantine.reconciled_utc IS NULL LIMIT 1`
          )
          .get(bindingId)
      ) return null;
      const unresolved = this.db
        .prepare<[string], { sequence: number }>(
          `SELECT MIN(sequence) AS sequence FROM thread_voice_segments segment
            WHERE session_id = ? AND state IN ('capturing','finalizing')
              AND NOT EXISTS (
                SELECT 1 FROM voice_console_invalid_captures invalid
                 WHERE invalid.capture_id = segment.capture_id
              )`
        )
        .get(bindingId)?.sequence;
      const pending = this.db
        .prepare<[string, number], VoiceConsoleSegmentRow>(
          `SELECT * FROM thread_voice_segments segment
            WHERE session_id = ? AND state = 'pending' AND sequence < ?
              AND NOT EXISTS (
                SELECT 1 FROM voice_console_invalid_captures invalid
                 WHERE invalid.capture_id = segment.capture_id
              )
            ORDER BY sequence ASC`
        )
        .all(bindingId, unresolved ?? Number.MAX_SAFE_INTEGER);
      if (pending.length === 0) return null;
      const authorId = pending[0]!.author_id;
      const authorName = pending[0]!.author_name ?? "";
      const rows: VoiceConsoleSegmentRow[] = [];
      for (const row of pending) {
        if (row.author_id !== authorId || (row.author_name ?? "") !== authorName) break;
        rows.push(row);
      }
      const placeholders = rows.map(() => "?").join(",");
      this.db
        .prepare(
          `UPDATE thread_voice_segments SET state = 'batched', dispatch_id = ?, updated_utc = ?
            WHERE id IN (${placeholders}) AND state = 'pending'
              AND NOT EXISTS (
                SELECT 1 FROM voice_console_invalid_captures invalid
                 WHERE invalid.capture_id = thread_voice_segments.capture_id
              )`
        )
        .run(dispatchId, claimedUtc, ...rows.map((row) => row.id));
      return this.buildVoiceConsoleBatch(
        dispatchId,
        binding,
        rows.map((row) =>
          mapVoiceConsoleSegment({ ...row, state: "batched", dispatch_id: dispatchId, updated_utc: claimedUtc })
        )
      );
    });
    return claim();
  }

  getVoiceConsoleBatch(dispatchId: string): VoiceConsoleBatch | null {
    const rows = this.db
      .prepare<[string], VoiceConsoleSegmentRow>(
        `SELECT * FROM thread_voice_segments segment WHERE dispatch_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM voice_console_invalid_captures invalid
             WHERE invalid.capture_id = segment.capture_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM voice_console_quarantined_dispatches quarantine
             WHERE quarantine.dispatch_id = segment.dispatch_id
          )
          ORDER BY sequence ASC`
      )
      .all(dispatchId);
    if (rows.length === 0) return null;
    const binding = this.getVoiceConsoleBinding(rows[0]!.session_id);
    return binding ? this.buildVoiceConsoleBatch(dispatchId, binding, rows.map(mapVoiceConsoleSegment)) : null;
  }

  listVoiceConsoleBatchesByState(state: "batched" | "dispatched"): VoiceConsoleBatch[] {
    return this.db
      .prepare<[string], { dispatch_id: string }>(
        `SELECT dispatch_id FROM thread_voice_segments segment
           JOIN thread_voice_sessions binding ON binding.id = segment.session_id
          WHERE segment.state = ? AND segment.dispatch_id IS NOT NULL AND binding.console_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM voice_console_invalid_captures invalid
               WHERE invalid.capture_id = segment.capture_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM voice_console_quarantined_dispatches quarantine
               WHERE quarantine.dispatch_id = segment.dispatch_id
            )
          GROUP BY dispatch_id ORDER BY MIN(segment.created_utc) ASC`
      )
      .all(state)
      .map(({ dispatch_id }) => this.getVoiceConsoleBatch(dispatch_id))
      .filter((batch): batch is VoiceConsoleBatch => batch !== null);
  }

  /** An artifact-free in-memory claim may be safely made releasable again. */
  requeueArtifactFreeVoiceConsoleBatch(
    bindingId: string,
    dispatchId: string,
    updatedUtc = new Date().toISOString()
  ): number {
    return this.db
      .prepare(
        `UPDATE thread_voice_segments SET state = 'pending', dispatch_id = NULL,
           updated_utc = ?, error = NULL
         WHERE session_id = ? AND dispatch_id = ? AND state = 'batched'
           AND NOT EXISTS (
             SELECT 1 FROM voice_console_invalid_captures invalid
              WHERE invalid.capture_id = thread_voice_segments.capture_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM voice_console_quarantined_dispatches quarantine
              WHERE quarantine.dispatch_id = thread_voice_segments.dispatch_id
                AND quarantine.reconciled_utc IS NULL
           )`
      )
      .run(updatedUtc, bindingId, dispatchId).changes;
  }

  getVoiceConsoleInteractionReplay(
    consoleId: string,
    interactionId: string | undefined,
    input: { expectedRevision?: number; discardPending: boolean; reason: string }
  ): VoiceConsoleMutationOutcome | null {
    const fingerprint = voiceConsoleMutationFingerprint({
      action: "stop-console",
      discardPending: input.discardPending,
      expectedRevision: input.expectedRevision,
      reason: input.reason,
    });
    if (!interactionId) return null;
    try {
      if (!this.getVoiceConsoleMutation(consoleId, interactionId, "stop-console", fingerprint)) return null;
    } catch {
      return interactionCollisionFailure();
    }
    return {
      ok: true,
      value: this.requireVoiceConsoleMutationResult(consoleId, false, true),
    };
  }

  listVoiceConsoleBindingsWithBufferedSegments(): ThreadVoiceBinding[] {
    return this.db
      .prepare<[], VoiceConsoleBindingRow>(
        `SELECT DISTINCT binding.* FROM thread_voice_sessions binding
           JOIN thread_voice_segments segment ON segment.session_id = binding.id
          WHERE binding.console_id IS NOT NULL AND segment.state IN ('pending','batched')
            AND NOT EXISTS (
              SELECT 1 FROM voice_console_invalid_captures invalid
               WHERE invalid.capture_id = segment.capture_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM voice_console_quarantined_dispatches quarantine
               WHERE quarantine.dispatch_id = segment.dispatch_id
            )
          ORDER BY binding.created_utc ASC`
      )
      .all()
      .map(mapVoiceConsoleBinding);
  }

  upgradeActiveV1ThreadVoiceSessions(
    defaults: VoiceConsoleUpgradeDefaults,
    upgradedUtc = new Date().toISOString()
  ): VoiceConsoleSession[] {
    const upgrade = this.db.transaction((): VoiceConsoleSession[] => {
      const legacy = this.db
        .prepare<[], ThreadVoiceSessionRow>(
          `SELECT * FROM thread_voice_sessions WHERE console_id IS NULL
             AND status IN ('starting','ready','stopping') ORDER BY created_utc ASC`
        )
        .all();
      const upgraded: VoiceConsoleSession[] = [];
      for (const row of legacy) {
        const existing = this.getActiveVoiceConsoleForGuild(row.guild_id);
        if (existing) throw new Error(`Cannot upgrade V1 session ${row.id}: guild already has console ${existing.id}.`);
        const id = newVoiceConsoleId();
        assertVoiceConsoleAuthorityId(row.id, "Legacy Thread Voice binding id");
        const consoleStatus: VoiceConsoleStatus = row.status === "ready" ? "ready" : row.status === "stopping" ? "stopping" : "starting";
        const console: VoiceConsoleSession = {
          id,
          platform: row.platform,
          guildId: row.guild_id,
          voiceChannelId: row.voice_channel_id,
          ownerUserId: row.owner_user_id,
          ownerName: row.owner_name,
          status: consoleStatus,
          cardChannelId: row.voice_channel_id,
          cardMessageId: null,
          cardPage: 0,
          revision: 1,
          fanoutArmed: false,
          forwardedAudioBytes: 0,
          forwardedAudioMs: row.transmitted_audio_ms,
          utteranceCount: 0,
          liveFinalCount: 0,
          unaryFallbackCount: 0,
          droppedCount: 0,
          sttFailureCount: 0,
          createdUtc: row.created_utc,
          updatedUtc: upgradedUtc,
          endedUtc: null,
          endReason: row.end_reason,
        };
        const alias = validateVoiceConsoleAlias(defaults.aliasFor({ channelRef: row.channel_ref }));
        const profile = defaults.profileFor({ channelRef: row.channel_ref });
        this.insertVoiceConsoleRow(console);
        const bindingStatus: VoiceConsoleBindingStatus = row.status === "ready" ? "active" : row.status === "stopping" ? "removing" : "adding";
        this.db
          .prepare(
            `UPDATE thread_voice_sessions SET console_id = ?, alias = ?, alias_normalized = ?,
               tts_voice = ?, tts_pace = ?, tts_style = ?, profile_updated_utc = ?,
               output_enabled = 1, output_generation = 0, status = ?, updated_utc = ? WHERE id = ?`
          )
          .run(
            id,
            alias,
            normalizeVoiceConsoleAlias(alias),
            profile.voice,
            profile.pace,
            profile.style,
            upgradedUtc,
            bindingStatus,
            upgradedUtc,
            row.id
          );
        if (bindingStatus !== "removing") {
          this.replaceVoiceConsoleTargetsRows(id, [row.id], upgradedUtc);
        }
        upgraded.push(console);
      }
      return upgraded;
    });
    return upgrade();
  }

  private insertVoiceConsoleRow(console: VoiceConsoleSession): void {
    assertVoiceConsoleAuthorityId(console.id, "Voice Console id");
    this.db
      .prepare(
        `INSERT INTO voice_console_sessions
           (id, platform, guild_id, voice_channel_id, owner_user_id, owner_name, status,
            card_channel_id, card_message_id, card_page, revision, fanout_armed,
            forwarded_audio_bytes, forwarded_audio_ms, utterance_count, live_final_count,
            unary_fallback_count, dropped_count, stt_failure_count, created_utc, updated_utc,
            ended_utc, end_reason)
         VALUES
           (@id, @platform, @guildId, @voiceChannelId, @ownerUserId, @ownerName, @status,
            @cardChannelId, @cardMessageId, @cardPage, @revision, @fanoutArmed,
            @forwardedAudioBytes, @forwardedAudioMs, @utteranceCount, @liveFinalCount,
            @unaryFallbackCount, @droppedCount, @sttFailureCount, @createdUtc, @updatedUtc,
            @endedUtc, @endReason)`
      )
      .run({ ...console, fanoutArmed: console.fanoutArmed ? 1 : 0 });
  }

  private insertVoiceConsoleBindingRow(binding: ThreadVoiceBinding): void {
    this.db
      .prepare(
        `INSERT INTO thread_voice_sessions
           (id, platform, channel_ref, parent_ref, guild_id, voice_channel_id,
            owner_user_id, owner_name, status, notice_message_id, transmitted_audio_ms,
            created_utc, updated_utc, ended_utc, end_reason, console_id, alias,
            alias_normalized, tts_voice, tts_pace, tts_style, profile_updated_utc,
            output_enabled, output_generation)
         VALUES
           (@id, @platform, @channelRef, @parentRef, @guildId, @voiceChannelId,
            @ownerUserId, @ownerName, @status, @noticeMessageId, 0,
            @createdUtc, @updatedUtc, @endedUtc, @endReason, @consoleId, @alias,
            @aliasNormalized, @ttsVoice, @ttsPace, @ttsStyle, @profileUpdatedUtc,
            @outputEnabled, @outputGeneration)`
      )
      .run({ ...binding, outputEnabled: binding.outputEnabled ? 1 : 0 });
  }

  private replaceVoiceConsoleTargetsRows(consoleId: string, ids: readonly string[], selectedUtc: string): void {
    this.db.prepare("DELETE FROM voice_console_input_targets WHERE console_id = ?").run(consoleId);
    const insert = this.db.prepare(
      `INSERT INTO voice_console_input_targets (console_id, binding_id, ordinal, selected_utc)
       VALUES (?, ?, ?, ?)`
    );
    ids.forEach((id, ordinal) => insert.run(consoleId, id, ordinal, selectedUtc));
  }

  private areActiveBindingsOwnedByConsole(consoleId: string, ids: readonly string[]): boolean {
    if (ids.length === 0) return true;
    const row = this.db
      .prepare<unknown[], { count: number }>(
        `SELECT COUNT(*) AS count FROM thread_voice_sessions
          WHERE console_id = ? AND id IN (${ids.map(() => "?").join(",")}) AND status = 'active'`
      )
      .get(consoleId, ...ids);
    return row?.count === ids.length;
  }

  private bumpVoiceConsoleRevision(consoleId: string, updatedUtc: string): void {
    this.db
      .prepare("UPDATE voice_console_sessions SET revision = revision + 1, updated_utc = ? WHERE id = ?")
      .run(updatedUtc, consoleId);
  }

  private replayVoiceConsoleAddInteraction(
    interaction: VoiceConsoleAddInteraction,
    fingerprint: string
  ): VoiceConsoleMutationOutcome {
    if (interaction.inputFingerprint !== fingerprint) return interactionCollisionFailure();
    if (interaction.status === "succeeded") {
      return {
        ok: true,
        value: this.requireVoiceConsoleMutationResult(interaction.consoleId, false, true),
      };
    }
    if (interaction.status === "pending") {
      return {
        ok: false,
        reason: "interaction-pending",
        error: "Voice Console binding add is already in progress.",
        duplicate: true,
      };
    }
    return {
      ok: false,
      reason: interaction.failureCode ?? "activation-failed",
      error: interaction.failureMessage ?? "Voice Console binding add failed.",
      duplicate: true,
      replayAsException: interaction.failureAsException,
    };
  }

  private getVoiceConsoleMutationRecord(
    consoleId: string,
    interactionId: string
  ): { mutation_id: string; action: string; input_fingerprint: string | null } | null {
    return (
      this.db
        .prepare<[string, string], { mutation_id: string; action: string; input_fingerprint: string | null }>(
          `SELECT mutation_id, action, input_fingerprint FROM voice_console_mutations
            WHERE console_id = ? AND mutation_id = ?`
        )
        .get(consoleId, interactionId) ?? null
    );
  }

  private getVoiceConsoleMutation(
    consoleId: string,
    interactionId: string | undefined,
    action: string,
    inputFingerprint: string
  ): boolean {
    if (!interactionId) return false;
    if (this.getVoiceConsoleAddInteraction(consoleId, interactionId)) {
      throw new Error(interactionCollisionFailure().error);
    }
    const mutation = this.getVoiceConsoleMutationRecord(consoleId, interactionId);
    if (!mutation) return false;
    if (mutation.action === action && mutation.input_fingerprint === inputFingerprint) return true;
    throw new Error(interactionCollisionFailure().error);
  }

  private recordVoiceConsoleMutation(
    consoleId: string,
    interactionId: string | undefined,
    createdUtc: string,
    action: string,
    inputFingerprint: string
  ): void {
    if (!interactionId) return;
    const revision = this.getVoiceConsole(consoleId)?.revision ?? 0;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO voice_console_mutations
           (console_id, mutation_id, action, input_fingerprint, revision, created_utc)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(consoleId, interactionId, action, inputFingerprint, revision, createdUtc);
  }

  private requireVoiceConsoleMutationResult(
    consoleId: string,
    applied: boolean,
    duplicate: boolean
  ): VoiceConsoleMutationResult {
    const console = this.getVoiceConsole(consoleId);
    if (!console) throw new Error(`Voice Console \`${consoleId}\` does not exist.`);
    return {
      applied,
      duplicate,
      console,
      bindings: this.listVoiceConsoleBindings(consoleId),
      targets: this.listVoiceConsoleInputTargets(consoleId),
    };
  }

  private buildVoiceConsoleBatch(
    dispatchId: string,
    binding: ThreadVoiceBinding,
    segments: VoiceConsoleSegment[]
  ): VoiceConsoleBatch {
    const authorId = segments[0]?.authorId ?? "";
    const authorName = segments[0]?.authorName ?? "";
    return {
      dispatchId,
      console: this.getVoiceConsole(binding.consoleId),
      binding,
      segments,
      prompt: composeVoiceConsolePrompt(authorId, segments),
      authorId,
      authorName,
    };
  }

  // --- Thread Voice -------------------------------------------------------

  insertThreadVoiceSession(session: ThreadVoiceSession): void {
    this.db
      .prepare(
        `INSERT INTO thread_voice_sessions
           (id, platform, channel_ref, parent_ref, guild_id, voice_channel_id,
            owner_user_id, owner_name, status, notice_message_id,
            transmitted_audio_ms, created_utc, updated_utc, ended_utc, end_reason)
         VALUES
           (@id, @platform, @channelRef, @parentRef, @guildId, @voiceChannelId,
            @ownerUserId, @ownerName, @status, @noticeMessageId,
            @transmittedAudioMs, @createdUtc, @updatedUtc, @endedUtc, @endReason)`
      )
      .run(session);
  }

  getThreadVoiceSession(id: string): ThreadVoiceSession | null {
    const row = this.db
      .prepare<[string], ThreadVoiceSessionRow>(
        "SELECT * FROM thread_voice_sessions WHERE id = ?"
      )
      .get(id);
    return row ? mapThreadVoiceSession(row) : null;
  }

  getActiveThreadVoiceForThread(
    platform: string,
    channelRef: string
  ): ThreadVoiceSession | null {
    const row = this.db
      .prepare<[string, string], ThreadVoiceSessionRow>(
        `SELECT * FROM thread_voice_sessions
          WHERE platform = ? AND channel_ref = ?
            AND status IN ('starting','ready','stopping')
          ORDER BY created_utc DESC LIMIT 1`
      )
      .get(platform, channelRef);
    return row ? mapThreadVoiceSession(row) : null;
  }

  getActiveThreadVoiceForGuild(guildId: string): ThreadVoiceSession | null {
    const row = this.db
      .prepare<[string], ThreadVoiceSessionRow>(
        `SELECT * FROM thread_voice_sessions
          WHERE guild_id = ? AND status IN ('starting','ready','stopping')
          ORDER BY created_utc DESC LIMIT 1`
      )
      .get(guildId);
    return row ? mapThreadVoiceSession(row) : null;
  }

  getActiveThreadVoiceForVoiceChannel(voiceChannelId: string): ThreadVoiceSession | null {
    const row = this.db
      .prepare<[string], ThreadVoiceSessionRow>(
        `SELECT * FROM thread_voice_sessions
          WHERE voice_channel_id = ? AND status IN ('starting','ready','stopping')
          ORDER BY created_utc DESC LIMIT 1`
      )
      .get(voiceChannelId);
    return row ? mapThreadVoiceSession(row) : null;
  }

  getActiveThreadVoiceForOwner(
    guildId: string,
    ownerUserId: string
  ): ThreadVoiceSession | null {
    const row = this.db
      .prepare<[string, string], ThreadVoiceSessionRow>(
        `SELECT * FROM thread_voice_sessions
          WHERE guild_id = ? AND owner_user_id = ?
            AND status IN ('starting','ready','stopping')
          ORDER BY created_utc DESC LIMIT 1`
      )
      .get(guildId, ownerUserId);
    return row ? mapThreadVoiceSession(row) : null;
  }

  listActiveThreadVoiceSessions(): ThreadVoiceSession[] {
    return this.db
      .prepare<[], ThreadVoiceSessionRow>(
        `SELECT * FROM thread_voice_sessions
          WHERE status IN ('starting','ready','stopping')
          ORDER BY created_utc ASC`
      )
      .all()
      .map(mapThreadVoiceSession);
  }

  listThreadVoiceSessionsWithBufferedSegments(): ThreadVoiceSession[] {
    return this.db
      .prepare<[], ThreadVoiceSessionRow>(
        `SELECT DISTINCT tv.* FROM thread_voice_sessions tv
           JOIN thread_voice_segments segment ON segment.session_id = tv.id
          WHERE segment.state IN ('pending','batched')
            AND NOT EXISTS (
              SELECT 1 FROM voice_console_invalid_captures invalid
               WHERE invalid.capture_id = segment.capture_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM voice_console_quarantined_dispatches quarantine
               WHERE quarantine.dispatch_id = segment.dispatch_id
            )
          ORDER BY tv.created_utc ASC`
      )
      .all()
      .map(mapThreadVoiceSession);
  }

  updateThreadVoiceSession(
    id: string,
    patch: {
      status?: ThreadVoiceSessionStatus;
      noticeMessageId?: string | null;
      transmittedAudioMs?: number;
      updatedUtc?: string;
      endedUtc?: string | null;
      endReason?: string | null;
    }
  ): ThreadVoiceSession | null {
    const current = this.getThreadVoiceSession(id);
    if (!current) return null;
    const next: ThreadVoiceSession = {
      ...current,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.noticeMessageId !== undefined
        ? { noticeMessageId: patch.noticeMessageId }
        : {}),
      ...(patch.transmittedAudioMs !== undefined
        ? { transmittedAudioMs: Math.max(0, Math.trunc(patch.transmittedAudioMs)) }
        : {}),
      updatedUtc: patch.updatedUtc ?? new Date().toISOString(),
      ...(patch.endedUtc !== undefined ? { endedUtc: patch.endedUtc } : {}),
      ...(patch.endReason !== undefined ? { endReason: patch.endReason } : {}),
    };
    this.db
      .prepare(
        `UPDATE thread_voice_sessions SET
           status = @status,
           notice_message_id = @noticeMessageId,
           transmitted_audio_ms = @transmittedAudioMs,
           updated_utc = @updatedUtc,
           ended_utc = @endedUtc,
           end_reason = @endReason
         WHERE id = @id`
      )
      .run(next);
    return next;
  }

  addThreadVoiceTransmittedAudio(
    id: string,
    durationMs: number,
    updatedUtc = new Date().toISOString()
  ): number {
    const delta = Math.max(0, Math.trunc(durationMs));
    if (delta === 0) return this.getThreadVoiceSession(id)?.transmittedAudioMs ?? 0;
    this.db
      .prepare(
        `UPDATE thread_voice_sessions
            SET transmitted_audio_ms = transmitted_audio_ms + ?, updated_utc = ?
          WHERE id = ?`
      )
      .run(delta, updatedUtc, id);
    return this.getThreadVoiceSession(id)?.transmittedAudioMs ?? 0;
  }

  appendThreadVoiceSegment(
    segment: ThreadVoiceSegment
  ): { inserted: boolean; segment: ThreadVoiceSegment } {
    if (!Number.isInteger(segment.sequence) || segment.sequence < 1) {
      throw new Error("Thread Voice segment sequence must be a positive integer.");
    }
    if (segment.state !== "pending") {
      throw new Error("Finalized Thread Voice segments must be appended in pending state.");
    }
    if (!segment.transcript.trim()) {
      throw new Error("Finalized Thread Voice transcript must not be empty.");
    }
    const session = this.getThreadVoiceSession(segment.sessionId);
    if (!session) throw new Error(`Thread Voice session \`${segment.sessionId}\` does not exist.`);
    if (segment.authorId !== session.ownerUserId) {
      throw new Error("Thread Voice segment author does not match the durable session owner.");
    }
    try {
      this.db
        .prepare(
          `INSERT INTO thread_voice_segments
             (id, session_id, sequence, author_id, transcript, state, audio_ms,
              dispatch_id, captured_started_utc, captured_ended_utc,
              created_utc, updated_utc, error)
           VALUES
             (@id, @sessionId, @sequence, @authorId, @transcript, @state, @audioMs,
              @dispatchId, @capturedStartedUtc, @capturedEndedUtc,
              @createdUtc, @updatedUtc, @error)`
        )
        .run({
          ...segment,
          transcript: segment.transcript.trim(),
          audioMs: Math.max(0, Math.trunc(segment.audioMs)),
        });
      return {
        inserted: true,
        segment: {
          ...segment,
          transcript: segment.transcript.trim(),
          audioMs: Math.max(0, Math.trunc(segment.audioMs)),
        },
      };
    } catch (err) {
      const existing = this.getThreadVoiceSegmentBySequence(
        segment.sessionId,
        segment.sequence
      );
      if (existing && (err as { code?: string }).code?.startsWith("SQLITE_CONSTRAINT")) {
        return { inserted: false, segment: existing };
      }
      throw err;
    }
  }

  recordDroppedThreadVoiceSegment(
    segment: ThreadVoiceSegment
  ): { inserted: boolean; segment: ThreadVoiceSegment } {
    if (!Number.isInteger(segment.sequence) || segment.sequence < 1) {
      throw new Error("Thread Voice segment sequence must be a positive integer.");
    }
    if (segment.state !== "capture_dropped" && segment.state !== "transcribe_failed") {
      throw new Error("Dropped Thread Voice segment must use a failure state.");
    }
    const session = this.getThreadVoiceSession(segment.sessionId);
    if (!session) throw new Error(`Thread Voice session \`${segment.sessionId}\` does not exist.`);
    if (segment.authorId !== session.ownerUserId) {
      throw new Error("Thread Voice segment author does not match the durable session owner.");
    }
    const normalized: ThreadVoiceSegment = {
      ...segment,
      transcript: "",
      audioMs: Math.max(0, Math.trunc(segment.audioMs)),
      dispatchId: null,
    };
    try {
      this.db
        .prepare(
          `INSERT INTO thread_voice_segments
             (id, session_id, sequence, author_id, transcript, state, audio_ms,
              dispatch_id, captured_started_utc, captured_ended_utc,
              created_utc, updated_utc, error)
           VALUES
             (@id, @sessionId, @sequence, @authorId, @transcript, @state, @audioMs,
              @dispatchId, @capturedStartedUtc, @capturedEndedUtc,
              @createdUtc, @updatedUtc, @error)`
        )
        .run(normalized);
      return { inserted: true, segment: normalized };
    } catch (err) {
      const existing = this.getThreadVoiceSegmentBySequence(
        segment.sessionId,
        segment.sequence
      );
      if (existing && (err as { code?: string }).code?.startsWith("SQLITE_CONSTRAINT")) {
        return { inserted: false, segment: existing };
      }
      throw err;
    }
  }

  getThreadVoiceSegment(id: string): ThreadVoiceSegment | null {
    const row = this.db
      .prepare<[string], ThreadVoiceSegmentRow>(
        "SELECT * FROM thread_voice_segments WHERE id = ?"
      )
      .get(id);
    return row ? mapThreadVoiceSegment(row) : null;
  }

  getThreadVoiceSegmentBySequence(
    sessionId: string,
    sequence: number
  ): ThreadVoiceSegment | null {
    const row = this.db
      .prepare<[string, number], ThreadVoiceSegmentRow>(
        "SELECT * FROM thread_voice_segments WHERE session_id = ? AND sequence = ?"
      )
      .get(sessionId, sequence);
    return row ? mapThreadVoiceSegment(row) : null;
  }

  listThreadVoiceSegments(
    sessionId: string,
    states?: readonly ThreadVoiceSegmentState[]
  ): ThreadVoiceSegment[] {
    if (!states || states.length === 0) {
      return this.db
        .prepare<[string], ThreadVoiceSegmentRow>(
          "SELECT * FROM thread_voice_segments WHERE session_id = ? ORDER BY sequence ASC"
        )
        .all(sessionId)
        .map(mapThreadVoiceSegment);
    }
    const placeholders = states.map(() => "?").join(",");
    return this.db
      .prepare<unknown[], ThreadVoiceSegmentRow>(
        `SELECT * FROM thread_voice_segments
          WHERE session_id = ? AND state IN (${placeholders})
          ORDER BY sequence ASC`
      )
      .all(sessionId, ...states)
      .map(mapThreadVoiceSegment);
  }

  nextThreadVoiceSequence(sessionId: string): number {
    const row = this.db
      .prepare<[string], { next_sequence: number }>(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM thread_voice_segments WHERE session_id = ?"
      )
      .get(sessionId);
    return row?.next_sequence ?? 1;
  }

  getThreadVoicePendingStats(
    platform: string,
    channelRef: string
  ): ThreadVoicePendingStats {
    const row = this.db
      .prepare<
        [string, string],
        { segment_count: number; character_count: number; active_dispatch_id: string | null }
      >(
        `SELECT
           COUNT(*) AS segment_count,
           COALESCE(SUM(LENGTH(segment.transcript)), 0) AS character_count,
           MAX(CASE WHEN segment.state = 'batched' THEN segment.dispatch_id END) AS active_dispatch_id
         FROM thread_voice_segments segment
         JOIN thread_voice_sessions tv ON tv.id = segment.session_id
         WHERE tv.platform = ? AND tv.channel_ref = ?
           AND segment.state IN ('pending','batched')
           AND NOT EXISTS (
             SELECT 1 FROM voice_console_invalid_captures invalid
              WHERE invalid.capture_id = segment.capture_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM voice_console_quarantined_dispatches quarantine
              WHERE quarantine.dispatch_id = segment.dispatch_id
                AND quarantine.reconciled_utc IS NULL
           )`
      )
      .get(platform, channelRef);
    return {
      segmentCount: row?.segment_count ?? 0,
      characterCount: row?.character_count ?? 0,
      activeDispatchId: row?.active_dispatch_id ?? null,
    };
  }

  hasThreadVoiceBufferedSegments(platform: string, channelRef: string): boolean {
    return this.getThreadVoicePendingStats(platform, channelRef).segmentCount > 0;
  }

  /**
   * Atomic pending snapshot. Rows finalized after this transaction wait for the
   * next batch. A pre-existing batched dispatch for the same home thread blocks
   * another claim until recovery/enqueue resolves it.
   */
  claimPendingThreadVoiceBatch(
    sessionId: string,
    dispatchId = newThreadVoiceDispatchId(),
    claimedUtc = new Date().toISOString()
  ): ThreadVoiceBatch | null {
    const claim = this.db.transaction((): ThreadVoiceBatch | null => {
      const sessionRow = this.db
        .prepare<[string], ThreadVoiceSessionRow>(
          "SELECT * FROM thread_voice_sessions WHERE id = ?"
        )
        .get(sessionId);
      if (!sessionRow) return null;
      const existing = this.db
        .prepare<[string, string], { dispatch_id: string }>(
          `SELECT segment.dispatch_id FROM thread_voice_segments segment
             JOIN thread_voice_sessions tv ON tv.id = segment.session_id
            WHERE tv.platform = ? AND tv.channel_ref = ?
              AND segment.state = 'batched' AND segment.dispatch_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM voice_console_invalid_captures invalid
                 WHERE invalid.capture_id = segment.capture_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM voice_console_quarantined_dispatches quarantine
                 WHERE quarantine.dispatch_id = segment.dispatch_id
                   AND quarantine.reconciled_utc IS NULL
              )
            LIMIT 1`
        )
        .get(sessionRow.platform, sessionRow.channel_ref);
      if (existing) return null;
      if (
        this.db
          .prepare<[string], { found: number }>(
            `SELECT 1 AS found FROM voice_console_quarantined_dispatches quarantine
              JOIN thread_voice_segments segment ON segment.dispatch_id = quarantine.dispatch_id
             WHERE segment.session_id = ? AND quarantine.reconciled_utc IS NULL LIMIT 1`
          )
          .get(sessionId)
      ) return null;

      const pending = this.db
        .prepare<[string], ThreadVoiceSegmentRow>(
          `SELECT * FROM thread_voice_segments segment
            WHERE session_id = ? AND state = 'pending'
              AND NOT EXISTS (
                SELECT 1 FROM voice_console_invalid_captures invalid
                 WHERE invalid.capture_id = segment.capture_id
              )
            ORDER BY sequence ASC`
        )
        .all(sessionId);
      if (pending.length === 0) return null;
      this.db
        .prepare(
          `UPDATE thread_voice_segments
              SET state = 'batched', dispatch_id = ?, updated_utc = ?
            WHERE session_id = ? AND state = 'pending'
              AND NOT EXISTS (
                SELECT 1 FROM voice_console_invalid_captures invalid
                 WHERE invalid.capture_id = thread_voice_segments.capture_id
              )`
        )
        .run(dispatchId, claimedUtc, sessionId);
      const session = mapThreadVoiceSession(sessionRow);
      const segments = pending.map((row) =>
        mapThreadVoiceSegment({
          ...row,
          state: "batched",
          dispatch_id: dispatchId,
          updated_utc: claimedUtc,
        })
      );
      return {
        dispatchId,
        session,
        segments,
        prompt: composeThreadVoicePrompt(session.ownerUserId, segments),
      };
    });
    return claim();
  }

  getThreadVoiceBatch(dispatchId: string): ThreadVoiceBatch | null {
    const rows = this.db
      .prepare<[string], ThreadVoiceSegmentRow>(
        `SELECT * FROM thread_voice_segments segment
          WHERE dispatch_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM voice_console_invalid_captures invalid
               WHERE invalid.capture_id = segment.capture_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM voice_console_quarantined_dispatches quarantine
               WHERE quarantine.dispatch_id = segment.dispatch_id
            )
          ORDER BY sequence ASC`
      )
      .all(dispatchId);
    if (rows.length === 0) return null;
    const session = this.getThreadVoiceSession(rows[0]!.session_id);
    if (!session) return null;
    const segments = rows.map(mapThreadVoiceSegment);
    return {
      dispatchId,
      session,
      segments,
      prompt: composeThreadVoicePrompt(session.ownerUserId, segments),
    };
  }

  listRecoverableThreadVoiceBatches(): ThreadVoiceBatch[] {
    return this.listThreadVoiceBatchesByState("batched");
  }

  listThreadVoiceBatchesByState(
    state: "batched" | "dispatched"
  ): ThreadVoiceBatch[] {
    const ids = this.db
      .prepare<[string], { dispatch_id: string }>(
        `SELECT dispatch_id FROM thread_voice_segments segment
          WHERE state = ? AND dispatch_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM voice_console_invalid_captures invalid
               WHERE invalid.capture_id = segment.capture_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM voice_console_quarantined_dispatches quarantine
               WHERE quarantine.dispatch_id = segment.dispatch_id
            )
          GROUP BY dispatch_id ORDER BY MIN(created_utc) ASC`
      )
      .all(state);
    return ids
      .map(({ dispatch_id }) => this.getThreadVoiceBatch(dispatch_id))
      .filter((batch): batch is ThreadVoiceBatch => batch !== null);
  }

  markThreadVoiceBatchDispatched(
    dispatchId: string,
    updatedUtc = new Date().toISOString()
  ): number {
    return this.db
      .prepare(
        `UPDATE thread_voice_segments SET state = 'dispatched', updated_utc = ?, error = NULL
          WHERE dispatch_id = ? AND state = 'batched'
            AND NOT EXISTS (
              SELECT 1 FROM voice_console_quarantined_dispatches quarantine
               WHERE quarantine.dispatch_id = thread_voice_segments.dispatch_id
                 AND quarantine.reconciled_utc IS NULL
            )`
      )
      .run(updatedUtc, dispatchId).changes;
  }

  markThreadVoiceBatchError(
    dispatchId: string,
    error: string,
    updatedUtc = new Date().toISOString()
  ): number {
    return this.db
      .prepare(
        `UPDATE thread_voice_segments SET error = ?, updated_utc = ?
          WHERE dispatch_id = ? AND state = 'batched'
            AND NOT EXISTS (
              SELECT 1 FROM voice_console_quarantined_dispatches quarantine
               WHERE quarantine.dispatch_id = thread_voice_segments.dispatch_id
                 AND quarantine.reconciled_utc IS NULL
            )`
      )
      .run(error, updatedUtc, dispatchId).changes;
  }

  discardPendingThreadVoiceSegments(
    sessionId: string,
    updatedUtc = new Date().toISOString()
  ): number {
    return this.db
      .prepare(
        `UPDATE thread_voice_segments
            SET state = 'discarded', transcript = '', updated_utc = ?, error = NULL
          WHERE session_id = ? AND state = 'pending'`
      )
      .run(updatedUtc, sessionId).changes;
  }

  discardArtifactFreeThreadVoiceBatch(
    sessionId: string,
    dispatchId: string,
    updatedUtc = new Date().toISOString()
  ): number {
    return this.db
      .prepare(
        `UPDATE thread_voice_segments
            SET state = 'discarded', transcript = '', updated_utc = ?, error = NULL
          WHERE session_id = ? AND dispatch_id = ? AND state = 'batched'`
      )
      .run(updatedUtc, sessionId, dispatchId).changes;
  }

  claimIngestStudent(
    ingestId: string,
    studentId: string
  ): { ok: true } | { ok: false; reason: "already-claimed" } {
    try {
      this.db
        .prepare(
          "INSERT INTO ingest_endpoint_claims (ingest_id, student_id, created_utc) VALUES (?, ?, ?)"
        )
        .run(ingestId, studentId, new Date().toISOString());
      return { ok: true };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "SQLITE_CONSTRAINT_PRIMARYKEY" || code === "SQLITE_CONSTRAINT_UNIQUE") {
        return { ok: false, reason: "already-claimed" };
      }
      throw err;
    }
  }

  insertChoiceResult(r: ChoiceResultRow): void {
    this.db
      .prepare(
        `INSERT INTO choice_results
           (dispatch_id, choice_id, status, body_json, error, schema_json, created_utc, finished_utc)
         VALUES
           (@dispatchId, @choiceId, @status, @bodyJson, @error, @schemaJson, @createdUtc, @finishedUtc)`
      )
      .run({
        dispatchId: r.dispatchId,
        choiceId: r.choiceId,
        status: r.status,
        bodyJson: r.body == null ? null : JSON.stringify(r.body),
        error: r.error,
        schemaJson: r.schema == null ? null : JSON.stringify(r.schema),
        createdUtc: r.createdUtc,
        finishedUtc: r.finishedUtc,
      });
  }

  getChoiceResult(dispatchId: string): ChoiceResultRow | null {
    const row = this.db
      .prepare<[string], ChoiceResultDbRow>("SELECT * FROM choice_results WHERE dispatch_id = ?")
      .get(dispatchId);
    return row ? mapChoiceResult(row) : null;
  }

  finishChoiceResult(
    dispatchId: string,
    status: ChoiceResultStatus,
    body: unknown | null,
    error: string | null
  ): void {
    const now = new Date().toISOString();
    const existing = this.getChoiceResult(dispatchId);
    if (!existing) return;
    if (existing.status === "ok") return;
    this.db
      .prepare(
        `UPDATE choice_results
            SET status = ?, body_json = ?, error = ?, finished_utc = ?
          WHERE dispatch_id = ? AND status = 'pending'`
      )
      .run(status, body == null ? null : JSON.stringify(body), error, now, dispatchId);
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
  acp_session_id  TEXT,
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
  acp_session_id: string | null;
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
  acpSessionId: r.acp_session_id ?? null,
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

const CHOICE_CARDS_SCHEMA = `
CREATE TABLE IF NOT EXISTS choice_cards (
  id                   TEXT PRIMARY KEY,
  platform             TEXT NOT NULL,
  channel_ref          TEXT NOT NULL,
  parent_ref           TEXT,
  message_id           TEXT,
  title                TEXT NOT NULL,
  body                 TEXT,
  max_clicks           INTEGER NOT NULL,
  target_user_id       TEXT,
  default_target_json  TEXT NOT NULL,
  options_json         TEXT NOT NULL,
  click_count          INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'open',
  last_clicker_id      TEXT,
  last_clicker_name    TEXT,
  last_option_index    INTEGER,
  created_by           TEXT NOT NULL,
  created_utc          TEXT NOT NULL,
  ingest_token_hash    TEXT,
  ingest_option_index  INTEGER,
  result_schema_json   TEXT,
  ingest_wrapper       TEXT,
  ingest_cors_json     TEXT,
  select_min           INTEGER,
  select_max           INTEGER,
  last_option_indices_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_choice_cards_channel ON choice_cards(platform, channel_ref);
CREATE INDEX IF NOT EXISTS idx_choice_cards_status ON choice_cards(status);
CREATE TABLE IF NOT EXISTS choice_clicks (
  choice_id    TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  option_index INTEGER NOT NULL,
  created_utc  TEXT NOT NULL,
  delivery_id  TEXT,
  PRIMARY KEY (choice_id, user_id)
);
`;

const CHOICE_RESULTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS choice_results (
  dispatch_id   TEXT PRIMARY KEY,
  choice_id     TEXT NOT NULL,
  status        TEXT NOT NULL,
  body_json     TEXT,
  error         TEXT,
  schema_json   TEXT,
  created_utc   TEXT NOT NULL,
  finished_utc  TEXT
);
CREATE INDEX IF NOT EXISTS idx_choice_results_choice ON choice_results(choice_id);
`;

const INGEST_ENDPOINTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS ingest_endpoints (
  id                     TEXT PRIMARY KEY,
  token_hash             TEXT NOT NULL UNIQUE,
  name                   TEXT NOT NULL,
  cwd                    TEXT,
  agent_id               TEXT,
  model                  TEXT,
  effort                 TEXT,
  wrapper                TEXT,
  result_schema_json     TEXT,
  cors_json              TEXT,
  unique_student         INTEGER NOT NULL DEFAULT 0,
  notify_thread          TEXT,
  preset                 TEXT,
  status                 TEXT NOT NULL DEFAULT 'open',
  created_by             TEXT NOT NULL,
  created_utc            TEXT NOT NULL,
  authoring_channel_ref  TEXT NOT NULL,
  authoring_parent_ref   TEXT,
  platform               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ingest_endpoints_channel ON ingest_endpoints(platform, authoring_channel_ref, status);
CREATE TABLE IF NOT EXISTS ingest_endpoint_claims (
  ingest_id    TEXT NOT NULL,
  student_id   TEXT NOT NULL,
  created_utc  TEXT NOT NULL,
  PRIMARY KEY (ingest_id, student_id)
);
`;

const LIVE_HELP_SCHEMA = `
CREATE TABLE IF NOT EXISTS live_help_sessions (
  id                     TEXT PRIMARY KEY,
  voice_channel_id       TEXT NOT NULL,
  guild_id               TEXT,
  channel_name           TEXT,
  system                 TEXT NOT NULL,
  history_summary        TEXT,
  notify_thread          TEXT,
  preset                 TEXT,
  authoring_channel_ref  TEXT NOT NULL,
  authoring_parent_ref   TEXT,
  platform               TEXT NOT NULL,
  status                 TEXT NOT NULL,
  created_by             TEXT NOT NULL,
  created_utc            TEXT NOT NULL,
  ended_utc              TEXT,
  end_reason             TEXT
);
CREATE INDEX IF NOT EXISTS idx_live_help_status ON live_help_sessions(status);
CREATE INDEX IF NOT EXISTS idx_live_help_vc ON live_help_sessions(voice_channel_id, status);
CREATE INDEX IF NOT EXISTS idx_live_help_author ON live_help_sessions(platform, authoring_channel_ref, status);
`;

const THREAD_VOICE_SCHEMA = `
CREATE TABLE IF NOT EXISTS thread_voice_sessions (
  id                    TEXT PRIMARY KEY,
  platform              TEXT NOT NULL,
  channel_ref           TEXT NOT NULL,
  parent_ref            TEXT,
  guild_id              TEXT NOT NULL,
  voice_channel_id      TEXT NOT NULL,
  owner_user_id         TEXT NOT NULL,
  owner_name            TEXT NOT NULL,
  status                TEXT NOT NULL,
  notice_message_id     TEXT,
  transmitted_audio_ms  INTEGER NOT NULL DEFAULT 0,
  created_utc           TEXT NOT NULL,
  updated_utc           TEXT NOT NULL,
  ended_utc             TEXT,
  end_reason            TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_voice_active_thread
  ON thread_voice_sessions(platform, channel_ref)
  WHERE status IN ('starting','ready','stopping','adding','active','removing');
CREATE INDEX IF NOT EXISTS idx_thread_voice_active_vc
  ON thread_voice_sessions(voice_channel_id, status);
CREATE INDEX IF NOT EXISTS idx_thread_voice_active_owner
  ON thread_voice_sessions(guild_id, owner_user_id, status);

CREATE TABLE IF NOT EXISTS thread_voice_segments (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL,
  sequence              INTEGER NOT NULL,
  author_id             TEXT NOT NULL,
  transcript            TEXT NOT NULL,
  state                 TEXT NOT NULL,
  audio_ms              INTEGER NOT NULL DEFAULT 0,
  dispatch_id           TEXT,
  captured_started_utc  TEXT NOT NULL,
  captured_ended_utc    TEXT NOT NULL,
  created_utc           TEXT NOT NULL,
  updated_utc           TEXT NOT NULL,
  error                 TEXT,
  UNIQUE(session_id, sequence),
  FOREIGN KEY(session_id) REFERENCES thread_voice_sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_thread_voice_segments_pending
  ON thread_voice_segments(session_id, state, sequence);
CREATE INDEX IF NOT EXISTS idx_thread_voice_segments_dispatch
  ON thread_voice_segments(dispatch_id);
`;

const VOICE_CONSOLE_SCHEMA = `
CREATE TABLE IF NOT EXISTS voice_console_sessions (
  id                       TEXT PRIMARY KEY,
  platform                 TEXT NOT NULL,
  guild_id                 TEXT NOT NULL,
  voice_channel_id         TEXT NOT NULL,
  owner_user_id            TEXT NOT NULL,
  owner_name               TEXT NOT NULL,
  status                   TEXT NOT NULL,
  card_channel_id          TEXT NOT NULL,
  card_message_id          TEXT,
  card_page                INTEGER NOT NULL DEFAULT 0,
  revision                 INTEGER NOT NULL DEFAULT 1,
  fanout_armed             INTEGER NOT NULL DEFAULT 0,
  forwarded_audio_bytes    INTEGER NOT NULL DEFAULT 0,
  forwarded_audio_ms       REAL NOT NULL DEFAULT 0,
  utterance_count          INTEGER NOT NULL DEFAULT 0,
  live_final_count         INTEGER NOT NULL DEFAULT 0,
  unary_fallback_count     INTEGER NOT NULL DEFAULT 0,
  dropped_count            INTEGER NOT NULL DEFAULT 0,
  stt_failure_count        INTEGER NOT NULL DEFAULT 0,
  created_utc              TEXT NOT NULL,
  updated_utc              TEXT NOT NULL,
  ended_utc                TEXT,
  end_reason               TEXT,
  CHECK(card_channel_id = voice_channel_id),
  CHECK(revision >= 1),
  CHECK(card_page >= 0)
);

CREATE TABLE IF NOT EXISTS voice_console_input_targets (
  console_id    TEXT NOT NULL,
  binding_id    TEXT NOT NULL,
  ordinal       INTEGER NOT NULL,
  selected_utc  TEXT NOT NULL,
  PRIMARY KEY (console_id, binding_id),
  UNIQUE(console_id, ordinal),
  FOREIGN KEY(console_id) REFERENCES voice_console_sessions(id),
  FOREIGN KEY(binding_id) REFERENCES thread_voice_sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_voice_console_targets_order
  ON voice_console_input_targets(console_id, ordinal);

CREATE TABLE IF NOT EXISTS voice_console_mutations (
  console_id    TEXT NOT NULL,
  mutation_id   TEXT NOT NULL,
  action        TEXT NOT NULL DEFAULT 'legacy',
  input_fingerprint TEXT,
  revision      INTEGER NOT NULL,
  created_utc   TEXT NOT NULL,
  PRIMARY KEY (console_id, mutation_id)
);

CREATE TABLE IF NOT EXISTS voice_console_add_interactions (
  console_id           TEXT NOT NULL,
  interaction_id       TEXT NOT NULL,
  binding_id           TEXT NOT NULL,
  input_fingerprint    TEXT NOT NULL,
  status               TEXT NOT NULL,
  failure_code         TEXT,
  failure_message      TEXT,
  failure_as_exception INTEGER NOT NULL DEFAULT 0,
  created_utc          TEXT NOT NULL,
  updated_utc          TEXT NOT NULL,
  PRIMARY KEY (console_id, interaction_id),
  CHECK(status IN ('pending','succeeded','failed')),
  CHECK(failure_as_exception IN (0,1))
);

CREATE TABLE IF NOT EXISTS voice_console_capture_reservations (
  capture_id            TEXT PRIMARY KEY,
  console_id            TEXT NOT NULL,
  speaker_id            TEXT NOT NULL,
  speaker_name          TEXT NOT NULL,
  captured_started_utc  TEXT NOT NULL,
  fanout_group_id       TEXT,
  target_fingerprint    TEXT NOT NULL,
  identity_version      INTEGER NOT NULL DEFAULT 2,
  identity_valid        INTEGER NOT NULL DEFAULT 1,
  invalid_reason        TEXT,
  created_utc           TEXT NOT NULL,
  FOREIGN KEY(console_id) REFERENCES voice_console_sessions(id),
  CHECK(identity_valid IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_voice_console_capture_reservations_console
  ON voice_console_capture_reservations(console_id, created_utc);

CREATE TABLE IF NOT EXISTS voice_console_capture_targets (
  capture_id      TEXT NOT NULL,
  target_ordinal  INTEGER NOT NULL,
  binding_id      TEXT NOT NULL,
  sequence        INTEGER NOT NULL,
  PRIMARY KEY(capture_id, target_ordinal),
  UNIQUE(capture_id, binding_id),
  FOREIGN KEY(capture_id) REFERENCES voice_console_capture_reservations(capture_id),
  CHECK(target_ordinal >= 0),
  CHECK(sequence >= 1)
);

CREATE TABLE IF NOT EXISTS voice_console_invalid_captures (
  capture_id     TEXT PRIMARY KEY,
  reason         TEXT NOT NULL,
  recovered_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS voice_console_quarantined_dispatches (
  dispatch_id      TEXT NOT NULL,
  capture_id       TEXT NOT NULL,
  binding_id       TEXT NOT NULL,
  reason           TEXT NOT NULL,
  artifact_state   TEXT NOT NULL DEFAULT 'unknown',
  quarantined_utc  TEXT NOT NULL,
  reconciled_utc   TEXT,
  PRIMARY KEY(dispatch_id, capture_id),
  CHECK(artifact_state IN ('unknown','missing','pending','running','done'))
);
CREATE INDEX IF NOT EXISTS idx_voice_console_quarantined_dispatches_open
  ON voice_console_quarantined_dispatches(reconciled_utc, dispatch_id);

CREATE TABLE IF NOT EXISTS voice_console_capture_terminals (
  capture_id            TEXT PRIMARY KEY,
  console_id            TEXT NOT NULL,
  speaker_id            TEXT NOT NULL,
  captured_started_utc  TEXT NOT NULL,
  target_fingerprint    TEXT NOT NULL,
  outcome               TEXT NOT NULL,
  reason                TEXT,
  result_source         TEXT,
  audio_ms              INTEGER NOT NULL,
  forwarded_audio_ms    REAL NOT NULL,
  captured_ended_utc    TEXT NOT NULL,
  created_utc           TEXT NOT NULL,
  FOREIGN KEY(console_id) REFERENCES voice_console_sessions(id),
  CHECK(outcome IN ('committed','dropped','failed')),
  CHECK(result_source IS NULL OR result_source IN ('live','unary')),
  CHECK(audio_ms >= 0),
  CHECK(forwarded_audio_ms >= 0)
);
CREATE INDEX IF NOT EXISTS idx_voice_console_capture_terminals_console
  ON voice_console_capture_terminals(console_id, created_utc);
`;

interface VoiceConsoleRow {
  id: string;
  platform: string;
  guild_id: string;
  voice_channel_id: string;
  owner_user_id: string;
  owner_name: string;
  status: string;
  card_channel_id: string;
  card_message_id: string | null;
  card_page: number;
  revision: number;
  fanout_armed: number;
  forwarded_audio_bytes: number;
  forwarded_audio_ms: number;
  utterance_count: number;
  live_final_count: number;
  unary_fallback_count: number;
  dropped_count: number;
  stt_failure_count: number;
  created_utc: string;
  updated_utc: string;
  ended_utc: string | null;
  end_reason: string | null;
}

interface VoiceConsoleAddInteractionRow {
  console_id: string;
  interaction_id: string;
  binding_id: string;
  input_fingerprint: string;
  status: string;
  failure_code: string | null;
  failure_message: string | null;
  failure_as_exception: number;
  created_utc: string;
  updated_utc: string;
}

interface VoiceConsoleCaptureTerminalRow {
  capture_id: string;
  console_id: string;
  speaker_id: string | null;
  captured_started_utc: string | null;
  target_fingerprint: string | null;
  outcome: string;
  reason: string | null;
  result_source: string | null;
  audio_ms: number;
  forwarded_audio_ms: number | null;
  captured_ended_utc: string;
  created_utc: string;
}

interface VoiceConsoleCaptureReservationRow {
  capture_id: string;
  console_id: string;
  speaker_id: string;
  speaker_name: string;
  captured_started_utc: string;
  fanout_group_id: string | null;
  target_fingerprint: string;
  identity_version: number;
  identity_valid: number;
  invalid_reason: string | null;
  created_utc: string;
}

interface VoiceConsoleCaptureTargetRow {
  capture_id: string;
  target_ordinal: number;
  binding_id: string;
  sequence: number;
}

interface VoiceConsoleQuarantinedDispatchRow {
  dispatch_id: string;
  capture_id: string;
  binding_id: string;
  reason: string;
  artifact_state: string;
  quarantined_utc: string;
  reconciled_utc: string | null;
}

const mapVoiceConsoleCaptureTerminal = (
  row: VoiceConsoleCaptureTerminalRow
): VoiceConsoleCaptureTerminal => ({
  captureId: row.capture_id,
  consoleId: row.console_id,
  speakerId: row.speaker_id,
  capturedStartedUtc: row.captured_started_utc,
  targetFingerprint: row.target_fingerprint,
  outcome: row.outcome as VoiceConsoleCaptureTerminalOutcome,
  reason: row.reason,
  resultSource: row.result_source as VoiceConsoleCaptureTerminal["resultSource"],
  audioMs: row.audio_ms,
  forwardedAudioMs: row.forwarded_audio_ms,
  capturedEndedUtc: row.captured_ended_utc,
  createdUtc: row.created_utc,
});

const mapVoiceConsoleAddInteraction = (
  row: VoiceConsoleAddInteractionRow
): VoiceConsoleAddInteraction => ({
  consoleId: row.console_id,
  interactionId: row.interaction_id,
  bindingId: row.binding_id,
  inputFingerprint: row.input_fingerprint,
  status: row.status as VoiceConsoleAddInteraction["status"],
  failureCode: row.failure_code as VoiceConsoleAddInteraction["failureCode"],
  failureMessage: row.failure_message,
  failureAsException: row.failure_as_exception === 1,
  createdUtc: row.created_utc,
  updatedUtc: row.updated_utc,
});

const mapVoiceConsole = (row: VoiceConsoleRow): VoiceConsoleSession => ({
  id: row.id,
  platform: row.platform,
  guildId: row.guild_id,
  voiceChannelId: row.voice_channel_id,
  ownerUserId: row.owner_user_id,
  ownerName: row.owner_name,
  status: row.status as VoiceConsoleStatus,
  cardChannelId: row.card_channel_id,
  cardMessageId: row.card_message_id,
  cardPage: row.card_page,
  revision: row.revision,
  fanoutArmed: row.fanout_armed !== 0,
  forwardedAudioBytes: row.forwarded_audio_bytes,
  forwardedAudioMs: row.forwarded_audio_ms,
  utteranceCount: row.utterance_count,
  liveFinalCount: row.live_final_count,
  unaryFallbackCount: row.unary_fallback_count,
  droppedCount: row.dropped_count,
  sttFailureCount: row.stt_failure_count,
  createdUtc: row.created_utc,
  updatedUtc: row.updated_utc,
  endedUtc: row.ended_utc,
  endReason: row.end_reason,
});

interface VoiceConsoleInputTargetRow {
  console_id: string;
  binding_id: string;
  ordinal: number;
  selected_utc: string;
}

const mapVoiceConsoleInputTarget = (row: VoiceConsoleInputTargetRow): VoiceConsoleInputTarget => ({
  consoleId: row.console_id,
  bindingId: row.binding_id,
  ordinal: row.ordinal,
  selectedUtc: row.selected_utc,
});

interface ThreadVoiceSessionRow {
  id: string;
  platform: string;
  channel_ref: string;
  parent_ref: string | null;
  guild_id: string;
  voice_channel_id: string;
  owner_user_id: string;
  owner_name: string;
  status: string;
  notice_message_id: string | null;
  transmitted_audio_ms: number;
  created_utc: string;
  updated_utc: string;
  ended_utc: string | null;
  end_reason: string | null;
}

const mapThreadVoiceSession = (row: ThreadVoiceSessionRow): ThreadVoiceSession => ({
  id: row.id,
  platform: row.platform,
  channelRef: row.channel_ref,
  parentRef: row.parent_ref,
  guildId: row.guild_id,
  voiceChannelId: row.voice_channel_id,
  ownerUserId: row.owner_user_id,
  ownerName: row.owner_name,
  status: row.status as ThreadVoiceSessionStatus,
  noticeMessageId: row.notice_message_id,
  transmittedAudioMs: row.transmitted_audio_ms,
  createdUtc: row.created_utc,
  updatedUtc: row.updated_utc,
  endedUtc: row.ended_utc,
  endReason: row.end_reason,
});

interface VoiceConsoleBindingRow extends ThreadVoiceSessionRow {
  console_id: string;
  alias: string;
  alias_normalized: string;
  tts_voice: string;
  tts_pace: string | null;
  tts_style: string | null;
  profile_updated_utc: string;
  output_enabled: number;
  output_generation: number;
}

const mapVoiceConsoleBinding = (row: VoiceConsoleBindingRow): ThreadVoiceBinding => ({
  id: row.id,
  consoleId: row.console_id,
  platform: row.platform,
  channelRef: row.channel_ref,
  parentRef: row.parent_ref,
  guildId: row.guild_id,
  voiceChannelId: row.voice_channel_id,
  ownerUserId: row.owner_user_id,
  ownerName: row.owner_name,
  status: row.status as VoiceConsoleBindingStatus,
  noticeMessageId: row.notice_message_id,
  alias: row.alias,
  aliasNormalized: row.alias_normalized,
  ttsVoice: row.tts_voice,
  ttsPace: row.tts_pace,
  ttsStyle: row.tts_style,
  profileUpdatedUtc: row.profile_updated_utc,
  outputEnabled: row.output_enabled !== 0,
  outputGeneration: row.output_generation,
  createdUtc: row.created_utc,
  updatedUtc: row.updated_utc,
  endedUtc: row.ended_utc,
  endReason: row.end_reason,
});

interface ThreadVoiceSegmentRow {
  id: string;
  session_id: string;
  sequence: number;
  author_id: string;
  transcript: string;
  state: string;
  audio_ms: number;
  dispatch_id: string | null;
  captured_started_utc: string;
  captured_ended_utc: string;
  created_utc: string;
  updated_utc: string;
  error: string | null;
}

const mapThreadVoiceSegment = (row: ThreadVoiceSegmentRow): ThreadVoiceSegment => ({
  id: row.id,
  sessionId: row.session_id,
  sequence: row.sequence,
  authorId: row.author_id,
  transcript: row.transcript,
  state: row.state as ThreadVoiceSegmentState,
  audioMs: row.audio_ms,
  dispatchId: row.dispatch_id,
  capturedStartedUtc: row.captured_started_utc,
  capturedEndedUtc: row.captured_ended_utc,
  createdUtc: row.created_utc,
  updatedUtc: row.updated_utc,
  error: row.error,
});

interface VoiceConsoleSegmentRow extends ThreadVoiceSegmentRow {
  capture_id: string | null;
  fanout_group_id: string | null;
  author_name: string | null;
}

const mapVoiceConsoleSegment = (row: VoiceConsoleSegmentRow): VoiceConsoleSegment => ({
  id: row.id,
  bindingId: row.session_id,
  sequence: row.sequence,
  captureId: row.capture_id,
  fanoutGroupId: row.fanout_group_id,
  authorId: row.author_id,
  authorName: row.author_name ?? "",
  transcript: row.transcript,
  state: row.state as ThreadVoiceSegmentState,
  audioMs: row.audio_ms,
  dispatchId: row.dispatch_id,
  capturedStartedUtc: row.captured_started_utc,
  capturedEndedUtc: row.captured_ended_utc,
  createdUtc: row.created_utc,
  updatedUtc: row.updated_utc,
  error: row.error,
});

function validateVoiceConsoleAlias(value: string): string {
  const alias = value
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/@/g, "＠")
    .trim()
    .replace(/\s+/g, " ");
  const length = [...alias].length;
  if (length < 1 || length > 32) {
    throw new Error("Voice Console alias must contain 1 to 32 visible characters.");
  }
  return alias;
}

function normalizeBinding(binding: ThreadVoiceBinding): ThreadVoiceBinding {
  assertVoiceConsoleAuthorityId(binding.id, "Voice Console binding id");
  assertVoiceConsoleAuthorityId(binding.consoleId, "Voice Console id");
  const alias = validateVoiceConsoleAlias(binding.alias);
  if (!binding.ttsVoice.trim()) throw new Error("Voice Console TTS voice must not be empty.");
  return {
    ...binding,
    alias,
    aliasNormalized: normalizeVoiceConsoleAlias(alias),
    ttsVoice: binding.ttsVoice.trim(),
    outputGeneration: Math.max(0, Math.trunc(binding.outputGeneration)),
  };
}

function isActiveConsole(console: VoiceConsoleSession): boolean {
  return console.status === "starting" || console.status === "ready" || console.status === "stopping";
}

function mutationFailure(
  reason: VoiceConsoleMutationFailure,
  error: string
): Extract<VoiceConsoleMutationOutcome, { ok: false }> {
  return { ok: false, reason, error };
}

function staleConsoleFailure(): Extract<VoiceConsoleMutationOutcome, { ok: false }> {
  return mutationFailure("stale-revision", "Console changed; refresh.");
}

function interactionCollisionFailure(): Extract<VoiceConsoleMutationOutcome, { ok: false }> {
  return mutationFailure(
    "interaction-collision",
    "Interaction ID is already used by a different Voice Console action or input."
  );
}

function voiceConsoleAddFingerprint(input: AddVoiceConsoleBindingInput): string {
  const binding = input.binding;
  return JSON.stringify({
    action: "add-binding",
    expectedRevision: input.expectedRevision,
    claim: input.claim !== false,
    binding: {
      id: binding.id,
      consoleId: binding.consoleId,
      platform: binding.platform,
      channelRef: binding.channelRef,
      parentRef: binding.parentRef,
      guildId: binding.guildId,
      voiceChannelId: binding.voiceChannelId,
      ownerUserId: binding.ownerUserId,
      ownerName: binding.ownerName,
      alias: binding.alias,
      ttsVoice: binding.ttsVoice,
      ttsPace: binding.ttsPace,
      ttsStyle: binding.ttsStyle,
      outputEnabled: binding.outputEnabled,
    },
  });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface LiveHelpRow {
  id: string;
  voice_channel_id: string;
  guild_id: string | null;
  channel_name: string | null;
  system: string;
  history_summary: string | null;
  notify_thread: string | null;
  preset: string | null;
  authoring_channel_ref: string;
  authoring_parent_ref: string | null;
  platform: string;
  status: string;
  created_by: string;
  created_utc: string;
  ended_utc: string | null;
  end_reason: string | null;
}

const mapLiveHelp = (r: LiveHelpRow): LiveHelpSession => ({
  id: r.id,
  voiceChannelId: r.voice_channel_id,
  guildId: r.guild_id,
  channelName: r.channel_name,
  system: r.system,
  historySummary: r.history_summary,
  notifyThread: r.notify_thread,
  preset: r.preset,
  authoringChannelRef: r.authoring_channel_ref,
  authoringParentRef: r.authoring_parent_ref,
  platform: r.platform,
  status: r.status as LiveHelpSession["status"],
  createdBy: r.created_by,
  createdUtc: r.created_utc,
  endedUtc: r.ended_utc,
  endReason: r.end_reason,
});

interface ChoiceRow {
  id: string;
  platform: string;
  channel_ref: string;
  parent_ref: string | null;
  message_id: string | null;
  title: string;
  body: string | null;
  max_clicks: number;
  target_user_id: string | null;
  default_target_json: string;
  options_json: string;
  click_count: number;
  status: string;
  last_clicker_id: string | null;
  last_clicker_name: string | null;
  last_option_index?: number | null;
  created_by: string;
  created_utc: string;
  ingest_token_hash?: string | null;
  ingest_option_index?: number | null;
  result_schema_json?: string | null;
  ingest_wrapper?: string | null;
  ingest_cors_json?: string | null;
  select_min?: number | null;
  select_max?: number | null;
  last_option_indices_json?: string | null;
}

interface ChoiceResultDbRow {
  dispatch_id: string;
  choice_id: string;
  status: string;
  body_json: string | null;
  error: string | null;
  schema_json: string | null;
  created_utc: string;
  finished_utc: string | null;
}

const mapChoice = (r: ChoiceRow): ChoiceCard => ({
  id: r.id,
  platform: r.platform,
  channelRef: r.channel_ref,
  parentRef: r.parent_ref,
  messageId: r.message_id,
  title: r.title,
  body: r.body,
  maxClicks: r.max_clicks,
  targetUserId: r.target_user_id,
  defaultTarget: parseJsonSafe<ChoiceTarget>(r.default_target_json, { type: "live" }),
  options: parseJsonSafe<ChoiceOption[]>(r.options_json, []),
  clickCount: r.click_count,
  status: r.status as ChoiceCardStatus,
  lastClickerId: r.last_clicker_id,
  lastClickerName: r.last_clicker_name,
  lastOptionIndex: r.last_option_index ?? null,
  lastOptionIndices: r.last_option_indices_json
    ? parseJsonSafe<number[]>(r.last_option_indices_json, [])
    : null,
  select:
    r.select_min != null && r.select_max != null
      ? { min: r.select_min, max: r.select_max }
      : undefined,
  createdBy: r.created_by,
  createdUtc: r.created_utc,
  ingestTokenHash: r.ingest_token_hash ?? null,
  ingestOptionIndex: r.ingest_option_index ?? null,
  resultSchema: r.result_schema_json ? parseJsonSafe<unknown>(r.result_schema_json, null) : null,
  ingestWrapper: r.ingest_wrapper ?? null,
  ingestCors: r.ingest_cors_json ? parseJsonSafe<string[]>(r.ingest_cors_json, []) : null,
});

const mapChoiceResult = (r: ChoiceResultDbRow): ChoiceResultRow => ({
  dispatchId: r.dispatch_id,
  choiceId: r.choice_id,
  status: r.status as ChoiceResultStatus,
  body: r.body_json ? parseJsonSafe<unknown>(r.body_json, null) : null,
  error: r.error,
  schema: r.schema_json ? parseJsonSafe<unknown>(r.schema_json, null) : null,
  createdUtc: r.created_utc,
  finishedUtc: r.finished_utc,
});

interface IngestEndpointRow {
  id: string;
  token_hash: string;
  name: string;
  cwd: string | null;
  agent_id: string | null;
  model: string | null;
  effort: string | null;
  wrapper: string | null;
  result_schema_json: string | null;
  cors_json: string | null;
  unique_student: number;
  notify_thread: string | null;
  preset: string | null;
  status: string;
  created_by: string;
  created_utc: string;
  authoring_channel_ref: string;
  authoring_parent_ref: string | null;
  platform: string;
}

const mapIngestEndpoint = (r: IngestEndpointRow): IngestEndpoint => ({
  id: r.id,
  tokenHash: r.token_hash,
  name: r.name,
  cwd: r.cwd,
  agentId: r.agent_id,
  model: r.model,
  effort: r.effort,
  wrapper: r.wrapper,
  resultSchema: r.result_schema_json ? parseJsonSafe<unknown>(r.result_schema_json, null) : null,
  corsOrigins: r.cors_json ? parseJsonSafe<string[]>(r.cors_json, []) : null,
  uniqueStudent: r.unique_student === 1,
  notifyThread: r.notify_thread,
  preset: r.preset ?? null,
  status: r.status as IngestEndpointStatus,
  createdBy: r.created_by,
  createdUtc: r.created_utc,
  authoringChannelRef: r.authoring_channel_ref,
  authoringParentRef: r.authoring_parent_ref,
  platform: r.platform,
});

function parseJsonSafe<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

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

// --- parked prompts schema + row mapping (#88) ------------------------------

const PARKED_PROMPTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS parked_prompts (
  id                 TEXT PRIMARY KEY,
  platform           TEXT NOT NULL,
  channel_ref        TEXT NOT NULL,
  parent_ref         TEXT,
  location           TEXT NOT NULL,
  kind               TEXT NOT NULL DEFAULT 'bridge_offline',
  prompt             TEXT NOT NULL,
  author_id          TEXT NOT NULL,
  author_name        TEXT,
  notice_message_id  TEXT,
  attachments_json   TEXT NOT NULL DEFAULT '[]',
  created_utc        TEXT NOT NULL,
  UNIQUE (platform, channel_ref)
);
CREATE INDEX IF NOT EXISTS idx_parked_location ON parked_prompts(location);
`;

interface ParkedRow {
  id: string;
  platform: string;
  channel_ref: string;
  parent_ref: string | null;
  location: string;
  kind: string;
  prompt: string;
  author_id: string;
  author_name: string | null;
  notice_message_id: string | null;
  attachments_json: string;
  created_utc: string;
}

function parseParkedAttachments(raw: string): ParkedAttachment[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (a): a is ParkedAttachment =>
        !!a &&
        typeof a === "object" &&
        typeof (a as ParkedAttachment).filename === "string" &&
        typeof (a as ParkedAttachment).mime === "string" &&
        typeof (a as ParkedAttachment).size === "number"
    );
  } catch {
    return [];
  }
}

const mapParked = (r: ParkedRow): ParkedPrompt => ({
  id: r.id,
  platform: r.platform,
  channelRef: r.channel_ref,
  parentRef: r.parent_ref,
  location: r.location,
  kind: r.kind === "user_queue" ? "user_queue" : "bridge_offline",
  prompt: r.prompt,
  authorId: r.author_id,
  authorName: r.author_name,
  noticeMessageId: r.notice_message_id,
  attachments: parseParkedAttachments(r.attachments_json),
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
  acpSessionId: "acp_session_id",
};

function truncatePreview(text: string | null): string | null {
  if (text === null) return null;
  return text.length <= PROMPT_PREVIEW_MAX
    ? text
    : text.slice(0, PROMPT_PREVIEW_MAX);
}

function requireNonNegativeFiniteNumber(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Voice Console ${field} must be a non-negative finite number.`);
  }
  return value;
}

function requirePositiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Voice Console ${field} must be a positive safe integer.`);
  }
  return value;
}

function orderedCaptureTargets(
  targets: readonly { bindingId: string; sequence: number }[]
): Array<{ bindingId: string; sequence: number }> {
  const ordered = targets.map((target) => {
    assertVoiceConsoleAuthorityId(target.bindingId, "Voice Console capture binding id");
    return {
      bindingId: target.bindingId,
      sequence: requirePositiveSafeInteger(target.sequence, "capture target sequence"),
    };
  });
  const bindingIds = new Set(ordered.map((target) => target.bindingId));
  if (bindingIds.size !== ordered.length) {
    throw new Error("Voice Console capture target identity is invalid.");
  }
  return ordered;
}

function captureTargetKey(target: { bindingId: string; sequence: number }): string {
  return JSON.stringify([target.bindingId, target.sequence]);
}

function captureTargetFingerprint(
  targets: readonly { bindingId: string; sequence: number }[]
): string {
  const ordered = orderedCaptureTargets(targets).map((target, ordinal) => ({
    ordinal,
    bindingId: target.bindingId,
    sequence: target.sequence,
  }));
  return createHash("sha256")
    .update(JSON.stringify(ordered))
    .digest("hex");
}

function sanitizeVoiceConsoleAuditReason(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500) || "invalid legacy capture identity";
}

function voiceConsoleMutationFingerprint(input: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

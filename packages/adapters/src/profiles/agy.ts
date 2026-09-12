/**
 * Native Seam Antigravity (`agy`) CLI adapter.
 *
 * `agy` doesn't speak ACP, so this profile fakes a `ChildProcessByStdio`
 * (`PassThrough` streams instead of a real subprocess) and runs an
 * `AgentSideConnection` against it directly inside seam-acp. Every ACP
 * `session/prompt` is fulfilled by spawning a real `agy -p` child,
 * discovering the language server it boots, and translating its
 * `StreamAgentStateUpdates` events into ACP `sessionUpdate` notifications.
 *
 * Streaming mapping:
 *   plannerResponse.thinking          → agent_thought_chunk (delta)
 *   plannerResponse.modifiedResponse  → agent_message_chunk (delta)
 *   tool-call step types              → tool_call + tool_call_update
 *   USER_INPUT / CONVERSATION_HISTORY / CHECKPOINT → suppressed (internal)
 *
 * Session continuity: the first prompt in an ACP session spawns a fresh
 * agy conversation; subsequent prompts pass `--conversation <id>` so the
 * agent picks up where it left off.
 */

import { type ChildProcess, type ChildProcessByStdio, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { SessionSummary, SessionSummaryLine } from "../session-manager.js";
import { PassThrough, Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Agent,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type ContentBlock,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type McpServer,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SessionConfigOption,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
} from "@agentclientprotocol/sdk";
import { AGENT_ADAPTER_VERSION, asLocalAdapter, type AgentProfile } from "../agent-profile.js";
import { AgyNativeRuntime } from "../agy-native-runtime.js";
import { AgyTurnLifecycle, agyFailure, agyWait } from "../agy-lifecycle.js";
import { runBoundedProbe, type ProbeHandle, ProbeError } from "../probe-process.js";
import {
  manifestCatalogScope,
  manifestCatalogSource,
  type CatalogModelEvidence,
  type CatalogScope,
  type ManifestCatalogModel,
} from "../model-catalog.js";
import { CATALOG_MAX_CONTEXT_TOKENS } from "../catalog-evidence.js";
import {
  discoverAgyLs,
  subscribeToAgyStream,
  waitForAgyConversationId,
  readAgyJsonResponse,
  type AgyStep,
} from "../agy-stream.js";
import { STAGING_ROOT } from "../attachment-staging.js";

const AGY_HOME = path.join(process.env.HOME ?? "/root", ".gemini/antigravity-cli");
const CONVERSATION_DIR = path.join(AGY_HOME, "conversations");
const SETTINGS_FILE = path.join(AGY_HOME, "settings.json");
const REAL_GEMINI = path.join(process.env.HOME ?? "/root", ".gemini");
const REAL_MCP_CONFIG = path.join(REAL_GEMINI, "config", "mcp_config.json");
const STALE_SEAM_SCRIPT = "agy-mcp-server.mjs";

/**
 * Translate ACP `mcpServers` into agy 1.1.20 `mcp_config.json` shape.
 * HTTP uses `serverUrl` + `headers` (what `agy mcp add --type http --header` writes).
 */
export function buildAgyMcpConfigJson(servers: McpServer[]): string {
  const map: Record<string, unknown> = {};
  for (const s of servers) {
    if ("type" in s && (s.type === "http" || s.type === "sse")) {
      const http = s as McpServer & {
        name: string;
        url: string;
        headers?: Array<{ name: string; value: string }>;
      };
      const headers: Record<string, string> = {};
      for (const h of http.headers ?? []) headers[h.name] = h.value;
      map[http.name] = {
        disabled: false,
        serverUrl: http.url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      };
    } else {
      const stdio = s as McpServer & {
        name: string;
        command: string;
        args: string[];
        env?: Array<{ name: string; value: string }>;
      };
      const env: Record<string, string> = {};
      for (const v of stdio.env ?? []) env[v.name] = v.value;
      map[stdio.name] = {
        command: stdio.command,
        args: stdio.args ?? [],
        ...(Object.keys(env).length > 0 ? { env } : {}),
      };
    }
  }
  return JSON.stringify({ mcpServers: map }, null, 2);
}

/** Drop the host's broken stdio `seam` entry that pointed at a missing script. */
export function scrubStaleGlobalSeamStdio(configPath = REAL_MCP_CONFIG): boolean {
  try {
    const json = JSON.parse(fsSync.readFileSync(configPath, "utf8")) as {
      mcpServers?: Record<string, { command?: string; args?: string[] }>;
    };
    const servers = json.mcpServers;
    if (!servers) return false;
    let changed = false;
    for (const [name, cfg] of Object.entries(servers)) {
      const blob = `${cfg?.command ?? ""} ${(cfg?.args ?? []).join(" ")}`;
      if (blob.includes(STALE_SEAM_SCRIPT)) {
        delete servers[name];
        changed = true;
      }
    }
    if (!changed) return false;
    fsSync.writeFileSync(configPath, JSON.stringify(json, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

/**
 * Per-session HOME so each `agy -p` reads its own mcp_config.json.
 * `~/.gemini/config/mcp_config.json` is process-global; HOME is the only
 * isolation that `agy mcp list` honors (no --mcp-config flag). Auth and
 * conversations stay on the real tree via symlink of `antigravity-cli`.
 */
export async function prepareAgyMcpHome(
  _sessionId: string,
  servers: McpServer[],
  realGemini = REAL_GEMINI
): Promise<string | undefined> {
  // Empty means NO MCP, not inherit the host's tools. Unique homes also prevent
  // a resumed runtime's config being deleted by its predecessor's disposal.
  const base = path.join(os.tmpdir(), "seam-agy-homes");
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  const home = await fs.mkdtemp(path.join(base, "session-"));
  try {
  const gemini = path.join(home, ".gemini");
  const cfgDir = path.join(gemini, "config");
  await fs.mkdir(cfgDir, { recursive: true, mode: 0o700 });
  await fs.chmod(home, 0o700);
  await fs.chmod(gemini, 0o700);
  await fs.chmod(cfgDir, 0o700);
  try {
    const ents = await fs.readdir(realGemini, { withFileTypes: true });
    for (const ent of ents) {
      if (ent.name === "config") continue;
      const dest = path.join(gemini, ent.name);
      try {
        await fs.lstat(dest);
      } catch {
        await fs.symlink(path.join(realGemini, ent.name), dest);
      }
    }
  } catch {
    /* no real ~/.gemini */
  }
  try {
    await fs.copyFile(path.join(realGemini, "config", "config.json"), path.join(cfgDir, "config.json"));
  } catch {
    /* optional userSettings */
  }
  await fs.writeFile(path.join(cfgDir, "mcp_config.json"), `${buildAgyMcpConfigJson(servers)}\n`, { mode: 0o600 });
  return home;
  } catch {
    // A failed MCP config write must not leave a credential-bearing temp HOME.
    await fs.rm(home, { recursive: true, force: true });
    throw agyFailure("spawn_failed");
  }
}
/**
 * Where we point each spawned `agy`'s `--log-file`. Every turn (and every
 * catalog/usage probe) gets a unique file under here so it can read back its
 * OWN language-server port and conversation id, instead of scanning agy's
 * shared global log dir by recency — which cross-wires concurrent turns onto
 * each other's language server (the intermittent empty-response bug).
 */
const AGY_SPAWN_LOG_DIR = path.join(os.tmpdir(), "seam-agy-logs");

/** Allocate a fresh private `--log-file` path and ensure its dir exists. */
async function newSpawnLogPath(): Promise<string> {
  await fs.mkdir(AGY_SPAWN_LOG_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(AGY_SPAWN_LOG_DIR, `agy-${randomUUID()}.log`);
  // CLI logs can include prompt/auth data; do not rely on the host umask.
  await fs.writeFile(file, "", { mode: 0o600, flag: "wx" });
  return file;
}
/** Legacy mapping file from before we moved this state out of agy's home dir. */
const LEGACY_MAPPING_FILE = path.join(AGY_HOME, "seam_sessions.json");

/**
 * On-disk session record. `maxStepIndex` is the highest cascade step idx we've
 * already emitted to the ACP client — used to skip the LS's history replay on
 * subscribe. Anything ≤ this we've already shown the user.
 */
interface PersistedSession {
  cascadeId?: string;
  maxStepIndex: number;
  cwd?: string;
  /** Canonical id from the exact native catalog used for every resumed turn. */
  modelId?: string;
}

type SessionMapping = Record<string, PersistedSession | string>;

const mappingWriteTails = new Map<string, Promise<void>>();

/**
 * Serialize read-modify-write operations for one mapping file in this process.
 * Without this queue, two native ACP sessions selecting models concurrently can
 * each read the old file and the last writer silently deletes the other row.
 */
async function mutateSessionMapping(
  file: string,
  mutate: (mapping: SessionMapping) => void,
): Promise<void> {
  const previous = mappingWriteTails.get(file) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    let mapping: SessionMapping = {};
    try {
      mapping = JSON.parse(await fs.readFile(file, "utf8")) as SessionMapping;
    } catch { /* fresh file */ }
    mutate(mapping);
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true });
    // The temporary file must share the target directory: a cross-filesystem
    // rename is not atomic, so a crash could expose a truncated mapping.
    const temp = path.join(
      dir,
      `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await fs.writeFile(temp, JSON.stringify(mapping, null, 2) + "\n", {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await fs.rename(temp, file);
    } catch (err) {
      // A failed write/rename must not leave abandoned session mappings that
      // a later recovery or operator could mistake for durable state.
      await fs.rm(temp, { force: true }).catch(() => {});
      throw err;
    }
  });
  mappingWriteTails.set(file, current);
  try {
    await current;
  } finally {
    // Keep a newer queued mutation registered; deleting it here would allow a
    // third write to bypass the still-running second write and lose its row.
    if (mappingWriteTails.get(file) === current) mappingWriteTails.delete(file);
  }
}

/**
 * Highest step index recorded in a cascade's conversation DB, or -1 if it can't
 * be read. Used to seed the replay high-water mark for legacy mapping entries
 * that pre-date step-index tracking: skip the already-recorded history but
 * still deliver anything new. The DB is opened read-only so it never contends
 * with the live language server writing the cascade.
 */
function conversationMaxStepIndex(cascadeId: string): number {
  const dbPath = path.join(CONVERSATION_DIR, `${cascadeId}.db`);
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare("SELECT MAX(idx) AS m FROM steps").get() as
        | { m: number | null }
        | undefined;
      return typeof row?.m === "number" ? row.m : -1;
    } finally {
      db.close();
    }
  } catch {
    return -1;
  }
}

async function loadPersistedSession(
  file: string,
  sessionId: string,
): Promise<PersistedSession | undefined> {
  for (const candidate of [file, LEGACY_MAPPING_FILE]) {
    try {
      const data = await fs.readFile(candidate, "utf8");
      const mapping = JSON.parse(data) as SessionMapping;
      const entry = mapping[sessionId];
      if (!entry) continue;
      // Old format stored just the cascadeId as a string, pre-dating step-index
      // tracking. Seed the high-water mark from the conversation DB's current
      // max idx: skip the LS's replay of already-recorded history, but still
      // deliver new steps. (The previous Number.MAX_SAFE_INTEGER pin skipped
      // EVERYTHING forever, so replies were never delivered — a silent
      // empty-response trap if a legacy entry was ever loaded.)
      if (typeof entry === "string") {
        return { cascadeId: entry, maxStepIndex: conversationMaxStepIndex(entry) };
      }
      return entry;
    } catch { /* try next */ }
  }
  return undefined;
}

async function savePersistedSession(
  file: string,
  sessionId: string,
  entry: PersistedSession,
): Promise<void> {
  try {
    await savePersistedSessionStrict(file, sessionId, entry);
  } catch (err) {
    if (process.env.AGY_PROFILE_DEBUG) {
      // eslint-disable-next-line no-console
      console.error("[agy] failed to save session mapping");
    }
  }
}

/**
 * Selection commits must report mapping write failures to the ACP caller.
 * If this throws, the in-memory session is left unchanged; otherwise a failed
 * disk write could make the current process use a model that resume forgets.
 */
async function savePersistedSessionStrict(
  file: string,
  sessionId: string,
  entry: PersistedSession,
): Promise<void> {
  await mutateSessionMapping(file, (mapping) => {
    mapping[sessionId] = entry;
  });
}

async function clearPersistedSession(
  file: string,
  sessionId: string,
): Promise<void> {
  try {
    const exists = await fs.access(file).then(() => true).catch(() => false);
    if (!exists) return;
    await mutateSessionMapping(file, (mapping) => {
      delete mapping[sessionId];
    });
  } catch (err) {
    if (process.env.AGY_PROFILE_DEBUG) {
      // eslint-disable-next-line no-console
      console.error("[agy] failed to clear session mapping");
    }
  }
}

export interface AgyNativeCatalogScopeOptions {
  credentialScope?: string;
  defaultModel: string;
  staticModels?: ReadonlyArray<{ modelId: string; name: string; contextLimit?: number }>;
}

/**
 * Semantic native-runtime identity. Location and paths are deliberately absent:
 * equivalent hosts share, while account/default/configured-selection changes
 * cannot contend for one canonical generation.
 */
export function agyNativeCatalogScope(opts: AgyNativeCatalogScopeOptions): CatalogScope {
  const credentialProfile = opts.credentialScope?.trim() || "antigravity-oauth:default";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/.test(credentialProfile) || path.isAbsolute(credentialProfile)) {
    throw new Error("AGY_CREDENTIAL_SCOPE must be a non-secret semantic identifier");
  }
  const selection = {
    defaultModel: opts.defaultModel,
    source: opts.staticModels?.length ? "configured+live-context" : "live-discovery",
    models: (opts.staticModels ?? []).map((model) => ({
      modelId: model.modelId,
      contextLimit: model.contextLimit ?? null,
    })).sort((a, b) =>
      a.modelId.localeCompare(b.modelId) ||
      (a.contextLimit ?? 0) - (b.contextLimit ?? 0)
    ),
  };
  const selectionFingerprint = createHash("sha256")
    .update(JSON.stringify(selection))
    .digest("hex");
  return manifestCatalogScope({
    provider: "google-antigravity",
    backend: "agy-native-language-server-v1",
    credentialProfile,
    policy: `configured-selection-v1:${selectionFingerprint}`,
  });
}

export function makeAgyProfile(opts: {
  /** One verified launch identity shared by catalog, quota, turns and helpers. */
  runtime: AgyNativeRuntime;
  /** Global managed MCP servers (playwright, …). Per-session seam-mcp arrives on newSession. */
  mcpServers?: McpServer[];
  /**
   * Model id to advertise as the profile-level default. Per-session model
   * comes from the catalog returned by `newSession` (or whatever the user
   * has set in `~/.gemini/antigravity-cli/settings.json`).
   */
  defaultModel?: string;
  /**
   * seam-acp's own state directory. The agy profile stores its ACP→cascade
   * mapping here, separate from agy's `~/.gemini/antigravity-cli/`. Defaults
   * to the legacy location for back-compat.
   */
  dataDir?: string;
  staticModels?: ReadonlyArray<{ modelId: string; name: string; contextLimit?: number }>;
  printTimeoutSeconds?: number;
  /** Run terminal tools inside agy's sandbox. Intended for tightly scoped
   *  one-shot helpers that consume untrusted content. */
  sandbox?: boolean;
  /** Expose Seam's shared attachment staging root. Defaults true for normal
   *  chat sessions; isolated helpers should copy inputs into their own cwd. */
  exposeGlobalStaging?: boolean;
  /** Override only the file read once when a session has no persisted model.
   *  Production uses AGY's normal global settings; fixtures use an isolated file. */
  initialSettingsFile?: string;
}): AgentProfile {
  const runtime = opts.runtime;
  const defaultModel = opts.defaultModel ?? "antigravity";
  const catalogScope = agyNativeCatalogScope({
    credentialScope: runtime.credentialScope,
    defaultModel,
    staticModels: opts.staticModels,
  });
  const mappingFile = opts.dataDir
    ? path.join(opts.dataDir, "agy-sessions.json")
    : LEGACY_MAPPING_FILE;
  return asLocalAdapter({
    id: "agy",
    displayName: "Antigravity",
    defaultModel,
    catalog: {
      scope: () => catalogScope,
      async fetch() {
        let models: ReadonlyArray<ManifestCatalogModel>;
        if (opts.staticModels && opts.staticModels.length > 0) {
          const rows = await getCatalog(runtime).catch(catalogFallback);
          const byId = new Map(rows.map((row) => [row.modelId, row]));
          models = opts.staticModels.map((model) => {
            const row = byId.get(model.modelId);
            return agyManifestModel(
              model,
              row,
              runtime.descriptor.provenance.version,
              catalogScope.fingerprint,
            );
          });
        } else {
          const rows = await getCatalog(runtime);
          models = [...rows.filter((row) => row.recommended), ...rows.filter((row) => !row.recommended)]
            .map((row) => agyManifestModel(
              { modelId: row.modelId, name: row.displayName },
              row,
              runtime.descriptor.provenance.version,
              catalogScope.fingerprint,
            ));
        }
        const enriched = models.some((model) => model.evidence?.some((entry) =>
          entry.kind === "live-observation" && entry.source === "agy language server"));
        const candidate = await manifestCatalogSource({
          provider: "google-antigravity",
          backend: catalogScope.backend,
          credentialProfile: catalogScope.credentialProfile,
          policy: catalogScope.policy,
          defaultModel,
          models: () => models,
          effort: { mechanism: "modelBaked", choices: ["default"] },
          adapterVersion: AGENT_ADAPTER_VERSION,
          source: opts.staticModels?.length
            ? enriched ? "validated-manifest+agy-session-language-server" : "validated-manifest+agy-models"
            : enriched ? "agy-models+session-language-server" : "agy-models",
        }).fetch();
        runtime.verify(process.cwd());
        candidate.cliVersion = runtime.descriptor.provenance.version;
        return candidate;
      },
    },
    // agy bakes effort into the model choice (high/med/low model variants) —
    // there is no separate reasoning-effort knob, so the picker is suppressed.
    effort: { mechanism: "modelBaked", levels: [] },
    runtime: runtime.descriptor,
    spawn() {
      return makeFakeAgyProcess(
        runtime,
        mappingFile,
        defaultModel,
        opts.printTimeoutSeconds,
        opts.mcpServers ?? [],
        {
          sandbox: opts.sandbox ?? false,
          exposeGlobalStaging: opts.exposeGlobalStaging ?? true,
        },
        opts.initialSettingsFile ?? SETTINGS_FILE,
      );
    },
    sessionManager: {
      async listSessions(cwd: string): Promise<SessionSummary[]> {
        try {
          const fileExists = await fs.access(mappingFile).then(() => true).catch(() => false);
          if (!fileExists) return [];
          const data = await fs.readFile(mappingFile, "utf8");
          const mapping = JSON.parse(data) as SessionMapping;
          const summaries: SessionSummary[] = [];

          // Query seam.db as a fallback/source of truth for session directories
          const seamDbSessions = new Set<string>();
          try {
            const dataDir = process.env.DATA_DIR ?? "./data";
            const seamDbPath = path.resolve(dataDir, "seam.db");
            const db = new Database(seamDbPath);
            try {
              const rows = db.prepare("SELECT acp_session_id FROM sessions WHERE repo_path = ? AND agent_id = ?").all(cwd, 'agy') as Array<{ acp_session_id?: string }>;
              for (const row of rows) {
                if (row.acp_session_id) {
                  seamDbSessions.add(row.acp_session_id);
                }
              }
            } finally {
              db.close();
            }
          } catch {
            // ignore database lookup errors
          }

          for (const sessionId of Object.keys(mapping)) {
            const entry = mapping[sessionId];
            let cascadeId: string | undefined;
            let entryCwd: string | undefined;

            if (typeof entry === "string") {
              cascadeId = entry;
            } else if (entry && typeof entry === "object") {
              cascadeId = entry.cascadeId;
              entryCwd = entry.cwd;
            }

            if (!cascadeId) continue;

            // Check if it belongs to this cwd
            const matchesCwd = entryCwd
              ? (entryCwd === cwd)
              : seamDbSessions.has(sessionId);

            if (!matchesCwd) continue;

            const transcriptFile = path.join(
              AGY_HOME,
              "brain",
              cascadeId,
              ".system_generated",
              "logs",
              "transcript.jsonl"
            );

            try {
              const stat = await fs.stat(transcriptFile);
              let createdAt = stat.birthtimeMs;
              let lastActivityAt = stat.mtimeMs;

              const content = await fs.readFile(transcriptFile, "utf8");
              const lines = content.split("\n").filter(l => l.trim().length > 0);
              const allMessages: Array<{ sender: "human" | "agent"; text: string; timestamp?: number }> = [];

              for (const line of lines) {
                try {
                  const entryObj = JSON.parse(line);
                  const ts = entryObj.created_at ? Date.parse(entryObj.created_at) : undefined;

                  if (entryObj.type === "USER_INPUT") {
                    let text = entryObj.content || "";
                    const match = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
                    if (match) {
                      text = match[1].trim();
                    }
                    if (text.trim()) {
                      allMessages.push({ sender: "human", text: text.trim(), timestamp: ts });
                    }
                  } else if (entryObj.type === "PLANNER_RESPONSE") {
                    const text = entryObj.content || "";
                    if (text.trim()) {
                      allMessages.push({ sender: "agent", text: text.trim(), timestamp: ts });
                    }
                  }
                } catch {
                  // ignore
                }
              }

              const validTimestamps = allMessages
                .map(m => m.timestamp)
                .filter((t): t is number => t !== undefined && !isNaN(t));
              if (validTimestamps.length > 0) {
                createdAt = validTimestamps[0]!;
                lastActivityAt = validTimestamps[validTimestamps.length - 1]!;
              }

              let previewLines: SessionSummaryLine[] = [];
              if (allMessages.length <= 16) {
                previewLines = allMessages.map(m => ({ sender: m.sender, text: m.text }));
              } else {
                const firstSix = allMessages.slice(0, 6);
                const lastTen = allMessages.slice(-10);
                previewLines = [...firstSix, ...lastTen].map(m => ({ sender: m.sender, text: m.text }));
              }

              const transcriptLines: string[] = [];
              for (const m of allMessages) {
                if (m.text.trim()) {
                  const prefix = m.sender === "human" ? "### User\n" : "### Assistant\n";
                  transcriptLines.push(`${prefix}${m.text.trim()}`);
                }
              }
              const estimatedTokens = Math.ceil(transcriptLines.join("\n\n").length / 4);

              summaries.push({
                sessionId,
                createdAt,
                lastActivityAt,
                previewLines,
                estimatedTokens,
              });
            } catch {
              // ignore if transcript file doesn't exist/can't be parsed
            }
          }

          return summaries.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
        } catch {
          return [];
        }
      },

      async cloneSession(cwd: string, oldSessionId: string, newSessionId: string): Promise<void> {
        const fileExists = await fs.access(mappingFile).then(() => true).catch(() => false);
        if (!fileExists) throw new Error("No sessions found to clone");
        const data = await fs.readFile(mappingFile, "utf8");
        const mapping = JSON.parse(data) as SessionMapping;

        const oldEntry = mapping[oldSessionId];
        if (!oldEntry) throw new Error(`Old session ${oldSessionId} not found in mapping`);

        let oldCascadeId: string | undefined;
        let oldMaxStepIndex = -1;
        let oldModelId: string | undefined;
        if (typeof oldEntry === "string") {
          oldCascadeId = oldEntry;
        } else {
          oldCascadeId = oldEntry.cascadeId;
          oldMaxStepIndex = oldEntry.maxStepIndex;
          oldModelId = oldEntry.modelId;
        }

        // A model-only row exists before the first prompt but has no native
        // conversation to clone; deleting this guard would invent file paths.
        if (!oldCascadeId) throw new Error(`Session ${oldSessionId} has no conversation to clone`);

        const newCascadeId = randomUUID();

        // 1. Copy the conversation file (.db current format; .pb legacy).
        for (const ext of [".db", ".pb"]) {
          try {
            await fs.copyFile(
              path.join(CONVERSATION_DIR, `${oldCascadeId}${ext}`),
              path.join(CONVERSATION_DIR, `${newCascadeId}${ext}`),
            );
            break; // copied whichever exists
          } catch {
            // try next extension / ignore if neither exists
          }
        }

        // 2. Copy brain folder recursively
        const oldBrain = path.join(AGY_HOME, "brain", oldCascadeId);
        const newBrain = path.join(AGY_HOME, "brain", newCascadeId);
        try {
          await fs.mkdir(newBrain, { recursive: true });
          await fs.cp(oldBrain, newBrain, { recursive: true });
        } catch {
          // ignore if brain folder doesn't exist
        }

        // 3. Update mapping
        await savePersistedSessionStrict(mappingFile, newSessionId, {
          cascadeId: newCascadeId,
          maxStepIndex: oldMaxStepIndex,
          cwd,
          ...(oldModelId ? { modelId: oldModelId } : {}),
        });
      },

      async deleteSession(cwd: string, sessionId: string): Promise<void> {
        const fileExists = await fs.access(mappingFile).then(() => true).catch(() => false);
        if (!fileExists) return;
        const data = await fs.readFile(mappingFile, "utf8");
        const mapping = JSON.parse(data) as SessionMapping;

        const entry = mapping[sessionId];
        if (!entry) return;

        let cascadeId: string | undefined;
        if (typeof entry === "string") {
          cascadeId = entry;
        } else {
          cascadeId = entry.cascadeId;
        }

        // 1. Delete the conversation file(s) (.db current, .pb legacy).
        if (cascadeId) {
          for (const ext of [".db", ".pb"]) {
            try {
              await fs.unlink(path.join(CONVERSATION_DIR, `${cascadeId}${ext}`));
            } catch {
              // ignore
            }
          }

          // 2. Delete brain folder
          const brainFolder = path.join(AGY_HOME, "brain", cascadeId);
          try {
            await fs.rm(brainFolder, { recursive: true, force: true });
          } catch {
            // ignore
          }
        }

        // 3. Delete from mapping
        await clearPersistedSession(mappingFile, sessionId);
      },

      async getTranscript(cwd: string, sessionId: string): Promise<string> {
        const fileExists = await fs.access(mappingFile).then(() => true).catch(() => false);
        if (!fileExists) return "";
        const data = await fs.readFile(mappingFile, "utf8");
        const mapping = JSON.parse(data) as SessionMapping;

        const entry = mapping[sessionId];
        if (!entry) return "";

        let cascadeId: string | undefined;
        if (typeof entry === "string") {
          cascadeId = entry;
        } else {
          cascadeId = entry.cascadeId;
        }
        // A newly persisted model-only session has no transcript yet; deleting
        // this guard would turn an ordinary pre-prompt lookup into a bad path.
        if (!cascadeId) return "";

        const transcriptFile = path.join(
          AGY_HOME,
          "brain",
          cascadeId,
          ".system_generated",
          "logs",
          "transcript.jsonl"
        );

        const content = await fs.readFile(transcriptFile, "utf8");
        const lines = content.split("\n").filter(l => l.trim().length > 0);
        const transcriptLines: string[] = [];

        for (const line of lines) {
          try {
            const entryObj = JSON.parse(line);
            if (entryObj.type === "USER_INPUT") {
              let text = entryObj.content || "";
              const match = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
              if (match) {
                text = match[1].trim();
              }
              if (text.trim()) {
                transcriptLines.push(`### User\n${text.trim()}`);
              }
            } else if (entryObj.type === "PLANNER_RESPONSE") {
              const text = entryObj.content || "";
              if (text.trim()) {
                transcriptLines.push(`### Assistant\n${text.trim()}`);
              }
            }
          } catch {
            // ignore
          }
        }

        return transcriptLines.join("\n\n");
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Fake ChildProcess: PassThrough streams + EventEmitter, ACP server attached.
// ---------------------------------------------------------------------------

type FakeProc = ChildProcessByStdio<Writable, Readable, Readable>;

function makeFakeAgyProcess(
  runtime: AgyNativeRuntime,
  mappingFile: string,
  defaultModel: string,
  printTimeoutSeconds?: number,
  mcpServers: McpServer[] = [],
  execution: AgyExecutionPolicy = DEFAULT_AGY_EXECUTION_POLICY,
  initialSettingsFile: string = SETTINGS_FILE,
): FakeProc {
  const fakeStdin = new PassThrough(); // client writes here; we read from it
  const fakeStdout = new PassThrough(); // we write here; client reads from it
  const fakeStderr = new PassThrough();
  const emitter = new EventEmitter();
  let killed = false;

  const agent = new AgyAgent(
    runtime,
    mappingFile,
    defaultModel,
    printTimeoutSeconds,
    mcpServers,
    execution,
    initialSettingsFile,
  );

  const stream = ndJsonStream(
    Writable.toWeb(fakeStdout),
    Readable.toWeb(fakeStdin) as ReadableStream<Uint8Array>,
  );
  // The constructor wires `conn` into the agent via the factory callback.
  new AgentSideConnection((conn) => {
    agent.bind(conn);
    return agent;
  }, stream);

  const fake = Object.assign(emitter, {
    stdin: fakeStdin as unknown as Writable,
    stdout: fakeStdout as unknown as Readable,
    stderr: fakeStderr as unknown as Readable,
    get killed() {
      return killed;
    },
    kill(): boolean {
      if (killed) return false;
      killed = true;
      // Do not report virtual process exit while a native child is still owned.
      void agent.shutdown().then(() => {
        fakeStdin.destroy();
        fakeStdout.push(null);
        fakeStderr.push(null);
        emitter.emit("exit", 0, null);
      }, () => {
        fakeStdin.destroy();
        fakeStdout.push(null);
        fakeStderr.push(null);
        emitter.emit("exit", 1, null);
      });
      return true;
    },
    pid: undefined,
  });

  return fake as unknown as FakeProc;
}

// ---------------------------------------------------------------------------
// ACP agent implementation
// ---------------------------------------------------------------------------

interface AgySession {
  cwd: string;
  /** Set after the first `agy -p` run; used for `--conversation` continuity. */
  cascadeId?: string;
  /**
   * Highest cascade step idx already emitted to the ACP client. The LS replays
   * the full step history on every subscribe; we use this as a high-water mark
   * to skip everything we've shown before. -1 = nothing yet.
   */
  maxStepIndex: number;
  modelId: string;
  mcpServers: McpServer[];
  /** Isolated HOME for this session's mcp_config.json (undefined = inherit). */
  mcpHome?: string;
}

/**
 * One canonical snapshot is used by selection and turn-progress writes.
 * If modelId is omitted here, a later high-water update erases the session's
 * model and the next process restart falls back to a shared default.
 */
function persistedSession(session: AgySession, modelId = session.modelId): PersistedSession {
  return {
    ...(session.cascadeId ? { cascadeId: session.cascadeId } : {}),
    maxStepIndex: session.maxStepIndex,
    cwd: session.cwd,
    ...(modelId ? { modelId } : {}),
  };
}
export interface AgyExecutionPolicy {
  sandbox: boolean;
  exposeGlobalStaging: boolean;
}

/**
 * The policy every production agy session actually launches with. Exported so
 * the documented posture in `docs/agy-native-lifecycle.md` is asserted rather
 * than described: no `--sandbox`, and permissions auto-approved. Changing
 * `sandbox` here means depending on a CLI boundary nobody has demonstrated,
 * which is the decision #324 records — so it should fail a test, not pass
 * quietly.
 */
export const DEFAULT_AGY_EXECUTION_POLICY: AgyExecutionPolicy = {
  sandbox: false,
  exposeGlobalStaging: true,
};

/** Pure argv fragment so isolation policy remains directly regression-testable. */
export function agyExecutionPolicyArgs(
  cwd: string,
  policy: AgyExecutionPolicy
): string[] {
  return [
    ...(policy.sandbox ? ["--sandbox"] : []),
    "--dangerously-skip-permissions",
    "--add-dir",
    cwd,
    ...(policy.exposeGlobalStaging ? ["--add-dir", STAGING_ROOT] : []),
  ];
}

/**
 * Opt out of agy's print-mode slash-command and skill expansion (agy >= 1.1.9,
 * issue #47). Without it, a prompt whose FIRST token is one of agy's own
 * commands (`/agents /changelog /config /credits /effort /help /hooks /model
 * /permissions /skills /usage`) or an installed skill name is resolved by the
 * CLI instead of reaching the model. Verified on 1.1.25: `agy -p "/skills do
 * X"` exits 2 with `Error: /skills takes no arguments` and never starts a turn,
 * and the stdin path fails identically — the whole turn is swallowed.
 *
 * Normal Discord chat turns are already immune because `withHarnessPreamble`
 * prepends `<seam-harness>` to every message, so the first token is never the
 * user's. This flag closes the paths that bypass the preamble — `injectTurn`
 * callers (seam-mcp `handoff`/`forward`/`send`, cron and wake deliveries) hand
 * their text straight through. Applied to EVERY print-mode spawn so the
 * invariant holds by construction rather than by remembering which prompt
 * strings happen to be literals today.
 *
 * Read-only for anything that does not begin with `/`: verified byte-identical
 * output with and without the flag on the `--model` validator probe.
 */
export const AGY_NO_SLASH_EXPANSION = "--disable-slash-commands";

/** ACP `_meta` key: a JSON Schema object for this print-mode turn only. */
export const SEAM_AGY_JSON_SCHEMA_META = "seam/agyJsonSchema";

/**
 * ACP extension carried on a normal config-option update after a real AGY
 * session has learned richer catalog metadata from its own language server.
 * The controller responds by refreshing this exact binding through the normal
 * catalog service; no catalog candidate crosses this private notification.
 */
export const SEAM_AGY_CATALOG_REFRESH_META = "seam/agyCatalogRefresh";

/**
 * Pure argv for one print-mode turn, so the flag set stays directly
 * regression-testable (same rationale as {@link agyExecutionPolicyArgs}).
 *
 * `useStdin` selects between the two prompt-delivery paths. They differ only in
 * whether the prompt rides `-p <text>` or the child's stdin; every other flag —
 * including {@link AGY_NO_SLASH_EXPANSION} — is shared, because agy expands
 * slash commands on both.
 */
export function buildAgyPromptArgs(opts: {
  promptText: string;
  useStdin: boolean;
  modelDisplayName: string;
  logFile: string;
  printTimeoutSeconds: number;
  cwd: string;
  execution: AgyExecutionPolicy;
  cascadeId?: string;
  /**
   * Print-mode structured output (agy >= 1.1.8). When set, BOTH
   * `--output-format json` and `--json-schema` are passed. Interactive /
   * prose turns omit this so argv stays unchanged.
   */
  structuredOutput?: { jsonSchema: string };
}): string[] {
  return [
    ...(opts.useStdin ? [] : ["-p", opts.promptText]),
    AGY_NO_SLASH_EXPANSION,
    "--model",
    opts.modelDisplayName,
    // Redirect this spawn's log to a private path we own and read back for
    // its port + conversation id. Exclusive: agy writes nothing to its shared
    // ~/.gemini/antigravity-cli/log dir when this is set (verified).
    "--log-file",
    opts.logFile,
    "--print-timeout",
    `${opts.printTimeoutSeconds}s`,
    ...(opts.structuredOutput
      ? ["--output-format", "json", "--json-schema", opts.structuredOutput.jsonSchema]
      : []),
    // agy ignores the process cwd for its "workspace" — execution policy
    // supplies --add-dir and optionally the shared staging root. Sandboxed
    // one-shot helpers deliberately expose only their private cwd.
    ...agyExecutionPolicyArgs(opts.cwd, opts.execution),
    ...(opts.cascadeId ? ["--conversation", opts.cascadeId] : []),
  ];
}

export function readAgyJsonSchemaMeta(
  meta: { [key: string]: unknown } | null | undefined
): Record<string, unknown> | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  if (!Object.prototype.hasOwnProperty.call(meta, SEAM_AGY_JSON_SCHEMA_META)) {
    return undefined;
  }
  const schema = meta[SEAM_AGY_JSON_SCHEMA_META];
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("agy structured output: json schema meta must be a JSON object");
  }
  return schema as Record<string, unknown>;
}

/**
 * Canonical reader for `agy --output-format json` stdout.
 *
 * Empirically (agy 1.1.27): stdout is a JSON envelope. `structured_output` is
 * the schema-conforming object. `response` is an unsafe concatenated string
 * that can include tool-progress JSON (`toolAction` / `toolSummary`) and MUST
 * NOT be used as the stage result.
 */
export function parseAgyPrintJsonEnvelope(stdout: string): {
  status: string;
  structuredOutput: Record<string, unknown>;
} {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("agy json output: empty stdout");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("agy json output: stdout is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("agy json output: envelope is not an object");
  }
  const env = parsed as {
    status?: unknown;
    structured_output?: unknown;
    response?: unknown;
    error?: unknown;
  };
  const status = typeof env.status === "string" ? env.status : "";
  if (status !== "SUCCESS") {
    const detail = typeof env.error === "string" && env.error ? ` (${env.error})` : "";
    throw new Error(`agy json output: status ${status || "missing"}${detail}`);
  }
  const structured = env.structured_output;
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) {
    throw new Error("agy json output: missing structured_output");
  }
  return { status, structuredOutput: structured as Record<string, unknown> };
}

class AgyAgent implements Agent {
  private conn?: AgentSideConnection;
  private readonly sessions = new Map<string, AgySession>();
  private active?: AgyTurnLifecycle;
  private shutdownPromise?: Promise<void>;
  private promptTail: Promise<unknown> = Promise.resolve();
  private catalogRefreshSignalled = false;

  constructor(
    private readonly runtime: AgyNativeRuntime,
    private readonly mappingFile: string,
    private readonly defaultModel: string,
    private readonly printTimeoutSeconds?: number,
    private readonly defaultMcpServers: McpServer[] = [],
    private readonly execution: AgyExecutionPolicy = DEFAULT_AGY_EXECUTION_POLICY,
    private readonly initialSettingsFile: string = SETTINGS_FILE,
  ) {}

  bind(conn: AgentSideConnection): void {
    this.conn = conn;
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        // agy takes a single text prompt, but we DO forward attachments: the
        // mapper inlines text files as `resource` blocks (advertise
        // embeddedContext so it inlines rather than emitting an un-fetchable
        // resource_link), and flattenPrompt folds their text into the prompt.
        // Binary files are staged to a path (orchestrator) that agy reads via
        // the staging --add-dir below. No image capability (agy CLI is text-in).
        promptCapabilities: { embeddedContext: true },
        loadSession: true,
      },
      authMethods: [],
    };
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    return {};
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const id = randomUUID();
    const mcpServers = this.execution.sandbox ? [] : params.mcpServers?.length ? params.mcpServers : this.defaultMcpServers;
    const mcpHome = await prepareAgyMcpHome(id, mcpServers);
    const catalog = await getCatalog(this.runtime).catch(catalogFallback);
    // An empty catalog cannot supply the exact canonical id required by --model;
    // deleting this guard would silently fall back to AGY's process-global default.
    if (catalog.length === 0) {
      throw new Error("AGY model catalog is unavailable");
    }
    const modelId = readInitialModelId(catalog, this.initialSettingsFile, this.defaultModel);
    // Every admitted session must own a catalog-valid model before its first turn;
    // deleting this guard would permit an invocation without an isolated model.
    if (!modelId) throw new Error("AGY model catalog has no selectable model");
    const session: AgySession = {
      cwd: params.cwd,
      maxStepIndex: -1,
      modelId,
      mcpServers,
      mcpHome,
    };
    await savePersistedSessionStrict(this.mappingFile, id, persistedSession(session));
    this.sessions.set(id, session);
    return {
      sessionId: id,
      configOptions: buildAgyConfigOptions(catalog, modelId),
    };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const persisted = await loadPersistedSession(this.mappingFile, params.sessionId);
    const mcpServers = this.execution.sandbox ? [] : params.mcpServers?.length ? params.mcpServers : this.defaultMcpServers;
    const mcpHome = await prepareAgyMcpHome(params.sessionId, mcpServers);
    const catalog = await getCatalog(this.runtime).catch(catalogFallback);
    // Resume cannot validate or invoke a canonical session model without a catalog;
    // deleting this guard would reintroduce implicit global/list-order selection.
    if (catalog.length === 0) throw new Error("AGY model catalog is unavailable");
    const modelId = persisted?.modelId ??
      readInitialModelId(catalog, this.initialSettingsFile, this.defaultModel);
    // A persisted id must still exist in the exact current catalog; deleting this
    // check would pass a stale/unknown id to AGY or silently substitute a model.
    if (!modelId || !catalog.some((entry) => entry.modelId === modelId)) {
      throw RequestError.invalidParams({
        details: modelId ? `unknown AGY model ${modelId}` : "AGY session has no model selection",
      });
    }
    const session: AgySession = {
      cwd: params.cwd,
      cascadeId: persisted?.cascadeId,
      maxStepIndex: persisted?.maxStepIndex ?? -1,
      modelId,
      mcpServers,
      mcpHome,
    };
    // Legacy mapping rows have no model; persisting the one-time initial default
    // here prevents later global-default changes from rewriting that session.
    if (!persisted?.modelId) {
      await savePersistedSessionStrict(
        this.mappingFile,
        params.sessionId,
        persistedSession(session),
      );
    }
    this.sessions.set(params.sessionId, session);
    return {
      configOptions: buildAgyConfigOptions(catalog, modelId),
    };
  }

  async setSessionMode(
    _params: SetSessionModeRequest,
  ): Promise<SetSessionModeResponse> {
    return {};
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const sess = this.sessions.get(params.sessionId);
    // Config changes for an unknown session cannot be persisted or invoked;
    // deleting this guard would acknowledge a model choice that no session owns.
    if (!sess) {
      throw RequestError.invalidParams({ details: `unknown session ${params.sessionId}` });
    }
    const catalog = await getCatalog(this.runtime).catch(catalogFallback);
    // An unavailable catalog cannot validate an exact model binding; deleting
    // this guard would turn a transient catalog failure into an arbitrary choice.
    if (catalog.length === 0) throw new Error("AGY model catalog is unavailable");
    // Only the "model" selector is advertised; anything else is a no-op that
    // still echoes the current option set back per the ACP contract.
    if (params.configId !== "model" || typeof params.value !== "string") {
      return { configOptions: buildAgyConfigOptions(catalog, sess.modelId) };
    }
    const modelId = params.value;
    const entry = catalog.find((e) => e.modelId === modelId);
    if (!entry) {
      throw RequestError.invalidParams({
        details: `unknown AGY model ${modelId}`,
      });
    }
    if (sess.modelId !== modelId) {
      // Persist before changing memory; deleting this order makes a failed write
      // partially commit until restart and then resume under the previous model.
      await savePersistedSessionStrict(
        this.mappingFile,
        params.sessionId,
        persistedSession(sess, modelId),
      );
      sess.modelId = modelId;
    }
    return { configOptions: buildAgyConfigOptions(catalog, modelId) };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    // Concurrent ACP requests must not both replace the same finished owner.
    this.active?.cancel();
    const next = this.promptTail.then(() => this.executePrompt(params)).catch((error) => {
      if (error instanceof RequestError) throw error;
      const code = error instanceof ProbeError ? error.code : "protocol_error";
      throw RequestError.internalError({ code }, `native AGY ${code}`);
    });
    this.promptTail = next.catch(() => {});
    return next;
  }

  private async executePrompt(params: PromptRequest): Promise<PromptResponse> {
    if (this.shutdownPromise) throw agyFailure("cancelled");
    // A replacement may not spawn while its predecessor still owns children.
    const previous = this.active;
    if (previous) { previous.cancel(); await previous.done; await previous.close(); }
    const run = new AgyTurnLifecycle(params.sessionId, (this.printTimeoutSeconds ?? 600) * 1000);
    this.active = run;
    try {
      try { return await this.runPrompt(params, run); }
      finally {
        await run.close();
        if (this.active === run) this.active = undefined;
      }
    }
    catch (error) {
      if (run.userCancelled && !(error instanceof ProbeError && error.code === "not_reaped")) return { stopReason: "cancelled" };
      // Keep local ACP parameter refusals (including R3 model validation) intact.
      if (error instanceof RequestError) throw error;
      // Upstream errors can embed private LS responses, argv or host paths.
      const failure = error instanceof ProbeError ? error : run.abort.signal.reason ?? agyFailure("protocol_error");
      throw RequestError.internalError({ code: failure.code }, `native AGY ${failure.code}`);
    }
  }

  private async runPrompt(params: PromptRequest, runRef: AgyTurnLifecycle): Promise<PromptResponse> {
    if (!this.conn) throw new Error("ACP connection not bound");
    const sess = this.sessions.get(params.sessionId);
    if (!sess) {
      throw RequestError.invalidParams({
        details: `unknown session ${params.sessionId}`,
      });
    }

    const promptText = flattenPrompt(params.prompt);
    if (!promptText.trim()) {
      return { stopReason: "end_turn" };
    }
    const jsonSchema = readAgyJsonSchemaMeta(params._meta);

    // Private per-turn log: agy writes its language-server port and the
    // conversation id it binds to here, so we read them back deterministically
    // instead of racing other concurrent turns over agy's shared global dirs.
    const agyLogPath = await newSpawnLogPath();
    runRef.temporaryFiles.push(agyLogPath);

    const catalog = await agyWait(getCatalog(this.runtime).catch(catalogFallback), runRef.abort.signal);
    const selected = selectAgyTurnModel({
      catalog,
      sessionModelId: sess.modelId,
    });
    if (selected.error) {
      throw RequestError.invalidParams({ details: selected.error });
    }
    const currentModel = selected.entry;
    // A turn without an exact model would let the native CLI consult global
    // settings; deleting this guard breaks isolation even if selection failed.
    if (!currentModel) throw new Error("AGY session has no model selection");
    let maxTokens = agyContextWindow(catalog, currentModel);

    // Linux limits each individual argv/envp string to MAX_ARG_STRLEN
    // (PAGE_SIZE * 32 = 131,072 bytes on x86-64), independent of the overall
    // ARG_MAX (~2MB) cap. The `-p <prompt>` arg is a single string, so prompts
    // over ~128KB hit `spawn E2BIG`. When that happens we pipe the prompt via
    // stdin instead — agy reads from stdin when no `-p` value is provided.
    const MAX_ARG_STRLEN = 120_000; // ~8KB headroom under the 131,072 kernel limit
    const useStdin = Buffer.byteLength(promptText, "utf8") > MAX_ARG_STRLEN;

    let schemaFile: string | undefined;
    if (jsonSchema) {
      schemaFile = path.join(
        os.tmpdir(),
        `agy-json-schema-${params.sessionId}-${Date.now()}.json`
      );
      runRef.temporaryFiles.push(schemaFile);
      await fs.writeFile(schemaFile, JSON.stringify(jsonSchema), { encoding: "utf8", mode: 0o600, flag: "wx" });
    }

    const args = buildAgyPromptArgs({
      promptText,
      useStdin,
      modelDisplayName: currentModel.rawDisplayName,
      logFile: agyLogPath,
      printTimeoutSeconds: this.printTimeoutSeconds ?? 600,
      cwd: sess.cwd,
      execution: this.execution,
      ...(sess.cascadeId ? { cascadeId: sess.cascadeId } : {}),
      ...(schemaFile ? { structuredOutput: { jsonSchema: schemaFile } } : {}),
    });

    if (process.env.AGY_PROFILE_DEBUG) {
      // eslint-disable-next-line no-console
      console.error(`[agy] spawning verified native runtime useStdin=${useStdin} argvCount=${args.length}`);
    }
    runRef.abort.signal.throwIfAborted();
    const proc = this.runtime.prepare(args, sess.cwd, {
      mcpHome: sess.mcpHome,
      detached: true,
      stdio: [useStdin ? "pipe" : "ignore", "pipe", "pipe"],
    }).spawn();
    runRef.attach(proc, !!jsonSchema, useStdin);

    if (useStdin && proc.stdin) {
      proc.stdin.write(promptText);
      proc.stdin.end();
    }

    // Clean post-discovery exit lets the LS flush its final frames. Abnormal
    // exit, timeout and external cancellation abort all turn-owned IO.
    const cancelAbort = runRef.abort;

    try {
      const ls = await discoverAgyLs({
        logFile: agyLogPath,
        timeoutMs: 90_000,
        signal: cancelAbort.signal,
      });
      const metadataLearning = learnAgyCatalogFromSession(
        this.runtime,
        ls.port,
        cancelAbort.signal,
      ).then(async (available) => {
        if (!available) return;
        const enriched = await getCatalog(this.runtime);
        const enrichedCurrent = enriched.find((entry) => entry.modelId === currentModel.modelId);
        maxTokens = agyContextWindow(enriched, enrichedCurrent ?? currentModel);
        if (this.catalogRefreshSignalled || !this.conn) return;
        await this.conn.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "config_option_update",
            configOptions: buildAgyConfigOptions(enriched, sess.modelId),
            _meta: { [SEAM_AGY_CATALOG_REFRESH_META]: true },
          },
        });
        this.catalogRefreshSignalled = true;
      }).catch(() => {
        // Blast radius: refuse only this metadata observation. The real turn,
        // prompt-free selectable ids, and R4a's conservative window keep working.
      });
      const cid =
        sess.cascadeId ??
        (await waitForAgyConversationId({
          logFile: agyLogPath,
          signal: cancelAbort.signal,
        }));
      if (!sess.cascadeId) {
        sess.cascadeId = cid;
        await savePersistedSession(this.mappingFile, params.sessionId, {
          cascadeId: cid,
          maxStepIndex: sess.maxStepIndex,
          cwd: sess.cwd,
          modelId: sess.modelId,
        });
      }
      runRef.streaming = true;

      const lastText = new Map<number, string>();
      const lastThinking = new Map<number, string>();
      const heldText = new Map<number, string>();
      const heldThinking = new Map<number, string>();
      const toolCallIds = new Map<number, string>();
      // High-water mark from prior turns. The LS replays every step at or
      // below this on subscribe — skip them so the user doesn't see the entire
      // previous conversation repeated. Anything strictly above is new.
      let skipUpTo = sess.maxStepIndex;
      if (sess.cascadeId) {
        const dbMax = conversationMaxStepIndex(sess.cascadeId);
        if (dbMax !== -1) {
          if (process.env.AGY_PROFILE_DEBUG || dbMax < skipUpTo) {
            // eslint-disable-next-line no-console
            console.error(`[agy] aligning skipUpTo from database: stored=${skipUpTo}, db=${dbMax}`);
          }
          skipUpTo = dbMax;
        }
      }

      const usageTracker = { maxUsed: 0 };

      // Outer retry loop: if the stream closes without any activity (hasBeenActive
      // stays false), it means we subscribed during the idle window between the LS
      // closing after the previous turn and AGY picking up our new prompt.
      // Re-subscribe after a brief delay (up to STALE_IDLE_RETRY_MS total).
      const STALE_IDLE_RETRY_DELAY_MS = 1_500;
      const STALE_IDLE_RETRY_TIMEOUT_MS = 30_000;
      const staleIdleDeadline = Date.now() + STALE_IDLE_RETRY_TIMEOUT_MS;
      let hasBeenActive = false;
      let staleIdleRetryCount = 0;
      outer: while (true) {
        hasBeenActive = false;
        try {
          for await (const update of subscribeToAgyStream({
            port: ls.port,
            conversationId: cid,
            signal: cancelAbort.signal,
          })) {
            if (cancelAbort.signal.aborted) break outer;

            const isRunning = update.status === "CASCADE_RUN_STATUS_RUNNING";
            const sup = update.mainTrajectoryUpdate?.stepsUpdate;
            let hasNewSteps = false;
            if (sup?.indices && sup.steps) {
              for (let i = 0; i < sup.indices.length; i++) {
                const idx = sup.indices[i];
                const step = sup.steps[i];
                if (idx !== undefined && step !== undefined && idx > skipUpTo) {
                  if (
                    step.type &&
                    step.type !== "CORTEX_STEP_TYPE_USER_INPUT" &&
                    step.type !== "CORTEX_STEP_TYPE_CONVERSATION_HISTORY"
                  ) {
                    hasNewSteps = true;
                  }
                }
              }
            }

            if (isRunning || hasNewSteps) {
              hasBeenActive = true;
            }

            if (sup?.indices && sup.steps) {
              for (let i = 0; i < sup.indices.length; i++) {
                const idx = sup.indices[i];
                const step = sup.steps[i];
                if (idx === undefined || step === undefined) continue;
                if (idx <= skipUpTo) continue;
                await this.emitStep(
                  params.sessionId,
                  idx,
                  step,
                  lastText,
                  lastThinking,
                  toolCallIds,
                  heldText,
                  heldThinking,
                  sess.cwd,
                  maxTokens,
                  usageTracker,
                  Boolean(jsonSchema),
                );
                if (idx > sess.maxStepIndex) sess.maxStepIndex = idx;
              }
            }

            // CASCADE_RUN_STATUS_IDLE fires when the MAIN trajectory pauses
            // (e.g. waiting for a subagent to finish). Only `fullyIdle` means
            // the entire cascade — including all subagents — has completed.
            // Breaking on plain IDLE alone causes premature turn termination
            // whenever AGY delegates to background tasks or subagents.
            const mainIdle = update.status === "CASCADE_RUN_STATUS_IDLE";
            const fully = update.fullyIdle === true;
            if ((mainIdle || fully) && hasBeenActive) {
              if (!fully) {
                // Main trajectory went idle but cascade isn't fully done —
                // a subagent or background task is still running. Log and
                // continue waiting.
                if (process.env.AGY_PROFILE_DEBUG) {
                  // eslint-disable-next-line no-console
                  console.error(
                    "[agy] main trajectory idle but NOT fullyIdle — continuing to wait",
                  );
                }
                continue;
              }
              if (process.env.AGY_PROFILE_DEBUG) {
                // eslint-disable-next-line no-console
                console.error(`[agy] cascade fully idle. Breaking stream loop.`);
              }
              break outer;
            }
          }
        } catch (streamErr) {
          // The LS closes the socket after the cascade reaches IDLE; undici
          // surfaces that as `TypeError: terminated` (incomplete chunked
          // read) since Connect doesn't always send a final HTTP trailer.
          // Treat any post-subscribe stream error as natural EOF — except
          // for an explicit user cancel.
          if (cancelAbort.signal.aborted && runRef.userCancelled) {
            return { stopReason: "cancelled" };
          }
          if (cancelAbort.signal.aborted) throw cancelAbort.signal.reason;
          if (streamErr instanceof Error && streamErr.name === "ProbeError") throw streamErr;
          // Fall through — check whether we need to retry below.
        }

        // If we got activity, we're done.
        if (hasBeenActive) break;

        // Stream closed without any activity (hasBeenActive still false).
        // This is a race: we subscribed while the cascade was idle between
        // the prior turn ending and AGY picking up our new prompt. Retry.
        if (cancelAbort.signal.aborted) break;
        if (proc.exitCode !== null || proc.signalCode !== null) break;
        const remaining = staleIdleDeadline - Date.now();
        if (remaining <= 0) {
          if (process.env.AGY_PROFILE_DEBUG) {
            // eslint-disable-next-line no-console
            console.error(
              `[agy] stale-idle retry deadline exceeded after ${staleIdleRetryCount} retries`,
            );
          }
          break;
        }
        staleIdleRetryCount += 1;
        if (process.env.AGY_PROFILE_DEBUG) {
          // eslint-disable-next-line no-console
          console.error(
            `[agy] stream ended with no activity (stale idle) — retry #${staleIdleRetryCount} in ${STALE_IDLE_RETRY_DELAY_MS}ms`,
          );
        }
        await delay(STALE_IDLE_RETRY_DELAY_MS, undefined, { signal: cancelAbort.signal });
      }

      cancelAbort.signal.throwIfAborted();
      if (jsonSchema) {
        const stdout = await runRef.structuredOutput();
        const { structuredOutput } = parseAgyPrintJsonEnvelope(stdout);
        if (this.conn) {
          await this.conn.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: JSON.stringify(structuredOutput) },
            },
          });
        }
      }

      // Flush any text held back as a potentially-partial pattern.
      await this.flushHeld(params.sessionId, heldText, "agent_message_chunk", sess.cwd);
      await this.flushHeld(params.sessionId, heldThinking, "agent_thought_chunk", sess.cwd);
      // Persist the new high-water mark so the next turn (or a restart) can
      // skip everything we've already emitted.
      if (sess.cascadeId && sess.maxStepIndex > skipUpTo) {
        await savePersistedSession(this.mappingFile, params.sessionId, {
          cascadeId: sess.cascadeId,
          maxStepIndex: sess.maxStepIndex,
          cwd: sess.cwd,
          modelId: sess.modelId,
        });
      }
      await metadataLearning;
    } catch (err) {
      if (cancelAbort.signal.aborted && runRef.userCancelled) return { stopReason: "cancelled" };
      throw err;
    } finally {
      await runRef.close();
      if (schemaFile) {
        await fs.unlink(schemaFile).catch(() => {});
      }
      await fs.unlink(agyLogPath).catch(() => {});
    }

    if (proc.exitCode !== null && proc.exitCode !== 0) throw agyFailure("exited_early");
    return { stopReason: "end_turn" };
  }

  async cancel(params: CancelNotification): Promise<void> {
    const wasActive = this.active?.sessionId === params.sessionId;
    if (wasActive && this.active) {
      const run = this.active;
      run.cancel();
      await run.done;
      await run.close();
    }
    // IMPORTANT: do NOT wipe the cascadeId or clear the persisted mapping on
    // cancel. Doing so destroyed the entire conversation on every interrupt /
    // stop / timeout — the next prompt would allocate a brand-new cascade and
    // the agent would "forget" the whole thread (root cause of the 2026-06-19
    // session-loss bug). The "empty stream on rejoin" this once guarded against
    // only happens when rejoining a cascade within the SAME language-server
    // lifecycle (the just-aborted cascade is parked in that LS's memory). Each
    // prompt spawns a fresh `agy -p` (fresh LS), so by the next turn the cascade
    // resumes cleanly WITH full context (verified 2026-06-19). A rare immediate
    // re-prompt right after a cancel may still yield one empty ~4s turn, but
    // resending recovers it and no context is lost.
  }

  shutdown(): Promise<void> {
    return this.shutdownPromise ??= (async () => {
      const run = this.active;
      if (run) { run.cancel(); await run.done; await run.close(); }
      // Only this runtime's generated HOME is disposable; symlinked provider
      // auth/conversations and the ACP restoration mapping are never removed.
      for (const session of this.sessions.values()) {
        if (session.mcpHome) await fs.rm(session.mcpHome, { recursive: true, force: true });
      }
      this.sessions.clear();
    })();
  }

  // -----------------------------------------------------------------------
  // Step → ACP translation
  // -----------------------------------------------------------------------

  private async emitStep(
    sessionId: string,
    idx: number,
    step: AgyStep,
    lastText: Map<number, string>,
    lastThinking: Map<number, string>,
    toolCallIds: Map<number, string>,
    heldText: Map<number, string>,
    heldThinking: Map<number, string>,
    cwd: string,
    maxTokens: number,
    usageTracker: { maxUsed: number },
    omitPlannerMessage = false,
  ): Promise<void> {
    if (!this.conn) return;

    if (step.metadata?.modelUsage) {
      const u = step.metadata.modelUsage;
      const input = parseInt(u.inputTokens ?? "0", 10) || 0;
      const output = parseInt(u.outputTokens ?? "0", 10) || 0;
      const used = input + output;
      if (used > usageTracker.maxUsed) {
        usageTracker.maxUsed = used;
        if (maxTokens > 0) {
          await this.conn.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "usage_update",
              used,
              size: maxTokens,
            } as any
          }).catch(() => {});
        }
      }
    }

    const type = step.type ?? "";

    if (type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE") {
      // Stream thinking deltas before visible text — agy fills them in that
      // order, so consumers see "thinking…" before the answer arrives.
      const thinking = step.plannerResponse?.thinking ?? "";
      const prevTh = lastThinking.get(idx) ?? "";
      if (thinking.length > prevTh.length) {
        const delta = thinking.slice(prevTh.length);
        lastThinking.set(idx, thinking);
        await this.emitTextChunk(sessionId, idx, delta, heldThinking, "agent_thought_chunk", cwd);
      }
      const text = step.plannerResponse?.modifiedResponse ?? "";
      const prevTx = lastText.get(idx) ?? "";
      if (text.length > prevTx.length) {
        const delta = text.slice(prevTx.length);
        lastText.set(idx, text);
        if (!omitPlannerMessage) {
          await this.emitTextChunk(sessionId, idx, delta, heldText, "agent_message_chunk", cwd);
        }
      }
      return;
    }

    // Skip internal trajectory steps — they're noise to a chat consumer.
    if (
      type === "CORTEX_STEP_TYPE_USER_INPUT" ||
      type === "CORTEX_STEP_TYPE_CONVERSATION_HISTORY" ||
      type === "CORTEX_STEP_TYPE_CHECKPOINT"
    ) {
      return;
    }

    // Generated images: agy writes the file to its brain dir and assumes the
    // host UI (the Antigravity IDE) can read it from there. Our chat pipeline
    // can't — we need to read the file and surface it as an ACP `image`
    // content block so agent-runtime can route it through to Discord.
    if (type === "CORTEX_STEP_TYPE_GENERATE_IMAGE") {
      await this.emitGeneratedImageBlock(sessionId, step);
      return;
    }

    // Anything else (VIEW_FILE, RUN_COMMAND, …) becomes a tool call.
    const status = mapToolStatus(step.status);
    const title = toolTitle(step);
    let toolCallId = toolCallIds.get(idx);
    if (!toolCallId) {
      toolCallId = `agy-step-${idx}`;
      toolCallIds.set(idx, toolCallId);
      await this.conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          title,
          status,
          kind: "other",
        },
      });
    } else {
      await this.conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          ...(title ? { title } : {}),
          status,
        },
      });
    }
  }

  /**
   * Pull the generated image path out of a GENERATE_IMAGE step's content
   * text, read the bytes off disk, and emit them as an ACP `image` content
   * block on `agent_message_chunk`. The content text follows the shape:
   *     "Generated image is saved at <absolute-path>."
   */
  private async emitGeneratedImageBlock(
    sessionId: string,
    step: AgyStep,
  ): Promise<void> {
    if (!this.conn) return;
    const content = typeof step.content === "string" ? step.content : "";
    const m = content.match(/saved at\s+(\S+\.(?:png|jpe?g|gif|webp|svg))/i);
    const imagePath = m?.[1];
    if (!imagePath) {
      if (process.env.AGY_PROFILE_DEBUG) {
        // eslint-disable-next-line no-console
        console.error("[agy] GENERATE_IMAGE step had no parseable file path");
      }
      return;
    }
    let data: string;
    try {
      const buf = await fs.readFile(imagePath);
      data = buf.toString("base64");
    } catch (err) {
      if (process.env.AGY_PROFILE_DEBUG) {
        // eslint-disable-next-line no-console
        console.error("[agy] failed to read generated image");
      }
      return;
    }
    const ext = imagePath.toLowerCase().split(".").pop() ?? "";
    const mimeType =
      ext === "png" ? "image/png" :
      ext === "jpg" || ext === "jpeg" ? "image/jpeg" :
      ext === "gif" ? "image/gif" :
      ext === "webp" ? "image/webp" :
      ext === "svg" ? "image/svg+xml" :
      "application/octet-stream";
    await this.conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "image", data, mimeType, uri: `file://${imagePath}` },
      },
    });
  }

  /**
   * Append `delta` to any previously-held tail for `idx`, emit the safe
   * portion (transformed for Discord), and re-hold whatever might still be
   * mid-pattern (unclosed markdown link or partial cwd prefix).
   */
  private async emitTextChunk(
    sessionId: string,
    idx: number,
    delta: string,
    held: Map<number, string>,
    updateType: "agent_thought_chunk" | "agent_message_chunk",
    cwd: string,
  ): Promise<void> {
    if (!this.conn) return;
    const combined = (held.get(idx) ?? "") + delta;
    const safeLen = findSafeBoundary(combined, cwd);
    const safe = combined.slice(0, safeLen);
    held.set(idx, combined.slice(safeLen));
    if (!safe) return;
    // Visible agent text may embed local images via markdown (e.g. agy
    // emitting `![alt](/abs/path.png)` to reference a file it wrote to its
    // brain dir). Pull each such reference out, emit the bytes as a separate
    // image content block, and strip the markdown so the surviving text
    // isn't littered with broken path-only links in Discord.
    const { textWithoutImages, imagesToEmit } =
      updateType === "agent_message_chunk"
        ? await extractInlineImagePaths(safe)
        : { textWithoutImages: safe, imagesToEmit: [] };
    for (const img of imagesToEmit) {
      await this.conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "image",
            data: img.data,
            mimeType: img.mimeType,
            uri: `file://${img.path}`,
          },
        },
      });
    }
    const transformed = transformAgyText(textWithoutImages, cwd);
    if (!transformed) return;
    await this.conn.sessionUpdate({
      sessionId,
      update: { sessionUpdate: updateType, content: { type: "text", text: transformed } },
    });
  }

  /** Emit any text held back as a potentially-partial pattern. */
  private async flushHeld(
    sessionId: string,
    held: Map<number, string>,
    updateType: "agent_thought_chunk" | "agent_message_chunk",
    cwd: string,
  ): Promise<void> {
    if (!this.conn) return;
    for (const tail of held.values()) {
      if (!tail) continue;
      const { textWithoutImages, imagesToEmit } =
        updateType === "agent_message_chunk"
          ? await extractInlineImagePaths(tail)
          : { textWithoutImages: tail, imagesToEmit: [] };
      for (const img of imagesToEmit) {
        await this.conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "image",
              data: img.data,
              mimeType: img.mimeType,
              uri: `file://${img.path}`,
            },
          },
        });
      }
      const transformed = transformAgyText(textWithoutImages, cwd);
      if (!transformed) continue;
      await this.conn.sessionUpdate({
        sessionId,
        update: { sessionUpdate: updateType, content: { type: "text", text: transformed } },
      });
    }
    held.clear();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flattenPrompt(blocks: ReadonlyArray<ContentBlock>): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "text") {
      if (b.text) parts.push(b.text);
    } else if (b.type === "resource") {
      // Text attachments arrive inlined as a resource with `.text` — fold the
      // file content into the prompt so agy actually sees it (previously these
      // were dropped, so an attached text file was invisible to agy).
      const r = b.resource;
      const name = r.uri ? r.uri.replace(/^attachment:\/\//, "") : "file";
      if ("text" in r && typeof r.text === "string") {
        parts.push(`[Attached file: ${name}]\n${r.text}`);
      } else {
        parts.push(`[Attached file: ${name} — binary content not inlined]`);
      }
    } else if (b.type === "resource_link") {
      const name = (b as { name?: string }).name ?? b.uri;
      parts.push(`[Attached file referenced: ${name}]`);
    }
    // image/audio: agy CLI is text-only (no vision) — skip.
  }
  return parts.join("\n");
}

function mapToolStatus(
  s: string | undefined,
): "pending" | "in_progress" | "completed" | "failed" {
  switch (s) {
    case "CORTEX_STEP_STATUS_DONE":
      return "completed";
    case "CORTEX_STEP_STATUS_WAITING":
      return "pending";
    case "CORTEX_STEP_STATUS_FAILED":
    case "CORTEX_STEP_STATUS_ERROR":
      return "failed";
    default:
      return "in_progress";
  }
}

function toolTitle(step: AgyStep): string {
  const t = step.type ?? "";
  return t.replace(/^CORTEX_STEP_TYPE_/, "").replace(/_/g, " ").toLowerCase();
}

/**
 * Find the last position in `text` past which we shouldn't emit yet, because
 * the suffix could still grow into a pattern we want to transform — either an
 * unclosed `[label](url)` markdown link, or a partial absolute path that may
 * complete into the session cwd.
 */
interface InlineImageMatch {
  path: string;
  data: string;
  mimeType: string;
}

/** Scan an agent message for `![label](path)` markdown image references.
 *  For each match whose path resolves to an existing local image file,
 *  read+base64-encode the bytes and remove the markdown from the text.
 *  Other matches (broken paths, non-images) are left intact so the user
 *  still sees the agent's intended formatting. */
async function extractInlineImagePaths(
  text: string,
): Promise<{ textWithoutImages: string; imagesToEmit: InlineImageMatch[] }> {
  const re = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const matches: Array<{ full: string; pathRef: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    matches.push({ full: m[0]!, pathRef: m[2]! });
  }
  if (matches.length === 0) {
    return { textWithoutImages: text, imagesToEmit: [] };
  }
  const imagesToEmit: InlineImageMatch[] = [];
  let textWithoutImages = text;
  for (const { full, pathRef } of matches) {
    const cleanPath = pathRef.startsWith("file://")
      ? decodeURIComponent(pathRef.slice("file://".length))
      : pathRef;
    if (!path.isAbsolute(cleanPath)) continue;
    const ext = cleanPath.toLowerCase().split(".").pop() ?? "";
    const mimeType =
      ext === "png" ? "image/png" :
      ext === "jpg" || ext === "jpeg" ? "image/jpeg" :
      ext === "gif" ? "image/gif" :
      ext === "webp" ? "image/webp" :
      ext === "svg" ? "image/svg+xml" :
      "";
    if (!mimeType) continue;
    try {
      const buf = await fs.readFile(cleanPath);
      imagesToEmit.push({
        path: cleanPath,
        data: buf.toString("base64"),
        mimeType,
      });
      textWithoutImages = textWithoutImages.replace(full, "").replace(/\n{3,}/g, "\n\n");
    } catch {
      // Path doesn't resolve — leave the markdown intact for the user to see.
    }
  }
  return { textWithoutImages, imagesToEmit };
}

function findSafeBoundary(text: string, cwd: string): number {
  let safe = text.length;

  const lastOpenBracket = text.lastIndexOf("[");
  if (lastOpenBracket !== -1) {
    const after = text.slice(lastOpenBracket);
    if (!/\]\([^)]*\)/.test(after)) {
      // If the bracket is preceded by `!`, hold back from the `!` so the
      // full `![label](path)` image markdown stays atomic across delta
      // boundaries — otherwise the `!` ships in an earlier safe chunk and
      // image extraction can't recognise the resulting `[…](…)` as an
      // image (it looks like a normal link).
      const start =
        lastOpenBracket > 0 && text[lastOpenBracket - 1] === "!"
          ? lastOpenBracket - 1
          : lastOpenBracket;
      safe = Math.min(safe, start);
    }
  }

  const minStart = Math.max(0, text.length - cwd.length);
  for (let i = minStart; i < text.length; i++) {
    if (cwd.startsWith(text.slice(i))) {
      safe = Math.min(safe, i);
      break;
    }
  }

  return safe;
}

/**
 * Discord-friendly rewrites of agy output:
 *   `[label](file:///abs/path)` →
 *     - inside cwd  → `` `label` (`relative/path`) ``
 *     - outside cwd → `` `label` `` (the absolute path is noise — usually agy's
 *                     internal brain dir — and Discord can't render file:// anyway)
 *   bare absolute paths under cwd → relative paths
 *   bare cwd alone                → basename of cwd (reads naturally in prose)
 */
function transformAgyText(text: string, cwd: string): string {
  const cwdNorm = cwd.replace(/\/+$/, "");

  text = text.replace(
    /\[([^\]]+)\]\(file:\/\/([^)]+)\)/g,
    (_match, label: string, urlPath: string) => {
      let p: string;
      try { p = decodeURIComponent(urlPath); } catch { p = urlPath; }
      if (p === cwdNorm) return `\`${label}\``;
      if (p.startsWith(cwdNorm + "/")) {
        const rel = p.slice(cwdNorm.length + 1);
        // When the label is just the file's basename it adds no new info;
        // collapse to the relative path to avoid awkward `name` (`path/to/name`).
        if (label === path.basename(rel)) return `\`${rel}\``;
        return `\`${label}\` (\`${rel}\`)`;
      }
      return `\`${label}\``;
    },
  );

  const cwdEsc = cwdNorm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const base = path.basename(cwdNorm);
  text = text.replace(
    new RegExp(`${cwdEsc}(/[\\w./\\-]*)?`, "g"),
    (_match, sub: string | undefined) => (sub ? sub.slice(1) : base),
  );

  return text;
}

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------
//
// `agy models` supplies the prompt-free selectable ids. A real turn's already
// running language server can later enrich those exact ids through
// GetAvailableModels; enrichment never starts a process of its own. AGY's
// global settings model is read only to initialize a session that has no
// persisted choice. Every turn then receives that session's exact runtime
// display name through `--model`.

/**
 * What we are willing to assume a context window is when nothing is known.
 *
 * 128,000 tokens. This is NOT a claim about any model — an unknown window is
 * still published as `null` in the catalog (`catalog.fetch` omits
 * `contextLimit` for an unenriched row). It is the largest window we are
 * willing to ASSUME while sizing a live turn, which is a different question
 * with a different failure mode.
 *
 * The asymmetry is the whole argument. This number becomes the `size` in
 * `usage_update`, which is what the auto-compaction consumer reads as
 * remaining headroom. Assume too much and a 200k-window model is driven past
 * its limit and fails mid-turn, far from the cause — the silent-wrong-answer
 * outcome `AGENTS.md` ranks worst. Assume too little and we compact earlier
 * than strictly needed, costing some headroom and nothing else.
 *
 * 128,000 because it sits at or below the smallest window among the model
 * families AGY advertises (Gemini, Claude, GPT-OSS), so a turn sized to it
 * fits all of them, while still being large enough that ordinary turns never
 * compact spuriously. Raising it trades a bounded, recoverable cost for an
 * unbounded, silent one.
 */
export const AGY_ASSUMED_CONTEXT_WINDOW = 128_000;

/**
 * The window to size this turn against (#260).
 *
 * Evidence first: the model's own observed window, then the smallest window
 * observed anywhere in THIS binding's catalog — a real number from a real
 * sibling model beats a constant, and staying inside the smallest known window
 * cannot overrun any of them. Only a catalog with no observed windows at all
 * falls back to {@link AGY_ASSUMED_CONTEXT_WINDOW}.
 *
 * This replaced `?? 1_000_000`, which assumed the CEILING: correct for Gemini,
 * five times over the limit for a 200k Claude window, and undetectable until
 * the turn failed. #346 removes the guessing entirely by learning real windows
 * from a real session's language server.
 */
export function agyContextWindow(
  catalog: ReadonlyArray<AgyCatalogEntry>,
  entry?: Pick<AgyCatalogEntry, "maxTokens">,
): number {
  if (entry?.maxTokens) return entry.maxTokens;
  const known = catalog.map((row) => row.maxTokens).filter((value) => value > 0);
  return known.length ? Math.min(...known) : AGY_ASSUMED_CONTEXT_WINDOW;
}

export interface AgyCatalogEntry {
  /** API id (e.g. "gemini-3-flash-agent") — what we put in ACP `modelId`. */
  modelId: string;
  /** Cleaned-up name for the Discord picker (tier word → icon, no "(Thinking)"). */
  displayName: string;
  /** Original Antigravity display name — the canonical native `--model` value. */
  rawDisplayName: string;
  /** Human-readable context window (e.g. "1M", "250K"). */
  ctx: string;
  recommended: boolean;
  supportsThinking: boolean;
  supportsImages: boolean;
  /** Maximum context window size in tokens. */
  maxTokens: number;
  /** Present only when rich fields came from this runtime's real-session LS. */
  metadataObservedAt?: string;
}

function agyManifestModel(
  configured: { modelId: string; name: string; contextLimit?: number },
  row: AgyCatalogEntry | undefined,
  runtimeVersion: string,
  scopeRef: string,
): ManifestCatalogModel {
  const contextLimit = configured.contextLimit ?? (row?.maxTokens || undefined);
  const evidence: CatalogModelEvidence[] = row?.metadataObservedAt ? [{
    kind: "live-observation",
    source: "agy language server",
    observedAt: row.metadataObservedAt,
    runtimeVersion,
    adapterVersion: AGENT_ADAPTER_VERSION,
    scopeRef,
    resolvedModel: configured.modelId,
    ...(row.maxTokens ? {
      context: {
        native: row.maxTokens,
        maximum: row.maxTokens,
        effective: row.maxTokens,
        method: "GetAvailableModels",
      },
    } : {}),
    note: `thinking ${row.supportsThinking ? "yes" : "no"}; images ${row.supportsImages ? "yes" : "no"}; recommended ${row.recommended ? "yes" : "no"}`,
  }] : [];
  return {
    ...configured,
    ...(contextLimit ? { contextLimit } : {}),
    ...(evidence.length ? { evidence } : {}),
    ...(row ? {
      modalities: {
        input: row.supportsImages ? ["text", "image"] : ["text"],
        output: ["text"],
      },
      visionMode: row.supportsImages ? "tool" : "none",
    } : {}),
  };
}

/**
 * Parse `agy models` stdout — one `<modelId>\t<displayName>` row per line.
 *
 * #260: this replaces a parser that read the list agy prints when `--model`
 * is INVALID. That list was only reachable by running `agy -p ok --model
 * __seam_probe_invalid__`, i.e. by starting a model turn and relying on an
 * error path to abort it before the turn billed. `agy models` asks the same
 * question directly, exits 0, and spends nothing.
 *
 * Tolerant of a space separator as well as a tab: the separator is a display
 * detail of a CLI we do not control, and a name list is too valuable to lose
 * to it. Rows without both fields are skipped rather than guessed at.
 */
export function parseAgyModelsList(output: string): Array<{ modelId: string; rawDisplayName: string }> {
  const rows: Array<{ modelId: string; rawDisplayName: string }> = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    const tabbed = /^([^\t]+)\t+(\S.*)$/.exec(trimmed);
    // A tab is the observed separator and is unambiguous. A space is accepted
    // only when the first token still LOOKS like a model id, so progress and
    // error prose ("Fetching available models...", "CLI error: not signed in")
    // cannot be mistaken for a model — a wrong id here would be published as a
    // selectable model and then fail at turn time.
    const spaced = tabbed ? null : /^([a-z0-9][a-z0-9._-]*) +(\S.*)$/.exec(trimmed);
    const match = tabbed ?? spaced;
    if (!match) continue;
    const modelId = match[1]!.trim();
    const rawDisplayName = match[2]!.trim();
    if (!modelId || !rawDisplayName || seen.has(modelId)) continue;
    seen.add(modelId);
    rows.push({ modelId, rawDisplayName });
  }
  return rows;
}

/** Finite discovery uses the shared lifecycle, retaining R4's current protocol. */
async function runAgyProbe<T>(
  runtime: AgyNativeRuntime, args: string[], timeoutMs: number,
  run: (handle: ProbeHandle) => Promise<T>,
  observe?: (proc: ChildProcessWithoutNullStreams) => (() => void),
  acceptNonzeroExit = false,
): Promise<T> {
  let proc: ChildProcessWithoutNullStreams;
  let stopObserving: (() => void) | undefined;
  try {
    return await runBoundedProbe({
      executable: "native-agy", label: "native AGY", timeoutMs, killGraceMs: 500,
      processGroup: true, allowCleanExit: true, acceptNonzeroExit,
      spawnOverride: () => {
        proc = runtime.prepare(args, "/tmp", { detached: true, stdio: ["pipe", "pipe", "pipe"] }).spawn() as ChildProcessWithoutNullStreams;
        return proc;
      },
      run: async (handle) => { stopObserving = observe?.(proc); return run(handle); },
    });
  } catch (error) {
    // Even the shared redactor cannot know secrets loaded from native auth files.
    throw agyFailure(error instanceof ProbeError ? error.code : "protocol_error");
  } finally {
    // Do not keep the validator parser/output alive after finite finalization.
    stopObserving?.();
  }
}

/** Resolve a requested model, falling back only to entries in the live catalog. */
export function resolveAgyModel(
  catalog: ReadonlyArray<AgyCatalogEntry>,
  sessionModelId?: string,
  defaultModel?: string,
  opts?: { allowAutoHeal?: boolean }
): AgyCatalogEntry | undefined {
  const exact = catalog.find((entry) => entry.modelId === sessionModelId);
  if (exact) return exact;
  if (opts?.allowAutoHeal === false) return undefined;
  return (
    catalog.find((entry) => entry.rawDisplayName === defaultModel) ??
    catalog.find((entry) => entry.recommended) ??
    catalog[0]
  );
}

/**
 * Choose the model for one AGY turn.
 *
 * A session-owned model is exact-match only and is never substituted. Initial
 * default resolution happens once in new/load, outside the per-turn path.
 */
export function selectAgyTurnModel(opts: {
  catalog: ReadonlyArray<AgyCatalogEntry>;
  sessionModelId?: string;
}): { entry?: AgyCatalogEntry; error?: string } {
  // A missing session choice must not fall through to AGY's global settings;
  // deleting this guard makes concurrent sessions share process-wide state.
  if (!opts.sessionModelId) return { error: "AGY session has no model selection" };
  const exact = resolveAgyModel(
    opts.catalog,
    opts.sessionModelId,
    undefined,
    { allowAutoHeal: false },
  );
  // A catalog miss must fail instead of healing to another model; deleting this
  // guard turns a removed baked-effort variant into an unrequested runtime.
  if (!exact) return { error: `unknown AGY model ${opts.sessionModelId}` };
  return { entry: exact };
}

const catalogRowsPromises = new Map<string, Promise<AgyCatalogEntry[]>>();
const sessionCatalogMetadata = new Map<string, {
  rows: AgyCatalogEntry[];
  observedAt: string;
  fingerprint: string;
}>();

function catalogFallback(error: unknown): AgyCatalogEntry[] {
  // Missing metadata may fall back as before; a live leaked child may not.
  if (error instanceof ProbeError && error.code === "not_reaped") throw error;
  return [];
}

async function getCatalogRows(runtime: AgyNativeRuntime): Promise<AgyCatalogEntry[]> {
  const cached = catalogRowsPromises.get(runtime.identityKey);
  const base = cached ?? fetchAgyModelCatalog(runtime)
    .then((rows) => {
      // Don't PIN an empty result. A cold-start LS (or any transient empty
      // response) would otherwise poison this module-level cache for the whole
      // process lifetime, leaving the model picker permanently empty for every
      // agy session — direct /seam model AND the new-thread wizard both read it.
      // Only memoize a real catalog; reset so the next caller retries.
      if (rows.length === 0) {
        catalogRowsPromises.delete(runtime.identityKey);
        console.error("[agy] catalog fetch returned no usable models — not caching; will retry");
      }
      return rows;
    })
    .catch((err) => {
      // Don't pin the cache to an error — let the next caller retry.
      catalogRowsPromises.delete(runtime.identityKey);
      console.error("[agy] catalog fetch failed");
      // A failed lifecycle is not an empty catalog; retain its classified error.
      throw err;
    });
  if (!cached) catalogRowsPromises.set(runtime.identityKey, base);
  const rows = await base;
  const observed = sessionCatalogMetadata.get(runtime.identityKey);
  return observed ? mergeAgyCatalogMetadata(rows, observed.rows, observed.observedAt) : rows;
}

/**
 * The binding's catalog.
 *
 * #260: this used to intersect two hidden prompt probes — a language-server
 * model list obtained by running `agy -p ok`, filtered by an accepted-name
 * list obtained by running `agy -p ok --model __seam_probe_invalid__`. Two
 * model turns to learn a list of models, invisible at this call site.
 *
 * `agy models` answers both questions without a prompt, so the intersection is
 * gone: the ids it prints ARE the selectable ids. A later real session may
 * enrich those exact ids from its already-running language server; enrichment
 * never starts a process or prompt of its own and is never required.
 */
async function getCatalog(runtime: AgyNativeRuntime): Promise<AgyCatalogEntry[]> {
  return getCatalogRows(runtime);
}

/** Snapshot of the agy CLI's "Models & Quota" data. */
export interface AgyUsage {
  description?: string;
  groups: Array<{
    displayName: string;
    description?: string;
    buckets: Array<{
      bucketId?: string;
      displayName: string;
      description?: string;
      window: "weekly" | "5h";
      remainingFraction: number;
      resetTime?: string;
    }>;
  }>;
}

interface UserQuotaSummaryResponse {
  response?: {
    groups?: Array<{
      displayName?: string;
      description?: string;
      buckets?: Array<{
        bucketId?: string;
        displayName?: string;
        description?: string;
        window?: string;
        remainingFraction?: number;
        resetTime?: string;
      }>;
    }>;
    description?: string;
  };
}

/** Parse the protobuf-JSON envelope returned by RetrieveUserQuotaSummary. */
export function parseAgyQuotaSummary(json: UserQuotaSummaryResponse): AgyUsage {
  const groups: AgyUsage["groups"] = [];
  for (const rawGroup of json.response?.groups ?? []) {
    if (!rawGroup.displayName) continue;
    const buckets: AgyUsage["groups"][number]["buckets"] = [];
    for (const rawBucket of rawGroup.buckets ?? []) {
      if (
        !rawBucket.displayName ||
        (rawBucket.window !== "weekly" && rawBucket.window !== "5h") ||
        typeof rawBucket.remainingFraction !== "number" ||
        !Number.isFinite(rawBucket.remainingFraction)
      ) {
        continue;
      }
      buckets.push({
        ...(rawBucket.bucketId ? { bucketId: rawBucket.bucketId } : {}),
        displayName: rawBucket.displayName,
        ...(rawBucket.description ? { description: rawBucket.description } : {}),
        window: rawBucket.window,
        remainingFraction: rawBucket.remainingFraction,
        ...(rawBucket.resetTime ? { resetTime: rawBucket.resetTime } : {}),
      });
    }
    groups.push({
      displayName: rawGroup.displayName,
      ...(rawGroup.description ? { description: rawGroup.description } : {}),
      buckets,
    });
  }
  return {
    ...(json.response?.description ? { description: json.response.description } : {}),
    groups,
  };
}

// Cache the usage snapshot briefly so repeated `/seam usage` calls don't pay
// the ~5s LS spawn cost. 60s strikes a balance between freshness and snappiness.
const USAGE_CACHE_TTL_MS = 60_000;
const usageCache = new Map<string, { at: number; data: AgyUsage }>();

/**
 * Fetch the current user's Antigravity usage snapshot. Spawns a transient
 * `agy -p` to bring the local LS up, hits `RetrieveUserQuotaSummary`, and
 * parses the response. Cached for {@link USAGE_CACHE_TTL_MS} after a successful
 * call.
 */
export async function fetchAgyUserStatus(runtime: AgyNativeRuntime): Promise<AgyUsage> {
  const cached = usageCache.get(runtime.identityKey);
  if (cached && Date.now() - cached.at < USAGE_CACHE_TTL_MS) {
    return cached.data;
  }
  const logFile = await newSpawnLogPath();
  try {
    // KNOWN REMAINING PROMPT PROBE (#260). Quota lives behind the same
    // language server as the catalog did, and this still pays a model turn to
    // start one. The catalog no longer does — `agy models` starts an LS
    // without prompting — so the same technique should work here, but quota
    // semantics belong to #345 and changing them is not this story's scope.
    // Left named rather than silently inherited: a probe nobody can see is how
    // this one survived two rounds of catalog work.
    return await runAgyProbe(runtime, ["-p", "ok", AGY_NO_SLASH_EXPANSION, "--log-file", logFile, "--print-timeout", "30s", "--dangerously-skip-permissions"], 30_000, async (handle) => {
    handle.stdout.resume();
    const ls = await discoverAgyLs({
      logFile,
      timeoutMs: 15_000,
      signal: handle.signal,
    });
    // /healthz comes up before the LS finishes silent-auth, so quota retrieval
    // can initially 500. Retry briefly until auth lands (usually 1–2s).
    const url = `http://localhost:${ls.port}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`;
    const deadline = Date.now() + 10_000;
    let lastStatus = 0;
    while (Date.now() < deadline) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
        signal: handle.signal,
      });
      if (res.ok) {
        const json = (await readAgyJsonResponse(res)) as UserQuotaSummaryResponse;
        const data = parseAgyQuotaSummary(json);
        usageCache.set(runtime.identityKey, { at: Date.now(), data });
        return data;
      }
      lastStatus = res.status;
      await res.body?.cancel();
      if (res.status !== 500) break;
      await delay(400, undefined, { signal: handle.signal });
    }
    throw new Error(`RetrieveUserQuotaSummary HTTP ${lastStatus}`);
    });
  } finally {
    await fs.unlink(logFile).catch(() => {});
  }
}

/**
 * Build the native catalog WITHOUT starting a model turn (#260).
 *
 * What this replaces: `agy -p ok … --print-timeout 30s`, spawned purely to
 * bring the local language server up so `GetAvailableModels` could be queried
 * over HTTP, plus a second `agy -p ok --model __seam_probe_invalid__` whose
 * accepted-name list was intersected with the first. Two model turns to learn
 * a list of models, neither visible at the call site.
 *
 * `agy models` asks for the list directly: exit 0, one
 * `<modelId>\t<displayName>` row per model, no prompt, nothing billed. The
 * intersection is gone rather than reimplemented — the ids it prints ARE the
 * selectable ids, which is what the validator probe was there to confirm.
 *
 * What it deliberately does NOT do is fetch context windows, thinking support
 * or a recommended flag. Those live in the language server, and the server
 * this subcommand starts is not answerable prompt-free: measured on agy
 * 1.1.27, the port appears ~124ms in and `GetAvailableModels` returns HTTP 400
 * for the whole ~2s the process lives, because the catalog RPC needs a warmup
 * the old probe bought with `--print-timeout 30s`. Trying anyway produced a
 * catalog whose metadata depended on who won a race. So every such field stays
 * UNKNOWN here — `maxTokens: 0`, which `catalog.fetch` omits rather than
 * publishing as a guessed `contextLimit` — and #346 learns the real values
 * from a session's own long-lived server.
 */
async function fetchAgyModelCatalog(runtime: AgyNativeRuntime): Promise<AgyCatalogEntry[]> {
  const logFile = await newSpawnLogPath();
  try {
    return await runAgyProbe(runtime, ["--log-file", logFile, "models"], 30_000, async (handle) => {
      let output = "";
      for await (const chunk of handle.stdout) output += chunk.toString();
      await handle.completed;
      return dedupeAgyDisplayNames(parseAgyModelsList(output).map((row) => ({
        modelId: row.modelId,
        rawDisplayName: row.rawDisplayName,
        displayName: cleanAgyDisplayName(row.rawDisplayName),
        ctx: formatTokens(0),
        recommended: false,
        supportsThinking: false,
        supportsImages: false,
        maxTokens: 0,
      })));
    });
  } finally {
    await fs.unlink(logFile).catch(() => {});
  }
}

interface AgyRawModel {
  displayName?: string;
  maxTokens?: number;
  recommended?: boolean;
  supportsThinking?: boolean;
  supportsImages?: boolean;
  isInternal?: boolean;
}

/** Parse the rich catalog shape observed from a live AGY language server. */
export function parseAgySessionCatalog(
  json: { response?: { models?: Record<string, AgyRawModel> } },
): AgyCatalogEntry[] {
  const rows: AgyCatalogEntry[] = [];
  for (const [modelId, raw] of Object.entries(json.response?.models ?? {})) {
    if (raw.isInternal || !raw.displayName) continue;
    const maxTokens = typeof raw.maxTokens === "number" &&
      Number.isSafeInteger(raw.maxTokens) && raw.maxTokens > 0 &&
      raw.maxTokens <= CATALOG_MAX_CONTEXT_TOKENS
      ? raw.maxTokens
      : 0;
    rows.push({
      modelId,
      rawDisplayName: raw.displayName,
      displayName: cleanAgyDisplayName(raw.displayName),
      ctx: formatTokens(maxTokens),
      recommended: raw.recommended === true,
      supportsThinking: raw.supportsThinking === true,
      supportsImages: raw.supportsImages === true,
      maxTokens,
    });
  }
  return rows;
}

/**
 * Apply metadata only to exact ids already advertised by `agy models`.
 * A language-server-only row is refused; the prompt-free selectable catalog
 * and every unmatched row keep working with R4a's conservative assumptions.
 */
export function mergeAgyCatalogMetadata(
  selectable: ReadonlyArray<AgyCatalogEntry>,
  observed: ReadonlyArray<AgyCatalogEntry>,
  observedAt?: string,
): AgyCatalogEntry[] {
  const byId = new Map(observed.map((row) => [row.modelId, row]));
  return selectable.map((row) => {
    const rich = byId.get(row.modelId);
    if (!rich) return { ...row };
    return {
      ...row,
      ctx: rich.ctx,
      recommended: rich.recommended,
      supportsThinking: rich.supportsThinking,
      supportsImages: rich.supportsImages,
      maxTokens: rich.maxTokens,
      ...(observedAt ? { metadataObservedAt: observedAt } : {}),
    };
  });
}

const AGY_SESSION_CATALOG_DEADLINE_MS = 10_000;

/**
 * Learn rich metadata from the language server of an ALREADY REAL turn.
 * This starts no process and sends no prompt. Failure refuses only enrichment;
 * the active turn and the conservative prompt-free catalog keep working.
 */
async function learnAgyCatalogFromSession(
  runtime: AgyNativeRuntime,
  port: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (sessionCatalogMetadata.has(runtime.identityKey)) return true;
  const selectable = await getCatalogRows(runtime);
  const selectableIds = new Set(selectable.map((row) => row.modelId));
  const url = `http://localhost:${port}/exa.language_server_pb.LanguageServerService/GetAvailableModels`;
  const deadline = Date.now() + AGY_SESSION_CATALOG_DEADLINE_MS;
  for (;;) {
    signal.throwIfAborted();
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal,
    });
    if (response.ok) {
      const parsed = parseAgySessionCatalog(
        (await readAgyJsonResponse(response)) as { response?: { models?: Record<string, AgyRawModel> } },
      ).filter((row) => selectableIds.has(row.modelId));
      if (parsed.length > 0) {
        const fingerprint = JSON.stringify(parsed.map((row) => ({
          modelId: row.modelId,
          maxTokens: row.maxTokens,
          recommended: row.recommended,
          supportsThinking: row.supportsThinking,
          supportsImages: row.supportsImages,
        })).sort((a, b) => a.modelId.localeCompare(b.modelId)));
        const prior = sessionCatalogMetadata.get(runtime.identityKey);
        sessionCatalogMetadata.set(runtime.identityKey, prior?.fingerprint === fingerprint
          ? prior
          : { rows: parsed, observedAt: new Date().toISOString(), fingerprint });
        return true;
      }
    } else {
      const retryable = response.status === 400 || response.status === 500;
      await response.body?.cancel();
      // A definitive refusal cannot become metadata by polling. Refuse only
      // enrichment; the real turn and conservative catalog keep working.
      if (!retryable) return false;
    }
    if (Date.now() >= deadline) return false;
    await delay(400, undefined, { signal });
  }
}

/**
 * Antigravity ships several ids under one display name (rebrand aliases and
 * stale labels), and the picker shows names. Keep the id whose slug best
 * matches its own display name, and order recommended first. Carried over from
 * the language-server parser #260 removed — the duplicates are a property of
 * the provider's naming, not of how the list was obtained.
 */
function dedupeAgyDisplayNames(rows: ReadonlyArray<AgyCatalogEntry>): AgyCatalogEntry[] {
  const byName = new Map<string, AgyCatalogEntry>();
  const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const score = (row: AgyCatalogEntry) => {
    const a = slug(row.rawDisplayName);
    const b = slug(row.modelId);
    let matched = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] === b[i]) matched++;
    return matched;
  };
  for (const row of rows) {
    const prev = byName.get(row.rawDisplayName);
    if (!prev || score(row) > score(prev)) byName.set(row.rawDisplayName, row);
  }
  return [...byName.values()].sort(
    (a, b) => Number(b.recommended) - Number(a.recommended) || a.displayName.localeCompare(b.displayName),
  );
}

const TIER_ICON: Record<string, string> = { high: "🔼", medium: "▶️", low: "🔽" };

function cleanAgyDisplayName(s: string): string {
  // "(Thinking)" is redundant — we already show 🧠 in the label suffix.
  let out = s.replace(/\s*\(Thinking\)\s*$/i, "");
  out = out.replace(
    /\s*\((High|Medium|Low)\)\s*$/i,
    (_m, t: string) => ` ${TIER_ICON[t.toLowerCase()] ?? ""}`,
  );
  return out.trim();
}

function formatTokens(n: number): string {
  if (!n) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return Math.round(n / 1_000) + "K";
  return String(n);
}

function pickerLabel(e: AgyCatalogEntry): string {
  const caps = [e.supportsThinking ? "🧠" : "", e.supportsImages ? "🖼️" : ""].filter(Boolean).join("");
  return `${e.recommended ? "★ " : ""}${e.displayName} — 🪟${e.ctx}${caps ? " " + caps : ""}`;
}

/** Build the ACP session config options advertised by the agy agent. ACP 1.x
 *  no longer has a dedicated `models` field on session responses — the model
 *  selector is a `configOption` with category/id "model". */
function buildAgyConfigOptions(
  catalog: ReadonlyArray<AgyCatalogEntry>,
  currentModelId: string,
): SessionConfigOption[] {
  return [
    {
      id: "model",
      name: "Model",
      description: "Antigravity model to use",
      category: "model",
      type: "select",
      currentValue: currentModelId,
      options: catalog.map((e) => ({
        value: e.modelId,
        name: pickerLabel(e),
      })),
    },
  ];
}

function readInitialModelId(
  catalog: ReadonlyArray<AgyCatalogEntry>,
  settingsFile: string,
  defaultModel?: string,
): string {
  try {
    const raw = fsSync.readFileSync(settingsFile, "utf8");
    const dn = (JSON.parse(raw) as { model?: unknown }).model;
    if (typeof dn === "string") {
      const match = catalog.find((e) => e.rawDisplayName === dn);
      if (match) return match.modelId;
    }
  } catch { /* one-time fallback below */ }
  return resolveAgyModel(catalog, defaultModel, defaultModel)?.modelId ?? "";
}

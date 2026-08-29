import type { ChildProcessByStdio } from "node:child_process";
import type { Readable as NodeReadable, Writable as NodeWritable } from "node:stream";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { ContextUsage, ISessionManager, SessionSummary } from "./session-manager.js";

/**
 * Adapter contract version advertised by in-process local agents via
 * `describe()`. Bumped when the §4 surface itself changes (not per agent).
 */
export const AGENT_ADAPTER_VERSION = 1;

/** How an agent exposes reasoning effort. See `AgentAdapter.effort`. */
export type EffortMechanism =
  | "meta"
  | "configOption"
  | "modelBaked"
  | "spawnArgs"
  | "none";

export interface EffortDescriptor {
  readonly mechanism: EffortMechanism;
  /** ACP config option id for mechanism "configOption" (e.g. "reasoning_effort"). */
  readonly configId?: string;
  /** Levels the picker should offer. Empty ⇒ effort is not separately settable. */
  readonly levels: ReadonlyArray<string>;
}

export interface AdapterModel {
  modelId: string;
  name: string;
  contextLimit?: number;
}

/**
 * Snapshot returned by `AgentAdapter.describe()`. `effort.mechanism` is
 * always present so callers can round-trip values like grok's `spawnArgs`.
 */
export interface AdapterDescribe {
  version: number;
  models: ReadonlyArray<AdapterModel>;
  effort: EffortDescriptor;
  promptCaps?: Record<string, unknown>;
}

/** Idempotent startup/pre-spawn hook declared by `prepare()`. */
export interface PrepareStep {
  id: string;
  description?: string;
}

/**
 * Pinned install recipe (§6). Local PR1 stubs `{ supported: false }` —
 * `install()` must not actually install anything.
 */
export interface InstallRecipe {
  supported: boolean;
  recipeId?: string;
  steps?: ReadonlyArray<string>;
}

export interface WorkspaceInfo {
  id: string;
  path: string;
  name?: string;
}

/** Host-side file ferry payload (§4.2). Local `readAttachment` stubs `null`. */
export interface AttachmentBytes {
  bytes: Uint8Array;
  filename: string;
  size: number;
}

/**
 * §4 agent-adapter contract, implemented in-process for PR1.
 *
 * SUPERSET of the pre-PR1 `AgentProfile`: every existing field and
 * `spawn(modelOverride?, effortOverride?)` stay as the runtime path.
 * `spawn(cwd, opts)` is a later-PR concern and is not added here.
 *
 * New methods are real (not comments) but are safe no-ops or
 * `sessionManager` delegates until PR3/PR4 call them over the bus.
 */
export interface AgentAdapter {
  /** Stable id used in commands and DB rows ("copilot", "claude-code", …). */
  readonly id: string;

  /** Human-readable name. */
  readonly displayName: string;

  /**
   * Status-card brand key (#96): names the *service*, not the harness.
   * Default resolution groups `copilot*`/`claude*` and overrides non-Anthropic
   * Claude-harness profiles (`zai`→`z-ai`, `ollama-cloud`, `claude-vertex`→`vertex`).
   * Set this to pin a logo that the id-based resolver would get wrong.
   */
  readonly brand?: string;

  /** Default model id this agent should use unless the session overrides it. */
  readonly defaultModel: string;

  /**
   * Optional static list of models to use for this profile. When provided,
   * these override any models advertised dynamically by the agent via ACP.
   */
  readonly staticModels?: ReadonlyArray<AdapterModel>;

  /**
   * Optional async model list for pickers that must not spawn an ACP session
   * (preset builder). Prefer `staticModels` when non-empty. Agy uses this to
   * return its cached language-server catalog.
   */
  listPickerModels?(): Promise<ReadonlyArray<AdapterModel>>;

  /**
   * Optional short abbreviation displayed in thread names when the new-thread
   * wizard renames the thread after setup (e.g. "cp-fhr", "agy").
   */
  readonly threadAbbr?: string;

  /**
   * If true, the agent's host has network restrictions that block Discord
   * (CDN URLs, etc.). When true, attachments are downloaded server-side and
   * written to the agent's filesystem via `sessionManager.writeAttachment`;
   * the LLM gets a local file path in the prompt instead of a Discord URL.
   */
  readonly restrictDiscordAccess?: boolean;

  /**
   * Optional config/data directory used by this profile. Profiles that
   * support multi-account isolation (Claude, Copilot) expose this so other
   * subsystems (e.g. usage fetching) can locate the right credentials file.
   */
  readonly configDir?: string;

  /** Spawn the agent as an ACP server over stdio.
   *  @param modelOverride — when set, the spawned process should use this model
   *  instead of the profile default. Used for non-Anthropic backends where
   *  `setModel()` (ACP config option) is rejected by the adapter.
   *  @param effortOverride — when set, the spawned process should use this
   *  reasoning effort level. Used for agents that accept effort via CLI flags
   *  (e.g. Grok `--reasoning-effort`). */
  spawn(
    modelOverride?: string,
    effortOverride?: string,
    /**
     * Per-runtime MCP servers. Most ACP agents consume these from
     * `session/new` / `session/load` and can ignore this argument. Copilot CLI
     * does not: it must receive them at process spawn via
     * `--additional-mcp-config`, otherwise a resumed process loses seam-MCP.
     */
    mcpServers?: McpServer[]
  ): ChildProcessByStdio<NodeWritable, NodeReadable, NodeReadable>;

  /**
   * How this agent exposes reasoning effort, if at all. Drives both the
   * `/seam config effort` picker (which levels to offer, or whether to show it)
   * and the application path in AgentRuntime:
   *   - "meta"        → folded into `session/new` `_meta` via `newSessionMeta`
   *                     (Claude: `_meta.claudeCode.options.effort`).
   *   - "configOption"→ applied after session creation via ACP
   *                     `setSessionConfigOption` (Copilot: `reasoning_effort`).
   *   - "modelBaked"  → effort is part of the model choice; no separate control
   *                     (agy ships high/med/low model variants).
   *   - "spawnArgs"   → passed as a CLI flag at process spawn (Grok:
   *                     `--reasoning-effort`). No ACP config option / `_meta`.
   *   - "none"        → the agent has no reasoning-effort concept.
   * Omit entirely to mean "not settable" (treated like "none").
   */
  readonly effort?: EffortDescriptor;

  /**
   * Optional `_meta` payload to attach to `session/new`. Lets a vendor
   * pass extra hints (compaction threshold, reasoning effort) without
   * polluting the generic API. `effort` is one of low|medium|high|xhigh|max;
   * undefined leaves the model's built-in default in place.
   */
  newSessionMeta?(
    modelId?: string,
    effort?: string
  ): Record<string, unknown> | undefined;

  /**
   * Best-effort identity probe: which account is this profile authenticated
   * as. Read from local CLI config files — no network call. Returns `null`
   * when unknown (CLI never logged in, file missing, parse error, profile
   * doesn't support the concept).
   */
  whoami?(): Promise<AgentIdentity | null>;
  sessionManager?: ISessionManager;

  /** Catalog + effort snapshot. Always includes `effort.mechanism`. */
  describe(): AdapterDescribe;

  /**
   * Idempotent startup / pre-spawn hooks (reconciliation, §4.1). Local
   * agents return an empty list — existing startup (e.g. opencode's
   * LM-Studio config sync in `index.ts`) stays where it is.
   */
  prepare(): PrepareStep[];

  /**
   * Pinned, allow-listed install recipe (§6). Local stub: not supported;
   * must not install anything.
   */
  install(): InstallRecipe;

  /**
   * Host-side workspace enumeration (§7 / D11). Local: empty — the
   * orchestrator still scans `REPOS_ROOT` itself. Do not invent a scan.
   */
  listWorkspaces(): WorkspaceInfo[];

  /**
   * Side-channel usage readout. Delegates to `sessionManager.getUsage`
   * when present; otherwise `null`.
   */
  usage(
    cwd?: string,
    sessionId?: string,
    newerThanMs?: number
  ): Promise<ContextUsage | null>;

  /**
   * Host → control-plane file ferry for `seam-attach` (§4.2). Local stub:
   * `null` (the orchestrator still reads local files directly). Do not
   * invent a new path jail here — that is PR3.
   */
  readAttachment(cwd: string, path: string): Promise<AttachmentBytes | null>;

  /** Session verbs — delegate to `sessionManager` when present. */
  listSessions(cwd: string): Promise<SessionSummary[]>;
  getTranscript(cwd: string, sessionId: string): Promise<string>;
  cloneSession(cwd: string, oldSessionId: string, newSessionId: string): Promise<void>;
  deleteSession(cwd: string, sessionId: string): Promise<void>;

  /**
   * Stage a user-sent upload onto the agent's filesystem. Delegates to
   * `sessionManager.writeAttachment` when present; otherwise `null`.
   * `bytes` may be raw octets or the base64 string the session manager
   * already accepts.
   */
  writeAttachment(
    cwd: string,
    filename: string,
    bytes: string | Uint8Array
  ): Promise<{ path: string } | null>;
}

/**
 * Back-compat alias. The rest of the tree (orchestrator, runtime, router)
 * keeps importing `AgentProfile`; it is the same type as `AgentAdapter`.
 */
export type AgentProfile = AgentAdapter;

/** Fields a local factory already implements; `asLocalAdapter` fills the rest. */
export type AgentProfileCore = Omit<
  AgentAdapter,
  | "describe"
  | "prepare"
  | "install"
  | "listWorkspaces"
  | "usage"
  | "readAttachment"
  | "listSessions"
  | "getTranscript"
  | "cloneSession"
  | "deleteSession"
  | "writeAttachment"
>;

/**
 * Fill the §4 surface on an in-process profile: `describe()` snapshots
 * models + effort (including `mechanism`), session verbs / `usage` /
 * `writeAttachment` delegate to `sessionManager` when present, and the
 * remaining methods are safe no-ops.
 */
/** Models for a Discord picker that must not start an ACP session. */
export async function pickerModelsForProfile(
  profile:
    | {
        staticModels?: ReadonlyArray<AdapterModel>;
        listPickerModels?: () => Promise<ReadonlyArray<AdapterModel>>;
      }
    | null
    | undefined,
  cap = 24
): Promise<ReadonlyArray<AdapterModel>> {
  if (!profile) return [];
  if (profile.staticModels && profile.staticModels.length > 0) {
    return profile.staticModels.slice(0, cap);
  }
  if (typeof profile.listPickerModels === "function") {
    try {
      return (await profile.listPickerModels()).slice(0, cap);
    } catch {
      return [];
    }
  }
  return [];
}

export function asLocalAdapter(core: AgentProfileCore): AgentAdapter {
  const adapter: AgentAdapter = {
    ...core,
    describe(): AdapterDescribe {
      const models: AdapterModel[] =
        adapter.staticModels && adapter.staticModels.length > 0
          ? adapter.staticModels.map((m) => ({
              modelId: m.modelId,
              name: m.name,
              ...(m.contextLimit != null ? { contextLimit: m.contextLimit } : {}),
            }))
          : [{ modelId: adapter.defaultModel, name: adapter.defaultModel }];
      const effort: EffortDescriptor = adapter.effort
        ? {
            mechanism: adapter.effort.mechanism,
            ...(adapter.effort.configId != null
              ? { configId: adapter.effort.configId }
              : {}),
            levels: [...adapter.effort.levels],
          }
        : { mechanism: "none", levels: [] };
      return { version: AGENT_ADAPTER_VERSION, models, effort };
    },
    prepare(): PrepareStep[] {
      return [];
    },
    install(): InstallRecipe {
      return { supported: false };
    },
    listWorkspaces(): WorkspaceInfo[] {
      // Local: orchestrator still enumerates REPOS_ROOT. Host-side
      // listWorkspaces is PR4/D11. Empty until then.
      return [];
    },
    async usage(
      cwd?: string,
      sessionId?: string,
      newerThanMs?: number
    ): Promise<ContextUsage | null> {
      if (!cwd) return null;
      const getUsage = adapter.sessionManager?.getUsage;
      if (!getUsage) return null;
      return getUsage.call(adapter.sessionManager, cwd, sessionId, newerThanMs);
    },
    async readAttachment(
      _cwd: string,
      _path: string
    ): Promise<AttachmentBytes | null> {
      // Ferry is PR3. Local seam-attach still reads the file directly.
      return null;
    },
    async listSessions(cwd: string): Promise<SessionSummary[]> {
      return adapter.sessionManager?.listSessions(cwd) ?? [];
    },
    async getTranscript(cwd: string, sessionId: string): Promise<string> {
      if (!adapter.sessionManager) return "";
      return adapter.sessionManager.getTranscript(cwd, sessionId);
    },
    async cloneSession(
      cwd: string,
      oldSessionId: string,
      newSessionId: string
    ): Promise<void> {
      if (!adapter.sessionManager) return;
      await adapter.sessionManager.cloneSession(cwd, oldSessionId, newSessionId);
    },
    async deleteSession(cwd: string, sessionId: string): Promise<void> {
      if (!adapter.sessionManager) return;
      await adapter.sessionManager.deleteSession(cwd, sessionId);
    },
    async writeAttachment(
      cwd: string,
      filename: string,
      bytes: string | Uint8Array
    ): Promise<{ path: string } | null> {
      const write = adapter.sessionManager?.writeAttachment;
      if (!write) return null;
      const base64 =
        typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("base64");
      return write.call(adapter.sessionManager, cwd, filename, base64);
    },
  };
  return adapter;
}

/** Identity of the account a profile is authenticated as. */
export interface AgentIdentity {
  /** Username / login (e.g. GitHub login). */
  login: string;
  /** Optional host (e.g. `https://github.com` or a GHE URL). */
  host?: string;
}

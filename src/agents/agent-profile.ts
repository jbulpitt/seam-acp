import type { ChildProcessByStdio } from "node:child_process";
import type { Readable as NodeReadable, Writable as NodeWritable } from "node:stream";
import type { ISessionManager } from "./session-manager.js";

/**
 * Describes how to spawn and configure an ACP-compatible coding agent.
 * Adding a new agent (Claude Code, Gemini, etc.) is a matter of writing one
 * of these and adding it to the registry.
 */
export interface AgentProfile {
  /** Stable id used in commands and DB rows ("copilot", "claude-code", …). */
  readonly id: string;

  /** Human-readable name. */
  readonly displayName: string;

  /** Default model id this agent should use unless the session overrides it. */
  readonly defaultModel: string;

  /**
   * Optional static list of models to use for this profile. When provided,
   * these override any models advertised dynamically by the agent via ACP.
   */
  readonly staticModels?: ReadonlyArray<{ modelId: string; name: string }>;

  /**
   * Optional short abbreviation displayed in thread names when the new-thread
   * wizard renames the thread after setup (e.g. "cp-fhr", "agy").
   */
  readonly threadAbbr?: string;

  /**
   * Optional config/data directory used by this profile. Profiles that
   * support multi-account isolation (Claude, Copilot) expose this so other
   * subsystems (e.g. usage fetching) can locate the right credentials file.
   */
  readonly configDir?: string;

  /** Spawn the agent as an ACP server over stdio. */
  spawn(): ChildProcessByStdio<NodeWritable, NodeReadable, NodeReadable>;

  /**
   * Optional `_meta` payload to attach to `session/new`. Lets a vendor
   * pass extra hints (e.g. effort) without polluting the generic API.
   */
  newSessionMeta?(modelId?: string): Record<string, unknown> | undefined;

  /**
   * Best-effort identity probe: which account is this profile authenticated
   * as. Read from local CLI config files — no network call. Returns `null`
   * when unknown (CLI never logged in, file missing, parse error, profile
   * doesn't support the concept).
   */
  whoami?(): Promise<AgentIdentity | null>;
  sessionManager?: ISessionManager;
}

/** Identity of the account a profile is authenticated as. */
export interface AgentIdentity {
  /** Username / login (e.g. GitHub login). */
  login: string;
  /** Optional host (e.g. `https://github.com` or a GHE URL). */
  host?: string;
}

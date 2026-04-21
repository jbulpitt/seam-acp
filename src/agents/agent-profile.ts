import type { ChildProcessByStdio } from "node:child_process";
import type { Readable as NodeReadable, Writable as NodeWritable } from "node:stream";

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

  /** Spawn the agent as an ACP server over stdio. */
  spawn(): ChildProcessByStdio<NodeWritable, NodeReadable, NodeReadable>;

  /**
   * Optional `_meta` payload to attach to `session/new`. Lets a vendor
   * pass extra hints (e.g. effort) without polluting the generic API.
   */
  newSessionMeta?(): Record<string, unknown> | undefined;

  /**
   * Best-effort identity probe: which account is this profile authenticated
   * as. Read from local CLI config files — no network call. Returns `null`
   * when unknown (CLI never logged in, file missing, parse error, profile
   * doesn't support the concept).
   */
  whoami?(): Promise<AgentIdentity | null>;
}

/** Identity of the account a profile is authenticated as. */
export interface AgentIdentity {
  /** Username / login (e.g. GitHub login). */
  login: string;
  /** Optional host (e.g. `https://github.com` or a GHE URL). */
  host?: string;
}

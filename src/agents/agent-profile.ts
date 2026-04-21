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
}

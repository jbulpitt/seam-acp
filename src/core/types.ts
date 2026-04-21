/**
 * Per-session, agent-specific settings. Stored as JSON in `sessions.config_json`.
 * Mostly mirrors the C# `SessionConfigState`, generalized for multi-agent use.
 */
export interface SessionConfigState {
  /** ACP model id (e.g. "gpt-5.4", "claude-sonnet-4.5", "auto"). */
  model?: string;
  /** ACP mode id (e.g. agent / plan / autopilot URI). */
  mode?: string;
  /** Reasoning effort for models that support it ("low" | "medium" | "high"). */
  reasoningEffort?: string;
  /** Allowlist of tool names; empty = all allowed. */
  availableTools?: string[];
  /** Blocklist of tool names. */
  excludedTools?: string[];
  /** Vendor-specific MCP server configuration (passed via ACP `_meta`). */
  mcpServers?: unknown;
  /** Per-session permission policy. */
  autoApprovePermissions?: boolean;
}

export function defaultSessionConfig(defaultModel: string): SessionConfigState {
  return { model: defaultModel };
}

/**
 * Persisted record for one chat session (one Discord thread, one Slack thread, etc.).
 * Multi-platform / multi-agent ready: keyed by composite (`platform`, `channel_ref`).
 */
export interface SessionRecord {
  /** Composite primary key: `${platform}:${channel_ref}`. */
  id: string;
  platform: string;
  channelRef: string;
  parentRef: string | null;
  agentId: string;
  acpSessionId: string;
  repoPath: string | null;
  configJson: string;
  createdUtc: string;
  updatedUtc: string;
}

/** Status panel state shown to the user during a turn. */
export type TurnState =
  | "Working"
  | "Done"
  | "Failed"
  | "Timed out"
  | "Waiting";

export interface StatusPanel {
  state: TurnState;
  repoDisplay: string;
  model: string;
  action: string;
  elapsedSeconds: number;
}

/** Result of one agent turn (reply round-trip). */
export interface TurnOutcome {
  success: boolean;
  timedOut: boolean;
  errorMessage?: string;
}

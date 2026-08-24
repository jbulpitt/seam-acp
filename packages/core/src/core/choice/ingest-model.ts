/**
 * Isolated ingest spawn cannot set arbitrary Claude model ids on this
 * account: claude-agent-acp advertises `default` / `sonnet` / `haiku` and
 * `setSessionConfigOption` exact-matches that list. A full id such as
 * `claude-opus-5` is rejected and (without strictModel) the throwaway
 * session silently continues on the adapter default.
 *
 * Live Discord threads can still pin full ids via the picker — this gate
 * is mint-time for isolated ingest only.
 */

/** Advertised ACP aliases plus the CLAUDE_MODELS full ids that are the
 *  sonnet/haiku alias targets. Opus full ids are NOT on this list — use
 *  `default` for latest Opus. */
export const ISOLATED_SAFE_CLAUDE_MODELS: ReadonlySet<string> = new Set([
  "default",
  "sonnet",
  "haiku",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
]);

export function isClaudeAgentId(agentId: string): boolean {
  const id = agentId.includes("@") ? agentId.slice(0, agentId.lastIndexOf("@")) : agentId;
  return id === "claude" || id.startsWith("claude-");
}

/** Refusal text when a pinned Claude model cannot be set on isolated ingest. */
export function isolatedClaudeModelRefusal(model: string): string {
  return (
    `Isolated ingest cannot set Claude model "${model}" on this account ` +
    `(ACP advertises default/sonnet/haiku). Use "default" for latest Opus ` +
    `(this account cannot set "${model}" on isolated ingest).`
  );
}

/**
 * When the resolved agent is Claude and a model is pinned, return an error
 * string if that model is not isolated-safe. Non-Claude agents and missing
 * model pins are not gated. Preset-backed mints skip this (fire-time).
 */
export function refuseIsolatedClaudeModel(
  agentId: string | null | undefined,
  model: string | null | undefined
): string | null {
  if (!agentId || !model) return null;
  if (!isClaudeAgentId(agentId)) return null;
  if (ISOLATED_SAFE_CLAUDE_MODELS.has(model)) return null;
  return isolatedClaudeModelRefusal(model);
}

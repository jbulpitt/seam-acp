/**
 * Retired agent ids (#12).
 *
 * An agent can be removed from the supported roster while sessions, channel
 * presets, and thread presets still name it — those live in the DB and in
 * `channel-presets.json`, neither of which this repo rewrites. Without this
 * table a retired id fails as a bare `Unknown agent profile "…"`, which is
 * indistinguishable from a typo and gives the operator nothing to act on.
 *
 * The contract is **fail clearly, never silently substitute**. A retired agent
 * does not fall back to the default agent: that would run the thread's prompts
 * on a different model than the thread was configured for, without anyone
 * asking. Instead the turn fails with a message naming the retirement and the
 * one command that fixes it. Nothing is mutated — the operator decides.
 */

export interface RetiredAgent {
  /** Human-facing name the agent had while it was supported. */
  displayName: string;
  /** Short reason, past tense, no trailing period. */
  reason: string;
}

/** Ids removed from the supported roster, with why. */
export const RETIRED_AGENTS: ReadonlyMap<string, RetiredAgent> = new Map([
  [
    "opencode",
    {
      displayName: "LM Studio 🔮",
      reason:
        "the opencode / LM Studio integration was retired in #12 — the LM Studio host served no models, " +
        "and the surface was unused",
    },
  ],
]);

/** The retirement record for `agentId`, or undefined if it is not retired. */
export function retiredAgent(agentId: string): RetiredAgent | undefined {
  return RETIRED_AGENTS.get(agentId.trim());
}

/**
 * Config-time explanation for a *setting* that names a retired agent, or null
 * when it is not retired. Distinct from `retiredAgentMessage`: nothing is bound
 * to a thread yet at boot, so this deliberately carries none of the per-session
 * "switch this thread" language.
 */
export function retiredAgentConfigMessage(setting: string, agentId: string): string | null {
  const retired = retiredAgent(agentId);
  if (!retired) return null;
  return (
    `${setting}="${agentId}" names a retired agent (${retired.displayName}): ${retired.reason}. ` +
    `Set ${setting} to a supported agent — seam-acp will not substitute one for you.`
  );
}

/**
 * Operator-facing explanation for a session still bound to a retired agent, or
 * null when `agentId` is not retired. Names the fix, because the failure is
 * only actionable if the reader knows a thread's agent is a one-command change
 * — and names its cost, because switching agents always forges a fresh ACP
 * session. The Discord thread and its messages survive; the agent's working
 * context does not.
 */
export function retiredAgentMessage(agentId: string): string | null {
  const retired = retiredAgent(agentId);
  if (!retired) return null;
  return (
    `Agent "${agentId}" (${retired.displayName}) is retired: ${retired.reason}. ` +
    `This thread is still bound to it, so it cannot start a turn. ` +
    `Pick a supported agent with \`/seam config agent\`. The Discord thread and its ` +
    `messages stay, but switching agents starts a fresh session — the previous ` +
    `conversation context is not carried over.`
  );
}

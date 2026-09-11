/** Served input budgets, not model-family windows (#291/#292). */
export interface ContextBudgetIdentity {
  agentId: string;
  location: string;
  acpSessionId: string;
  model: string;
  /** Launch request only; accepting a CLI flag does not confirm a served tier. */
  requestedTier: string | null;
}

export interface ContextBudgetObservation extends ContextBudgetIdentity {
  observedTier: string | null;
  used: number;
  promptBudget: number;
  totalWindow: number | null;
  outputAllocation: number | null;
  source: "acp-usage" | "session-usage";
  atUtc: string;
  /** Previous observation for this exact identity; exposes a smaller served limit. */
  previousPromptBudget: number | null;
}

export function matchesContextBudget(
  observed: ContextBudgetIdentity | undefined,
  expected: ContextBudgetIdentity
): boolean {
  // Prevent reuse after a provider, host, session, model or launch-tier change.
  // Removing any comparison permits a different execution's budget to leak in.
  return !!observed && observed.agentId === expected.agentId &&
    observed.location === expected.location && observed.acpSessionId === expected.acpSessionId &&
    observed.model === expected.model && observed.requestedTier === expected.requestedTier;
}

export function validContextUsage(used: number, promptBudget: number): boolean {
  // Zero used is valid (fresh/compacted session); zero/invalid limits cannot budget input.
  return Number.isFinite(used) && used >= 0 && Number.isFinite(promptBudget) && promptBudget > 0;
}

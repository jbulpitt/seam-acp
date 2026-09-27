/**
 * Holding-cost and load-cost facts for warm-set (#452).
 *
 * Measured on a representative controller host using quiet ACP trees (wrapper + descendants,
 * no nested test processes). The issue cited ~593 MB for Claude (165 wrapper +
 * 422 binary). The representative host's quiet Claude tree was 230 + 448 = 678 MiB RSS.
 * We use the number we measured so a cap cannot over-commit against RAM we
 * have actually seen a session occupy.
 *
 * Codex and Grok were measured the same way. Copilot and agy had no live
 * trees in that sample — unknown, not Claude-sized. The selector will not
 * *start* an unknown-footprint agent (already-hot ones are kept, counted at
 * the worst measured cost so we under-admit rather than OOM).
 *
 * Load cost is independent of holding cost: large Codex transcript sets make
 * session loads expensive. High-cost loads share a tighter concurrency bound.
 */
export type AgentFamily = "claude" | "codex" | "grok" | "copilot" | "agy" | "unknown";
export type LoadCost = "low" | "high";

/** Quiet-tree RSS, MiB. Null = not measured; do not invent Claude's number. */
export const HOLDING_MB: Record<AgentFamily, number | null> = {
  claude: 680,
  codex: 380,
  grok: 110,
  copilot: null,
  agy: null,
  unknown: null,
};

/** Worst measured holding cost; used only as a ceiling for already-hot unknowns. */
export const UNKNOWN_HOT_CEILING_MB = HOLDING_MB.claude!;

export function agentFamily(agentId: string): AgentFamily {
  const id = agentId.trim().toLowerCase();
  if (id === "claude" || id.startsWith("claude-")) return "claude";
  if (id === "codex" || id === "ollama-cloud") return "codex";
  if (id === "grok" || id.startsWith("grok-")) return "grok";
  if (id === "agy" || id.startsWith("agy")) return "agy";
  if (id === "copilot" || id.startsWith("copilot")) return "copilot";
  return "unknown";
}

export function holdingMb(agentId: string): number | null {
  return HOLDING_MB[agentFamily(agentId)];
}

export function loadCost(agentId: string): LoadCost {
  return agentFamily(agentId) === "codex" ? "high" : "low";
}

/** Default holding budget (MiB) for a host without an explicit override. */
export const DEFAULT_HOST_BUDGET_MB = 4_096;

export function budgetForHost(_hostId: string, overrideMb?: number): number {
  if (overrideMb != null && overrideMb > 0) return overrideMb;
  return DEFAULT_HOST_BUDGET_MB;
}

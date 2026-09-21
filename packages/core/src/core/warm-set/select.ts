/**
 * Pure warm-set packing (#452). No I/O.
 *
 * Keep already-hot sessions that fit the holding budget (newest first).
 * Evict the coldest hot ones only when they blow the budget — never a
 * mid-turn session (`busy`). Fill remaining budget with recent cold
 * sessions whose footprint is measured, up to this tick's load slots.
 * High-cost loads (Codex transcript replay) have their own slot cap so
 * one session/load hang cannot occupy every worker.
 *
 * Unknown-footprint agents are not started. Already-hot unknowns count
 * against the budget at the Claude ceiling so we under-admit.
 */
import { UNKNOWN_HOT_CEILING_MB, holdingMb, loadCost } from "./footprint.js";

export interface WarmCandidate {
  sessionId: string;
  agentId: string;
  updatedUtc: string;
  acpSessionId: string;
  hot: boolean;
  busy: boolean;
}

export type WarmAction = "keep" | "load" | "evict" | "ignore";

export interface WarmDecision {
  sessionId: string;
  action: WarmAction;
  reason: string;
  footprintMb: number;
}

export interface WarmSelectOpts {
  candidates: readonly WarmCandidate[];
  budgetMb: number;
  loadSlots: number;
  highCostLoadSlots: number;
}

export function selectWarmSet(opts: WarmSelectOpts): WarmDecision[] {
  const budget = Math.max(0, opts.budgetMb);
  const loadSlots = Math.max(0, opts.loadSlots);
  const highCostSlots = Math.max(0, opts.highCostLoadSlots);
  const byRecency = [...opts.candidates].sort((a, b) => {
    const t = b.updatedUtc.localeCompare(a.updatedUtc);
    return t !== 0 ? t : a.sessionId.localeCompare(b.sessionId);
  });

  const decisions = new Map<string, WarmDecision>();
  let used = 0;

  const costOf = (c: WarmCandidate): number => holdingMb(c.agentId) ?? UNKNOWN_HOT_CEILING_MB;

  for (const c of byRecency.filter((x) => x.hot)) {
    const mb = costOf(c);
    if (c.busy || used + mb <= budget) {
      decisions.set(c.sessionId, { sessionId: c.sessionId, action: "keep", reason: c.busy ? "mid-turn" : "already hot, fits budget", footprintMb: mb });
      used += mb;
    } else {
      decisions.set(c.sessionId, { sessionId: c.sessionId, action: "evict", reason: "hot but over holding budget", footprintMb: mb });
    }
  }

  let loads = 0;
  let highLoads = 0;
  for (const c of byRecency.filter((x) => !x.hot)) {
    if (!c.acpSessionId) {
      decisions.set(c.sessionId, { sessionId: c.sessionId, action: "ignore", reason: "no ACP session to resume", footprintMb: 0 });
      continue;
    }
    const measured = holdingMb(c.agentId);
    if (measured == null) {
      decisions.set(c.sessionId, { sessionId: c.sessionId, action: "ignore", reason: "holding cost unmeasured; not started", footprintMb: 0 });
      continue;
    }
    if (loads >= loadSlots) {
      decisions.set(c.sessionId, { sessionId: c.sessionId, action: "ignore", reason: "load slot exhausted this tick", footprintMb: measured });
      continue;
    }
    const high = loadCost(c.agentId) === "high";
    if (high && highLoads >= highCostSlots) {
      decisions.set(c.sessionId, { sessionId: c.sessionId, action: "ignore", reason: "high-cost load slot exhausted this tick", footprintMb: measured });
      continue;
    }
    if (used + measured > budget) {
      decisions.set(c.sessionId, { sessionId: c.sessionId, action: "ignore", reason: "does not fit holding budget", footprintMb: measured });
      continue;
    }
    decisions.set(c.sessionId, { sessionId: c.sessionId, action: "load", reason: "recent, measured, fits budget", footprintMb: measured });
    used += measured;
    loads += 1;
    if (high) highLoads += 1;
  }

  return byRecency.map((c) => decisions.get(c.sessionId)!).filter(Boolean);
}

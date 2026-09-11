import type Database from "better-sqlite3";
import { validContextUsage, type ContextBudgetIdentity, type ContextBudgetObservation } from "./context-budget.js";

/** Latest measurement per execution identity, including isolated/silent dispatches. */
export class ContextBudgetStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS context_budget_observations (
      agent_id TEXT NOT NULL, location TEXT NOT NULL, acp_session_id TEXT NOT NULL,
      model TEXT NOT NULL, requested_tier TEXT NOT NULL, observed_tier TEXT NOT NULL,
      observation_json TEXT NOT NULL,
      PRIMARY KEY(agent_id, location, acp_session_id, model, requested_tier, observed_tier)
    )`);
  }

  get(identity: ContextBudgetIdentity, observedTier: string | null = null): ContextBudgetObservation | undefined {
    const row = this.db.prepare(`SELECT observation_json FROM context_budget_observations
      WHERE agent_id = ? AND location = ? AND acp_session_id = ? AND model = ?
      AND requested_tier = ? AND observed_tier = ?`).get(
      identity.agentId, identity.location, identity.acpSessionId, identity.model,
      identity.requestedTier ?? "", observedTier ?? ""
    ) as { observation_json: string } | undefined;
    return row ? JSON.parse(row.observation_json) as ContextBudgetObservation : undefined;
  }

  record(input: Omit<ContextBudgetObservation, "previousPromptBudget">): ContextBudgetObservation {
    // Reject incomplete attribution/invalid telemetry; otherwise a shared or unusable budget gets cached.
    if (!input.agentId || !input.location || !input.acpSessionId || !input.model ||
        !validContextUsage(input.used, input.promptBudget)) throw new Error("Invalid context budget observation");
    // Unknown is null, not an empty tier or a non-finite dimension that JSON would silently turn into null.
    if ([input.requestedTier, input.observedTier].some(tier => tier !== null && !tier) ||
        [input.totalWindow, input.outputAllocation].some(limit =>
          limit !== null && (!Number.isFinite(limit) || limit < 0))) {
      throw new Error("Invalid context budget observation");
    }
    return this.db.transaction(() => {
      const previous = this.get(input, input.observedTier);
      const observation = { ...input, previousPromptBudget: previous?.promptBudget ?? null };
      this.db.prepare(`INSERT OR REPLACE INTO context_budget_observations VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        input.agentId, input.location, input.acpSessionId, input.model,
        input.requestedTier ?? "", input.observedTier ?? "", JSON.stringify(observation)
      );
      return observation;
    })();
  }
}

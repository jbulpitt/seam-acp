import type { CatalogApplicationMode } from "./model-catalog.js";

/** Versioned upstream policy, safe to carry in a slot's spawn configuration.
 * The requested scalar remains for older bridges. #467 owns daemon execution;
 * storing this list does NOT mean this bridge can recover an ACP session yet. */
export interface ModelFallbackPlan {
  version: 1;
  agentId: string;
  location: string;
  requestedModel: string;
  requiredContextTokens: number | null;
  alternatives: Array<{
    model: string;
    effort?: string;
    normalizedModel: string;
    applicationMode: CatalogApplicationMode;
    contextWindow: number;
    notice: string;
  }>;
}

/** RPC input is untyped. A malformed/foreign plan refuses only automatic
 * substitution, never the original scalar spawn. Future-version senders and
 * mixed-version bridges must not lose their whole execution capability. */
export function isModelFallbackPlan(value: unknown): value is ModelFallbackPlan {
  if (!value || typeof value !== "object") return false;
  const p = value as Partial<ModelFallbackPlan>;
  return p.version === 1 && typeof p.agentId === "string" && typeof p.location === "string" &&
    typeof p.requestedModel === "string" &&
    (p.requiredContextTokens === null || (typeof p.requiredContextTokens === "number" && Number.isFinite(p.requiredContextTokens) && p.requiredContextTokens >= 0)) &&
    Array.isArray(p.alternatives) && p.alternatives.every(c => c && typeof c === "object" &&
      typeof c.model === "string" && typeof c.normalizedModel === "string" && typeof c.notice === "string" &&
      (c.effort === undefined || typeof c.effort === "string") &&
      ["live", "reload", "freshSession"].includes(c.applicationMode) &&
      Number.isFinite(c.contextWindow) && c.contextWindow >= 0);
}

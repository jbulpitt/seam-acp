export const RECONSTRUCTION_BUDGET_FRACTION = 0.6;
export const OPENING_HUMAN_PROMPTS = 10;
/** Adjacent Seam-bot posts closer than this are one assistant response. */
export const ASSISTANT_FRAGMENT_GAP_MS = 10_000;

export type ReconstructionRole = "user" | "assistant";

export interface LogicalReconstructionMessage {
  id: string;
  sourcePostIds: string[];
  role: ReconstructionRole;
  authorName: string;
  timestampMs: number;
  text: string;
}

export interface ReconstructionRiders {
  channel?: string;
  thread?: string;
}

export interface ReconstructionSelection {
  opening: LogicalReconstructionMessage[];
  recent: LogicalReconstructionMessage[];
  omitted: LogicalReconstructionMessage[];
  complete: boolean;
}

export interface ReconstructionSeed {
  text: string;
  estimatedTokens: number;
  budgetTokens: number;
  contextWindow: number;
  sourcePostCount: number;
  projectedLogicalCount: number;
  retainedLogicalCount: number;
  omittedLogicalCount: number;
  omittedRawPostCount: number;
  transformSavedTokens: number;
  complete: boolean;
}

export class ReconstructionBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconstructionBudgetError";
  }
}

export class ReconstructionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconstructionUnavailableError";
  }
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function reconstructionBudgetTokens(contextWindow: number): number {
  return Math.floor(contextWindow * RECONSTRUCTION_BUDGET_FRACTION);
}

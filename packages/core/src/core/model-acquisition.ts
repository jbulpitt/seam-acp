import { isModelFallbackPlan, readErrorClassification, type ModelFallbackPlan } from "@seam/adapters";

export interface ModelAcquisitionIdentity {
  agentId: string;
  location: string;
  requestedModel: string;
  effort?: string;
  cwd: string;
  acpSessionId: string;
}

/** Seam's cursor, not bridge policy. No prompt or acceptance inference lives here. */
export interface ModelAcquisitionState {
  version: 1;
  identity: ModelAcquisitionIdentity;
  plan: ModelFallbackPlan;
  index: number;
  phase: "trying" | "selected" | "exhausted";
}

export function matchingModelAcquisition(value: unknown, identity: ModelAcquisitionIdentity): ModelAcquisitionState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const state = value as ModelAcquisitionState;
  if (state.version !== 1 || !state.identity || !isModelFallbackPlan(state.plan)
    || !Number.isSafeInteger(state.index) || state.index < 0 || state.index > state.plan.alternatives.length
    || !["trying", "selected", "exhausted"].includes(state.phase)) return undefined;
  for (const key of ["agentId", "location", "requestedModel", "effort", "cwd", "acpSessionId"] as const) {
    if (state.identity[key] !== identity[key]) return undefined;
  }
  if (state.plan.agentId !== identity.agentId || state.plan.location !== identity.location
    || state.plan.requestedModel !== identity.requestedModel) return undefined;
  return state;
}

export class ModelAcquisitionExhaustedError extends Error {
  readonly acquisitionRecoveryExhausted = true;
  constructor(cause?: unknown) {
    super("model fallback acquisition exhausted its recorded candidates; the conversation is preserved", { cause });
  }
}

/** One Seam-owned pre-prompt budget. Without the durable cursor, a restart or
 * outer boot retry replays every rejected model. Only classified model refusal
 * advances it; transport/auth failures retain their cause and current choice.
 * No operation here submits a prompt. Unknown acceptance elsewhere can never
 * authorize replay through this acquisition path. */
export async function acquireWithModelFallback<T>(input: {
  identity: ModelAcquisitionIdentity;
  plan: ModelFallbackPlan;
  saved?: ModelAcquisitionState;
  save(state: ModelAcquisitionState): void;
  acquire(model: string, effort: string | undefined): Promise<T>;
  sessionId(result: T): string;
  notice(result: T, text: string): void;
  discard(result: T): Promise<void>;
}): Promise<T> {
  let state = input.saved;
  let cause: unknown;
  if (!state) {
    try { return await input.acquire(input.identity.requestedModel, input.identity.effort); }
    catch (error) {
      if (readErrorClassification(error)?.errorKind !== "model_not_found") throw error;
      cause = error;
    }
    state = { version: 1, identity: input.identity, plan: input.plan, index: 0, phase: "trying" };
  }
  // Exhaustion is index === alternatives.length. A separate phase guard was
  // mutation-tested and redundant: the persisted cursor is the budget owner.
  for (; state.index < state.plan.alternatives.length;) {
    const candidate = state.plan.alternatives[state.index]!;
    const advance = () => {
      state = { ...state!, index: state!.index + 1, phase: "trying" };
      input.save(state);
    };
    // Refuse only a history-losing substitution. A recorded session remains
    // loadable with live/reload candidates; fresh sessions are for empty starts.
    if (state.identity.acpSessionId && candidate.applicationMode === "freshSession") { advance(); continue; }
    // A stale plan may not overrule refreshed vendor/capacity/availability facts.
    // Unknown capability still ranks normally: the existing planner owns that.
    if (!input.plan.alternatives.some(current => current.model === candidate.model
      && current.effort === candidate.effort && current.applicationMode === candidate.applicationMode)) { advance(); continue; }
    state = { ...state, phase: "trying" };
    input.save(state); // before creating a replacement child, not after success
    let result: T;
    try { result = await input.acquire(candidate.model, candidate.effort); }
    catch (error) {
      if (readErrorClassification(error)?.errorKind !== "model_not_found") throw error;
      cause = error;
      advance();
      continue;
    }
    state = { ...state, phase: "selected", identity: { ...state.identity, acpSessionId: input.sessionId(result) } };
    try { input.save(state); }
    catch (error) { await input.discard(result); throw error; }
    input.notice(result, candidate.notice);
    return result;
  }
  input.save({ ...state, phase: "exhausted" });
  throw new ModelAcquisitionExhaustedError(cause);
}

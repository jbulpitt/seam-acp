import { OPENING_HUMAN_PROMPTS, ReconstructionBudgetError, type LogicalReconstructionMessage, type ReconstructionRiders, type ReconstructionSelection } from "./types.js";
import { renderReconstructionSeed } from "./render.js";

export function selectOpeningExchanges(
  messages: readonly LogicalReconstructionMessage[],
  maxHumans = OPENING_HUMAN_PROMPTS
): LogicalReconstructionMessage[] {
  const opening: LogicalReconstructionMessage[] = [];
  let humans = 0;
  for (const message of messages) {
    if (message.role === "user") {
      if (humans >= maxHumans) break;
      humans += 1;
      opening.push(message);
      continue;
    }
    // Opening is always a chronological prefix: leading assistant fragments,
    // the first N human-led exchanges, and that last exchange's trailing
    // assistant fragments until the next human prompt.
    opening.push(message);
  }
  return opening;
}

export function selectReconstructionRanges(opts: {
  messages: readonly LogicalReconstructionMessage[];
  contextWindow: number;
  budgetTokens: number;
  riders?: ReconstructionRiders;
  sourcePostCount: number;
  transformSavedTokens?: number;
}): ReconstructionSelection {
  const messages = [...opts.messages];
  const opening = selectOpeningExchanges(messages);
  const openingIds = new Set(opening.map((m) => m.id));
  const rest = messages.filter((m) => !openingIds.has(m.id));

  const measure = (selection: ReconstructionSelection) =>
    renderReconstructionSeed({
      selection,
      riders: opts.riders,
      contextWindow: opts.contextWindow,
      budgetTokens: opts.budgetTokens,
      sourcePostCount: opts.sourcePostCount,
      transformSavedTokens: opts.transformSavedTokens ?? 0,
    }).estimatedTokens;

  const full: ReconstructionSelection = {
    opening,
    recent: rest,
    omitted: [],
    complete: true,
  };
  if (measure(full) <= opts.budgetTokens) return full;

  const emptyRecent: ReconstructionSelection = {
    opening,
    recent: [],
    omitted: rest,
    complete: false,
  };
  if (measure(emptyRecent) > opts.budgetTokens) {
    throw new ReconstructionBudgetError(
      `Rebuild opening exchanges plus instructions exceed the ${opts.budgetTokens}-token ` +
        `(60% of ${opts.contextWindow}) destination budget. Nothing was changed.`
    );
  }

  let recent: LogicalReconstructionMessage[] = [];
  let omitted = rest;
  for (let i = rest.length - 1; i >= 0; i--) {
    const trialRecent = [rest[i]!, ...recent];
    const trialOmitted = rest.slice(0, i);
    const trial: ReconstructionSelection = {
      opening,
      recent: trialRecent,
      omitted: trialOmitted,
      complete: trialOmitted.length === 0,
    };
    if (measure(trial) > opts.budgetTokens) break;
    recent = trialRecent;
    omitted = trialOmitted;
    if (trial.complete) return trial;
  }

  return { opening, recent, omitted, complete: omitted.length === 0 };
}

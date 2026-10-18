import { OPENING_PROMPTS, ReconstructionBudgetError, type LogicalReconstructionMessage, type ReconstructionRiders, type ReconstructionSelection } from "./types.js";
import { renderReconstructionSeed } from "./render.js";

export function selectOpeningExchanges(
  messages: readonly LogicalReconstructionMessage[],
  maxPrompts = OPENING_PROMPTS
): LogicalReconstructionMessage[] {
  const opening: LogicalReconstructionMessage[] = [];
  let prompts = 0;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role === "assistant") continue;
    if (prompts >= maxPrompts) break;
    prompts += 1;
    opening.push(message);
    // A terminal card bounds the whole response, including spaced progress
    // posts. Without that evidence, preserve only the first logical response.
    if (messages[i + 1]?.role === "assistant") {
      opening.push(messages[++i]!);
      while (messages[i + 1]?.role === "assistant" && message.responseEndTimestampMs != null
        && messages[i + 1]!.timestampMs <= message.responseEndTimestampMs) opening.push(messages[++i]!);
    }
  }
  return opening;
}

export function selectReconstructionRanges(opts: {
  messages: readonly LogicalReconstructionMessage[];
  contextWindow: number;
  budgetTokens: number;
  riders?: ReconstructionRiders;
  sourcePostCount: number;
  sourceName?: string;
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
      sourceName: opts.sourceName,
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

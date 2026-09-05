export * from "./types.js";
export * from "./window.js";
export * from "./project.js";
export * from "./normalize.js";
export * from "./render.js";
export * from "./select.js";

import type { LogicalReconstructionMessage } from "./types.js";
import { normalizeReconstructionMessage, type NormalizeResult } from "./normalize.js";
import { selectOpeningExchanges, selectReconstructionRanges } from "./select.js";
import { renderReconstructionSeed } from "./render.js";
import type { ReconstructionRiders, ReconstructionSeed } from "./types.js";

export function assembleReconstruction(opts: {
  messages: readonly LogicalReconstructionMessage[];
  contextWindow: number;
  budgetTokens: number;
  riders?: ReconstructionRiders;
  sourcePostCount: number;
  normalize?: (text: string, options?: { priorExactTexts?: ReadonlySet<string> }) => NormalizeResult;
  onNormalizeError?: (info: { messageId: string }) => void;
}): ReconstructionSeed {
  const opening = selectOpeningExchanges(opts.messages);
  const openingIds = new Set(opening.map((m) => m.id));
  const prior = new Set<string>();
  for (const message of opening) prior.add(message.text);
  const normalize = opts.normalize ?? normalizeReconstructionMessage;

  let savedChars = 0;
  const prepared = opts.messages.map((message) => {
    if (openingIds.has(message.id)) return message;
    try {
      const normalized = normalize(message.text, { priorExactTexts: prior });
      savedChars += normalized.savedChars;
      prior.add(message.text);
      return { ...message, text: normalized.text };
    } catch {
      opts.onNormalizeError?.({ messageId: message.id });
      prior.add(message.text);
      return message;
    }
  });

  const selection = selectReconstructionRanges({
    messages: prepared,
    contextWindow: opts.contextWindow,
    budgetTokens: opts.budgetTokens,
    riders: opts.riders,
    sourcePostCount: opts.sourcePostCount,
    transformSavedTokens: Math.ceil(savedChars / 4),
  });

  return renderReconstructionSeed({
    selection,
    riders: opts.riders,
    contextWindow: opts.contextWindow,
    budgetTokens: opts.budgetTokens,
    sourcePostCount: opts.sourcePostCount,
    transformSavedTokens: Math.ceil(savedChars / 4),
  });
}

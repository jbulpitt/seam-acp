import {
  estimateTokens,
  type LogicalReconstructionMessage,
  type ReconstructionRiders,
  type ReconstructionSelection,
  type ReconstructionSeed,
} from "./types.js";

export const RECONSTRUCTION_INSTRUCTIONS = [
  "This is a deterministic reconstruction from Discord, not an AI-generated summary.",
  "Inspect the opening exchanges for directives and context-loading instructions.",
  "If a reconstruction boundary appears, it is intentional; the original Discord thread remains authoritative.",
  "Use the recent exchanges to continue seamlessly.",
  "Acknowledge loading in one line and wait for the next instruction. Do not begin work autonomously.",
].join(" ");

export function renderLogicalMessage(message: LogicalReconstructionMessage): string {
  const heading =
    message.role === "user" ? `Human — ${message.authorName}` : "Assistant — Seam";
  return `${heading}\n\n${message.text}`;
}

export function formatOmissionMarker(opts: {
  logicalCount: number;
  rawPostCount: number;
}): string {
  return (
    `Session reconstruction boundary: ${opts.logicalCount} logical messages ` +
    `(${opts.rawPostCount} Discord posts) were omitted here to fit the destination ` +
    `model's context budget. The original Discord thread remains authoritative.`
  );
}

export function renderReconstructionSeed(opts: {
  selection: ReconstructionSelection;
  riders?: ReconstructionRiders;
  contextWindow: number;
  budgetTokens: number;
  sourcePostCount: number;
  transformSavedTokens: number;
}): ReconstructionSeed {
  const { selection } = opts;
  const body = selection.complete
    ? [...selection.opening, ...selection.recent].map(renderLogicalMessage).join("\n\n")
    : [
        selection.opening.length
          ? `## Opening exchanges\n\n${selection.opening.map(renderLogicalMessage).join("\n\n")}`
          : "",
        `## Reconstruction boundary\n\n${formatOmissionMarker({
          logicalCount: selection.omitted.length,
          rawPostCount: selection.omitted.reduce((n, m) => n + m.sourcePostIds.length, 0),
        })}`,
        selection.recent.length
          ? `## Recent exchanges\n\n${selection.recent.map(renderLogicalMessage).join("\n\n")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");

  const riderBlocks = [
    opts.riders?.channel ? `## Channel rider\n\n${opts.riders.channel}` : "",
    opts.riders?.thread ? `## Thread rider\n\n${opts.riders.thread}` : "",
  ].filter(Boolean);

  const text = [
    RECONSTRUCTION_INSTRUCTIONS,
    ...riderBlocks,
    body,
  ]
    .filter(Boolean)
    .join("\n\n");

  const retained = selection.complete
    ? selection.opening.length + selection.recent.length
    : selection.opening.length + selection.recent.length;
  const projected = retained + selection.omitted.length;

  return {
    text,
    estimatedTokens: estimateTokens(text),
    budgetTokens: opts.budgetTokens,
    contextWindow: opts.contextWindow,
    sourcePostCount: opts.sourcePostCount,
    projectedLogicalCount: projected,
    retainedLogicalCount: retained,
    omittedLogicalCount: selection.omitted.length,
    omittedRawPostCount: selection.omitted.reduce((n, m) => n + m.sourcePostIds.length, 0),
    transformSavedTokens: opts.transformSavedTokens,
    complete: selection.complete,
  };
}

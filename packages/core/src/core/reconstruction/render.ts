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
    message.role === "user" ? `Human — ${message.authorName}`
      : message.role === "prompt" ? `Prompt — ${message.authorName}` : "Assistant — Seam";
  return `${heading}\n\n${message.text}`;
}

export function formatOmissionMarker(opts: {
  logicalCount: number;
  rawPostCount: number;
  sourceName?: string;
}): string {
  const source = opts.sourceName ?? "Discord";
  return (
    `Session reconstruction boundary: ${opts.logicalCount} logical messages ` +
    `(${opts.rawPostCount} ${source} posts) were omitted here to fit the destination ` +
    `model's context budget. The original ${source} thread remains authoritative.`
  );
}

export function renderReconstructionSeed(opts: {
  selection: ReconstructionSelection;
  riders?: ReconstructionRiders;
  contextWindow: number;
  budgetTokens: number;
  sourcePostCount: number;
  transformSavedTokens: number;
  sourceName?: string;
}): ReconstructionSeed {
  const { selection } = opts;
  const ordered = [...selection.opening, ...selection.recent, ...selection.omitted]
    .sort((a, b) => a.timestampMs - b.timestampMs || a.id.localeCompare(b.id));
  const openingIds = new Set(selection.opening.map(message => message.id));
  const omittedIds = new Set(selection.omitted.map(message => message.id));
  const blocks: string[] = [];
  let group: LogicalReconstructionMessage[] = [];
  let section: "opening" | "recent" | "omitted" | undefined;
  const flush = () => {
    if (!group.length) return;
    blocks.push(section === "omitted"
      ? `## Reconstruction boundary\n\n${formatOmissionMarker({
          logicalCount: group.length,
          rawPostCount: group.reduce((n, message) => n + message.sourcePostIds.length, 0),
          sourceName: opts.sourceName,
        })}`
      : `## ${section === "opening" ? "Opening" : "Recent"} exchanges\n\n${group.map(renderLogicalMessage).join("\n\n")}`);
    group = [];
  };
  if (!selection.complete) {
    for (const message of ordered) {
      const next = omittedIds.has(message.id) ? "omitted" : openingIds.has(message.id) ? "opening" : "recent";
      if (next !== section) flush();
      section = next;
      group.push(message);
    }
    flush();
  }
  const body = selection.complete
    ? ordered.map(renderLogicalMessage).join("\n\n")
    : blocks.join("\n\n");

  const riderBlocks = [
    opts.riders?.channel ? `## Channel rider\n\n${opts.riders.channel}` : "",
    opts.riders?.thread ? `## Thread rider\n\n${opts.riders.thread}` : "",
  ].filter(Boolean);

  const text = [
    RECONSTRUCTION_INSTRUCTIONS.replaceAll("Discord", opts.sourceName ?? "Discord"),
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

/**
 * The premium-compaction prompt suite (docs/premium-compaction-design.md §6).
 *
 * Each stage's output is the next stage's input, so the contracts must line up.
 * seam-acp runs these in temp AgentRuntimes (not the schema-enforced Workflow
 * tool), so structured stages instruct the model to emit ONLY a JSON object;
 * `parseJsonOutput` tolerates code-fence wrapping. Prose stages (synthesizer)
 * return markdown directly.
 *
 * These are first drafts pending empirical tuning against a real heavy session
 * (design §10). Treat the wording as adjustable; treat the CONTRACTS as the
 * stable interface the pipeline depends on.
 */

// ---------------------------------------------------------------------------
// Shared output-contract documentation, embedded in prompts so the model knows
// exactly what shape to emit. (Kept as strings, not just types, because the
// model reads them.)
// ---------------------------------------------------------------------------

const JSON_ONLY =
  "Output ONLY a single JSON object — no prose, no markdown fences, no commentary before or after.";

/** Strip code fences / leading prose and parse the first JSON object found. */
export function parseJsonOutput<T = unknown>(raw: string): T {
  let s = raw.trim();
  // Strip ```json ... ``` or ``` ... ``` fences.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1]!.trim();
  // If there's leading prose, grab from the first { to the last }.
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first > 0 || last < s.length - 1) {
    if (first !== -1 && last !== -1 && last > first) s = s.slice(first, last + 1);
  }
  return JSON.parse(s) as T;
}

// ---------------------------------------------------------------------------
// (1) Chunk analyzer
// ---------------------------------------------------------------------------

export interface ChunkAnalysis {
  chunkIndex: number;
  timeRange?: { fromTs?: string; toTs?: string };
  topics: string[];
  decisions: Array<{ what: string; why: string; anchorTs?: string }>;
  userCorrections: Array<{ quote: string; trigger?: string; anchorTs?: string }>;
  selfCoachedRules: Array<{ rule: string; anchorTs?: string }>;
  openThreads: string[];
  toolFindings: Array<{ finding: string; anchorTs?: string }>;
  notableQuotes: Array<{ quote: string; anchorTs?: string }>;
}

export function chunkAnalyzerPrompt(chunk: {
  index: number;
  firstTs?: string;
  lastTs?: string;
  text: string;
}): string {
  return `You are analyzing ONE chunk of a longer agent work session for a high-fidelity compaction. Your job is not to summarize for brevity — it is to *index* this chunk so a later stage can decide what must be preserved.

The chunk uses one event per line, anchored with [ISO timestamp]:
  USER: …   ASSISTANT: …   THINKING: …   TOOL name(input) → finding

Extract, attaching an approximate anchor timestamp to each item where possible:
- topics: the threads of work in this chunk
- decisions: {what was decided, why}
- userCorrections: terse or explicit user corrections/coaching — INCLUDE the agent activity that triggered each (a reaction is meaningless without its trigger). Quote the user verbatim.
- selfCoachedRules: rules/decisions the agent reasoned out in THINKING that may never appear in a visible message
- openThreads: unresolved or in-progress items
- toolFindings: tool results that CHANGED the course of work (the finding, not the raw output)
- notableQuotes: short verbatim quotes that are load-bearing

Be exhaustive over signal; ignore only pure noise that drove no decision.

${JSON_ONLY} Shape:
{"chunkIndex": ${chunk.index}, "timeRange": {"fromTs": "${chunk.firstTs ?? ""}", "toTs": "${chunk.lastTs ?? ""}"}, "topics": [], "decisions": [{"what":"","why":"","anchorTs":""}], "userCorrections": [{"quote":"","trigger":"","anchorTs":""}], "selfCoachedRules": [{"rule":"","anchorTs":""}], "openThreads": [], "toolFindings": [{"finding":"","anchorTs":""}], "notableQuotes": [{"quote":"","anchorTs":""}]}

=== CHUNK ${chunk.index} (${chunk.firstTs ?? "?"} → ${chunk.lastTs ?? "?"}) ===
${chunk.text}`;
}

// ---------------------------------------------------------------------------
// (2) Meta-analyzer / reducer  (keystone)
// ---------------------------------------------------------------------------

export interface MetaAnalysis {
  purpose: string;
  milestones: string[];
  decisions: Array<{ what: string; why: string }>;
  lessonsLearned: string[];
  openThreads: string[];
  recencyWeighting: string;
  riskChecklist: Array<{ item: string; whereBestSourced: "session" | "discord" | "both"; severity: "low" | "medium" | "high" }>;
  deepDiveTargets: Array<{ fromTs?: string; toTs?: string; source: "session" | "discord"; why: string; depth: "normal" | "deep" }>;
}

export function metaAnalyzerPrompt(args: {
  chunkAnalyses: ChunkAnalysis[];
  gapSignals: string[];
  discordRanges: Array<{ toTs?: string; fromTs?: string; reason: string }>;
  thinkingAvailable: boolean;
}): string {
  return `You are consolidating per-chunk analyses of ONE work session into a single structured picture, and producing a work-list for detailed extraction. Premium compaction was explicitly chosen for this session — assume thoroughness matters more than token cost.

De-dupe and organize into: the session's original purpose; key milestones; major decisions (with rationale); valuable lessons learned; still-open threads. Decide whether recent activity deserves extra weight, or some other region does, and say which.

Then produce a RISK CHECKLIST: every item whose loss of sharpness would be costly, each tagged with where it is best sourced (session / discord / both) and a severity.

Finally, emit DEEP-DIVE TARGETS — the timestamp ranges worth a detailed second read. Cover the WHOLE session (every region gets a target); set depth "deep" for the highest-risk regions and "normal" for routine ones, but never omit a region. For ranges flagged below as Discord-preferred, set source "discord"; otherwise "session".

${args.thinkingAvailable ? "Thinking was captured in cleartext for this session — mine selfCoachedRules carefully." : "NOTE: thinking was redacted/unavailable for this session — do not expect self-coached rules; rely on messages + tool activity."}

Gap signals detected: ${args.gapSignals.join("; ") || "none"}
Discord-preferred ranges (session is lossy/absent here): ${JSON.stringify(args.discordRanges)}

${JSON_ONLY} Shape:
{"purpose":"","milestones":[],"decisions":[{"what":"","why":""}],"lessonsLearned":[],"openThreads":[],"recencyWeighting":"","riskChecklist":[{"item":"","whereBestSourced":"session","severity":"high"}],"deepDiveTargets":[{"fromTs":"","toTs":"","source":"session","why":"","depth":"deep"}]}

=== CHUNK ANALYSES ===
${JSON.stringify(args.chunkAnalyses, null, 1)}`;
}

// ---------------------------------------------------------------------------
// (3) Deep-dive extractor  (un-gated; one per region)
// ---------------------------------------------------------------------------

export interface DeepDive {
  timeRange?: { fromTs?: string; toTs?: string };
  narrative: string;
  causalPairs: Array<{ activity: string; userResponse: string }>;
  selfCoachedRules: string[];
  userCorrections: string[];
  decisions: Array<{ what: string; why: string }>;
  artifacts: string[];
}

export function deepDivePrompt(args: {
  fromTs?: string;
  toTs?: string;
  depth: "normal" | "deep";
  source: "session" | "discord";
  text: string;
}): string {
  return `Produce a faithful, detailed rendering of THIS region of the work session — enough that a fresh agent could resume the work without re-reading the original. Treatment depth: ${args.depth.toUpperCase()}. Source: ${args.source}.

Capture especially:
- causalPairs: agent activity + the user interjection that reacted to it. Keep the user side VERBATIM, with enough trigger context to understand WHY it was said.
- selfCoachedRules: rules the agent reasoned out in thinking (if any present).
- userCorrections: user corrections/coaching, VERBATIM.
- decisions: concrete decisions + rationale.
- artifacts: durable items — file paths, IDs, commands, constraints, config values.

Compress raw tool output to the finding it produced; never drop a finding that changed the work. Match the established voice in the narrative.

${JSON_ONLY} Shape:
{"timeRange":{"fromTs":"${args.fromTs ?? ""}","toTs":"${args.toTs ?? ""}"},"narrative":"","causalPairs":[{"activity":"","userResponse":""}],"selfCoachedRules":[],"userCorrections":[],"decisions":[{"what":"","why":""}],"artifacts":[]}

=== REGION (${args.fromTs ?? "?"} → ${args.toTs ?? "?"}) ===
${args.text}`;
}

// ---------------------------------------------------------------------------
// (4) Synthesizer  (prose / markdown output)
// ---------------------------------------------------------------------------

export function synthesizerPrompt(args: {
  meta: MetaAnalysis;
  deepDives: DeepDive[];
  pinnedFacts: PinnedFacts;
}): string {
  return `Assemble the deep-dive extractions and the meta-analysis into the session's RESUMPTION SUMMARY — a working brief a fresh agent reads to continue the work seamlessly. Favor specificity over narrative.

Structure it EXACTLY as these markdown sections (and ONLY these):
## Purpose
## Current state
## Open threads
## Decisions & rationale

Do NOT add a pinned-constraints section — the verbatim pinned facts are appended
to the session separately and must not be paraphrased here. Do NOT restate a
verbatim recent-message window — it is also appended separately. Output the
markdown directly (no JSON, no fences). The pinned facts are provided below only
as context so your prose is consistent with them — reference them naturally, do
not reproduce them as a list.

=== META-ANALYSIS ===
${JSON.stringify(args.meta, null, 1)}

=== DEEP DIVES ===
${JSON.stringify(args.deepDives, null, 1)}

=== PINNED FACTS (context only — do NOT reproduce as a section) ===
${JSON.stringify(args.pinnedFacts, null, 1)}`;
}

// ---------------------------------------------------------------------------
// (5) Completeness critic  (inverted gate — additive only)
// ---------------------------------------------------------------------------

export interface CritiqueResult {
  verdicts: Array<{ checklistItem: string; preserved: boolean; evidence: string }>;
  recoveries: Array<{ fromTs?: string; toTs?: string; source: "session" | "discord"; what: string }>;
}

export function completenessCriticPrompt(args: {
  summaryMarkdown: string;
  riskChecklist: MetaAnalysis["riskChecklist"];
}): string {
  return `Audit this compaction against the risk checklist. For EACH checklist item, decide whether the summary preserves it with enough fidelity to resume safely, citing where in the summary. For any item that thinned out or vanished, emit a targeted recovery request (which time range + source to re-read, and what to recover).

Default to "not preserved" when uncertain — a false miss is cheap to re-check; a real loss is not.

${JSON_ONLY} Shape:
{"verdicts":[{"checklistItem":"","preserved":true,"evidence":""}],"recoveries":[{"fromTs":"","toTs":"","source":"session","what":""}]}

=== RISK CHECKLIST ===
${JSON.stringify(args.riskChecklist, null, 1)}

=== COMPACTION SUMMARY ===
${args.summaryMarkdown}`;
}

// ---------------------------------------------------------------------------
// (6) Pinned-facts extractor  (shared with default tier)
// ---------------------------------------------------------------------------

export interface PinnedFacts {
  corrections: string[];
  constraints: string[];
  decisions: string[];
  openTodos: string[];
  activePaths: string[];
  rules: string[];
}

export function pinnedFactsPrompt(args: { text: string; thinkingAvailable: boolean }): string {
  return `Extract ONLY the load-bearing, must-not-lose facts from this session, VERBATIM. Quote exactly — never paraphrase.

Include:
- corrections: explicit user corrections/coaching ("never do X", "always do Y", "here is the fact you kept missing")
- constraints: active constraints that govern the work
- decisions: firm decisions already made
- openTodos: explicit unfinished tasks
- activePaths: active file paths / IDs / commands / config values in play
- rules: ${args.thinkingAvailable ? "rules the agent coached itself on in thinking" : "(thinking unavailable for this session — derive only from messages)"}

If a category is large, order by how costly each item would be to lose and keep the highest-cost ones.

${JSON_ONLY} Shape:
{"corrections":[],"constraints":[],"decisions":[],"openTodos":[],"activePaths":[],"rules":[]}

=== SESSION ===
${args.text}`;
}

// ---------------------------------------------------------------------------
// (8) Session-seed / pre-warm framing  (assembled artifact, not an LLM call)
// ---------------------------------------------------------------------------

export function preWarmFraming(): string {
  return [
    "[Context — the user does not see this message and expects to continue seamlessly.]",
    "Your session was compacted to free context. Below is a faithful summary of the work so far,",
    "the must-preserve constraints, and the most recent exchanges verbatim. Resume as if no",
    "interruption occurred — do not re-introduce yourself or re-ask what you were doing.",
  ].join(" ");
}

/** Assemble the final new-session seed text (design §7). */
export function assembleNewSession(args: {
  summaryMarkdown: string;
  pinnedFacts: PinnedFacts;
  recentVerbatim: string;
}): string {
  const pinned = [
    "## Pinned constraints (verbatim)",
    ...args.pinnedFacts.corrections.map((c) => `- CORRECTION: ${c}`),
    ...args.pinnedFacts.constraints.map((c) => `- CONSTRAINT: ${c}`),
    ...args.pinnedFacts.rules.map((c) => `- RULE: ${c}`),
    ...args.pinnedFacts.openTodos.map((c) => `- TODO: ${c}`),
    ...args.pinnedFacts.activePaths.map((c) => `- ACTIVE: ${c}`),
  ].join("\n");

  return [
    preWarmFraming(),
    "",
    args.summaryMarkdown,
    "",
    pinned,
    "",
    "--- Recent context (verbatim) ---",
    args.recentVerbatim,
  ].join("\n");
}

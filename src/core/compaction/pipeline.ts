/**
 * Premium-compaction pipeline (docs/premium-compaction-design.md §4).
 *
 * Orchestrates the fan-out → reduce → fan-out → synthesize → critic flow over
 * the richest-source history + (where the gap-detector says) Discord ranges.
 *
 * Decoupled from AgentRuntime: the caller injects `runAgent(prompt) => text`
 * (the orchestrator wraps temp-runtime spawning). This keeps the pipeline pure
 * and structure-testable with a mock runner before it spends a real LLM call.
 * End-to-end fidelity is proven separately by the §10 tuning loop.
 */

import { chunkHistory, renderHistory, type HistoryEvent, type RichHistory } from "./source-reader.js";
import type { GapReport } from "./gap-detector.js";
import {
  chunkAnalyzerPrompt,
  metaAnalyzerPrompt,
  deepDivePrompt,
  synthesizerPrompt,
  completenessCriticPrompt,
  pinnedFactsPrompt,
  assembleNewSession,
  parseJsonOutput,
  type ChunkAnalysis,
  type MetaAnalysis,
  type DeepDive,
  type CritiqueResult,
  type PinnedFacts,
} from "./prompts.js";

/** Injected agent runner: given a prompt, return the agent's text reply. */
export type RunAgent = (prompt: string, label: string) => Promise<string>;

export interface PremiumCompactionInput {
  richHistory: RichHistory;
  gapReport: GapReport;
  /** Rendered Discord text for the ranges the gap-detector flagged, if any. */
  discordText?: string;
  runAgent: RunAgent;
  /** Max concurrent agent calls in a fan-out stage. */
  concurrency?: number;
  /** Token budget for the verbatim recent window kept in the new session. */
  recentWindowTokens?: number;
  log?: (msg: string) => void;
}

export interface PremiumCompactionResult {
  summaryMarkdown: string;
  pinnedFacts: PinnedFacts;
  meta: MetaAnalysis;
  critique: CritiqueResult;
  /** The full text to seed the new session with. */
  assembledSeed: string;
  stats: {
    chunks: number;
    deepDives: number;
    checklistItems: number;
    unpreservedItems: number;
    recoveriesRequested: number;
  };
}

/** Bounded-concurrency map. Preserves order; a thrown task rejects the whole
 *  run (the caller decides whether to keep the original session). */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Render the last events that fit a token budget, for the verbatim window. */
function recentVerbatim(events: HistoryEvent[], budgetTokens: number): string {
  const budgetChars = budgetTokens * 4;
  const kept: HistoryEvent[] = [];
  let chars = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    const len = renderHistory([e]).length + 2;
    if (chars + len > budgetChars && kept.length > 0) break;
    kept.unshift(e);
    chars += len;
  }
  return renderHistory(kept);
}

export async function runPremiumCompaction(
  input: PremiumCompactionInput
): Promise<PremiumCompactionResult> {
  const {
    richHistory,
    gapReport,
    discordText,
    runAgent,
    concurrency = 6,
    recentWindowTokens = 12_000,
    log = () => {},
  } = input;

  const fullText = renderHistory(richHistory.events);
  const thinkingAvailable = richHistory.stats.thinkingAvailable;

  // --- Stage 1: chunk + analyze (fan-out) -------------------------------------
  const chunks = chunkHistory(richHistory.events);
  log(`analyzing ${chunks.length} chunk(s)`);
  const chunkAnalyses = await mapLimit(chunks, concurrency, async (c, i) => {
    const raw = await runAgent(chunkAnalyzerPrompt(c), `chunk-${i}`);
    return parseJsonOutput<ChunkAnalysis>(raw);
  });

  // --- Stage 2: meta-analyze (reduce) -----------------------------------------
  log("meta-analyzing");
  const metaRaw = await runAgent(
    metaAnalyzerPrompt({
      chunkAnalyses,
      gapSignals: gapReport.signals.map((s) => `${s.kind}: ${s.detail}`),
      discordRanges: gapReport.discordRanges,
      thinkingAvailable,
    }),
    "meta"
  );
  const meta = parseJsonOutput<MetaAnalysis>(metaRaw);

  // --- Stage 3: deep-dive every target (fan-out, UN-GATED) --------------------
  const targets = meta.deepDiveTargets ?? [];
  log(`deep-diving ${targets.length} region(s)`);
  const deepDives = await mapLimit(targets, concurrency, async (t, i) => {
    // Choose the text for the region: Discord text when the meta says so and we
    // have it; otherwise the session render. (Region slicing by timestamp is a
    // build-time refinement; v1 hands the relevant whole-source text.)
    const text = t.source === "discord" && discordText ? discordText : fullText;
    const raw = await runAgent(
      deepDivePrompt({ fromTs: t.fromTs, toTs: t.toTs, depth: t.depth, source: t.source, text }),
      `deepdive-${i}`
    );
    return parseJsonOutput<DeepDive>(raw);
  });

  // --- Pinned facts (shared) --------------------------------------------------
  log("extracting pinned facts");
  const pinnedRaw = await runAgent(pinnedFactsPrompt({ text: fullText, thinkingAvailable }), "pinned");
  const pinnedFacts = parseJsonOutput<PinnedFacts>(pinnedRaw);

  // --- Stage 4: synthesize ----------------------------------------------------
  log("synthesizing");
  const summaryMarkdown = (
    await runAgent(synthesizerPrompt({ meta, deepDives, pinnedFacts }), "synthesize")
  ).trim();

  // --- Stage 5: completeness critic (inverted gate) ---------------------------
  log("verifying completeness");
  const critiqueRaw = await runAgent(
    completenessCriticPrompt({ summaryMarkdown, riskChecklist: meta.riskChecklist ?? [] }),
    "critic"
  );
  const critique = parseJsonOutput<CritiqueResult>(critiqueRaw);

  // Assemble the new-session seed (verbatim recent window appended).
  const assembledSeed = assembleNewSession({
    summaryMarkdown,
    pinnedFacts,
    recentVerbatim: recentVerbatim(richHistory.events, recentWindowTokens),
  });

  return {
    summaryMarkdown,
    pinnedFacts,
    meta,
    critique,
    assembledSeed,
    stats: {
      chunks: chunks.length,
      deepDives: deepDives.length,
      checklistItems: (meta.riskChecklist ?? []).length,
      unpreservedItems: (critique.verdicts ?? []).filter((v) => !v.preserved).length,
      recoveriesRequested: (critique.recoveries ?? []).length,
    },
  };
}

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
  mergePinnedFacts,
  JSON_REPARSE_INSTRUCTION,
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
  /** Per-chunk token budget for the pinned-facts pass. Kept well under the
   *  standard 200K context window so the pass NEVER makes one giant call (which
   *  both forces the credit-gated 1M tier and is the run's fragile long-pole).
   *  Each chunk is extracted independently and the results are merged. */
  pinnedChunkTokens?: number;
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

/** Run a structured stage with one corrective retry. The dominant real-run
 *  failure is an unescaped `"` inside a long free-text field (e.g. a deep-dive
 *  narrative), which corrupts the whole object's brace-balance and makes it
 *  unparseable. On the first parse failure we re-prompt once, appending an
 *  explicit "re-emit as valid JSON, escape interior quotes" instruction — the
 *  standard self-heal. Throws only if the retry also fails. */
async function runStructured<T>(
  runAgent: RunAgent,
  prompt: string,
  label: string,
  log: (msg: string) => void
): Promise<T> {
  const raw = await runAgent(prompt, label);
  try {
    return parseJsonOutput<T>(raw);
  } catch (err) {
    log(`  [${label}] parse failed (${(err as Error).message.slice(0, 80)}); retrying`);
    const retryPrompt = `${prompt}\n\n${JSON_REPARSE_INSTRUCTION}`;
    const raw2 = await runAgent(retryPrompt, `${label}-retry`);
    return parseJsonOutput<T>(raw2);
  }
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

/** Render only the events within [fromTs, toTs] (inclusive). Open-ended when a
 *  bound is undefined. Used to give each deep-dive just its region instead of
 *  the whole history. */
function sliceByRange(events: HistoryEvent[], fromTs?: string, toTs?: string): string {
  const from = fromTs ? Date.parse(fromTs) : -Infinity;
  const to = toTs ? Date.parse(toTs) : Infinity;
  const inRange = events.filter((e) => e.ts === 0 || (e.ts >= from && e.ts <= to));
  return renderHistory(inRange.length ? inRange : events);
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
    pinnedChunkTokens = 120_000,
    log = () => {},
  } = input;

  const thinkingAvailable = richHistory.stats.thinkingAvailable;

  // --- Stage 1: chunk + analyze (fan-out) -------------------------------------
  const chunks = chunkHistory(richHistory.events);
  log(`analyzing ${chunks.length} chunk(s)`);
  const chunkAnalyses = await mapLimit(chunks, concurrency, (c, i) =>
    runStructured<ChunkAnalysis>(runAgent, chunkAnalyzerPrompt(c), `chunk-${i}`, log)
  );

  // --- Stage 2: meta-analyze (reduce) -----------------------------------------
  log("meta-analyzing");
  const meta = await runStructured<MetaAnalysis>(
    runAgent,
    metaAnalyzerPrompt({
      chunkAnalyses,
      gapSignals: gapReport.signals.map((s) => `${s.kind}: ${s.detail}`),
      discordRanges: gapReport.discordRanges,
      thinkingAvailable,
    }),
    "meta",
    log
  );

  // --- Stage 3: deep-dive every target (fan-out, UN-GATED) --------------------
  const targets = meta.deepDiveTargets ?? [];
  log(`deep-diving ${targets.length} region(s)`);
  const deepDives = await mapLimit(targets, concurrency, async (t, i) => {
    // Give each deep-dive only its region: Discord text when the meta flagged
    // this range Discord-preferred and we have it; otherwise the session events
    // sliced to the target's timestamp range.
    const text =
      t.source === "discord" && discordText
        ? discordText
        : sliceByRange(richHistory.events, t.fromTs, t.toTs);
    const prompt = deepDivePrompt({ fromTs: t.fromTs, toTs: t.toTs, depth: t.depth, source: t.source, text });
    try {
      return await runStructured<DeepDive>(runAgent, prompt, `deepdive-${i}`, log);
    } catch (err) {
      // Deep-dives are independent regions. One unrecoverable region must NOT
      // abort the whole (multi-minute) run — degrade it to a stub the
      // synthesizer can note, and let the completeness critic flag any gap.
      log(`  [deepdive-${i}] UNRECOVERABLE after retry (${(err as Error).message.slice(0, 80)}); stubbing region`);
      return {
        timeRange: { fromTs: t.fromTs, toTs: t.toTs },
        narrative: `[deep-dive failed to parse for region ${t.fromTs ?? "?"} → ${t.toTs ?? "?"}; this region was not extracted]`,
        causalPairs: [],
        selfCoachedRules: [],
        userCorrections: [],
        decisions: [],
        artifacts: [],
      } satisfies DeepDive;
    }
  });

  // --- Pinned facts (shared) — chunked fan-out + merge ------------------------
  // Extract verbatim facts per ~120K-token chunk in parallel, then union them.
  // This keeps every call under the standard 200K window (no 1M-tier dependency,
  // no single fragile mega-call) while reconstructing the single-pass result.
  const pinnedChunks = chunkHistory(richHistory.events, pinnedChunkTokens);
  log(`extracting pinned facts (${pinnedChunks.length} chunk(s))`);
  const pinnedParts = await mapLimit(pinnedChunks, concurrency, (c, i) =>
    runStructured<PinnedFacts>(
      runAgent,
      pinnedFactsPrompt({ text: c.text, thinkingAvailable }),
      `pinned-${i}`,
      log
    )
  );
  const pinnedFacts = mergePinnedFacts(pinnedParts);

  // --- Stage 4: synthesize ----------------------------------------------------
  log("synthesizing");
  const summaryMarkdown = (
    await runAgent(synthesizerPrompt({ meta, deepDives, pinnedFacts }), "synthesize")
  ).trim();

  // --- Stage 5: completeness critic (inverted gate) ---------------------------
  log("verifying completeness");
  const critique = await runStructured<CritiqueResult>(
    runAgent,
    completenessCriticPrompt({ summaryMarkdown, riskChecklist: meta.riskChecklist ?? [] }),
    "critic",
    log
  );

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

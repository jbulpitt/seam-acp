/**
 * Premium-compaction pipeline (docs/premium-compaction-design.md §4).
 *
 * Orchestrates the simplified fan-out compaction flow:
 * Partitions history into verbatim Head (10%), verbatim Tail (20%), and Middle (70%).
 * Chunks the Middle dynamically (120KB default, max 12 chunks) and summarizes in parallel.
 * Re-integrates the verbatim Head, Middle chunk summaries, verbatim Tail, and verbatim Pinned Facts.
 *
 * Isolated to the premium compaction offering only.
 */

import { chunkHistory, renderHistory, type HistoryEvent, type RichHistory } from "./source-reader.js";
import type { GapReport } from "./gap-detector.js";
import {
  pinnedFactsPrompt,
  assembleNewSession,
  parseJsonOutput,
  mergePinnedFacts,
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
  /** Per-chunk token budget for the pinned-facts pass. */
  pinnedChunkTokens?: number;
  /** Hard per-call input budget (est. tokens). */
  maxCallTokens?: number;
  log?: (msg: string) => void;
}

export interface PremiumCompactionResult {
  summaryMarkdown: string;
  pinnedFacts: PinnedFacts;
  /** The full text to seed the new session with. */
  assembledSeed: string;
  stats: {
    chunks: number;
  };
}

// --- helpers ----------------------------------------------------------------

/**
 * Partition events into head, middle, and tail arrays based on character budget
 * (10% head, 20% tail, 70% middle).
 */
function partitionHistory(
  events: HistoryEvent[],
  headPercent = 0.1,
  tailPercent = 0.2
): { head: HistoryEvent[]; middle: HistoryEvent[]; tail: HistoryEvent[] } {
  // Estimate size of each event
  const eventSizes = events.map(e => renderHistory([e]).length + 2);
  const totalChars = eventSizes.reduce((s, x) => s + x, 0);

  const headBudget = totalChars * headPercent;
  const tailBudget = totalChars * tailPercent;

  let headEndIndex = 0;
  let headSum = 0;
  for (let i = 0; i < events.length; i++) {
    const size = eventSizes[i]!;
    if (headSum + size > headBudget && i > 0) {
      break;
    }
    headSum += size;
    headEndIndex = i + 1;
  }

  let tailStartIndex = events.length;
  let tailSum = 0;
  for (let i = events.length - 1; i >= headEndIndex; i--) {
    const size = eventSizes[i]!;
    if (tailSum + size > tailBudget && i < events.length - 1) {
      break;
    }
    tailSum += size;
    tailStartIndex = i;
  }

  const head = events.slice(0, headEndIndex);
  const middle = events.slice(headEndIndex, tailStartIndex);
  const tail = events.slice(tailStartIndex);

  return { head, middle, tail };
}

/**
 * Split an array of events into chunks where each chunk's rendered size
 * is strictly under maxCharsPerChunk.
 */
function chunkEvents(
  events: HistoryEvent[],
  maxCharsPerChunk: number
): Array<{ index: number; firstTs?: string; lastTs?: string; text: string }> {
  const chunks: Array<{ index: number; firstTs?: string; lastTs?: string; text: string }> = [];
  let cur: HistoryEvent[] = [];
  let curChars = 0;

  const flush = () => {
    if (cur.length === 0) return;
    const text = renderHistory(cur);
    const firstTs = cur[0]!.ts ? new Date(cur[0]!.ts).toISOString() : undefined;
    const lastTs = cur[cur.length - 1]!.ts ? new Date(cur[cur.length - 1]!.ts).toISOString() : undefined;
    chunks.push({
      index: chunks.length,
      ...(firstTs ? { firstTs } : {}),
      ...(lastTs ? { lastTs } : {}),
      text,
    });
    cur = [];
    curChars = 0;
  };

  for (const e of events) {
    const len = renderHistory([e]).length + 2;
    if (curChars + len > maxCharsPerChunk && cur.length > 0) flush();
    cur.push(e);
    curChars += len;
  }
  flush();
  return chunks;
}

/** Bounded-concurrency map. Preserves order. */
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

function chunkProseSummarizerPrompt(text: string): string {
  return `You are summarizing a segment of a long technical conversation between a human and an AI agent. This is one chunk of a larger conversation — your summary will be concatenated with summaries of other chunks to form a complete record.

Your summary must:
1. Preserve ALL specific technical decisions, corrections, and constraints mentioned.
2. Preserve exact file paths, command names, error messages, and configuration values.
3. Capture the user's explicit instructions and corrections verbatim where possible.
4. Note any problems encountered and how they were resolved.
5. Maintain chronological flow so the reader understands what happened in order.

Do NOT:
- Omit details because they seem minor — everything the user said matters.
- Paraphrase user corrections — quote them.
- Skip over error diagnosis and resolution steps.
- Produce a high-level overview — this needs to be detailed enough to resume work.

The conversation chunk to summarize follows. Read the ENTIRE chunk before summarizing.

=== CONVERSATION CHUNK ===
${text}
=== END OF CONVERSATION CHUNK ===`;
}

// --- pipeline execution -----------------------------------------------------

export async function runPremiumCompaction(
  input: PremiumCompactionInput
): Promise<PremiumCompactionResult> {
  const {
    richHistory,
    runAgent,
    concurrency = 6,
    log = () => {},
  } = input;

  const thinkingAvailable = richHistory.stats.thinkingAvailable;

  // --- Step 1: Partition events into Head (10%), Middle (70%), Tail (20%) -----
  log("partitioning history into head, middle, and tail…");
  const { head, middle, tail } = partitionHistory(richHistory.events, 0.1, 0.2);

  const headText = renderHistory(head);
  const tailText = renderHistory(tail);
  
  // Measure middle segment size
  const middleChars = middle.map(e => renderHistory([e]).length + 2).reduce((s, x) => s + x, 0);
  log(`middle segment size: ${Math.round(middleChars / 1024)} KB`);

  // --- Step 2: Chunk the middle segment (Max 12 chunks, default 120KB) ---------
  const DEFAULT_CHUNK_CHARS = 120 * 1024;
  const MAX_CHUNKS = 12;

  let chunkCharsBudget = DEFAULT_CHUNK_CHARS;
  let chunks = chunkEvents(middle, chunkCharsBudget);
  if (chunks.length > MAX_CHUNKS) {
    let factor = 1.0;
    while (chunks.length > MAX_CHUNKS) {
      factor += 0.05;
      chunkCharsBudget = Math.ceil((middleChars / MAX_CHUNKS) * factor);
      chunks = chunkEvents(middle, chunkCharsBudget);
    }
    log(`scaled chunk size budget to ${Math.round(chunkCharsBudget / 1024)} KB to keep chunk count at ${chunks.length}`);
  } else {
    log(`using default 120 KB chunk size; split middle into ${chunks.length} chunk(s)`);
  }

  // --- Step 3: Run summarization on middle chunks in parallel (concurrency limit = 6) ---
  log(`summarizing ${chunks.length} middle chunk(s) (max concurrency = ${concurrency})`);
  const chunkSummaries = await mapLimit(chunks, concurrency, async (c, i) => {
    log(`  [chunk-${i}] starting summarization`);
    const prompt = chunkProseSummarizerPrompt(c.text);
    try {
      const summary = await runAgent(prompt, `chunk-${i}`);
      if (!summary.trim()) throw new Error("empty summary returned");
      log(`  [chunk-${i}] completed`);
      return summary.trim();
    } catch (err) {
      log(`  [chunk-${i}] failed: ${(err as Error).message}`);
      return `[Failed to summarize middle segment ${i + 1}]`;
    }
  });

  // --- Step 4: Extract pinned facts in parallel (concurrency limit = 6) -----------
  const pinnedChunkTokens = 120_000;
  const pinnedChunks = chunkHistory(richHistory.events, pinnedChunkTokens);
  log(`extracting pinned facts from ${pinnedChunks.length} chunk(s)`);
  const pinnedParts = await mapLimit(pinnedChunks, concurrency, async (c, i) => {
    try {
      const raw = await runAgent(pinnedFactsPrompt({ text: c.text, thinkingAvailable }), `pinned-${i}`);
      return parseJsonOutput<PinnedFacts>(raw);
    } catch (err) {
      log(`  [pinned-${i}] extraction failed: ${(err as Error).message}`);
      return { corrections: [], constraints: [], decisions: [], openTodos: [], activePaths: [], rules: [] } satisfies PinnedFacts;
    }
  });
  const pinnedFacts = mergePinnedFacts(pinnedParts);
  const pinnedCount =
    pinnedFacts.corrections.length +
    pinnedFacts.constraints.length +
    pinnedFacts.rules.length +
    pinnedFacts.openTodos.length +
    pinnedFacts.activePaths.length;
  log(`pinned ${pinnedCount} facts`);

  // --- Step 5: Assemble output -----------------------------------------------
  let summaryMarkdown = "";
  if (headText) {
    summaryMarkdown += `## Verbatim Conversation Start (Head)\n\n${headText}\n\n`;
  }
  if (chunkSummaries.length > 0) {
    summaryMarkdown += `## Chronological Summaries of Middle Conversation\n\n`;
    summaryMarkdown += chunkSummaries.map((s, idx) => `### Middle Segment ${idx + 1}\n\n${s}`).join("\n\n") + "\n\n";
  }

  const dropNote = 
    `## Premium Compaction Note\n` +
    `- Kept first 10% of conversation verbatim (${head.length} events) as head.\n` +
    `- Summarized middle section into ${chunks.length} segments using Gemini.\n` +
    `- Kept last 20% of conversation verbatim (${tail.length} events) as tail.\n` +
    `- Pinned ${pinnedCount} verbatim constraint(s)/correction(s)/rule(s)/path(s).`;

  const assembledSeed = assembleNewSession({
    summaryMarkdown,
    pinnedFacts,
    recentVerbatim: tailText,
    dropNote,
  });

  return {
    summaryMarkdown,
    pinnedFacts,
    assembledSeed,
    stats: {
      chunks: chunks.length,
    },
  };
}

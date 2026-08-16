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
import { chunkHistory, renderHistory } from "./source-reader.js";
import { chunkAnalyzerPrompt, metaAnalyzerPrompt, deepDivePrompt, synthesizerPrompt, completenessCriticPrompt, pinnedFactsPrompt, assembleNewSession, parseJsonOutput, mergePinnedFacts, JSON_REPARSE_INSTRUCTION, } from "./prompts.js";
/** Run a structured stage with bounded retries that distinguish the two real
 *  failure modes:
 *   - EMPTY completion — the runner emitted no agent text at all. A transient
 *     ACP/model hiccup (seen when several runners spawn at once); re-running the
 *     SAME prompt fresh is the fix. The reparse corrective is meaningless here
 *     (there is no prior reply to re-emit), so we do NOT append it — appending
 *     "re-emit the SAME analysis" to an empty turn only confuses the model.
 *   - NON-EMPTY but unparseable — usually an unescaped `"`/newline inside a long
 *     free-text field. Append JSON_REPARSE_INSTRUCTION so the model re-emits the
 *     same analysis with valid escaping.
 *  Throws only after `maxAttempts` are exhausted; fan-out callers catch that and
 *  stub the one item rather than abort the whole multi-minute run. */
async function runStructured(runAgent, prompt, label, log, maxAttempts = 3) {
    let lastErr = "unknown";
    let appendReparse = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const thisPrompt = appendReparse ? `${prompt}\n\n${JSON_REPARSE_INSTRUCTION}` : prompt;
        const thisLabel = attempt === 1 ? label : `${label}-retry${attempt - 1}`;
        const raw = await runAgent(thisPrompt, thisLabel);
        if (!raw.trim()) {
            // Empty completion: transient, not a formatting problem — re-run fresh.
            lastErr = "empty completion (no agent text)";
            appendReparse = false;
            if (attempt < maxAttempts)
                log(`  [${thisLabel}] empty completion; re-running fresh`);
            continue;
        }
        try {
            return parseJsonOutput(raw);
        }
        catch (err) {
            // Non-empty but unparseable: next attempt re-emits with explicit escaping.
            // Log the raw length + head — NOT the parser's long message, which gets
            // truncated right at "raw[0..200]:" and hides what actually came back
            // (preamble? prose? a refusal? malformed JSON?).
            lastErr = err.message;
            appendReparse = true;
            const head = raw.replace(/\s+/g, " ").trim().slice(0, 160);
            if (attempt < maxAttempts) {
                log(`  [${thisLabel}] unparseable: len=${raw.length}, no JSON object; head="${head}"; retrying with reparse`);
            }
        }
    }
    throw new Error(`[${label}] no parseable output after ${maxAttempts} attempts (last: ${lastErr.slice(0, 120)})`);
}
/** Bounded-concurrency map. Preserves order; a thrown task rejects the whole
 *  run (the caller decides whether to keep the original session). */
async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
        while (true) {
            const i = next++;
            if (i >= items.length)
                return;
            results[i] = await fn(items[i], i);
        }
    });
    await Promise.all(workers);
    return results;
}
/** Render only the events within [fromTs, toTs] (inclusive). Open-ended when a
 *  bound is undefined. Used to give each deep-dive just its region instead of
 *  the whole history. */
function sliceByRange(events, fromTs, toTs) {
    const from = fromTs ? Date.parse(fromTs) : -Infinity;
    const to = toTs ? Date.parse(toTs) : Infinity;
    const inRange = events.filter((e) => e.ts === 0 || (e.ts >= from && e.ts <= to));
    return renderHistory(inRange.length ? inRange : events);
}
/** Truncate text to a char budget, keeping head + tail with an elision marker.
 *  Guarantees a single agent call's input can never exceed the model context
 *  ("Prompt is too long"), even for an unexpectedly huge deep-dive region. */
function fitText(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    const head = Math.floor(maxChars * 0.55);
    const tail = Math.max(0, maxChars - head - 120);
    const elided = text.length - head - tail;
    return (text.slice(0, head) +
        `\n\n… [${elided.toLocaleString()} chars of this region elided to fit the model context window] …\n\n` +
        text.slice(text.length - tail));
}
/** Render the last events that fit a token budget, for the verbatim window. */
function recentVerbatim(events, budgetTokens) {
    const budgetChars = budgetTokens * 4;
    const kept = [];
    let chars = 0;
    for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        const len = renderHistory([e]).length + 2;
        if (chars + len > budgetChars && kept.length > 0)
            break;
        kept.unshift(e);
        chars += len;
    }
    return renderHistory(kept);
}
export async function runPremiumCompaction(input) {
    const { richHistory, gapReport, discordText, runAgent, concurrency = 6, recentWindowTokens = 12_000, pinnedChunkTokens = 120_000, maxCallTokens = 130_000, log = () => { }, } = input;
    const thinkingAvailable = richHistory.stats.thinkingAvailable;
    const maxCallChars = maxCallTokens * 4;
    // --- Stage 1: chunk + analyze (fan-out) -------------------------------------
    // Chunk small enough that NO single chunk-analysis call can blow the context.
    const chunks = chunkHistory(richHistory.events, maxCallTokens);
    log(`analyzing ${chunks.length} chunk(s)`);
    const chunkAnalyses = await mapLimit(chunks, concurrency, async (c, i) => {
        try {
            return await runStructured(runAgent, chunkAnalyzerPrompt(c), `chunk-${i}`, log);
        }
        catch (err) {
            // One transient chunk must not abort the whole run. Degrade to an empty
            // index entry — the deep-dive of this region still re-reads it in full,
            // and the completeness critic will flag anything genuinely lost.
            log(`  [chunk-${i}] UNRECOVERABLE after retries (${err.message.slice(0, 80)}); stubbing chunk`);
            return {
                chunkIndex: i,
                timeRange: { fromTs: c.firstTs, toTs: c.lastTs },
                topics: [],
                decisions: [],
                userCorrections: [],
                selfCoachedRules: [],
                openThreads: [],
                toolFindings: [],
                notableQuotes: [],
            };
        }
    });
    // --- Stage 2: meta-analyze (reduce) -----------------------------------------
    log("meta-analyzing");
    const meta = await runStructured(runAgent, metaAnalyzerPrompt({
        chunkAnalyses,
        gapSignals: gapReport.signals.map((s) => `${s.kind}: ${s.detail}`),
        discordRanges: gapReport.discordRanges,
        thinkingAvailable,
    }), "meta", log);
    // --- Stage 3: deep-dive every target (fan-out, UN-GATED) --------------------
    const targets = meta.deepDiveTargets ?? [];
    log(`deep-diving ${targets.length} region(s)`);
    const deepDives = await mapLimit(targets, concurrency, async (t, i) => {
        // Give each deep-dive only its region: Discord text when the meta flagged
        // this range Discord-preferred and we have it; otherwise the session events
        // sliced to the target's timestamp range.
        const rawText = t.source === "discord" && discordText
            ? discordText
            : sliceByRange(richHistory.events, t.fromTs, t.toTs);
        // Cap the region so an oversized deep-dive can never exceed the context.
        const text = fitText(rawText, maxCallChars);
        const prompt = deepDivePrompt({ fromTs: t.fromTs, toTs: t.toTs, depth: t.depth, source: t.source, text });
        try {
            return await runStructured(runAgent, prompt, `deepdive-${i}`, log);
        }
        catch (err) {
            // Deep-dives are independent regions. One unrecoverable region must NOT
            // abort the whole (multi-minute) run — degrade it to a stub the
            // synthesizer can note, and let the completeness critic flag any gap.
            log(`  [deepdive-${i}] UNRECOVERABLE after retry (${err.message.slice(0, 80)}); stubbing region`);
            return {
                timeRange: { fromTs: t.fromTs, toTs: t.toTs },
                narrative: `[deep-dive failed to parse for region ${t.fromTs ?? "?"} → ${t.toTs ?? "?"}; this region was not extracted]`,
                causalPairs: [],
                selfCoachedRules: [],
                userCorrections: [],
                decisions: [],
                artifacts: [],
            };
        }
    });
    // --- Pinned facts (shared) — chunked fan-out + merge ------------------------
    // Extract verbatim facts per ~120K-token chunk in parallel, then union them.
    // This keeps every call under the standard 200K window (no 1M-tier dependency,
    // no single fragile mega-call) while reconstructing the single-pass result.
    const pinnedChunks = chunkHistory(richHistory.events, pinnedChunkTokens);
    log(`extracting pinned facts (${pinnedChunks.length} chunk(s))`);
    const pinnedParts = await mapLimit(pinnedChunks, concurrency, async (c, i) => {
        try {
            return await runStructured(runAgent, pinnedFactsPrompt({ text: c.text, thinkingAvailable }), `pinned-${i}`, log);
        }
        catch (err) {
            // Tolerate one bad chunk: mergePinnedFacts unions whatever the rest found.
            log(`  [pinned-${i}] UNRECOVERABLE after retries (${err.message.slice(0, 80)}); skipping chunk`);
            return { corrections: [], constraints: [], decisions: [], openTodos: [], activePaths: [], rules: [] };
        }
    });
    const pinnedFacts = mergePinnedFacts(pinnedParts);
    // --- Stage 4: synthesize ----------------------------------------------------
    log("synthesizing");
    const summaryMarkdown = (await runAgent(synthesizerPrompt({ meta, deepDives, pinnedFacts }), "synthesize")).trim();
    // Assemble the new-session seed BEFORE auditing. The critic must check what
    // actually ships — the prose summary + the pinned-facts block + the recent
    // verbatim window — not the prose alone, or it false-flags facts that are
    // preserved verbatim in the pinned block as "lost" (they're invisible to a
    // summary-only audit, which is what inflated the unpreserved count).
    const assembledSeed = assembleNewSession({
        summaryMarkdown,
        pinnedFacts,
        recentVerbatim: recentVerbatim(richHistory.events, recentWindowTokens),
    });
    // --- Stage 5: completeness critic (inverted gate) ---------------------------
    log("verifying completeness");
    const critique = await runStructured(runAgent, completenessCriticPrompt({ assembled: assembledSeed, riskChecklist: meta.riskChecklist ?? [] }), "critic", log);
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
//# sourceMappingURL=pipeline.js.map
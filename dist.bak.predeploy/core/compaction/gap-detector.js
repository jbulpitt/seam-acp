/**
 * Discord gap-detector for premium compaction (docs/premium-compaction-design.md §5).
 *
 * Runs ALWAYS, cheaply (timestamps / markers, no LLM). Decides whether the
 * Discord thread holds history the session store has lost or never had, and for
 * which time ranges Discord out-fidelities the session — so the pipeline pulls
 * Discord ONLY where it actually beats the session (automatic de-dup).
 *
 * The four gap signals (any → include Discord for the affected range):
 *   1. pre-history gap — thread predates the session's earliest entry
 *   2. attachment swap — the thread has had >1 acp_session_id over its life
 *   3. prior in-session compaction — isCompactSummary in the JSONL means the
 *      session's history before that point is itself a summary (lower fidelity)
 *   4. time discontinuity — a gap in the session's entries the thread fills
 *
 * NOTE: signal #2 (attachment swap) requires attachment history, which seam-acp
 * does not yet persist (the DB holds only the current acp_session_id). The
 * caller passes `priorAttachmentCount` if known; otherwise that signal is
 * skipped. Tracking attachment history is a documented follow-up.
 */
import { promises as fsp } from "node:fs";
/** Threshold for flagging an internal wall-clock gap as a possible
 *  discontinuity (a long quiet period is normal; this only flags suspiciously
 *  large jumps that *might* indicate lost history). Tunable. */
const INTERNAL_GAP_FLAG_MS = 6 * 60 * 60 * 1000; // 6h
/** Analyze the session JSONL for coverage + compaction boundaries. Pure read. */
export async function analyzeSessionCoverage(jsonlPath) {
    const content = await fsp.readFile(jsonlPath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    let firstTs;
    let lastTs;
    const compactionBoundaries = [];
    const internalGaps = [];
    let prevTs;
    for (const line of lines) {
        let e;
        try {
            e = JSON.parse(line);
        }
        catch {
            continue;
        }
        const tsIso = e.timestamp;
        if (e.isCompactSummary === true && tsIso)
            compactionBoundaries.push(tsIso);
        if (!tsIso)
            continue;
        const ms = Date.parse(tsIso);
        if (Number.isNaN(ms))
            continue;
        if (!firstTs)
            firstTs = tsIso;
        lastTs = tsIso;
        if (prevTs && ms - prevTs.ms >= INTERNAL_GAP_FLAG_MS) {
            internalGaps.push({ afterTs: prevTs.iso, beforeTs: tsIso, gapMs: ms - prevTs.ms });
        }
        prevTs = { iso: tsIso, ms };
    }
    return {
        ...(firstTs ? { firstTs } : {}),
        ...(lastTs ? { lastTs } : {}),
        compactionBoundaries,
        hasPriorCompaction: compactionBoundaries.length > 0,
        internalGaps,
    };
}
/** Decide whether/where Discord history is needed. */
export function detectGaps(input) {
    const { coverage, threadFirstTs, priorAttachmentCount } = input;
    const signals = [];
    const discordRanges = [];
    // 1. Pre-history gap: thread starts before the session's earliest entry.
    if (threadFirstTs &&
        coverage.firstTs &&
        Date.parse(threadFirstTs) < Date.parse(coverage.firstTs)) {
        signals.push({
            kind: "pre-history",
            detail: `thread starts ${threadFirstTs}, session starts ${coverage.firstTs}`,
        });
        discordRanges.push({
            toTs: coverage.firstTs,
            reason: "thread predates the session store",
        });
    }
    // 2. Attachment swap (only if the count is known and > 1).
    if (typeof priorAttachmentCount === "number" && priorAttachmentCount > 1) {
        signals.push({
            kind: "attachment-swap",
            detail: `thread has used ${priorAttachmentCount} acp sessions`,
        });
        // Conservative: the whole pre-current-session timeline may live elsewhere.
        discordRanges.push({
            ...(coverage.firstTs ? { toTs: coverage.firstTs } : {}),
            reason: "thread re-attached across multiple sessions",
        });
    }
    // 3. Prior in-session compaction: everything up to the LAST boundary is
    //    reduced-fidelity in the session store → prefer Discord there.
    if (coverage.hasPriorCompaction) {
        const lastBoundary = coverage.compactionBoundaries
            .slice()
            .sort()
            .pop();
        signals.push({
            kind: "prior-compaction",
            detail: `${coverage.compactionBoundaries.length} prior compaction(s); latest ${lastBoundary}`,
        });
        discordRanges.push({
            toTs: lastBoundary,
            reason: "session history before this point is itself a summary",
        });
    }
    // 4. Time discontinuities — flag, but don't aggressively pull (a long quiet
    //    period is usually benign). Surface for the meta-analyzer to weigh.
    for (const g of coverage.internalGaps) {
        signals.push({
            kind: "time-discontinuity",
            detail: `${Math.round(g.gapMs / 3_600_000)}h gap between ${g.afterTs} and ${g.beforeTs}`,
        });
    }
    // Merge overlapping discord ranges (all are open-at-start "up to T" here, so
    // collapse to the widest).
    let merged = [];
    if (discordRanges.length > 0) {
        const widest = discordRanges
            .filter((r) => r.toTs)
            .sort((a, b) => Date.parse(b.toTs) - Date.parse(a.toTs))[0];
        if (widest) {
            merged = [widest];
        }
        else {
            merged = discordRanges;
        }
    }
    return {
        signals,
        discordRanges: merged,
        needDiscord: merged.length > 0,
    };
}
//# sourceMappingURL=gap-detector.js.map
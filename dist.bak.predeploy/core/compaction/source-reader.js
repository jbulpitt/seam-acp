/**
 * Richest-source reader for premium compaction (docs/premium-compaction-design.md).
 *
 * Reads a Claude Code session's RAW JSONL and produces a structure-preserving
 * history that keeps everything the model actually saw — user/assistant text,
 * **thinking (where stored in cleartext)**, and tool activity compressed to
 * `call → finding` — while dropping only what was never in context or already
 * lost (base64 image blobs, oversized dumps).
 *
 * This is deliberately richer than the text-only `getTranscript` used by the
 * cheap compaction path: the premium deep-dive's entire value is having material
 * the cheap summary never saw (thinking-derived rules, the tool activity that
 * triggered a user interjection).
 *
 * REALITY CHECK (verified 2026-06-01): thinking is **opportunistic** — some
 * sessions store cleartext thinking, others store only redacted signatures
 * (empty content). The reader includes thinking where present and silently skips
 * redacted blocks; downstream stages must not assume thinking exists.
 */
import { promises as fsp } from "node:fs";
/** Max characters of a tool result we keep as a brief; the LLM deep-dive turns
 *  this (plus surrounding context) into the durable finding. */
const TOOL_RESULT_BRIEF_MAX = 800;
/** Tool-result content blocks of these types are dropped (never in-context as
 *  text, or already-stripped blobs). */
const DROP_TOOL_BLOCK_TYPES = new Set(["image"]);
function textFromContent(content) {
    if (typeof content === "string")
        return content;
    if (Array.isArray(content)) {
        return content
            .filter((b) => b && typeof b === "object" && b.type === "text")
            .map((b) => b.text ?? "")
            .join("\n");
    }
    return "";
}
function briefFromToolResult(content) {
    let text;
    if (typeof content === "string") {
        text = content;
    }
    else if (Array.isArray(content)) {
        text = content
            .filter((b) => b && typeof b === "object" && !DROP_TOOL_BLOCK_TYPES.has(b.type))
            .map((b) => (b.type === "text" ? b.text ?? "" : `[${b.type}]`))
            .join("\n");
    }
    else {
        text = "";
    }
    text = text.trim();
    if (text.length > TOOL_RESULT_BRIEF_MAX) {
        return text.slice(0, TOOL_RESULT_BRIEF_MAX) + ` …[+${text.length - TOOL_RESULT_BRIEF_MAX} chars]`;
    }
    return text;
}
function briefFromToolInput(input) {
    if (!input || typeof input !== "object")
        return "";
    // Compact, single-line: keep the most identifying fields, truncate values.
    const parts = [];
    for (const [k, v] of Object.entries(input)) {
        let val;
        if (typeof v === "string")
            val = v.length > 120 ? v.slice(0, 120) + "…" : v;
        else
            val = JSON.stringify(v);
        if (val && val.length > 160)
            val = val.slice(0, 160) + "…";
        parts.push(`${k}=${val}`);
        if (parts.join(" ").length > 240)
            break;
    }
    return parts.join(" ");
}
/** Read and parse a Claude session JSONL into structure-preserving events. */
export async function readRichHistory(jsonlPath) {
    const content = await fsp.readFile(jsonlPath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    const events = [];
    let userTurns = 0;
    let assistantTurns = 0;
    let thinkingKept = 0;
    let thinkingRedactedSkipped = 0;
    let toolEvents = 0;
    let firstTs;
    let lastTs;
    for (const line of lines) {
        let entry;
        try {
            entry = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (entry.isMeta === true || entry.isSidechain === true)
            continue;
        const tsIso = entry.timestamp;
        const ts = tsIso ? Date.parse(tsIso) : 0;
        if (tsIso) {
            if (!firstTs)
                firstTs = tsIso;
            lastTs = tsIso;
        }
        const msgContent = entry.message?.content;
        if (entry.type === "user") {
            const text = textFromContent(msgContent).trim();
            if (text) {
                events.push({ kind: "user", ts, text });
                userTurns++;
            }
            // tool_result blocks live on user entries
            if (Array.isArray(msgContent)) {
                for (const b of msgContent) {
                    if (b?.type === "tool_result") {
                        const brief = briefFromToolResult(b.content);
                        // We attach the result to the most recent tool event lacking one.
                        const lastTool = [...events].reverse().find((e) => e.kind === "tool" && !e._resolved);
                        if (lastTool && lastTool.kind === "tool") {
                            lastTool.resultBrief = brief;
                            lastTool.isError = b.is_error === true;
                            lastTool._resolved = true;
                        }
                    }
                }
            }
            continue;
        }
        if (entry.type === "assistant" && Array.isArray(msgContent)) {
            let sawText = false;
            for (const b of msgContent) {
                if (b?.type === "text" && (b.text ?? "").trim()) {
                    events.push({ kind: "assistant", ts, text: b.text.trim() });
                    sawText = true;
                }
                else if (b?.type === "thinking") {
                    const t = (b.thinking ?? "").trim();
                    if (t) {
                        events.push({ kind: "thinking", ts, text: t });
                        thinkingKept++;
                    }
                    else {
                        thinkingRedactedSkipped++;
                    }
                }
                else if (b?.type === "tool_use") {
                    events.push({
                        kind: "tool",
                        ts,
                        name: b.name ?? "tool",
                        input: briefFromToolInput(b.input),
                        resultBrief: "",
                        isError: false,
                    });
                    toolEvents++;
                }
            }
            if (sawText)
                assistantTurns++;
        }
    }
    // Strip the internal _resolved marker.
    for (const e of events)
        delete e._resolved;
    const estimatedTokens = Math.ceil(renderHistory(events).length / 4);
    return {
        events,
        stats: {
            totalEvents: events.length,
            userTurns,
            assistantTurns,
            thinkingKept,
            thinkingRedactedSkipped,
            toolEvents,
            ...(firstTs ? { firstTs } : {}),
            ...(lastTs ? { lastTs } : {}),
            estimatedTokens,
            thinkingAvailable: thinkingKept > 0,
        },
    };
}
/** Render events to a structure-preserving text block for chunk analysis. Each
 *  event is anchored with its timestamp so downstream stages can emit ranges. */
export function renderHistory(events) {
    const out = [];
    for (const e of events) {
        const t = e.ts ? new Date(e.ts).toISOString() : "";
        const stamp = t ? `[${t}] ` : "";
        switch (e.kind) {
            case "user":
                out.push(`${stamp}USER: ${e.text}`);
                break;
            case "assistant":
                out.push(`${stamp}ASSISTANT: ${e.text}`);
                break;
            case "thinking":
                out.push(`${stamp}THINKING: ${e.text}`);
                break;
            case "tool": {
                const res = e.isError ? `ERROR: ${e.resultBrief}` : e.resultBrief;
                out.push(`${stamp}TOOL ${e.name}(${e.input})${res ? ` → ${res}` : ""}`);
                break;
            }
        }
    }
    return out.join("\n\n");
}
/** Split rendered history into chunks under a token budget for fan-out analysis.
 *  Splits on event boundaries (never mid-event) and carries the time range of
 *  each chunk so the meta-analyzer can target deep-dives by timestamp. */
export function chunkHistory(events, maxTokensPerChunk = 700_000) {
    const maxChars = maxTokensPerChunk * 4;
    const chunks = [];
    let cur = [];
    let curChars = 0;
    const flush = () => {
        if (cur.length === 0)
            return;
        const text = renderHistory(cur);
        const firstTs = cur[0].ts ? new Date(cur[0].ts).toISOString() : undefined;
        const lastTs = cur[cur.length - 1].ts ? new Date(cur[cur.length - 1].ts).toISOString() : undefined;
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
        if (curChars + len > maxChars && cur.length > 0)
            flush();
        cur.push(e);
        curChars += len;
    }
    flush();
    return chunks;
}
//# sourceMappingURL=source-reader.js.map
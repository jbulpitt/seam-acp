/**
 * Streaming-aware text splitter for chat platforms.
 *
 * Decides, for an in-flight buffer of agent text, whether to flush now and
 * where to cut. Honors:
 *   - open ``` code fences (never split inside one unless forced)
 *   - paragraph / line / sentence boundaries (in that preference order)
 *   - a hard max length (e.g. Discord's 2000-char limit, with headroom)
 *
 * Returns:
 *   - `null` if nothing should be flushed right now
 *   - `{ send, keep }` otherwise, where `send` goes to the platform and
 *     `keep` stays in the buffer for the next round
 */

export interface SplitOptions {
  /** Hard upper bound for a single sent message. */
  maxLen: number;
  /**
   * If true, the caller insists on flushing (e.g. end of turn, or the buffer
   * has exceeded `maxLen`). The splitter will produce a `send` even if the
   * cut is awkward — closing/reopening fences as needed.
   */
  force: boolean;
  /**
   * Minimum send size for a soft (non-forced) flush. Below this, defer.
   */
  softMin?: number;
}

interface OpenFence {
  /** Index of the opening ``` for the last unclosed fence. */
  start: number;
  /** Language tag captured after the opener (may be ""). */
  lang: string;
}

/** Returns the open fence info if the buffer has an unclosed ```, else null. */
export function hasOpenFence(buf: string): boolean {
  return findOpenFence(buf) !== null;
}

function findOpenFence(buf: string): OpenFence | null {
  const re = /```([^\n`]*)/g;
  const matches: { start: number; lang: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(buf)) !== null) {
    matches.push({ start: m.index, lang: (m[1] ?? "").trim() });
  }
  if (matches.length % 2 === 0) return null;
  const last = matches[matches.length - 1];
  return last ?? null;
}

/** Best clean split point in [minIdx, maxIdx]. Returns -1 if none found. */
function findCleanSplit(
  buf: string,
  minIdx: number,
  maxIdx: number,
  paragraphOnly = false
): { idx: number; skip: number } | null {
  const window = buf.slice(0, Math.min(buf.length, maxIdx));

  // Paragraph break (preferred — only safe boundary mid-stream).
  const para = window.lastIndexOf("\n\n");
  if (para >= minIdx) return { idx: para, skip: 2 };

  if (paragraphOnly) return null;

  // Line break
  const nl = window.lastIndexOf("\n");
  if (nl >= minIdx) return { idx: nl, skip: 1 };

  // Sentence break: ". ", "! ", "? "
  for (let i = window.length - 2; i >= minIdx; i--) {
    const c = window.charCodeAt(i);
    if ((c === 46 || c === 33 || c === 63) && window.charCodeAt(i + 1) === 32) {
      return { idx: i + 1, skip: 1 };
    }
  }

  return null;
}

export function splitForFlush(
  buffer: string,
  opts: SplitOptions
): { send: string; keep: string } | null {
  if (!buffer) return null;
  const { maxLen, force } = opts;
  const softMin = opts.softMin ?? 1;
  const fence = findOpenFence(buffer);

  // --- Soft path: only flush on a paragraph break outside any open fence.
  // Mid-stream the model emits punctuation as separate chunks, so anything
  // less safe than a paragraph break risks landing mid-sentence.
  if (!force) {
    if (fence) return null;
    const split = findCleanSplit(buffer, softMin, buffer.length, true);
    if (!split) return null;
    const send = buffer.slice(0, split.idx).replace(/\s+$/, "");
    const keep = buffer.slice(split.idx + split.skip);
    if (!send) return null;
    return { send, keep };
  }

  // --- Forced path.
  if (buffer.length <= maxLen && !fence) {
    return { send: buffer.replace(/\s+$/, ""), keep: "" };
  }

  // Forced and (over cap or open fence). Need to cut within [0, maxLen].
  if (fence) {
    // Reserve room for closing "\n```".
    const reserve = 4;
    const windowEnd = Math.min(buffer.length, maxLen - reserve);
    // Index just past the fence opener + lang tag (the content starts here).
    const fenceContentStart = fence.start + 3 + fence.lang.length;
    // If everything inside the fence fits and there's no extra trailing
    // text after the (unclosed) fence, just emit the whole buffer with a
    // closer appended — no need to split or re-open.
    const inner = buffer.slice(fenceContentStart).replace(/^\n/, "");
    if (buffer.length + reserve <= maxLen) {
      // No real content inside yet → nothing useful to send. Drop the
      // orphan opener so the caller's drain loop terminates instead of
      // re-emitting empty fences forever.
      if (!inner.trim()) {
        return { send: "", keep: "" };
      }
      const sent = buffer.replace(/\s+$/, "") + "\n```";
      return { send: sent, keep: "" };
    }
    const split = findCleanSplit(buffer, fenceContentStart + 1, windowEnd);
    const cutIdx = split ? split.idx : windowEnd;
    // Refuse to split before any actual content lands inside the fence —
    // otherwise we'd emit an empty ```lang ... ``` block and reopen with
    // the same empty opener, looping forever.
    if (cutIdx <= fenceContentStart || !inner.trim()) {
      return { send: "", keep: "" };
    }
    const skip = split ? split.skip : 0;
    const sentInner = buffer.slice(0, cutIdx).replace(/\s+$/, "");
    const send = sentInner + "\n```";
    const tail = buffer.slice(cutIdx + skip);
    const keep = "```" + fence.lang + "\n" + tail;
    return { send, keep };
  }

  // Forced over-cap, no fence.
  const split = findCleanSplit(buffer, Math.floor(maxLen / 4), maxLen);
  if (split) {
    return {
      send: buffer.slice(0, split.idx).replace(/\s+$/, ""),
      keep: buffer.slice(split.idx + split.skip),
    };
  }
  return {
    send: buffer.slice(0, maxLen),
    keep: buffer.slice(maxLen),
  };
}

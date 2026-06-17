/**
 * Streaming-aware text splitter for chat platforms.
 *
 * Decides, for an in-flight buffer of agent PROSE, whether to flush now and
 * where to cut. Honors:
 *   - a standalone `---` thematic break (a hard, forced message boundary)
 *   - open markdown links/images (never cut inside one unless forced)
 *   - paragraph / line / sentence boundaries (in that preference order)
 *   - a hard max length (e.g. Discord's 2000-char limit, with headroom)
 *
 * Code fences are NOT handled here — FenceStream extracts them upstream, so the
 * buffer this sees never contains a ``` fence (older tests for in-splitter fence
 * close/reopen were removed when that logic moved to FenceStream).
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
  /**
   * If true, allow cutting inside an open markdown link/image. Used by
   * idle-flush and end-of-turn paths where the agent may never close the
   * construct, and by the must-drain fallback when the buffer is over cap
   * and no safe prefix exists.
   */
  allowUnsafeCut?: boolean;
}

interface OpenFence {
  /** Index of the opening ``` for the last unclosed fence. */
  start: number;
  /** Language tag captured after the opener (may be ""). */
  lang: string;
}



/**
 * Find the index of the EARLIEST still-open markdown link/image construct at
 * end of buffer. Returns -1 if all link constructs are closed.
 *
 * Tracked constructs (inline syntax only):
 *   - `[text](url)` link
 *   - `![alt](url)` image — unsafe start is the `!`
 *   - `[text](url "title")` / `[text](url 'title')` / `[text](url (title))`
 *     — handled as part of the outer `(...)` after `](`
 *
 * Backslash escapes (`\[`, `\]`, `\(`, `\)`, `\\`) are honored via consecutive
 * backslash counting (odd → next char escaped, even → literal).
 *
 * Out of scope (v1): inline code spans, fenced code (handled upstream),
 * reference-style links, autolinks, angle-bracket destinations.
 */
export function findFirstUnsafeIndex(buf: string): number {
  // Stack of open constructs. Each entry tracks its outermost start index
  // (the position we'd send up-to as the "safe prefix" if it never closes).
  type State =
    | { kind: "text"; start: number; depth: number } // inside [...]
    | { kind: "url"; start: number; depth: number }; // inside ](...)
  const stack: State[] = [];
  let i = 0;
  const n = buf.length;
  while (i < n) {
    const ch = buf.charCodeAt(i);
    // Backslash escape: skip the next char if odd run length.
    if (ch === 92) {
      let run = 1;
      while (i + run < n && buf.charCodeAt(i + run) === 92) run++;
      i += run;
      if (run % 2 === 1 && i < n) i += 1;
      continue;
    }
    const top = stack[stack.length - 1];
    if (top && top.kind === "url") {
      if (ch === 40) {
        // nested ( inside url destination/title
        top.depth += 1;
      } else if (ch === 41) {
        top.depth -= 1;
        if (top.depth === 0) {
          stack.pop();
        }
      }
      i += 1;
      continue;
    }
    // Not in a url destination. We're either at top level or inside [text].
    if (ch === 91) {
      // `[` — opens link text. Detect image marker `![` for safe-start.
      const isImage = i > 0 && buf.charCodeAt(i - 1) === 33;
      const start = isImage ? i - 1 : i;
      stack.push({ kind: "text", start, depth: 1 });
      i += 1;
      continue;
    }
    if (ch === 93 && top && top.kind === "text") {
      // `]` — closes link text (depth-1 since we don't nest `[` in text).
      top.depth -= 1;
      if (top.depth === 0) {
        // Look for the matching `(` that starts the destination. Per
        // CommonMark it must immediately follow `]` (no whitespace).
        if (i + 1 < n && buf.charCodeAt(i + 1) === 40) {
          // Consume `]` and `(`, switch to url state, but inherit the
          // ORIGINAL [start] so an unclosed url still rolls back to it.
          const origStart = top.start;
          stack.pop();
          stack.push({ kind: "url", start: origStart, depth: 1 });
          i += 2;
          continue;
        } else {
          // `]` not followed by `(` → not a link, just text. Drop the state.
          stack.pop();
          i += 1;
          continue;
        }
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  if (stack.length === 0) return -1;
  // Earliest open construct = bottom of stack.
  return stack[0]!.start;
}

/**
 * Returns true if position `pos` in `buf` is inside a single-backtick
 * inline-code span (e.g. `foo`).  Multi-backtick runs (`` `` ``, ` ``` `)
 * are skipped — triple-backtick fences are consumed upstream by FenceStream
 * and never appear in the prose buffer.
 */
function isInsideInlineCode(buf: string, pos: number): boolean {
  let inCode = false;
  let i = 0;
  while (i < pos) {
    if (buf.charCodeAt(i) === 96 /* ` */) {
      // Count the backtick run length.
      let run = 1;
      while (i + run < buf.length && buf.charCodeAt(i + run) === 96) run++;
      if (run === 1) {
        // Single backtick toggles the inline-code state.
        inCode = !inCode;
      }
      // Multi-backtick runs are skipped (they open/close a different span
      // kind that we don't track here).
      i += run;
    } else {
      i++;
    }
  }
  return inCode;
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
  // Scan backwards so we find the latest one that is not inside a code span.
  {
    let end = window.length;
    while (true) {
      const para = window.lastIndexOf("\n\n", end - 1);
      if (para < minIdx) break;
      if (!isInsideInlineCode(window, para)) return { idx: para, skip: 2 };
      end = para; // try an earlier paragraph break
    }
  }

  if (paragraphOnly) return null;

  // Line break — find the last one that is not inside an inline-code span.
  {
    let end = window.length;
    while (true) {
      const nl = window.lastIndexOf("\n", end - 1);
      if (nl < minIdx) break;
      if (!isInsideInlineCode(window, nl)) return { idx: nl, skip: 1 };
      end = nl; // try an earlier line break
    }
  }

  // Sentence break: ". ", "! ", "? "
  for (let i = window.length - 2; i >= minIdx; i--) {
    const c = window.charCodeAt(i);
    if ((c === 46 || c === 33 || c === 63) && window.charCodeAt(i + 1) === 32) {
      return { idx: i + 1, skip: 1 };
    }
  }

  return null;
}

/** Find the first COMPLETE "---" separator — a line that is EXACTLY three
 *  hyphens (optionally padded with spaces/tabs) AND terminated by a newline.
 *  Exactly three (not `-{3,}`) so a longer run like "----------" or a setext
 *  underline is left alone — the marker is literally "---" by itself. Requiring
 *  the trailing newline means a half-streamed "--" or a "--- heading" never
 *  triggers a cut, and table separator rows (which contain `|`) are excluded by
 *  construction. Fenced code never reaches this buffer (FenceStream strips it
 *  upstream — only `prose` segments are appended), and inline-code `---` spans
 *  are skipped below. Returns the slice bounds to DROP: `from` = the rule line's
 *  start (its preceding newline, if any), `to` = just past its trailing newline. */
function findThematicBreakCut(buf: string): { from: number; to: number } | null {
  const re = /(^|\n)[ \t]*-{3}[ \t]*\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buf)) !== null) {
    const lineStart = m.index + (m[1] ? m[1].length : 0);
    if (isInsideInlineCode(buf, lineStart)) continue;
    return { from: m.index, to: m.index + m[0].length };
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
  const allowUnsafeCut = opts.allowUnsafeCut ?? false;

  // Honor an explicit markdown thematic break ("---" on its own line) as a hard
  // message boundary — the user's "start a new message here" marker — in BOTH
  // the soft and forced paths, regardless of size. Drop the rule itself (the
  // message split replaces it). Only act when the content before the rule fits
  // one message; if it's over cap, let the length logic below chunk it first
  // and the rule is honored on a later drain.
  const rule = findThematicBreakCut(buffer);
  if (rule) {
    const before = buffer.slice(0, rule.from).replace(/\s+$/, "");
    const after = buffer.slice(rule.to);
    if (!before) {
      // Leading rule (nothing before it) — drop it, continue on the remainder.
      return splitForFlush(after, opts);
    }
    if (before.length <= maxLen) {
      const u = allowUnsafeCut ? -1 : findFirstUnsafeIndex(buffer);
      // Don't cut if an open link/image construct starts before the rule.
      if (u === -1 || rule.from <= u) return { send: before, keep: after };
    }
    // before is over cap (or the rule sits past an open link) — fall through.
  }
  // Fences are handled separately upstream by FenceStream, so the prose buffer
  // never contains unclosed code blocks. We only check link-safety.
  const unsafeIdx = !allowUnsafeCut ? findFirstUnsafeIndex(buffer) : -1;

  // --- Soft path: only flush on a paragraph break.
  // Mid-stream the model emits punctuation as separate chunks, so anything
  // less safe than a paragraph break risks landing mid-sentence.
  if (!force) {
    const split = findCleanSplit(buffer, softMin, buffer.length, true);
    if (!split) return null;
    // Refuse soft cut that lands inside an open link/image construct.
    if (unsafeIdx !== -1 && split.idx > unsafeIdx) return null;
    const send = buffer.slice(0, split.idx).replace(/\s+$/, "");
    const keep = buffer.slice(split.idx + split.skip);
    if (!send) return null;
    return { send, keep };
  }

  // --- Forced path.
  if (buffer.length <= maxLen) {
    if (unsafeIdx === -1) {
      return { send: buffer.replace(/\s+$/, ""), keep: "" };
    }
    // Open link/image with safe prefix. Send what's safe; keep the tail.
    if (unsafeIdx === 0) return null; // nothing safe to send yet
    const send = buffer.slice(0, unsafeIdx).replace(/\s+$/, "");
    const keep = buffer.slice(unsafeIdx);
    if (!send) return null;
    return { send, keep };
  }

  // Forced over-cap.
  const minSplit = Math.floor(maxLen / 4);
  // Cap the search window at unsafeIdx if there's an open link/image, so
  // we don't pick a clean break that lands inside the link.
  const windowMax =
    unsafeIdx === -1 ? maxLen : Math.min(maxLen, unsafeIdx);
  const split =
    windowMax > minSplit
      ? findCleanSplit(buffer, minSplit, windowMax)
      : null;
  if (split) {
    return {
      send: buffer.slice(0, split.idx).replace(/\s+$/, ""),
      keep: buffer.slice(split.idx + split.skip),
    };
  }
  // No safe clean split. If we have an open link with a meaningful safe
  // prefix, send that. Otherwise we MUST drain (Discord rejects >2000),
  // so fall back to an unsafe hard cut.
  if (unsafeIdx !== -1 && unsafeIdx >= minSplit) {
    return {
      send: buffer.slice(0, unsafeIdx).replace(/\s+$/, ""),
      keep: buffer.slice(unsafeIdx),
    };
  }
  return {
    send: buffer.slice(0, maxLen),
    keep: buffer.slice(maxLen),
  };
}

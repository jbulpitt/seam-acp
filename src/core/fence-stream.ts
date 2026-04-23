/**
 * Streaming code-fence extractor.
 *
 * Feed text chunks in as they arrive from the agent. The extractor
 * produces an in-order stream of segments:
 *   - { kind: 'prose', text }        text outside any fence
 *   - { kind: 'fence-open' }         opening ``` was just consumed
 *   - { kind: 'fence-close', fence } closing ``` was just consumed
 *
 * The opening and closing backticks themselves are NOT included in any
 * prose segment. Fence content is captured internally and returned in
 * the `fence-close` segment.
 *
 * Within-chunk ordering is preserved: a single chunk containing
 * `prose1 [fence] prose2` produces three segments in that order.
 *
 * Design notes:
 *   - Pure state machine. No I/O, no logging.
 *   - Robust to fences split across chunk boundaries (the opener
 *     ``` is buffered byte-by-byte).
 *   - `flush()` at end-of-turn returns any unclosed fence as
 *     `unclosed`, so the caller can decide what to do (emit with a
 *     notice, drop, etc).
 *   - `forceClose()` takes a snapshot of the current open fence and
 *     resets the state to outside-fence; subsequent `feed()` bytes
 *     flow as prose. Used by the watchdog.
 */

import { LANG_EXT, EXT_MIME } from "./fence-mime.js";

export interface CompletedFence {
  /** Original (lowercased) language tag the model wrote. Empty when none. */
  lang: string;
  /** Suggested file extension. "txt" if the lang tag is unknown/missing. */
  ext: string;
  /** Suggested MIME type for the extension. "text/plain" fallback. */
  mimeType: string;
  /** Raw inner content (no fences). */
  content: string;
  /** When the opening ``` was first seen, in epoch ms. */
  openedAtMs: number;
}

export type Segment =
  | { kind: "prose"; text: string }
  | { kind: "fence-open" }
  | { kind: "fence-close"; fence: CompletedFence };

export interface FeedResult {
  /** Segments in stream order. */
  segments: Segment[];
}

export interface FlushResult {
  /** Trailing prose / fence-close segments produced by draining buffered state. */
  segments: Segment[];
  /** A fence that was open when flush() was called, if any. */
  unclosed: CompletedFence | null;
}

interface State {
  inFence: boolean;
  /** Captured language tag while collecting it (between ``` and \n). */
  fenceLangBuf: string;
  /** Has the lang line been terminated by \n? */
  fenceLangComplete: boolean;
  /** Final lang tag once finalized. */
  fenceLang: string;
  /** Inner content captured so far. */
  fenceInner: string;
  /** Epoch ms of the opening backtick run. */
  fenceOpenedAtMs: number;
  /** Pending backticks (we need 3 in a row to flip state). */
  backtickRun: number;
}

function makeState(): State {
  return {
    inFence: false,
    fenceLangBuf: "",
    fenceLangComplete: false,
    fenceLang: "",
    fenceInner: "",
    fenceOpenedAtMs: 0,
    backtickRun: 0,
  };
}

/**
 * Streaming fence extractor. Construct one per turn; call `feed()` for
 * every text chunk and `flush()` at end-of-turn. Use `forceClose()` to
 * abort a stuck open fence (e.g. watchdog trip).
 */
export class FenceStream {
  private state: State = makeState();

  /** True iff a fence is currently open. */
  get inFence(): boolean {
    return this.state.inFence;
  }

  /** Current open fence's language tag (empty string if none / not yet known). */
  currentFenceLang(): string {
    if (!this.state.inFence) return "";
    return this.state.fenceLangComplete ? this.state.fenceLang : "";
  }

  /** Bytes captured inside the currently open fence (0 if none). */
  currentFenceContentLength(): number {
    if (!this.state.inFence) return 0;
    return this.state.fenceLangComplete
      ? this.state.fenceInner.length
      : this.state.fenceLangBuf.length;
  }

  /** Time in ms since the current open fence started, or 0 if none. */
  openSinceMs(now: number = Date.now()): number {
    if (!this.state.inFence || this.state.fenceOpenedAtMs === 0) return 0;
    return now - this.state.fenceOpenedAtMs;
  }

  /** Feed a chunk of streamed agent text. */
  feed(text: string, now: number = Date.now()): FeedResult {
    const segments: Segment[] = [];
    let proseBuf = "";
    const flushProse = () => {
      if (proseBuf.length > 0) {
        segments.push({ kind: "prose", text: proseBuf });
        proseBuf = "";
      }
    };

    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === "`") {
        this.state.backtickRun += 1;
        if (this.state.backtickRun === 3) {
          // Flip state. Don't emit the backticks.
          this.state.backtickRun = 0;
          if (!this.state.inFence) {
            // Opening fence — flush any pending prose first so segments
            // stay ordered, then announce open.
            flushProse();
            this.state.inFence = true;
            this.state.fenceLangBuf = "";
            this.state.fenceLangComplete = false;
            this.state.fenceLang = "";
            this.state.fenceInner = "";
            this.state.fenceOpenedAtMs = now;
            segments.push({ kind: "fence-open" });
          } else {
            // Closing fence — emit and reset.
            const fence = this.finalizeFence();
            segments.push({ kind: "fence-close", fence });
          }
        }
        i += 1;
        continue;
      }

      // Not a backtick. If we had buffered <3 backticks, they were prose
      // (or content), not a fence marker.
      if (this.state.backtickRun > 0) {
        const stray = "`".repeat(this.state.backtickRun);
        this.state.backtickRun = 0;
        if (this.state.inFence) {
          this.appendInner(stray);
        } else {
          proseBuf += stray;
        }
      }

      if (this.state.inFence) {
        if (!this.state.fenceLangComplete) {
          if (c === "\n") {
            this.state.fenceLang = this.state.fenceLangBuf
              .trim()
              .toLowerCase();
            this.state.fenceLangComplete = true;
            this.state.fenceLangBuf = "";
          } else {
            this.state.fenceLangBuf += c;
          }
        } else {
          this.state.fenceInner += c;
        }
      } else {
        proseBuf += c;
      }
      i += 1;
    }

    flushProse();
    return { segments };
  }

  /**
   * Drain any trailing 1–2 backticks as content (they aren't a fence).
   * If a fence is still open, its snapshot is returned as `unclosed`
   * and internal state is reset so the instance is reusable.
   */
  flush(): FlushResult {
    const segments: Segment[] = [];
    if (this.state.backtickRun > 0) {
      const stray = "`".repeat(this.state.backtickRun);
      this.state.backtickRun = 0;
      if (this.state.inFence) {
        this.appendInner(stray);
      } else {
        segments.push({ kind: "prose", text: stray });
      }
    }
    let unclosed: CompletedFence | null = null;
    if (this.state.inFence) {
      unclosed = this.snapshotOpenFence();
      this.state = makeState();
    }
    return { segments, unclosed };
  }

  /**
   * Snapshot the currently open fence and reset to outside-fence so
   * subsequent `feed()` bytes flow as prose. Returns null if no fence
   * is open.
   */
  forceClose(): CompletedFence | null {
    if (!this.state.inFence) return null;
    const snap = this.snapshotOpenFence();
    // Preserve any pending backtickRun (extremely unlikely to matter,
    // but keeps semantics predictable for callers).
    const backtickRun = this.state.backtickRun;
    this.state = makeState();
    this.state.backtickRun = backtickRun;
    return snap;
  }

  private appendInner(s: string): void {
    if (!this.state.fenceLangComplete) {
      // Backticks before the lang newline — treat as part of the lang
      // buffer (very unusual; e.g. ```` is gibberish). Append to lang
      // capture so we don't crash; trim() in finalize will clean it.
      this.state.fenceLangBuf += s;
    } else {
      this.state.fenceInner += s;
    }
  }

  private finalizeFence(): CompletedFence {
    // If the closer arrived before the lang newline, the lang capture
    // is everything between opener and closer; treat it all as content
    // with no lang.
    let lang = this.state.fenceLang;
    let inner = this.state.fenceInner;
    if (!this.state.fenceLangComplete) {
      lang = "";
      inner = this.state.fenceLangBuf;
    }
    // Strip a single trailing newline from inner — it's the "\n" that
    // immediately precedes the closing ```.
    if (inner.endsWith("\n")) inner = inner.slice(0, -1);
    const ext = LANG_EXT[lang] ?? "txt";
    const mimeType = EXT_MIME[ext] ?? "text/plain";
    const fence: CompletedFence = {
      lang,
      ext,
      mimeType,
      content: inner,
      openedAtMs: this.state.fenceOpenedAtMs,
    };
    // Reset fence state but stay outside-fence.
    this.state.inFence = false;
    this.state.fenceLang = "";
    this.state.fenceLangBuf = "";
    this.state.fenceLangComplete = false;
    this.state.fenceInner = "";
    this.state.fenceOpenedAtMs = 0;
    return fence;
  }

  private snapshotOpenFence(): CompletedFence {
    const lang = this.state.fenceLangComplete ? this.state.fenceLang : "";
    const inner = this.state.fenceLangComplete
      ? this.state.fenceInner
      : this.state.fenceLangBuf;
    const ext = LANG_EXT[lang] ?? "txt";
    const mimeType = EXT_MIME[ext] ?? "text/plain";
    return {
      lang,
      ext,
      mimeType,
      content: inner,
      openedAtMs: this.state.fenceOpenedAtMs,
    };
  }
}

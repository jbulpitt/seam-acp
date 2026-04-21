/**
 * Streaming code-fence extractor.
 *
 * Feed text chunks in as they arrive from the agent. The extractor
 * separates the stream into:
 *   - "prose": text that lives outside any code fence; goes to chat
 *     through the normal chunk/flush pipeline.
 *   - "completed fences": closed ```lang ... ``` blocks, returned as
 *     uploadable file payloads.
 *
 * The fence opener and closer themselves are NOT included in either
 * stream — they are consumed. This means a Discord user sees the
 * model's prose plus file attachments, never raw fence syntax.
 *
 * Design notes:
 *   - Pure state machine. No I/O, no logging.
 *   - Robust to fences split across chunk boundaries (the opener
 *     ``` is buffered byte-by-byte).
 *   - `flush()` at end-of-turn returns any unclosed fence as
 *     `unclosed`, so the caller can post a notice and discard.
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

export interface FeedResult {
  /** Text that should be forwarded to the chat-text pipeline. */
  prose: string;
  /** Fences that closed during this feed. */
  fences: CompletedFence[];
}

export interface FlushResult extends FeedResult {
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
 * Streaming fence-to-file extractor. Construct one per turn; call
 * `feed()` for every text chunk and `flush()` at end-of-turn.
 */
export class FenceStream {
  private state: State = makeState();

  /** True iff a fence is currently open. */
  get inFence(): boolean {
    return this.state.inFence;
  }

  /** Time in ms since the current open fence started, or 0 if none. */
  openSinceMs(now: number = Date.now()): number {
    if (!this.state.inFence || this.state.fenceOpenedAtMs === 0) return 0;
    return now - this.state.fenceOpenedAtMs;
  }

  /** Feed a chunk of streamed agent text. */
  feed(text: string, now: number = Date.now()): FeedResult {
    const out: FeedResult = { prose: "", fences: [] };
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === "`") {
        this.state.backtickRun += 1;
        if (this.state.backtickRun === 3) {
          // Flip state. Don't emit the backticks.
          this.state.backtickRun = 0;
          if (!this.state.inFence) {
            this.state.inFence = true;
            this.state.fenceLangBuf = "";
            this.state.fenceLangComplete = false;
            this.state.fenceLang = "";
            this.state.fenceInner = "";
            this.state.fenceOpenedAtMs = now;
          } else {
            // Closing fence — emit and reset.
            const fence = this.finalizeFence();
            out.fences.push(fence);
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
          out.prose += stray;
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
        out.prose += c;
      }
      i += 1;
    }
    return out;
  }

  /** Drain any trailing 1–2 backticks as content (they aren't a fence). */
  flush(): FlushResult {
    const out: FlushResult = { prose: "", fences: [], unclosed: null };
    if (this.state.backtickRun > 0) {
      const stray = "`".repeat(this.state.backtickRun);
      this.state.backtickRun = 0;
      if (this.state.inFence) {
        this.appendInner(stray);
      } else {
        out.prose += stray;
      }
    }
    if (this.state.inFence) {
      out.unclosed = this.snapshotOpenFence();
      // Reset so the instance is reusable.
      this.state = makeState();
    }
    return out;
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

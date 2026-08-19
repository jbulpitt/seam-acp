/**
 * Progressive, message-per-flush renderer for streamed agent text.
 *
 * This is a faithful, reusable extraction of the OUTPUT streaming pipeline the
 * user-turn path runs inline in `handleIncomingMessageInner` — the machinery
 * that makes a normal turn read naturally: incremental REAL messages posted at
 * clean paragraph / fence boundaries, with linebreaks and code fences intact.
 *
 * Feed each agent-text chunk in as it arrives; call {@link finalize} at
 * end-of-turn. Each time a clean, substantial boundary is reached (or the buffer
 * crosses the hard cap, or a fence closes, or the idle timer fires) the renderer
 * posts a fresh message via the `send` callback — it never edits a single
 * tail-capped message and never dumps everything at the end.
 *
 * The pipeline mirrors the main path piece-for-piece and constant-for-constant:
 *   - {@link FenceStream} pulls every ```lang … ``` block out of the prose so
 *     the splitter never sees a fence; closed fences are re-emitted verbatim as
 *     their own message (kept intact across flushes).
 *   - {@link splitForFlush} decides where to cut buffered prose (paragraph →
 *     line → sentence, honoring `---` breaks and open markdown links), bounded by
 *     `hardMax` with a `softMin` floor for soft (mid-stream) flushes.
 *   - a {@link SerialQueue} serializes every drain so concurrent feeds (the ACP
 *     read loop calls handlers without awaiting) can never reorder sends.
 *   - an idle-flush timer force-drains a slow trickle that never crosses the cap
 *     or hits a boundary; a fence watchdog + size ceiling force-close a fence
 *     that stays open too long or grows without bound.
 *
 * NOT included (deliberately turn-specific — they stay in the main path): the
 * runaway-loop / whitespace / retry-runaway detectors. This class is display
 * plumbing only; callers keep their own lossless full-text capture.
 */
import { FenceStream, type CompletedFence } from "./fence-stream.js";
import { splitForFlush } from "./stream-flush.js";
import { SerialQueue } from "./serial-queue.js";
import { isMathFenceLang, renderMathPng } from "./math-render.js";

/** Posts one flushed message. The renderer serializes calls so they never
 *  overlap; a rejection is the caller's to swallow (best-effort display). */
export type SendMessage = (text: string) => Promise<void>;

export interface StreamingMessageRendererOptions {
  /** Hard upper bound for a single sent message. Default 1800 (Discord headroom). */
  hardMax?: number;
  /** Minimum size for a soft (non-forced) mid-stream flush. Default 800. */
  softMin?: number;
  /** Force-flush a buffered trickle after this idle gap. Default 4000ms. */
  idleFlushMs?: number;
  /** Force-close a fence left open longer than this. Default 60000ms. */
  fenceMaxOpenMs?: number;
  /** Force-close a fence whose captured content grows past this. Default 16000. */
  fenceBufferCeiling?: number;
  /** Clock injection point (fence timing). Default {@link Date.now}. */
  now?: () => number;
  /** Optional structured logger for watchdog trips (best-effort). */
  logger?: { warn: (obj: unknown, msg?: string) => void };
  /** Optional file upload. When set, latex/math/tex/katex fences render as
   *  a PNG instead of reconstructed markdown. Existing callers that pass only
   *  `send` keep today's source-fence behavior. */
  sendFile?: (file: { data: Buffer; filename: string; mimeType: string }) => Promise<void>;
}

// Same constants the user-turn path uses in handleIncomingMessageInner.
const DEFAULT_HARD_MAX = 1800;
const DEFAULT_SOFT_MIN = 800;
const DEFAULT_IDLE_FLUSH_MS = 4000;
const DEFAULT_FENCE_MAX_OPEN_MS = 60_000;
const DEFAULT_FENCE_BUFFER_CEILING = 16_000;

export class StreamingMessageRenderer {
  private readonly fenceStream = new FenceStream();
  private textBuffer = "";
  // Serialize every drain. maybeFlush(), the idle timer, fence boundaries, and
  // finalize all trigger drains; without this they could run concurrently, each
  // reassigning `textBuffer` and issuing an independent send whose delivery
  // order isn't guaranteed — reordering output. Enqueueing is synchronous, so
  // drains (and their sends) run strictly in call order.
  private readonly flushQueue = new SerialQueue();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private fenceWatchdogTripped = false;
  private finalized = false;
  private sent = 0;

  private readonly hardMax: number;
  private readonly softMin: number;
  private readonly idleFlushMs: number;
  private readonly fenceMaxOpenMs: number;
  private readonly fenceBufferCeiling: number;
  private readonly now: () => number;
  private readonly logger?: { warn: (obj: unknown, msg?: string) => void };
  private readonly sendFile?: (file: {
    data: Buffer;
    filename: string;
    mimeType: string;
  }) => Promise<void>;
  private mathFenceCounter = 0;

  constructor(
    private readonly send: SendMessage,
    opts: StreamingMessageRendererOptions = {}
  ) {
    this.hardMax = opts.hardMax ?? DEFAULT_HARD_MAX;
    this.softMin = opts.softMin ?? DEFAULT_SOFT_MIN;
    this.idleFlushMs = opts.idleFlushMs ?? DEFAULT_IDLE_FLUSH_MS;
    this.fenceMaxOpenMs = opts.fenceMaxOpenMs ?? DEFAULT_FENCE_MAX_OPEN_MS;
    this.fenceBufferCeiling = opts.fenceBufferCeiling ?? DEFAULT_FENCE_BUFFER_CEILING;
    this.now = opts.now ?? Date.now;
    if (opts.logger) this.logger = opts.logger;
    if (opts.sendFile) this.sendFile = opts.sendFile;
  }

  /** How many messages have been posted so far (progressive flushes + fences +
   *  the terminal drain). Lets callers tell "streamed something" from "empty". */
  get sentCount(): number {
    return this.sent;
  }

  /** Resolves once every drain queued so far has settled. Lets a caller (or a
   *  test) await pending mid-stream flushes without finalizing the renderer. */
  whenIdle(): Promise<void> {
    return this.flushQueue.idle();
  }

  /** Feed one chunk of streamed agent text. Runs it through the fence extractor
   *  and routes each ordered segment: prose into the flush pipeline, a fence-open
   *  commits the preceding prose, a fence-close re-emits the fence as its own
   *  message. No-op once finalized. */
  feed(chunk: string): void {
    if (this.finalized || !chunk) return;
    const result = this.fenceStream.feed(chunk, this.now());
    for (const seg of result.segments) {
      if (seg.kind === "prose") {
        if (seg.text) {
          this.textBuffer += seg.text;
          this.maybeFlush();
          this.armIdleFlush();
        }
      } else if (seg.kind === "fence-open") {
        // Commit any pending prose before the fence so message ordering matches
        // the agent's stream order.
        this.cancelIdleTimer();
        void this.drainBuffer(true);
      } else {
        // fence-close: re-emit the fence verbatim as its own message.
        void this.emitFence(seg.fence);
      }
    }
    // Watchdog: a fence open too long is snapshotted, emitted with a notice, and
    // treated as closed so subsequent bytes flow as prose.
    if (
      !this.fenceWatchdogTripped &&
      this.fenceStream.inFence &&
      this.fenceStream.openSinceMs(this.now()) > this.fenceMaxOpenMs
    ) {
      this.tripFenceWatchdog("_(fence exceeded the watchdog timeout and was closed early)_");
    }
    // Hard ceiling: even inside an open fence, force-close if the captured
    // content grows past the ceiling. Defends against a runaway model loop
    // spamming inside a fence without losing legitimate long fences.
    if (
      !this.fenceWatchdogTripped &&
      this.fenceStream.inFence &&
      this.fenceStream.currentFenceContentLength() > this.fenceBufferCeiling
    ) {
      this.tripFenceWatchdog("_(fence exceeded the size ceiling and was closed early)_");
    }
  }

  /** End-of-turn: drain the fence extractor (an unclosed fence is emitted with a
   *  notice, not dropped), then force-drain every remaining byte. Idempotent — a
   *  second call just awaits the queue. */
  async finalize(): Promise<void> {
    if (this.finalized) {
      await this.flushQueue.idle();
      return;
    }
    this.finalized = true;
    this.cancelIdleTimer();
    const tail = this.fenceStream.flush();
    for (const seg of tail.segments) {
      if (seg.kind === "prose") {
        if (seg.text) this.textBuffer += seg.text;
      } else if (seg.kind === "fence-open") {
        // Shouldn't appear in flush output, but handle defensively.
        void this.drainBuffer(true, true);
      } else {
        void this.emitFence(seg.fence);
      }
    }
    if (tail.unclosed && !this.fenceWatchdogTripped) {
      this.logger?.warn(
        { lang: tail.unclosed.lang, chars: tail.unclosed.content.length },
        "turn ended with an unclosed code fence; emitting partial"
      );
      // Drain any prose preceding the unclosed fence first.
      void this.drainBuffer(true, true);
      void this.emitFence(tail.unclosed, "_(fence was not closed by the agent)_");
    }
    // Must drain everything. An open link will never be closed, so allow unsafe
    // cuts here.
    void this.drainBuffer(true, true);
    await this.flushQueue.idle();
  }

  /** Reconstruct a completed fence verbatim (```lang … ```) and post it as its
   *  own message, kept intact — never split across flushes. The lossless full
   *  text lives with the caller, so we don't route huge fences to a file here (a
   *  normal turn doesn't cap the streamed body). Math fences with `sendFile`
   *  typeset to a PNG instead (still on this queue so uploads stay ordered). */
  private emitFence(fence: CompletedFence, notice?: string): Promise<void> {
    return this.flushQueue.run(async () => {
      if (isMathFenceLang(fence.lang) && this.sendFile) {
        const body = fence.content.trim();
        if (!body) {
          this.logger?.warn(
            { lang: fence.lang },
            "empty math fence; emitting nothing"
          );
          return;
        }
        try {
          const png = await renderMathPng(fence.content);
          this.mathFenceCounter += 1;
          await this.sendFile({
            data: png,
            filename: `math-${this.mathFenceCounter}.png`,
            mimeType: "image/png",
          });
          this.sent += 1;
          if (notice) {
            await this.send(notice);
            this.sent += 1;
          }
          return;
        } catch (err) {
          this.logger?.warn(
            { err, lang: fence.lang },
            "math fence render failed; emitting source"
          );
          const failNotice = notice
            ? `${notice}\n_(couldn't render latex)_`
            : "_(couldn't render latex)_";
          const reconstructed = "```" + (fence.lang ?? "") + "\n" + fence.content + "\n```";
          await this.send(`${reconstructed}\n${failNotice}`);
          this.sent += 1;
          return;
        }
      }
      const reconstructed = "```" + (fence.lang ?? "") + "\n" + fence.content + "\n```";
      const text = notice ? `${reconstructed}\n${notice}` : reconstructed;
      await this.send(text);
      this.sent += 1;
    });
  }

  private tripFenceWatchdog(notice: string): void {
    this.fenceWatchdogTripped = true;
    const snap = this.fenceStream.forceClose();
    if (!snap) return;
    this.logger?.warn(
      { chars: snap.content.length },
      "open fence tripped the renderer watchdog; emitting partial content"
    );
    void this.emitFence(snap, notice);
  }

  private async drainBufferInner(force: boolean, allowUnsafeCut = false): Promise<void> {
    while (this.textBuffer) {
      const split = splitForFlush(this.textBuffer, {
        maxLen: this.hardMax,
        softMin: this.softMin,
        force,
        allowUnsafeCut,
      });
      if (!split) return;
      this.textBuffer = split.keep;
      if (split.send) {
        await this.send(split.send);
        this.sent += 1;
      }
      if (!force) return;
    }
  }

  private drainBuffer(force: boolean, allowUnsafeCut = false): Promise<void> {
    return this.flushQueue.run(() => this.drainBufferInner(force, allowUnsafeCut));
  }

  private maybeFlush(): void {
    if (this.textBuffer.length >= this.hardMax) {
      void this.drainBuffer(true);
      return;
    }
    void this.drainBuffer(false);
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private armIdleFlush(): void {
    this.cancelIdleTimer();
    if (!this.textBuffer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      // Idle for idleFlushMs — any open markdown link is probably never going to
      // close. Allow unsafe cuts so we don't strand the buffer.
      if (this.textBuffer) void this.drainBuffer(true, true);
    }, this.idleFlushMs);
    // Don't let a pending idle flush keep the process alive; finalize() clears it
    // in the normal path anyway.
    this.idleTimer.unref?.();
  }
}

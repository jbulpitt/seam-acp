/**
 * Throttled, serialized progressive editing of a single already-posted message
 * as agent text streams in.
 *
 * The dispatch path (handoff / forward / wake / watch / chain hops) runs a turn
 * through `Orchestrator.injectTurn`, which emits every `agent-text` chunk via
 * `onEvent` while still accumulating the full text for report-back. Feeding
 * those chunks straight into `editMessage` per token would be a Discord
 * rate-limit disaster (~5 edits / 5s per message). This helper interposes the
 * SAME two defences the user-turn status panel uses in
 * `handleIncomingMessageInner`:
 *
 *   1. **Throttle** — coalesce bursts of chunks into at most one edit per
 *      `debounceMs`. The first chunk always lands an edit immediately (so the
 *      viewer sees output start), subsequent chunks are debounced.
 *   2. **Serialize** — every edit runs through a {@link SerialQueue}, so a slow
 *      edit can never be overtaken by a later one and reorder the rendered text
 *      (the concurrency landmine the ACP read loop introduces).
 *
 * The full accumulated text is retained losslessly in {@link text}; the render
 * callback owns how much of it (and in what shape) actually reaches the wire.
 */
import { SerialQueue } from "./serial-queue.js";

/** Renders the current accumulated text into the target message. `done` is true
 *  only for the terminal render issued by {@link StreamingPanel.finalize}. Must
 *  perform the actual edit; the panel serializes calls so they never overlap. */
export type StreamRender = (text: string, done: boolean) => Promise<void>;

export class StreamingPanel {
  private buffer = "";
  private readonly queue = new SerialQueue();
  private lastEditAt = 0;
  private pending: ReturnType<typeof setTimeout> | undefined;
  private finalized = false;
  private renders = 0;

  /**
   * @param render     Performs one edit with the full accumulated text so far.
   * @param debounceMs Minimum spacing between edits. Defaults to 900ms, under
   *   Discord's ~5-edits-per-5s ceiling with headroom for the terminal render.
   */
  constructor(
    private readonly render: StreamRender,
    private readonly debounceMs = 900
  ) {}

  /** The full text accumulated so far — always the complete stream, never a
   *  truncated view. Independent of what the render callback chooses to show. */
  get text(): string {
    return this.buffer;
  }

  /** How many renders have been issued (progressive + terminal). Lets callers /
   *  tests assert the panel was edited more than once (i.e. streamed live). */
  get renderCount(): number {
    return this.renders;
  }

  /** Feed one chunk of agent text. Schedules a throttled edit; the first chunk
   *  edits immediately so output visibly starts. No-op once finalized. */
  append(chunk: string): void {
    if (this.finalized || !chunk) return;
    this.buffer += chunk;
    const now = Date.now();
    if (now - this.lastEditAt >= this.debounceMs) {
      // Due now (always true for the first chunk) — edit immediately so the
      // viewer sees streaming begin without waiting out the debounce.
      if (this.pending) {
        clearTimeout(this.pending);
        this.pending = undefined;
      }
      void this.enqueueRender(false);
      return;
    }
    // Within the debounce window — coalesce into a single trailing edit that
    // will flush the latest buffer once the window elapses.
    if (this.pending) return;
    const wait = this.debounceMs - (now - this.lastEditAt);
    this.pending = setTimeout(() => {
      this.pending = undefined;
      void this.enqueueRender(false);
    }, wait);
  }

  private enqueueRender(done: boolean): Promise<void> {
    this.lastEditAt = Date.now();
    this.renders += 1;
    const snapshot = this.buffer;
    return this.queue.run(() => this.render(snapshot, done));
  }

  /** Cancel any pending throttled edit, issue one terminal render, and wait for
   *  every queued edit to settle. Idempotent — a second call just awaits the
   *  queue. Safe to call even if no text ever streamed (renders the empty/final
   *  state once). */
  async finalize(): Promise<void> {
    if (this.finalized) {
      await this.queue.idle();
      return;
    }
    this.finalized = true;
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = undefined;
    }
    await this.enqueueRender(true);
    await this.queue.idle();
  }
}

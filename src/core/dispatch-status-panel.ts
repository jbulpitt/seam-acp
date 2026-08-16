/**
 * The traditional live STATUS PANEL, driven for a **dispatched** turn.
 *
 * Normal user turns get a rich, editable status card in
 * `handleIncomingMessageInner` — thinking output, context-window health, elapsed
 * time, model, tool calls. When dispatched output went plain
 * (`SEAM_DISPATCH_OUTPUT_STYLE=messages`) the dispatched turns (handoffs,
 * forwards, wakes, watches, chain hops, compaction, report-backs) lost that
 * panel. For a real work turn, that live health read is vital, so this class
 * brings it back — reusing the EXACT same {@link TurnStatus} model and
 * {@link renderStatusPanel} renderer, driven from `injectTurn`'s per-event
 * stream.
 *
 * It owns exactly the two defences the user-turn panel relies on, so a burst of
 * agent events can never turn into an editMessage storm or a reordered render:
 *
 *   1. **Throttle** — coalesce refreshes into at most one edit per `debounceMs`,
 *      with a periodic heartbeat so the elapsed clock still ticks while idle.
 *   2. **Serialize** — every edit runs through a {@link SerialQueue}, so a slow
 *      edit can't be overtaken by a later one (the ACP read-loop concurrency
 *      landmine).
 *
 * It is deliberately independent of the plain-output stream (`StreamingPanel`):
 * the panel and the answer are two separate messages, each throttled+serialized
 * on its own queue. This class never touches the answer text.
 */
import type { AgentEvent } from "../agents/agent-runtime.js";
import type { Renderer } from "../platforms/renderer.js";
import { serializePanelText } from "../platforms/renderer.js";
import { SerialQueue } from "./serial-queue.js";
import { TurnStatus, renderStatusPanel, formatContextUsage } from "./status-panel.js";
import type { TurnState } from "./types.js";

/** Platform I/O for the panel message. `post` sends the initial panel and
 *  returns an opaque ref (or undefined on failure — the panel then goes inert,
 *  since it is purely additive visibility). `edit` replaces the panel body. */
export interface DispatchStatusPanelIO<TRef> {
  post: (text: string) => Promise<TRef | undefined>;
  edit: (ref: TRef, text: string) => Promise<void>;
}

export interface DispatchStatusPanelOptions {
  /** Minimum spacing between throttled edits. Defaults to 2500ms, matching the
   *  user-turn panel's `STATUS_EDIT_DEBOUNCE_MS`. */
  debounceMs?: number;
  /** Heartbeat interval that ticks the elapsed clock while otherwise idle.
   *  Defaults to 5000ms, matching the user-turn panel's `STATUS_HEARTBEAT_MS`. */
  heartbeatMs?: number;
  /** Authoritative per-model context window floor (from static models), used so
   *  an agent's generic 200K default never masks the true window. 0 = unknown. */
  modelContextFloor?: number;
}

export class DispatchStatusPanel<TRef = unknown> {
  /** The underlying mutable turn state — same model the user-turn panel drives.
   *  Exposed so callers (and tests) can seed context or assert on it. */
  readonly status: TurnStatus;

  private ref: TRef | undefined;
  private readonly queue = new SerialQueue();
  private lastEditAt = 0;
  private pending: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private lastRendered = "";
  private finalized = false;
  private started = false;
  private renders = 0;

  constructor(
    private readonly renderer: Renderer,
    status: TurnStatus,
    private readonly io: DispatchStatusPanelIO<TRef>,
    private readonly opts: DispatchStatusPanelOptions = {}
  ) {
    this.status = status;
  }

  /** How many renders (initial post + edits) have been issued. Lets tests
   *  assert the panel actually updated. The initial post counts as 1. */
  get renderCount(): number {
    return this.renders;
  }

  /** True once the initial panel message was posted successfully — i.e. the
   *  panel is live and will receive edits. */
  get isLive(): boolean {
    return this.ref !== undefined;
  }

  /** Post the initial panel and arm the heartbeat. Returns true when the panel
   *  is live; false when the post failed (the panel then no-ops every event).
   *  Best-effort — never throws. */
  async start(): Promise<boolean> {
    if (this.started) return this.isLive;
    this.started = true;
    const text = this.renderText();
    this.lastRendered = text;
    this.renders += 1;
    try {
      this.ref = await this.io.post(text);
    } catch {
      this.ref = undefined;
    }
    if (this.ref === undefined) return false;
    const hb = this.opts.heartbeatMs ?? 5000;
    this.heartbeat = setInterval(() => {
      void this.refresh();
    }, hb);
    // Don't keep the event loop alive on the heartbeat alone.
    if (typeof this.heartbeat.unref === "function") this.heartbeat.unref();
    return true;
  }

  /**
   * Map one agent event onto the turn state, then throttle a refresh. This is
   * the SAME mapping the user-turn path uses in `handleIncomingMessageInner`:
   *   - tool-start / tool-update → action + activity
   *   - model-changed            → model
   *   - agent-thought            → thinking window
   *   - agent-state              → action
   *   - usage-update             → context-window health (high-water + floor)
   * agent-text / agent-file / mode-changed / config-options / error do not
   * alter the panel (agent-text drives the *separate* plain-output stream).
   */
  handleEvent(event: AgentEvent): void {
    if (this.finalized || !this.isLive) return;
    const s = this.status;
    switch (event.kind) {
      case "tool-start": {
        const label = event.title ?? event.kindLabel ?? "…";
        s.setAction(`Tool: ${label}`);
        s.pushActivity(label);
        break;
      }
      case "tool-update":
        if (event.status === "completed" || event.status === "failed") {
          s.setAction("Working…");
        } else if (event.title) {
          s.setAction(`Tool: ${event.title}`);
          s.pushActivity(event.title);
        } else {
          return;
        }
        break;
      case "model-changed":
        s.setModel(event.modelId);
        break;
      case "agent-thought":
        s.pushThinkingChunk(event.text);
        break;
      case "agent-state":
        s.setAction(event.state);
        break;
      case "usage-update": {
        // Ignore size:0 and mid-turn used:0 blips (compact boundaries / proxy
        // chunks with missing usage), exactly as the user-turn path does.
        if (event.size <= 0 || event.used === 0) return;
        const used = Math.max(event.used, s.contextUsedHighWater);
        s.contextUsedHighWater = used;
        const size = Math.max(
          event.size,
          this.opts.modelContextFloor ?? 0,
          s.contextWindowSize
        );
        s.contextWindowSize = size;
        s.context = formatContextUsage(used, size);
        break;
      }
      default:
        // agent-text / agent-file / mode-changed / config-options / error
        return;
    }
    void this.refresh();
  }

  /**
   * Finalize the panel: set the terminal state/action, stop the heartbeat, and
   * issue one last serialized render. Idempotent — a second call just awaits the
   * queue. Best-effort — never throws.
   */
  async finalize(state: TurnState, action?: string): Promise<void> {
    if (this.finalized) {
      await this.queue.idle();
      return;
    }
    this.finalized = true;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = undefined;
    }
    this.status.setState(state);
    if (action !== undefined) this.status.setAction(action);
    if (this.isLive) await this.enqueueRender(true, true);
    await this.queue.idle();
  }

  /** Serialize the current turn state to the panel's plain-text form. */
  private renderText(): string {
    return serializePanelText(
      renderStatusPanel(this.renderer, this.status.toInput(), Date.now())
    );
  }

  /** Throttled refresh: edit now if the debounce window has elapsed, else
   *  schedule a single trailing edit. Mirrors the user-turn panel's `refresh`. */
  private async refresh(): Promise<void> {
    if (this.finalized || !this.isLive) return;
    const now = Date.now();
    const debounce = this.opts.debounceMs ?? 2500;
    if (now - this.lastEditAt < debounce) {
      if (!this.pending) {
        const remaining = debounce - (now - this.lastEditAt);
        this.pending = setTimeout(() => {
          this.pending = undefined;
          void this.refresh();
        }, remaining);
        if (typeof this.pending.unref === "function") this.pending.unref();
      }
      return;
    }
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = undefined;
    }
    await this.enqueueRender(false);
  }

  /** Render + enqueue one serialized edit. Skips a redundant edit when the
   *  rendered text is byte-identical to the last one (unless forced/terminal). */
  private enqueueRender(done: boolean, force = false): Promise<void> {
    this.lastEditAt = Date.now();
    const text = this.renderText();
    if (!force && text === this.lastRendered) return Promise.resolve();
    this.lastRendered = text;
    this.renders += 1;
    const ref = this.ref;
    if (ref === undefined) return Promise.resolve();
    return this.queue.run(() => this.io.edit(ref, text));
  }
}

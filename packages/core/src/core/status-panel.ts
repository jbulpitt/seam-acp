import type { Renderer } from "../platforms/renderer.js";
import type {
  TurnState,
  PanelOrigin,
  StatusPanel,
  StatusCardStyle,
  StructuredPanel,
} from "./types.js";

/**
 * Renders the single editable status panel that the bot keeps for each
 * in-flight turn. State and helpers are pure; no I/O happens here — the
 * caller decides when to send/edit on the chat platform.
 */
export interface StatusPanelInput {
  state: TurnState;
  startedUtc: number;
  repoDisplay: string;
  model: string;
  /** Resolved API model id (e.g. "claude-opus-4-8"), if different from model alias. */
  resolvedModel?: string;
  /** Reasoning effort for this turn, if set. */
  effort?: string;
  /** Resolved Claude Fast-mode state for this turn (#37), if worth showing. */
  fastMode?: string;
  /** Optional title prefix shown before the turn state, e.g. a dispatch type
   *  ("📨 Handoff", "⏰ Wake"). Left unset for normal user turns so the panel
   *  title is just the state. */
  titlePrefix?: string;
  /** Provenance for a dispatched turn (#153): what the work is and where it
   *  came from. Unset for normal user turns. */
  origin?: PanelOrigin;
  action: string;
  /** Optional context-window line shown when tokens are known. */
  context?: string;
  /** Integer percent of the context window used, when known. */
  contextPct?: number;
  /** Recent activity (oldest → newest). */
  activity?: string[];
  /** Last few lines of model reasoning (oldest → newest). */
  thinking?: string[];
  style?: StatusCardStyle;
  brandFilename?: string;
  authorName?: string;
}

export function renderStatusPanel(
  renderer: Renderer,
  input: StatusPanelInput,
  nowUtc: number
): StructuredPanel {
  const elapsedSeconds = Math.max(
    0,
    Math.floor((nowUtc - input.startedUtc) / 1000)
  );
  const panel: StatusPanel = {
    state: input.state,
    elapsedSeconds,
    repoDisplay: input.repoDisplay,
    model: input.model,
    ...(input.resolvedModel ? { resolvedModel: input.resolvedModel } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.fastMode ? { fastMode: input.fastMode } : {}),
    ...(input.titlePrefix ? { titlePrefix: input.titlePrefix } : {}),
    ...(input.origin ? { origin: input.origin } : {}),
    action: input.action,
    context: input.context,
    ...(input.contextPct != null ? { contextPct: input.contextPct } : {}),
    activity: input.activity,
    thinking: input.thinking,
    ...(input.style ? { style: input.style } : {}),
    ...(input.brandFilename ? { brandFilename: input.brandFilename } : {}),
    ...(input.authorName ? { authorName: input.authorName } : {}),
  };
  return renderer.statusPanel(panel);
}

/** True when a {@link PanelOrigin} carries anything worth rendering. An origin
 *  whose every member was omitted as redundant is dropped, not shown blank. */
export function hasOrigin(origin: PanelOrigin | undefined): origin is PanelOrigin {
  if (!origin) return false;
  return Boolean(origin.promptExcerpt || origin.threadName || origin.channelName);
}

/**
 * The "who asked for this" line: `<thread name> · #<channel>`, with each part
 * present only when it was NOT dropped as redundant (#153 — a same-channel
 * label is noise, and naming this very thread as the origin is noise too).
 * Returns "" when nothing survives.
 */
export function formatOriginSource(origin: PanelOrigin | undefined): string {
  if (!origin) return "";
  const parts: string[] = [];
  if (origin.threadName) parts.push(origin.threadName);
  if (origin.channelName) parts.push(`#${origin.channelName}`);
  return parts.join(" · ");
}

/** Format a context-window usage line, e.g. "128k / 1m (13%)". Shared by the
 *  live user-turn panel and the dispatched-turn panel so both read identically. */
export function formatContextUsage(used: number, size: number): string {
  const pct = Math.round((used / size) * 100);
  return `${fmtTokens(used)} / ${fmtTokens(size)} (${pct}%)`;
}

/** Compact a token count to a `k`/`m` suffixed string. */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}m`;
  return `${Math.round(n / 1_000)}k`;
}

/**
 * Mutable status state for an in-flight turn. The Discord adapter wraps this
 * with a debounced editor so we never edit a message more often than once a
 * second (matching the C# bot's behavior).
 */
export class TurnStatus {
  state: TurnState = "Working";
  action = "Starting…";
  model: string;
  /** Resolved API model id returned by getUsage (e.g. "claude-opus-4-8").
   *  Set after the turn completes; cleared on each new TurnStatus instance. */
  resolvedModel?: string;
  /** Reasoning effort for this turn (low|medium|high|xhigh|max), or undefined
   *  when unset (the model's built-in default applies). */
  effort?: string;
  /** Resolved Claude Fast-mode state (#37). Set from the runtime outcome after
   *  the session exists, so the card reports what was APPLIED, not requested. */
  fastMode?: string;
  /** Optional title prefix (e.g. a dispatch type "📨 Handoff"). Unset for
   *  normal user turns. Rendered before the turn state in the panel title. */
  titlePrefix?: string;
  /** Provenance for a dispatched turn (#153) — prompt excerpt + source
   *  thread/channel. Fixed at turn start; unset for normal user turns. */
  origin?: PanelOrigin;
  repoDisplay: string;
  startedUtc: number;
  context?: string;
  /** Monotonic ceiling on context-window `used` for this turn. Some agents
   *  emit a falling reading mid-turn (e.g. a fresh API call that excludes
   *  cached tokens, or post-compaction); we want the panel to show the
   *  highest watermark seen so it doesn't visibly drop. Reset per turn. */
  contextUsedHighWater = 0;
  /** Last-known context-window size for the active model, learned from
   *  usage-update events. Auto-compact uses this to size the summary prompt
   *  so it fits comfortably in the same window. 0 = unknown. */
  contextWindowSize = 0;
  /** Rolling activity log (oldest → newest). Capped to last N entries. */
  activity: string[] = [];
  /** `"simple"` compact layout; default `"full"`. */
  style: StatusCardStyle = "full";
  /** Brand logo filename for `attachment://` (set at turn start). */
  brandFilename?: string;
  /** Full-card author name (agent display name). */
  authorName?: string;
  private static readonly MAX_ACTIVITY = 20;
  /** Last N complete lines of model reasoning (oldest → newest). */
  private thinkingLines: string[] = [];
  /** Incoming thought chunks may end mid-line — buffer until we see a \n. */
  private thinkingPending = "";
  private static readonly MAX_THINKING = 5;

  constructor(opts: {
    model: string;
    repoDisplay: string;
    effort?: string;
    titlePrefix?: string;
    origin?: PanelOrigin;
    style?: StatusCardStyle;
    brandFilename?: string;
    authorName?: string;
  }) {
    this.model = opts.model;
    this.repoDisplay = opts.repoDisplay;
    if (opts.effort) this.effort = opts.effort;
    if (opts.titlePrefix) this.titlePrefix = opts.titlePrefix;
    if (opts.origin && hasOrigin(opts.origin)) this.origin = opts.origin;
    if (opts.style) this.style = opts.style;
    if (opts.brandFilename) this.brandFilename = opts.brandFilename;
    if (opts.authorName) this.authorName = opts.authorName;
    this.startedUtc = Date.now();
  }

  setState(state: TurnState): void {
    this.state = state;
  }

  setAction(action: string): void {
    this.action = action;
  }

  setModel(model: string): void {
    this.model = model;
  }

  setRepo(repoDisplay: string): void {
    this.repoDisplay = repoDisplay;
  }

  /** Append a recent-activity line; dedupes consecutive duplicates. */
  pushActivity(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    const last = this.activity[this.activity.length - 1];
    if (last === trimmed) return;
    this.activity.push(trimmed);
    if (this.activity.length > TurnStatus.MAX_ACTIVITY) {
      this.activity.splice(0, this.activity.length - TurnStatus.MAX_ACTIVITY);
    }
  }

  private isSystemInstruction(text: string): boolean {
    const lower = text.toLowerCase();
    return (
      lower.includes("tool specificity") ||
      lower.includes("critical instruction") ||
      lower.includes("avoid cat for file creation") ||
      lower.includes("grepsearch") ||
      lower.includes("refining tool usage") ||
      lower.includes("refining my approach") ||
      lower.includes("specific tool usage") ||
      lower.includes("in tool selection") ||
      lower.includes("precise tool utilization") ||
      lower.includes("focused on adhering") ||
      lower.includes("more specific tool selections") ||
      lower.includes("explicit tool listings")
    );
  }

  /**
   * Append a streamed thought chunk. Thoughts arrive as deltas that may end
   * mid-line; we buffer until we hit a newline, then promote complete lines
   * to a rolling window of the last N. The in-progress tail is shown at the
   * bottom of the window via {@link thinkingWindow} so streaming feels live.
   */
  pushThinkingChunk(text: string): void {
    if (!text) return;
    this.thinkingPending += text;
    const lastNl = this.thinkingPending.lastIndexOf("\n");
    if (lastNl === -1) return;
    const complete = this.thinkingPending.slice(0, lastNl);
    this.thinkingPending = this.thinkingPending.slice(lastNl + 1);
    for (const raw of complete.split("\n")) {
      const t = raw.trim();
      if (!t || this.isSystemInstruction(t)) continue;
      this.thinkingLines.push(t);
      if (this.thinkingLines.length > TurnStatus.MAX_THINKING) {
        this.thinkingLines.shift();
      }
    }
  }

  /** Rolling window of the last N thought lines plus the in-flight tail. */
  thinkingWindow(): string[] | undefined {
    const pending = this.thinkingPending.trim();
    const showPending = pending && !this.isSystemInstruction(pending);
    if (this.thinkingLines.length === 0 && !showPending) return undefined;
    const lines = showPending ? [...this.thinkingLines, pending] : [...this.thinkingLines];
    return lines.length > 0 ? lines.slice(-TurnStatus.MAX_THINKING) : undefined;
  }

  toInput(): StatusPanelInput {
    const thinking = this.thinkingWindow();
    const contextPct =
      this.contextWindowSize > 0
        ? Math.round((this.contextUsedHighWater / this.contextWindowSize) * 100)
        : undefined;
    return {
      state: this.state,
      startedUtc: this.startedUtc,
      repoDisplay: this.repoDisplay,
      model: this.model,
      ...(this.resolvedModel ? { resolvedModel: this.resolvedModel } : {}),
      ...(this.effort ? { effort: this.effort } : {}),
      ...(this.fastMode ? { fastMode: this.fastMode } : {}),
      ...(this.titlePrefix ? { titlePrefix: this.titlePrefix } : {}),
      ...(this.origin ? { origin: this.origin } : {}),
      action: this.action,
      context: this.context,
      ...(contextPct != null ? { contextPct } : {}),
      activity: this.activity.length ? [...this.activity] : undefined,
      ...(thinking ? { thinking } : {}),
      ...(this.style !== "full" ? { style: this.style } : {}),
      ...(this.brandFilename ? { brandFilename: this.brandFilename } : {}),
      ...(this.authorName ? { authorName: this.authorName } : {}),
    };
  }
}

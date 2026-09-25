/**
 * Current-state status for one turn (#445).
 *
 * This is not the output log. The log is a cursor over bytes and replaying it
 * redraws every intermediate frame. A snapshot is one record and one Discord
 * message: the caller renders the latest and skips everything in between.
 * Elapsed time always reflects the clock.
 *
 * `contextUsed` is the token count already read from the session transcript.
 * The catalog window is not a field of this record — seam-acp supplies it at
 * render time, because a window size is catalog metadata, not a daemon fact.
 */

/** Bounded tail. Long enough for one thought line, short enough that the
 *  record cannot become the stream. */
export const STATUS_TEXT_TAIL_MAX = 240;

export interface StatusSnapshot {
  state: string;
  /** Current one-line activity ("Tool: Read", "Working…"). Not a history. */
  action: string;
  model: string;
  /** Transcript tokens. Null when no reading has been observed. */
  contextUsed: number | null;
  latestTool: string | null;
  textTail: string;
  /**
   * Seconds since start, as of the latest publish.
   */
  elapsedSeconds: number;
}

export interface StatusObservation {
  state: string;
  action: string;
  model: string;
  contextUsed: number | null;
  latestTool: string | null;
  textTail: string;
  startedAt: number;
}

/** Turn fields the snapshot is projected from. The activity list and the
 *  thinking window stay on the turn; only the latest tool and the tail enter
 *  the record. */
export interface TurnSnapshotSource {
  state: string;
  action: string;
  model: string;
  contextUsedHighWater: number;
  contextWindowSize: number;
  activity: readonly string[];
  startedUtc: number;
  thinkingWindow(): readonly string[] | undefined;
}

function boundTail(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= STATUS_TEXT_TAIL_MAX) return flat;
  return flat.slice(flat.length - STATUS_TEXT_TAIL_MAX);
}

function normalizeUsed(used: number | null): number | null {
  if (used == null || !Number.isFinite(used) || used < 0) return null;
  return used;
}

function normalizeWindow(window: number | null): number | null {
  if (window == null || !Number.isFinite(window) || window <= 0) return null;
  return window;
}

function contentOf(observation: StatusObservation): Omit<StatusSnapshot, "elapsedSeconds"> {
  const tool = observation.latestTool?.trim() ?? "";
  return {
    state: observation.state,
    action: observation.action,
    model: observation.model,
    contextUsed: normalizeUsed(observation.contextUsed),
    latestTool: tool ? tool : null,
    textTail: boundTail(observation.textTail),
  };
}

function sameContent(
  snapshot: StatusSnapshot,
  content: Omit<StatusSnapshot, "elapsedSeconds">,
): boolean {
  return snapshot.state === content.state
    && snapshot.action === content.action
    && snapshot.model === content.model
    && snapshot.contextUsed === content.contextUsed
    && snapshot.latestTool === content.latestTool
    && snapshot.textTail === content.textTail;
}

export function observationFromTurn(status: TurnSnapshotSource): {
  observation: StatusObservation;
  contextWindow: number | null;
} {
  const thinking = status.thinkingWindow();
  const textTail = thinking && thinking.length ? thinking[thinking.length - 1]! : "";
  const latest = status.activity.length ? status.activity[status.activity.length - 1]! : null;
  const seen = status.contextWindowSize > 0 || status.contextUsedHighWater > 0;
  return {
    observation: {
      state: status.state,
      action: status.action,
      model: status.model,
      contextUsed: seen ? status.contextUsedHighWater : null,
      latestTool: latest,
      textTail,
      startedAt: status.startedUtc,
    },
    contextWindow: status.contextWindowSize > 0 ? status.contextWindowSize : null,
  };
}

/**
 * Pure render. Same snapshot and same window → same string. Does not read
 * the clock. The window is display-only and is not written back onto the
 * snapshot.
 */
export function renderStatusSnapshot(
  snapshot: StatusSnapshot,
  contextWindow: number | null,
): string {
  const window = normalizeWindow(contextWindow);
  const usage = snapshot.contextUsed == null
    ? ""
    : window == null
      ? String(snapshot.contextUsed)
      : `${snapshot.contextUsed}/${window}`;
  return [
    snapshot.state,
    snapshot.action,
    snapshot.model,
    snapshot.latestTool ?? "",
    snapshot.textTail,
    String(snapshot.elapsedSeconds),
    usage,
  ].join("\n");
}

/**
 * One card. `bind` after the single create. Later publishes either edit that
 * message or do nothing. This class never asks for a second message.
 */
export class StatusSnapshotCard {
  private snapshot: StatusSnapshot | null = null;
  private body = "";
  private window: number | null = null;
  private bound = false;
  private deliveredBody: string | null = null;

  current(): StatusSnapshot | null {
    return this.snapshot ? { ...this.snapshot } : null;
  }

  renderedBody(): string {
    return this.body;
  }

  /**
   * Fold the latest observation in. A catalog-window change alone updates
   * the rendered body only.
   */
  publish(observation: StatusObservation, contextWindow: number | null, now: number): StatusSnapshot {
    const content = contentOf(observation);
    const window = normalizeWindow(contextWindow);
    const elapsedSeconds = Math.max(0, Math.floor((now - observation.startedAt) / 1000));
    // The clock is part of what the card shows: a later publish of the same
    // content still moves it, so a long quiet turn visibly keeps counting.
    if (this.snapshot && sameContent(this.snapshot, content) && this.snapshot.elapsedSeconds === elapsedSeconds) {
      if (this.window !== window) {
        this.window = window;
        this.body = renderStatusSnapshot(this.snapshot, window);
      }
      return { ...this.snapshot };
    }
    this.snapshot = { ...content, elapsedSeconds };
    this.window = window;
    this.body = renderStatusSnapshot(this.snapshot, window);
    return { ...this.snapshot };
  }

  /** The message exists and currently shows `renderedBody`. */
  bind(): void {
    this.bound = true;
    this.deliveredBody = this.body;
  }

  /** The edit of the bound message landed. */
  acknowledge(): void {
    if (!this.bound) this.bound = true;
    this.deliveredBody = this.body;
  }

  /**
   * What the one artifact needs. `skip` does no I/O. `edit` patches the
   * message already bound. There is no `post`: creating the message is the
   * caller's one-time act, followed by `bind`.
   */
  plan(): { action: "skip" | "edit"; body: string } {
    if (!this.snapshot || !this.bound || this.deliveredBody === this.body) {
      return { action: "skip", body: this.body };
    }
    return { action: "edit", body: this.body };
  }
}

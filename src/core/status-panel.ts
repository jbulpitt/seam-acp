import type { Renderer } from "../platforms/renderer.js";
import type { TurnState, StatusPanel } from "./types.js";

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
  action: string;
  /** Optional usage line shown when tokens/multiplier are known. */
  usage?: string;
  /** Recent activity (oldest → newest). */
  activity?: string[];
}

export function renderStatusPanel(
  renderer: Renderer,
  input: StatusPanelInput,
  nowUtc: number
): string {
  const elapsedSeconds = Math.max(
    0,
    Math.floor((nowUtc - input.startedUtc) / 1000)
  );
  const panel: StatusPanel = {
    state: input.state,
    elapsedSeconds,
    repoDisplay: input.repoDisplay,
    model: input.model,
    action: input.action,
    usage: input.usage,
    activity: input.activity,
  };
  return renderer.statusPanel(panel);
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
  repoDisplay: string;
  startedUtc: number;
  usage?: string;
  /** Rolling activity log (oldest → newest). Capped to last N entries. */
  activity: string[] = [];
  private static readonly MAX_ACTIVITY = 5;

  constructor(opts: { model: string; repoDisplay: string }) {
    this.model = opts.model;
    this.repoDisplay = opts.repoDisplay;
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

  toInput(): StatusPanelInput {
    return {
      state: this.state,
      startedUtc: this.startedUtc,
      repoDisplay: this.repoDisplay,
      model: this.model,
      action: this.action,
      usage: this.usage,
      activity: this.activity.length ? [...this.activity] : undefined,
    };
  }
}

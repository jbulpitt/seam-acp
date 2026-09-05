/**
 * Durable in-thread Rebuild card (#217).
 *
 * Pure copy + StructuredPanel so tests do not boot Discord. Orchestrator
 * posts/edits/freezes via sendPanel/editPanel; this module never talks to
 * the adapter.
 */
import type { StatusCardStyle, StructuredPanel } from "./types.js";
import { SerialQueue } from "./serial-queue.js";

export type RebuildCardStyle = StatusCardStyle;
export type RebuildWorkingStage =
  | "starting"
  | "fetching"
  | "assembled"
  | "seeding"
  | "attaching";

export interface RebuildWorkingDetails {
  agentId?: string;
  model?: string;
  contextWindow?: number;
  budgetTokens?: number;
  discordPosts?: number;
  projectedLogicalCount?: number;
  retainedLogicalCount?: number;
  omittedLogicalCount?: number;
  estimatedTokens?: number;
}

export interface RebuildSuccessStats {
  agentId: string;
  model: string;
  contextWindow: number;
  sourcePostCount: number;
  projectedLogicalCount: number;
  retainedLogicalCount: number;
  omittedLogicalCount: number;
  estimatedTokens: number;
  budgetTokens: number;
  transformSavedTokens?: number;
  newSessionId: string;
  attachLine: string;
}

export type RebuildCardState =
  | {
      kind: "working";
      stage: RebuildWorkingStage;
      startedAt: number;
      now: number;
      details: RebuildWorkingDetails;
    }
  | {
      kind: "success";
      startedAt: number;
      now: number;
      stats: RebuildSuccessStats;
    }
  | {
      kind: "failure";
      startedAt: number;
      now: number;
      error: string;
    };

export interface RebuildCardIO<TRef = unknown> {
  post: (panel: StructuredPanel) => Promise<TRef | undefined>;
  edit: (ref: TRef, panel: StructuredPanel) => Promise<void>;
}

const COLOR_WORKING = 0xfaa61a;
const COLOR_SUCCESS = 0x57f287;
const COLOR_FAILURE = 0xed4245;

const SIMPLE_STAGE: Record<RebuildWorkingStage, string> = {
  starting: "Looking back through the thread",
  fetching: "Looking back through the thread",
  assembled: "Preparing",
  seeding: "Loading it back in",
  attaching: "Finishing",
};

const FULL_STAGE: Record<RebuildWorkingStage, string> = {
  starting: "Resolving destination",
  fetching: "Fetching Discord history",
  assembled: "Assembling seed",
  seeding: "Seeding new session",
  attaching: "Attaching",
};

/** Locked simple working copy. Do not paraphrase. */
export const SIMPLE_WORKING_TITLE = "Getting ready to continue";
export const SIMPLE_WORKING_LINE = "This can take a few minutes.";
export const SIMPLE_SUCCESS_TITLE = "Ready to continue";
export const SIMPLE_SUCCESS_LINE = "This conversation can continue.";
export const SIMPLE_FAILURE_TITLE = "Couldn't finish";
export const SIMPLE_FAILURE_LINE = "You can keep going from here, or try again.";

export function formatRebuildElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function firstErrorLine(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const line = raw.split("\n")[0]?.trim() ?? "";
  return line || "Rebuild failed.";
}

export function destinationLine(d: RebuildWorkingDetails): string {
  const agent = d.agentId ?? "unknown";
  const model = d.model ?? "unknown";
  const window = d.contextWindow ?? 0;
  const budget = d.budgetTokens ?? 0;
  return `${agent} · ${model} · window ${window} · 60% budget ${budget}`;
}

function elapsedFooter(startedAt: number, now: number): string {
  return `⏱ ${formatRebuildElapsed(now - startedAt)}`;
}

function simpleWorking(state: Extract<RebuildCardState, { kind: "working" }>): StructuredPanel {
  const stage = SIMPLE_STAGE[state.stage];
  return {
    color: COLOR_WORKING,
    title: SIMPLE_WORKING_TITLE,
    description: `${SIMPLE_WORKING_LINE}\n${stage}`,
    fields: [],
    footer: elapsedFooter(state.startedAt, state.now),
  };
}

function simpleSuccess(state: Extract<RebuildCardState, { kind: "success" }>): StructuredPanel {
  return {
    color: COLOR_SUCCESS,
    title: SIMPLE_SUCCESS_TITLE,
    description: SIMPLE_SUCCESS_LINE,
    fields: [],
    footer: elapsedFooter(state.startedAt, state.now),
    actions: [],
  };
}

function simpleFailure(state: Extract<RebuildCardState, { kind: "failure" }>): StructuredPanel {
  return {
    color: COLOR_FAILURE,
    title: SIMPLE_FAILURE_TITLE,
    description: SIMPLE_FAILURE_LINE,
    fields: [],
    footer: elapsedFooter(state.startedAt, state.now),
    actions: [],
  };
}

function fullWorking(state: Extract<RebuildCardState, { kind: "working" }>): StructuredPanel {
  const d = state.details;
  const fields: StructuredPanel["fields"] = [];
  if (d.agentId || d.model || d.contextWindow != null) {
    fields.push({
      name: "Destination",
      value: `\`${d.agentId ?? "?"}\` · \`${d.model ?? "?"}\` · window ${d.contextWindow ?? "?"}`,
      inline: false,
    });
  }
  if (d.budgetTokens != null) {
    fields.push({
      name: "Budget",
      value: `${d.budgetTokens} tokens (60%)`,
      inline: true,
    });
  }
  if (d.discordPosts != null) {
    fields.push({
      name: "Fetched",
      value: `${d.discordPosts} Discord post${d.discordPosts === 1 ? "" : "s"}`,
      inline: true,
    });
  }
  if (
    d.projectedLogicalCount != null &&
    d.retainedLogicalCount != null &&
    d.omittedLogicalCount != null
  ) {
    fields.push({
      name: "Projected",
      value:
        `${d.projectedLogicalCount} logical · retained ${d.retainedLogicalCount} · ` +
        `omitted ${d.omittedLogicalCount}` +
        (d.estimatedTokens != null ? ` · ~${d.estimatedTokens} tokens` : ""),
      inline: false,
    });
  }
  let description: string;
  switch (state.stage) {
    case "starting":
      description = destinationLine(d);
      break;
    case "fetching":
      description =
        d.discordPosts != null
          ? `Fetched ${d.discordPosts} Discord post${d.discordPosts === 1 ? "" : "s"}`
          : "Fetching Discord history";
      break;
    case "assembled":
      description =
        d.projectedLogicalCount != null
          ? `projected ${d.projectedLogicalCount} logical · retained ${d.retainedLogicalCount} · omitted ${d.omittedLogicalCount} · ~${d.estimatedTokens ?? 0} tokens`
          : "Assembling seed";
      break;
    case "seeding":
      description = "Seeding new session";
      break;
    case "attaching":
      description = "Attaching";
      break;
  }
  return {
    color: COLOR_WORKING,
    title: "Rebuild",
    description,
    fields,
    footer: `${elapsedFooter(state.startedAt, state.now)} · ${FULL_STAGE[state.stage]}`,
  };
}

function fullSuccess(state: Extract<RebuildCardState, { kind: "success" }>): StructuredPanel {
  const s = state.stats;
  const fields: StructuredPanel["fields"] = [
    {
      name: "Destination",
      value: `\`${s.agentId}\` · \`${s.model}\` · window ${s.contextWindow}`,
      inline: false,
    },
    {
      name: "Discord",
      value: `${s.sourcePostCount} posts → logical ${s.projectedLogicalCount}`,
      inline: true,
    },
    {
      name: "Retained",
      value: `${s.retainedLogicalCount} retained, ${s.omittedLogicalCount} omitted`,
      inline: true,
    },
    {
      name: "Seed",
      value:
        `${s.estimatedTokens} / ${s.budgetTokens} tokens (60% budget)` +
        (s.transformSavedTokens
          ? `\nNormalization saved ~${s.transformSavedTokens} tokens`
          : ""),
      inline: false,
    },
    {
      name: "New session",
      value: `\`${s.newSessionId}\``,
      inline: false,
    },
    {
      name: "Attach",
      value: s.attachLine,
      inline: false,
    },
  ];
  return {
    color: COLOR_SUCCESS,
    title: "Rebuild complete",
    description: undefined,
    fields,
    footer: elapsedFooter(state.startedAt, state.now),
    actions: [],
  };
}

function fullFailure(state: Extract<RebuildCardState, { kind: "failure" }>): StructuredPanel {
  return {
    color: COLOR_FAILURE,
    title: "Rebuild failed",
    description: state.error,
    fields: [],
    footer: elapsedFooter(state.startedAt, state.now),
    actions: [],
  };
}

export function renderRebuildCard(style: RebuildCardStyle, state: RebuildCardState): StructuredPanel {
  if (style === "simple") {
    if (state.kind === "working") return simpleWorking(state);
    if (state.kind === "success") return simpleSuccess(state);
    return simpleFailure(state);
  }
  if (state.kind === "working") return fullWorking(state);
  if (state.kind === "success") return fullSuccess(state);
  return fullFailure(state);
}

/** Collect every user-visible string on a panel (for simple-copy audits). */
export function panelTextBlob(panel: StructuredPanel): string {
  const parts = [
    panel.title ?? "",
    panel.author ?? "",
    panel.description ?? "",
    panel.footer ?? "",
    ...panel.fields.map((f) => `${f.name} ${f.value}`),
  ];
  return parts.join("\n");
}

/**
 * Live card session: post once, edit through stages, heartbeat elapsed during
 * the opaque seed wait, freeze on success or failure. Best-effort — never throws.
 */
export class RebuildCardSession<TRef = unknown> {
  private ref: TRef | undefined;
  private readonly startedAt: number;
  private stage: RebuildWorkingStage = "starting";
  private details: RebuildWorkingDetails = {};
  private kind: "working" | "success" | "failure" = "working";
  private successStats?: RebuildSuccessStats;
  private error = "";
  private finalized = false;
  private lastEditAt = 0;
  private lastRendered = "";
  private pending: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private readonly queue = new SerialQueue();
  readonly renders: StructuredPanel[] = [];

  constructor(
    private readonly style: RebuildCardStyle,
    private readonly io: RebuildCardIO<TRef>,
    private readonly opts: {
      now?: () => number;
      debounceMs?: number;
      heartbeatMs?: number;
    } = {}
  ) {
    this.startedAt = this.now();
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  get isLive(): boolean {
    return this.ref !== undefined;
  }

  async start(details: RebuildWorkingDetails): Promise<boolean> {
    this.details = { ...details };
    this.stage = "starting";
    const panel = this.render();
    this.lastRendered = JSON.stringify(panel);
    this.renders.push(panel);
    try {
      this.ref = await this.io.post(panel);
    } catch {
      this.ref = undefined;
    }
    if (this.ref === undefined) return false;
    this.lastEditAt = this.now();
    const hb = this.opts.heartbeatMs ?? 5000;
    this.heartbeat = setInterval(() => {
      void this.refresh(false);
    }, hb);
    this.heartbeat.unref?.();
    return true;
  }

  async setStage(stage: RebuildWorkingStage, details?: RebuildWorkingDetails): Promise<void> {
    if (this.finalized) return;
    this.stage = stage;
    if (details) this.details = { ...this.details, ...details };
    await this.refresh(true);
  }

  async succeed(stats: RebuildSuccessStats): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    this.stopTimers();
    this.kind = "success";
    this.successStats = stats;
    if (this.isLive) await this.enqueueRender(true);
    await this.queue.idle();
  }

  async fail(error: string): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    this.stopTimers();
    this.kind = "failure";
    this.error = error;
    if (this.isLive) await this.enqueueRender(true);
    await this.queue.idle();
  }

  dispose(): void {
    this.stopTimers();
  }

  private stopTimers(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = undefined;
    }
  }

  private state(): RebuildCardState {
    if (this.kind === "success" && this.successStats) {
      return {
        kind: "success",
        startedAt: this.startedAt,
        now: this.now(),
        stats: this.successStats,
      };
    }
    if (this.kind === "failure") {
      return {
        kind: "failure",
        startedAt: this.startedAt,
        now: this.now(),
        error: this.error,
      };
    }
    return {
      kind: "working",
      stage: this.stage,
      startedAt: this.startedAt,
      now: this.now(),
      details: this.details,
    };
  }

  private render(): StructuredPanel {
    return renderRebuildCard(this.style, this.state());
  }

  private async refresh(force: boolean): Promise<void> {
    if (this.finalized || !this.isLive) return;
    const debounce = this.opts.debounceMs ?? 2500;
    const t = this.now();
    if (!force && t - this.lastEditAt < debounce) {
      if (!this.pending) {
        const remaining = debounce - (t - this.lastEditAt);
        this.pending = setTimeout(() => {
          this.pending = undefined;
          void this.refresh(false);
        }, remaining);
        this.pending.unref?.();
      }
      return;
    }
    await this.enqueueRender(force);
  }

  private enqueueRender(force: boolean): Promise<void> {
    return this.queue.run(async () => {
      if (!this.isLive) return;
      if (this.finalized && !force && this.kind === "working") return;
      const panel = this.render();
      const fingerprint = JSON.stringify(panel);
      if (!force && fingerprint === this.lastRendered) return;
      this.lastRendered = fingerprint;
      this.lastEditAt = this.now();
      this.renders.push(panel);
      try {
        await this.io.edit(this.ref as TRef, panel);
      } catch {
        /* best-effort */
      }
    });
  }
}

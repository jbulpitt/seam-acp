import type { AgyStep } from "./agy-stream.js";

export type AgyContentRole = "message" | "thought";
export type AgyDelivery = "live" | "historical";
export type AgyToolStatus = "pending" | "in_progress" | "completed" | "failed";
export type AgyToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "fetch" | "other";

interface AgyEventIdentity {
  sessionId: string;
  stepIndex: number;
}

export interface AgyContentEvent extends AgyEventIdentity {
  kind: "content";
  role: AgyContentRole;
  operation: "append" | "replace";
  text: string;
}

export interface AgyUsageEvent extends AgyEventIdentity {
  kind: "usage";
  used: number;
  size: number;
}

export interface AgyToolMetadata {
  nativeType: string;
  nativeStatus?: string;
  terminal: boolean;
  edit: boolean;
  task: boolean;
  error: boolean;
}

export interface AgyToolStartEvent extends AgyEventIdentity {
  kind: "tool-start";
  toolCallId: string;
  title: string;
  toolKind: AgyToolKind;
  status: AgyToolStatus;
  metadata: AgyToolMetadata;
}

export interface AgyToolUpdateEvent extends AgyEventIdentity {
  kind: "tool-update";
  toolCallId: string;
  title: string;
  status: AgyToolStatus;
  metadata: AgyToolMetadata;
}

export interface AgyGeneratedImageEvent extends AgyEventIdentity {
  kind: "generated-image";
  content: string;
}

export type AgyNativeEvent =
  | AgyContentEvent
  | AgyUsageEvent
  | AgyToolStartEvent
  | AgyToolUpdateEvent
  | AgyGeneratedImageEvent;

export interface AgyTranslationBatch {
  sessionId: string;
  stepIndex: number;
  delivery: AgyDelivery;
  events: AgyNativeEvent[];
}

export interface AgyNativeTranslatorOptions {
  sessionId: string;
  replayThrough: number;
  maxTokens: number;
  omitPlannerMessage?: boolean;
}

interface ToolSnapshot {
  title: string;
  status: AgyToolStatus;
  metadata: AgyToolMetadata;
}

const INTERNAL_STEP_TYPES = new Set([
  "CORTEX_STEP_TYPE_USER_INPUT",
  "CORTEX_STEP_TYPE_CONVERSATION_HISTORY",
  "CORTEX_STEP_TYPE_CHECKPOINT",
]);

/**
 * Pure, per-turn translator for native AGY cumulative trajectory snapshots.
 * Fetching, redaction, persistence, filesystem IO and ACP rendering stay with
 * their existing owners; this class only owns replay classification and state.
 */
export class AgyNativeTranslator {
  private readonly text = new Map<number, string>();
  private readonly thinking = new Map<number, string>();
  private readonly tools = new Map<number, ToolSnapshot>();
  private readonly usageHighWater: Record<AgyDelivery, number> = {
    live: 0,
    historical: 0,
  };

  constructor(private readonly options: AgyNativeTranslatorOptions) {}

  translate(stepIndex: number, step: AgyStep): AgyTranslationBatch {
    // A resumed LS demonstrably replays old trajectory indices. Preserve their
    // typed history for deterministic replay consumers, but label it historical
    // so the production caller refuses only re-delivery as a new live response;
    // the resumed session and its genuinely new indices keep working.
    const delivery: AgyDelivery = stepIndex <= this.options.replayThrough
      ? "historical"
      : "live";
    const events: AgyNativeEvent[] = [];

    this.translateUsage(delivery, stepIndex, step, events);
    const type = step.type ?? "";

    if (type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE") {
      this.translateContent(stepIndex, "thought", step.plannerResponse?.thinking ?? "", events);
      if (!this.options.omitPlannerMessage) {
        this.translateContent(stepIndex, "message", step.plannerResponse?.modifiedResponse ?? "", events);
      } else {
        // Structured output is delivered from the CLI JSON envelope, but still
        // track native text so a later cumulative snapshot cannot be mistaken
        // for a fresh response if translation policy changes mid-turn.
        this.updateSnapshot(this.text, stepIndex, step.plannerResponse?.modifiedResponse ?? "");
      }
      return { sessionId: this.options.sessionId, stepIndex, delivery, events };
    }

    if (INTERNAL_STEP_TYPES.has(type)) {
      return { sessionId: this.options.sessionId, stepIndex, delivery, events };
    }

    if (type === "CORTEX_STEP_TYPE_GENERATE_IMAGE") {
      events.push({
        kind: "generated-image",
        sessionId: this.options.sessionId,
        stepIndex,
        content: typeof step.content === "string" ? step.content : "",
      });
      return { sessionId: this.options.sessionId, stepIndex, delivery, events };
    }

    const title = toolTitle(step);
    const status = mapToolStatus(step.status);
    const metadata = toolMetadata(type, step.status);
    const previous = this.tools.get(stepIndex);
    if (!previous) {
      this.tools.set(stepIndex, { title, status, metadata });
      events.push({
        kind: "tool-start",
        sessionId: this.options.sessionId,
        stepIndex,
        toolCallId: `agy-step-${stepIndex}`,
        title,
        toolKind: mapToolKind(type),
        status,
        metadata,
      });
    } else if (!sameToolSnapshot(previous, { title, status, metadata })) {
      // Repeated polls commonly contain the same tool snapshot. Suppressing an
      // exact duplicate prevents duplicate cards; a status/title/semantic flag
      // change still becomes an ordered update, including terminal failures.
      this.tools.set(stepIndex, { title, status, metadata });
      events.push({
        kind: "tool-update",
        sessionId: this.options.sessionId,
        stepIndex,
        toolCallId: `agy-step-${stepIndex}`,
        title,
        status,
        metadata,
      });
    }

    return { sessionId: this.options.sessionId, stepIndex, delivery, events };
  }

  private translateUsage(
    delivery: AgyDelivery,
    stepIndex: number,
    step: AgyStep,
    events: AgyNativeEvent[],
  ): void {
    const usage = step.metadata?.modelUsage;
    if (!usage) return;
    const input = Number.parseInt(usage.inputTokens ?? "0", 10) || 0;
    const output = Number.parseInt(usage.outputTokens ?? "0", 10) || 0;
    const used = input + output;
    // An observed trace decreases from 160 to 100. Only increasing readings
    // describe context high water; refusing that one regressive observation
    // keeps the turn, subsequent usage, and every other session available.
    if (used <= this.usageHighWater[delivery]) return;
    this.usageHighWater[delivery] = used;
    if (this.options.maxTokens <= 0) return;
    events.push({
      kind: "usage",
      sessionId: this.options.sessionId,
      stepIndex,
      used,
      size: this.options.maxTokens,
    });
  }

  private translateContent(
    stepIndex: number,
    role: AgyContentRole,
    current: string,
    events: AgyNativeEvent[],
  ): void {
    const snapshots = role === "thought" ? this.thinking : this.text;
    const previous = snapshots.get(stepIndex) ?? "";
    if (current === previous) return;
    snapshots.set(stepIndex, current);
    if (!current) {
      if (previous) {
        events.push(this.contentEvent(stepIndex, role, "replace", current));
      }
      return;
    }
    if (current.startsWith(previous)) {
      events.push(this.contentEvent(stepIndex, role, "append", current.slice(previous.length)));
      return;
    }
    // AGY sends cumulative snapshots, so a non-prefix value is a correction or
    // truncation, not an append. Refuse only the false delta: emit a labeled
    // replacement for this role while the turn and all other roles keep going.
    events.push(this.contentEvent(stepIndex, role, "replace", current));
  }

  private updateSnapshot(snapshots: Map<number, string>, stepIndex: number, current: string): void {
    if (snapshots.get(stepIndex) !== current) snapshots.set(stepIndex, current);
  }

  private contentEvent(
    stepIndex: number,
    role: AgyContentRole,
    operation: "append" | "replace",
    text: string,
  ): AgyContentEvent {
    return {
      kind: "content",
      sessionId: this.options.sessionId,
      stepIndex,
      role,
      operation,
      text,
    };
  }
}

export function mapToolStatus(status: string | undefined): AgyToolStatus {
  switch (status) {
    case "CORTEX_STEP_STATUS_DONE":
      return "completed";
    case "CORTEX_STEP_STATUS_WAITING":
      return "pending";
    case "CORTEX_STEP_STATUS_FAILED":
    case "CORTEX_STEP_STATUS_ERROR":
    case "CORTEX_STEP_STATUS_CANCELLED":
      return "failed";
    default:
      return "in_progress";
  }
}

export function toolTitle(step: AgyStep): string {
  return (step.type ?? "")
    .replace(/^CORTEX_STEP_TYPE_/, "")
    .replace(/_/g, " ")
    .toLowerCase();
}

function mapToolKind(type: string): AgyToolKind {
  if (type.includes("EDIT")) return "edit";
  if (type.includes("VIEW") || type.includes("READ")) return "read";
  if (type.includes("DELETE")) return "delete";
  if (type.includes("MOVE") || type.includes("RENAME")) return "move";
  if (type.includes("SEARCH") || type.includes("FIND")) return "search";
  if (type.includes("COMMAND") || type.includes("EXECUTE") || type.includes("SHELL")) return "execute";
  if (type.includes("FETCH") || type.includes("WEB")) return "fetch";
  return "other";
}

function toolMetadata(type: string, nativeStatus: string | undefined): AgyToolMetadata {
  const terminal = [
    "CORTEX_STEP_STATUS_DONE",
    "CORTEX_STEP_STATUS_FAILED",
    "CORTEX_STEP_STATUS_ERROR",
    "CORTEX_STEP_STATUS_CANCELLED",
  ].includes(nativeStatus ?? "");
  return {
    nativeType: type,
    ...(nativeStatus ? { nativeStatus } : {}),
    terminal,
    edit: type.includes("EDIT"),
    task: type.includes("TASK") || type.includes("SUBAGENT"),
    error: nativeStatus === "CORTEX_STEP_STATUS_FAILED" || nativeStatus === "CORTEX_STEP_STATUS_ERROR",
  };
}

function sameToolSnapshot(left: ToolSnapshot, right: ToolSnapshot): boolean {
  return left.title === right.title
    && left.status === right.status
    && left.metadata.nativeType === right.metadata.nativeType
    && left.metadata.nativeStatus === right.metadata.nativeStatus
    && left.metadata.terminal === right.metadata.terminal
    && left.metadata.edit === right.metadata.edit
    && left.metadata.task === right.metadata.task
    && left.metadata.error === right.metadata.error;
}

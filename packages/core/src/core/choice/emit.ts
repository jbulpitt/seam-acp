/**
 * emitChoice (#91) — the ONE helper Discord clicks and #92 HTTP ingest call.
 *
 * Validates the frozen row + destination, builds a `DispatchSpec` (`kind:
 * "choice"`), and enqueues it. Does **not** claim the click (caller does that
 * first, except when target-gone: caller must check this *before* claim, or
 * pass `checkTarget` so we refuse without enqueue). Does **not** treat
 * isolated `injectTurn().text` as a return API.
 */
import { randomUUID } from "node:crypto";
import type { DispatchSpec } from "../dispatch/types.js";
import type { SessionRecord } from "../types.js";
import {
  formatDestination,
  resolveOptionTarget,
  wrapChoiceMultiPrompt,
  wrapChoicePrompt,
  type ChoiceCard,
  type ChoiceTarget,
} from "./types.js";

export interface ChoiceActor {
  id: string;
  name: string;
}

export interface EmitChoiceInput {
  card: ChoiceCard;
  optionIndex: number;
  actor: ChoiceActor;
  /** Frozen prompt payload, or typed custom text. */
  payload: string;
  enqueue: (spec: DispatchSpec) => Promise<void>;
  /** Authoring thread session (for isolated inherit of agent/model/cwd). */
  authoringSession: SessionRecord | null;
  /**
   * Effective authoring cwd for isolated inherit. Prefer this over
   * `authoringSession.repoPath`, which may still hold the REPOS_ROOT
   * creation default (#207).
   */
  cwd?: string;
  /**
   * Live-state of the destination thread. `undefined` = skip the check
   * (tests). `"gone"` or `{ archived: true }` → refuse, do not enqueue.
   */
  destLive?: "ok" | "gone" | "archived";
  defaultModel?: string;
  source?: "discord" | "http";
  wrapper?: string;
  untrustedStudentId?: string | null;
}

export type EmitChoiceResult =
  | { ok: true; dispatchId: string; spec: DispatchSpec }
  | { ok: false; error: string; consume: false };

export function planChoiceDispatch(input: EmitChoiceInput): EmitChoiceResult {
  const option = input.card.options[input.optionIndex];
  if (!option) {
    return { ok: false, error: "Unknown option.", consume: false };
  }
  const target = resolveOptionTarget(input.card, option);
  const destCheck = checkDestination(target, input.destLive);
  if (!destCheck.ok) return destCheck;

  const destChannel = destinationChannel(input.card, target);
  const session = target.type === "isolated" ? "isolated" : "live";
  const destination = formatDestination(target);
  const prompt = wrapChoicePrompt({
    cardId: input.card.id,
    optionLabel: option.label,
    clickerName: input.actor.name || "unknown",
    clickerId: input.actor.id,
    authoringThread: input.card.channelRef,
    destination,
    payload: input.payload,
    source: input.source ?? "discord",
    ...(input.wrapper ? { wrapper: input.wrapper } : {}),
    ...(input.untrustedStudentId ? { untrustedStudentId: input.untrustedStudentId } : {}),
  });

  const spec: DispatchSpec = {
    id: randomUUID(),
    target: destChannel,
    prompt,
    session,
    kind: "choice",
    correlationId: input.card.id,
    createdUtc: new Date().toISOString(),
  };
  if (session === "isolated" && input.authoringSession) {
    const cfg = safeJson(input.authoringSession.configJson);
    if (cfg.model) spec.model = cfg.model;
    else if (input.defaultModel) spec.model = input.defaultModel;
    if (cfg.reasoningEffort) spec.effort = cfg.reasoningEffort;
    const cwd = input.cwd ?? input.authoringSession.repoPath;
    if (cwd) spec.cwd = cwd;
  }
  return { ok: true, dispatchId: spec.id, spec };
}

export async function emitChoice(input: EmitChoiceInput): Promise<EmitChoiceResult> {
  const planned = planChoiceDispatch(input);
  if (!planned.ok) return planned;
  await input.enqueue(planned.spec);
  return planned;
}

export interface EmitChoiceMultiInput {
  card: ChoiceCard;
  optionIndices: number[];
  actor: ChoiceActor;
  enqueue: (spec: DispatchSpec) => Promise<void>;
  authoringSession: SessionRecord | null;
  destLive?: "ok" | "gone" | "archived";
  defaultModel?: string;
  source?: "discord" | "http";
  wrapper?: string;
  untrustedStudentId?: string | null;
  /** Effective authoring cwd for isolated inherit. See EmitChoiceInput.cwd. */
  cwd?: string;
}

/** Combined multi-select emit (#94). Destination is the card defaultTarget. */
export function planChoiceMultiDispatch(input: EmitChoiceMultiInput): EmitChoiceResult {
  if (input.optionIndices.length === 0) {
    return { ok: false, error: "No options selected.", consume: false };
  }
  const options = input.optionIndices.map((i) => input.card.options[i]);
  if (options.some((o) => !o)) {
    return { ok: false, error: "Unknown option.", consume: false };
  }
  const target = input.card.defaultTarget ?? { type: "live" };
  const destCheck = checkDestination(target, input.destLive);
  if (!destCheck.ok) return destCheck;

  const destChannel = destinationChannel(input.card, target);
  const session = target.type === "isolated" ? "isolated" : "live";
  const destination = formatDestination(target);
  const prompt = wrapChoiceMultiPrompt({
    cardId: input.card.id,
    optionLabels: options.map((o) => o!.label),
    clickerName: input.actor.name || "unknown",
    clickerId: input.actor.id,
    authoringThread: input.card.channelRef,
    destination,
    payloads: options.map((o) => o!.payload ?? ""),
    source: input.source ?? "discord",
    ...(input.wrapper ? { wrapper: input.wrapper } : {}),
    ...(input.untrustedStudentId ? { untrustedStudentId: input.untrustedStudentId } : {}),
  });

  const spec: DispatchSpec = {
    id: randomUUID(),
    target: destChannel,
    prompt,
    session,
    kind: "choice",
    correlationId: input.card.id,
    createdUtc: new Date().toISOString(),
  };
  if (session === "isolated" && input.authoringSession) {
    const cfg = safeJson(input.authoringSession.configJson);
    if (cfg.model) spec.model = cfg.model;
    else if (input.defaultModel) spec.model = input.defaultModel;
    if (cfg.reasoningEffort) spec.effort = cfg.reasoningEffort;
    const cwd = input.cwd ?? input.authoringSession.repoPath;
    if (cwd) spec.cwd = cwd;
  }
  return { ok: true, dispatchId: spec.id, spec };
}

export async function emitChoiceMulti(input: EmitChoiceMultiInput): Promise<EmitChoiceResult> {
  const planned = planChoiceMultiDispatch(input);
  if (!planned.ok) return planned;
  await input.enqueue(planned.spec);
  return planned;
}

function destinationChannel(card: ChoiceCard, target: ChoiceTarget): string {
  if (target.type === "thread" && target.threadId) return target.threadId;
  return card.channelRef;
}

function checkDestination(
  target: ChoiceTarget,
  destLive: EmitChoiceInput["destLive"]
): EmitChoiceResult | { ok: true } {
  if (destLive === "gone") {
    return { ok: false, error: "That destination thread is gone.", consume: false };
  }
  if (destLive === "archived") {
    return { ok: false, error: "That destination thread is archived.", consume: false };
  }
  if (target.type === "thread" && !target.threadId) {
    return { ok: false, error: "Thread destination is missing a thread id.", consume: false };
  }
  return { ok: true };
}

function safeJson(raw: string): { model?: string; reasoningEffort?: string } {
  try {
    const v = JSON.parse(raw) as { model?: string; reasoningEffort?: string };
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

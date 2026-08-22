/**
 * Frozen interactive choice cards (#91). Schema, wrap, custom_id, authoring
 * gate. Persistence and Discord live elsewhere; this module is side-effect free.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { StructuredPanel } from "../types.js";

export const CHOICE_FENCE_LANG = "seam-choice";
export const CHOICE_CUSTOM_ID_PREFIX = "choice:";
export const CHOICE_MAX_CLICKS = 100;
export const CHOICE_DEFAULT_MAX_CLICKS = 1;
export const CHOICE_TITLE_MAX = 256;
export const CHOICE_LABEL_MAX = 80;
export const CHOICE_CUSTOM_TEXT_MAX = 4000;

/** Thin preamble bullet — same weight as seam-wake. Canonical how-to is the agent guide. */
export const CHOICE_AUTHORING_RULE =
  "To publish a frozen click-card in this thread, output a fenced block tagged `seam-choice` whose body is JSON `{ title, options:[{label, kind:\"prompt\"|\"custom\", payload?}] }` (or call `create_choice`). Default is live in THIS thread, one person, one pick — after they choose, the card shows the selection and buttons go away. Set maxClicks > 1 only for multi-user. Destinations live|isolated|thread and HTTP ingest: docs/agent-guides/interactive-prompts.md. Participants may click; they cannot create or cancel.";

/** MCP-less declared HTTP result (#92). Stripped like seam-choice. */
export const RESULT_FENCE_LANG = "seam-result";

export type ChoiceDestType = "live" | "isolated" | "thread";

export interface ChoiceTarget {
  type: ChoiceDestType;
  threadId?: string;
}

export interface ChoiceOption {
  label: string;
  kind: "prompt" | "custom";
  payload?: string;
  target?: ChoiceTarget;
}

export interface ChoiceIngress {
  /** Which frozen option HTTP POST activates (default: first custom, else 0). */
  optionIndex?: number;
  /** Authoring agent's contract with the page. Optional JSON Schema. */
  resultSchema?: unknown;
  corsOrigins?: string[];
  /** Frozen wrapper merged ahead of the POST body (rubric, persist path, …). */
  wrapper?: string;
}

export interface ChoiceSpec {
  title: string;
  body?: string;
  maxClicks?: number;
  targetUserId?: string | null;
  defaultTarget?: ChoiceTarget;
  options: ChoiceOption[];
  /** When set, mint a site token and expose POST /ingest. */
  ingress?: boolean | ChoiceIngress;
}

export type ChoiceCardStatus = "open" | "exhausted" | "cancelled";

export interface ChoiceCard {
  id: string;
  platform: string;
  channelRef: string;
  parentRef: string | null;
  messageId: string | null;
  title: string;
  body: string | null;
  maxClicks: number;
  targetUserId: string | null;
  defaultTarget: ChoiceTarget;
  options: ChoiceOption[];
  clickCount: number;
  status: ChoiceCardStatus;
  lastClickerId: string | null;
  lastClickerName: string | null;
  /** Index of the last successful option. Single-user cards show this label. */
  lastOptionIndex: number | null;
  createdBy: string;
  createdUtc: string;
  ingestTokenHash: string | null;
  ingestOptionIndex: number | null;
  resultSchema: unknown | null;
  ingestWrapper: string | null;
  ingestCors: string[] | null;
}

export type ChoiceResultStatus = "pending" | "ok" | "missing" | "error";

export interface ChoiceResultRow {
  dispatchId: string;
  choiceId: string;
  status: ChoiceResultStatus;
  body: unknown | null;
  error: string | null;
  schema: unknown | null;
  createdUtc: string;
  finishedUtc: string | null;
}

const TargetSchema = z
  .object({
    type: z.enum(["live", "isolated", "thread"]),
    threadId: z.string().min(1).optional(),
  })
  .superRefine((t, ctx) => {
    if (t.type === "thread" && !t.threadId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'target type "thread" requires threadId' });
    }
  });

const OptionSchema = z.object({
  label: z.string().trim().min(1).max(CHOICE_LABEL_MAX),
  kind: z.enum(["prompt", "custom"]),
  payload: z.string().optional(),
  target: TargetSchema.optional(),
});

export const ChoiceSpecSchema = z
  .object({
    title: z.string().trim().min(1).max(CHOICE_TITLE_MAX),
    body: z.string().optional(),
    maxClicks: z.number().int().min(1).max(CHOICE_MAX_CLICKS).optional(),
    targetUserId: z.string().regex(/^\d+$/).nullable().optional(),
    defaultTarget: TargetSchema.optional(),
    options: z.array(OptionSchema).min(1),
    ingress: z
      .union([
        z.boolean(),
        z.object({
          optionIndex: z.number().int().min(0).optional(),
          resultSchema: z.unknown().optional(),
          corsOrigins: z.array(z.string().min(1)).optional(),
          wrapper: z.string().optional(),
        }),
      ])
      .optional(),
  })
  .superRefine((spec, ctx) => {
    const hasCustom = spec.options.some((o) => o.kind === "custom");
    const cap = hasCustom ? 24 : 25;
    if (spec.options.length > cap) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: hasCustom
          ? `at most 24 options when a custom option is present (got ${spec.options.length})`
          : `at most 25 options (got ${spec.options.length})`,
      });
    }
    spec.options.forEach((o, i) => {
      if (o.kind === "prompt" && !(o.payload && o.payload.trim())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `options[${i}]: kind "prompt" requires a non-empty payload`,
        });
      }
    });
  });

export function newChoiceId(): string {
  return randomBytes(9).toString("base64url");
}

export function parseChoiceSpec(raw: unknown): { ok: true; spec: ChoiceSpec } | { ok: false; error: string } {
  const parsed = ChoiceSpecSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, error: issues };
  }
  return { ok: true, spec: parsed.data as ChoiceSpec };
}

export function parseChoiceFence(content: string): { ok: true; spec: ChoiceSpec } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(content.trim());
  } catch {
    return { ok: false, error: "seam-choice body must be JSON" };
  }
  return parseChoiceSpec(json);
}

export function resolveOptionTarget(card: ChoiceCard, option: ChoiceOption): ChoiceTarget {
  return option.target ?? card.defaultTarget ?? { type: "live" };
}

export function makeChoiceCustomId(choiceId: string, optionIndex: number): string {
  return `${CHOICE_CUSTOM_ID_PREFIX}${choiceId}:${optionIndex}`;
}

export function makeChoiceSelectId(choiceId: string): string {
  return `${CHOICE_CUSTOM_ID_PREFIX}${choiceId}:s`;
}

export function makeChoiceModalId(choiceId: string, optionIndex: number): string {
  return `${CHOICE_CUSTOM_ID_PREFIX}${choiceId}:m:${optionIndex}`;
}

export function parseChoiceCustomId(
  customId: string
): { choiceId: string; optionIndex?: number; kind: "option" | "select" | "modal" } | null {
  if (!customId.startsWith(CHOICE_CUSTOM_ID_PREFIX)) return null;
  const rest = customId.slice(CHOICE_CUSTOM_ID_PREFIX.length);
  const parts = rest.split(":");
  if (parts.length === 2 && parts[1] === "s") {
    return { choiceId: parts[0]!, kind: "select" };
  }
  if (parts.length === 3 && parts[1] === "m") {
    const idx = Number.parseInt(parts[2]!, 10);
    if (!Number.isFinite(idx)) return null;
    return { choiceId: parts[0]!, optionIndex: idx, kind: "modal" };
  }
  if (parts.length === 2) {
    const idx = Number.parseInt(parts[1]!, 10);
    if (!Number.isFinite(idx)) return null;
    return { choiceId: parts[0]!, optionIndex: idx, kind: "option" };
  }
  return null;
}

/** D8: bridge-stamped provenance wrapping the creator payload / typed custom text. */
export function wrapChoicePrompt(opts: {
  cardId: string;
  optionLabel: string;
  clickerName: string;
  clickerId: string;
  authoringThread: string;
  destination: string;
  payload: string;
  source?: "discord" | "http";
  wrapper?: string;
  untrustedStudentId?: string | null;
}): string {
  const http = opts.source === "http";
  const who = http
    ? `HTTP ingest (site token; not a Discord user). Actor ${opts.clickerName} (id ${opts.clickerId}). Claimed student id (untrusted): ${opts.untrustedStudentId || "(none)"}.`
    : `clicked by ${opts.clickerName} (id ${opts.clickerId}).`;
  const resultHint = http
    ? `Declare the student-facing HTTP body with submit_result({...}) or a seam-result fence. That JSON is the HTTP response — not the Discord transcript.`
    : "";
  const head = [
    "<seam-choice>",
    `Card ${opts.cardId} option "${opts.optionLabel}" ${who}`,
    `Authoring thread: ${opts.authoringThread}. Destination: ${opts.destination}.`,
    resultHint,
    "</seam-choice>",
  ].filter((l) => l.length > 0);
  const wrapper = (opts.wrapper ?? "").trim();
  const payload = opts.payload ?? "";
  return [...head, "", ...(wrapper ? [wrapper, ""] : []), payload].join("\n");
}

export function normalizeIngress(spec: ChoiceSpec): ChoiceIngress | null {
  if (!spec.ingress) return null;
  if (spec.ingress === true) return {};
  return spec.ingress;
}

export function resolveIngestOptionIndex(
  options: ReadonlyArray<ChoiceOption>,
  requested?: number
): number {
  if (requested != null && requested >= 0 && requested < options.length) return requested;
  const custom = options.findIndex((o) => o.kind === "custom");
  return custom >= 0 ? custom : 0;
}

export function defaultMaxClicks(spec: ChoiceSpec): number {
  if (spec.maxClicks != null) return spec.maxClicks;
  return spec.ingress ? CHOICE_MAX_CLICKS : CHOICE_DEFAULT_MAX_CLICKS;
}

export function formatDestination(target: ChoiceTarget): string {
  if (target.type === "thread") return `thread ${target.threadId}`;
  return target.type;
}

/**
 * D9 authoring gate. `authorId` is the Discord author of the *user* turn.
 * `null`/`undefined` = injected turn (dispatch/isolated/wake) → authoring allowed.
 * Independent of SPEAKER_IDENTITY_ENABLED.
 */
export function isChoiceAuthoringRefused(
  authorId: string | null | undefined,
  participantIds: ReadonlySet<string> | undefined,
  adminIds: ReadonlySet<string> | undefined
): boolean {
  if (!authorId) return false;
  return Boolean(participantIds?.has(authorId) && !adminIds?.has(authorId));
}

/** D5 click auth (not a consume). */
export function choiceClickRefusal(
  userId: string,
  card: Pick<ChoiceCard, "targetUserId" | "status">,
  allowedUserIds: ReadonlySet<string>
): "ok" | "not-allowed" | "not-target" | "closed" {
  if (card.status !== "open") return "closed";
  if (!allowedUserIds.has(userId)) return "not-allowed";
  if (card.targetUserId && card.targetUserId !== userId) return "not-target";
  return "ok";
}

/** Default: one person, one pick (`maxClicks` 1). `targetUserId` does not change this. */
export function isChoiceSingleUser(card: Pick<ChoiceCard, "maxClicks">): boolean {
  return card.maxClicks <= 1;
}

export function selectedChoiceLabel(card: ChoiceCard): string | null {
  if (card.lastOptionIndex == null) return null;
  const opt = card.options[card.lastOptionIndex];
  return opt?.label ?? null;
}

/** Single-user closed/cancelled cards drop action rows instead of leaving dead buttons. */
export function choiceCardHideButtons(card: ChoiceCard): boolean {
  return isChoiceSingleUser(card) && card.status !== "open";
}

export function renderChoicePanel(card: ChoiceCard): StructuredPanel {
  const title = `🗳️ ${card.title}`.slice(0, 256);
  const description = card.body ? card.body.slice(0, 4096) : undefined;
  const color = card.status === "open" ? 0x5865f2 : 0x99aab5;
  const selected = selectedChoiceLabel(card);
  const who = card.lastClickerName;

  if (isChoiceSingleUser(card)) {
    const fields: NonNullable<StructuredPanel["fields"]> = [];
    if (card.status === "exhausted" && selected) {
      fields.push({
        name: "Selected",
        value: who ? `**${selected}** · ${who}` : `**${selected}**`,
      });
    } else if (card.status === "cancelled") {
      fields.push({ name: "Status", value: "Cancelled" });
    }
    const footer =
      card.status === "open" ? "Pick one" : card.status === "exhausted" ? "Done" : "Cancelled";
    return { color, title, ...(description ? { description } : {}), fields, footer };
  }

  const last = who ? ` · last: ${who}` : "";
  const status =
    card.status === "open" ? "open" : card.status === "exhausted" ? "closed" : "cancelled";
  return {
    color,
    title,
    ...(description ? { description } : {}),
    fields: [],
    footer: `${card.clickCount}/${card.maxClicks} · ${status}${last}`,
  };
}

export function choiceLayoutCapError(options: ReadonlyArray<Pick<ChoiceOption, "kind">>): string | null {
  const hasCustom = options.some((o) => o.kind === "custom");
  const cap = hasCustom ? 24 : 25;
  if (options.length < 1) return "at least one option is required";
  if (options.length > cap) {
    return hasCustom
      ? `at most 24 options when a custom option is present (got ${options.length})`
      : `at most 25 options (got ${options.length})`;
  }
  return null;
}

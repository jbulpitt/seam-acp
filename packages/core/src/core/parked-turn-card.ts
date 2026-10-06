import type { ChoiceSpec } from "./choice/types.js";
import type { TurnAttempt } from "./dispatch/attempt-store.js";
import { parseExecutionIdentity } from "./dispatch/execution-identity.js";
import type { InboundAdmission } from "./inbound-admission/types.js";
import { promptExcerpt } from "./prompt-excerpt.js";
import type { ScheduledOccurrence } from "./scheduled-prompts/occurrence-store.js";

export interface ParkedTurnSource {
  schedule?: ScheduledOccurrence | null;
  inbound?: InboundAdmission | null;
}

function recordedTime(value: string | number | null | undefined): number | undefined {
  const time = typeof value === "number" ? value : value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : undefined;
}

/** Display only recorded facts; current thread settings are not this attempt's identity. */
export function parkedTurnContext(attempt: TurnAttempt, source: ParkedTurnSource, channelRef?: string): string[] {
  const { spec } = attempt;
  let what: string;
  let prompt = spec.originPrompt ?? spec.prompt;
  if (attempt.source === "schedule") {
    const schedule = source.schedule;
    what = `Scheduled${schedule?.row.name ? `: ${schedule.row.name}` : ""}${schedule ? ` (\`${schedule.scheduleId}\`)` : ""}`;
    if (schedule) prompt = schedule.row.promptText;
  } else if (attempt.source === "inbound") {
    what = source.inbound?.authorId ? `Message from <@${source.inbound.authorId}>` : "User message";
    if (source.inbound) prompt = source.inbound.text;
  } else {
    const kind = spec.kind ?? "dispatch";
    what = kind.charAt(0).toUpperCase() + kind.slice(1).replaceAll("_", " ");
    const requester = spec.originThreadRef ?? spec.returnTo;
    if (kind === "handoff" && requester) what += ` from <#${requester}>`;
  }
  const excerpt = promptExcerpt(prompt, { chars: 160 });
  const lines = [`${what}${excerpt ? ` — ${excerpt}` : ""}`];
  const identity = parseExecutionIdentity(attempt.identity);
  const where = [
    spec.target && spec.target !== channelRef ? `<#${spec.target}>` : "",
    identity?.agent && identity.location ? `\`${identity.agent}@${identity.location}\``
      : identity?.agent ? `Agent \`${identity.agent}\`` : identity?.location ? `Host \`${identity.location}\`` : "",
    identity?.model ? `\`${identity.model}\`` : "",
  ].filter(Boolean);
  if (where.length) lines.push(where.join(" · "));
  const starts = (attempt.submissions ?? []).map(s => recordedTime(s.rpcInvokedUtc)).filter(t => t !== undefined);
  const started = recordedTime(attempt.statusCardState?.status.input.startedUtc) ?? (starts.length ? Math.min(...starts) : undefined);
  const activity = [attempt.updatedUtc, attempt.stdoutFallback?.lastUtc, ...(attempt.submissions ?? []).map(s => s.finishedUtc)]
    .map(recordedTime).filter(t => t !== undefined);
  const times = [
    ["Started", started],
    ["Parked", recordedTime(attempt.stalledUtc)],
    ["Last active", activity.length ? Math.max(...activity) : undefined],
  ] as const;
  const when = times.filter(([, time]) => time !== undefined)
    .map(([label, time]) => `${label} <t:${Math.floor(time! / 1000)}:R>`);
  if (when.length) lines.push(when.join(" · "));
  return lines;
}

export type ParkedTurnAction = "resume" | "cancel";
const PREFIX = "parked-turn:";
const ATTEMPT_ID = /^[A-Za-z0-9_-]{1,80}$/;

export function parkedTurnPayload(action: ParkedTurnAction, attemptId: string): string {
  if (!ATTEMPT_ID.test(attemptId)) throw new Error("parked-turn action requires an attempt id");
  return `${PREFIX}${action}:${attemptId}`;
}

export function parkedTurnAction(payload: string | undefined): { action: ParkedTurnAction; attemptId: string } | null {
  if (!payload?.startsWith(PREFIX)) return null;
  const [, rawAction, attemptId] = payload.split(":");
  const action = rawAction === "abandon" ? "cancel" : rawAction;
  return (action === "resume" || action === "cancel") && attemptId && ATTEMPT_ID.test(attemptId)
    ? { action, attemptId } : null;
}

/** Like reauth acceptance, these persisted payloads are actions, not prompts. */
export function parkedTurnChoiceSpec(attemptId: string, body: string, labels: Record<ParkedTurnAction, string>,
  actions: readonly ParkedTurnAction[] = ["resume", "cancel"]): ChoiceSpec {
  return {
    title: "Parked turn", body, maxClicks: 1, defaultTarget: { type: "live" },
    options: actions.map(action => ({
      label: labels[action], kind: "prompt", payload: parkedTurnPayload(action, attemptId),
    })),
  };
}

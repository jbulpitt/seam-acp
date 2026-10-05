import type { DispatchSpec } from "../dispatch/types.js";
import { CHOICE_FENCE_LANG, parseChoiceFence } from "./types.js";

/** Agent callers read results; they cannot answer cards in the worker thread. */
export function agentChoiceRefusal(spec?: DispatchSpec): string | undefined {
  if (!spec || !["handoff", "forward"].includes(spec.kind ?? "")) return undefined;
  const caller = spec.originThreadRef ?? spec.returnTo;
  if (!caller) return undefined;
  return `Choice cards are unavailable: this turn was requested by thread ${caller} (an agent); put the question in your result and the caller will decide or ask the user.`;
}

export function agentChoiceQuestion(content: string, refusal: string): string {
  const parsed = parseChoiceFence(content);
  if (!parsed.ok) return `${refusal}\nChoice card not published: ${parsed.error}`;
  return [
    `Question for you: ${parsed.spec.title}`,
    ...(parsed.spec.body ? [parsed.spec.body] : []),
    "",
    ...parsed.spec.options.map(option => `- ${option.label}`),
    "",
    refusal,
  ].join("\n");
}

/** Preserve the question in durable output and report-backs without card JSON. */
export function agentChoiceOutput(text: string, spec?: DispatchSpec): string {
  const refusal = agentChoiceRefusal(spec);
  if (!refusal) return text;
  return text.replace(/```([\s\S]*?)(?:```|$)/g, (fence, inner: string) => {
    const newline = inner.indexOf("\n");
    if (newline < 0 || inner.slice(0, newline).trim().toLowerCase() !== CHOICE_FENCE_LANG) return fence;
    return agentChoiceQuestion(inner.slice(newline + 1), refusal);
  });
}

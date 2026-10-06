import type { ChoiceSpec } from "./choice/types.js";

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

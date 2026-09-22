/**
 * The re-auth card (#450).
 *
 * The attempt row is already the decision. This is a choice card so the
 * accept survives restart, and it is not an elicitation row: boot marks those
 * interrupted. The option payload names the attempt. It is not a prompt, and
 * it does not carry the device code or the original brief.
 *
 * There is no auto-fire. Continuing before someone accepts would send the
 * parked turn before authentication. A watch is not armed: `workProgress`
 * already says whether work is executing, and a watch that fired this accept
 * would continue the turn on a timer.
 */
import type { ChoiceSpec } from "./choice/types.js";
import { reauthWaitNotice, type ReauthPark } from "./reauth-negotiation.js";

export const REAUTH_ACCEPT_PREFIX = "reauth-accept:";

const ATTEMPT_ID = /^[A-Za-z0-9_-]{1,80}$/;

export function reauthAcceptPayload(attemptId: string): string {
  if (!ATTEMPT_ID.test(attemptId)) {
    throw new Error("reauth accept payload requires an attempt id");
  }
  return `${REAUTH_ACCEPT_PREFIX}${attemptId}`;
}

/** Null when this click is an ordinary choice and must be dispatched as one. */
export function reauthAcceptAttemptId(payload: string | undefined): string | null {
  if (!payload?.startsWith(REAUTH_ACCEPT_PREFIX)) return null;
  const id = payload.slice(REAUTH_ACCEPT_PREFIX.length);
  return ATTEMPT_ID.test(id) ? id : null;
}

/** One button. Accept calls `acceptReauthWait`. Cancel is not this button. */
export function reauthChoiceSpec(attemptId: string, park: ReauthPark): ChoiceSpec {
  return {
    title: "Provider authentication",
    body: reauthWaitNotice(park),
    maxClicks: 1,
    defaultTarget: { type: "live" },
    options: [{
      label: "Authentication is done — continue",
      kind: "prompt",
      payload: reauthAcceptPayload(attemptId),
    }],
  };
}

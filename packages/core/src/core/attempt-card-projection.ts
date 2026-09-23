import type { TurnAttempt } from "./dispatch/attempt-store.js";
import type { TurnState } from "./types.js";

export interface AttemptCardProjection {
  state: TurnState;
  action: string;
}

const ACTION_MAX = 120;

function action(prefix: string, detail?: string): string {
  const clean = detail?.replace(/\s+/g, " ").trim();
  const rendered = clean ? `${prefix} — ${clean}` : prefix;
  return rendered.length <= ACTION_MAX ? rendered : `${rendered.slice(0, ACTION_MAX - 1)}…`;
}

/**
 * Project the durable attempt winner onto the Discord card owned by an older
 * invocation (#576). The card is only a view: cancellation, suspension and a
 * replacement generation all revoke execution ownership, but none makes the
 * already-posted artifact disappear. Without this mapping the real cancelled
 * attempt inbound-1552209792582418483 remained amber forever.
 *
 * Returning null is deliberately narrow: a missing row or the same active
 * generation has no terminal fact to report. Refuse only that projection; the
 * attempt, replacement turn and every unrelated card keep working.
 */
export function projectAttemptCard(
  latest: TurnAttempt | null,
  invocation: Pick<TurnAttempt, "generation" | "ownerBoot">
): AttemptCardProjection | null {
  if (!latest) return null;

  if (latest.state === "cancelled") {
    const reason = latest.outcome?.error;
    return {
      state: "Failed",
      action: reason && reason !== "cancelled by operator"
        ? action("Cancelled", reason)
        : "Cancelled",
    };
  }

  if (latest.state === "suspended") {
    return { state: "Waiting", action: "Suspended — awaiting recovery" };
  }

  if (latest.state === "completed") {
    if (latest.outcome?.status === "completed") {
      return { state: "Done", action: latest.outcome.stopReason || "Completed" };
    }
    if (latest.outcome?.status === "failed") {
      return {
        state: "Failed",
        action: action("Failed", latest.outcome.error ?? latest.outcome.workerError),
      };
    }
    return null;
  }

  if (
    latest.state === "active" &&
    (latest.generation !== invocation.generation || latest.ownerBoot !== invocation.ownerBoot)
  ) {
    return { state: "Waiting", action: "Superseded — a newer attempt owns this turn" };
  }

  return null;
}

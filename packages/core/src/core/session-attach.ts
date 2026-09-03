/**
 * Who owns the thread's ACP binding when a long compaction finishes (#179).
 *
 * Compaction seeds a NEW session and then has to decide whether the thread
 * should follow it. The old rule was a boolean captured *before* the pipeline
 * ran — `wasActive = sessionId === record.acpSessionId` — which is wrong in
 * three directions once the run can last ten minutes:
 *
 *   - the thread may have been UNBOUND at the start (the common case right
 *     after an agent switch/reset), so the operator's compaction produced a
 *     resumable seed that nothing pointed at;
 *   - the binding may have changed DURING the run, and writing the start-time
 *     decision back would silently clobber that newer, deliberate choice;
 *   - the record snapshot itself goes stale, so writing it back whole would
 *     revert every other field edited meanwhile.
 *
 * The fix is a compare-and-swap: read the authoritative binding at completion,
 * decide from THAT, and let the store's conditional UPDATE arbitrate the final
 * race. This module is the decision half — pure, so every branch is testable
 * without a database.
 */

/**
 * How much authority the caller has to bind the thread.
 *
 * `"swap-only"` is the programmatic contract (`compact` dispatch / MCP tool):
 * follow the binding only if the compacted session actually held it.
 * `"attach"` is what the operator-facing session-browser buttons ask for, and
 * it differs in exactly one case — an UNBOUND thread is bound to the result
 * rather than left disconnected.
 *
 * Neither intent ever steals a binding that points somewhere else. A thread
 * deliberately bound to session X is not asking to be moved because someone
 * compacted session Y.
 */
export type AttachIntent = "attach" | "swap-only";

/** Why the binding was left alone. */
export type AttachSkipReason =
  /** The session record disappeared while the job ran (thread deleted). */
  | "record-gone"
  /** The compacted session was not this thread's binding, and still isn't. */
  | "source-inactive"
  /** Someone bound the thread elsewhere during the run. Their choice wins. */
  | "rebound-elsewhere";

/** Why the binding moved. */
export type AttachBindReason =
  /** The compacted session still held the binding: source → new. */
  | "swapped"
  /** The thread was disconnected and this action was asked to attach. */
  | "bound-unbound";

/**
 * What to do with the binding. `cas` carries the exact expected value so the
 * store can refuse the write if the world moved underneath the decision.
 */
export type AttachPlan =
  | { action: "noop"; attached: true; reason: "already-attached" }
  | { action: "cas"; expect: string; next: string; reason: AttachBindReason }
  | { action: "skip"; attached: false; reason: AttachSkipReason };

/** The settled answer, after the plan has been executed against the store. */
export type AttachOutcome =
  | { attached: true; reason: AttachBindReason | "already-attached" }
  | { attached: false; reason: AttachSkipReason };

export interface AttachInput {
  /**
   * The binding read from the store AT COMPLETION. `null` means the record is
   * gone. This is the only value the decision may trust — never the snapshot
   * the job started with.
   */
  current: string | null;
  /** The binding observed when the job STARTED. Used only to detect a change. */
  observedAtStart: string;
  /** The session that was compacted. */
  sourceId: string;
  /** The freshly seeded session. */
  newId: string;
  intent: AttachIntent;
}

/**
 * Decide the binding from authoritative state.
 *
 * Order is load-bearing, and the second step is the one that matters:
 *
 * 1. no record — nothing to write, and writing would resurrect a deleted row;
 * 2. already on the new session — a replay or a double completion. This is the
 *    ONE case that outranks change detection, because it is not a change: the
 *    desired end state is already the actual one, so the operation is a no-op
 *    however it got there;
 * 3. **anything observably different from where we started** — the operator
 *    moved the binding while the pipeline ran, and their choice is newer than
 *    ours. Every direction counts, including the two that look benign:
 *
 *      source → unbound   they DETACHED the very session being compacted.
 *                         Binding the result would undo that on their behalf.
 *      unbound → source   they ATTACHED the session being compacted. An earlier
 *                         revision treated this as "so they want its
 *                         compaction", swapped, and thereby overwrote a
 *                         deliberate choice with a guess about intent.
 *
 *    A compaction that started against one world does not get to write into a
 *    different one. The result is still seeded and still listed; the operator
 *    can attach it in one click if that is what they meant;
 * 4. still on the source, unchanged — the swap this feature exists for;
 * 5. unbound, unchanged — attach only when the caller has that authority;
 * 6. bound elsewhere, unchanged — the pre-existing "not your binding" case.
 */
export function planSessionAttachment(input: AttachInput): AttachPlan {
  const { current, observedAtStart, sourceId, newId, intent } = input;

  if (current === null) return { action: "skip", attached: false, reason: "record-gone" };
  if (newId !== "" && current === newId) {
    return { action: "noop", attached: true, reason: "already-attached" };
  }
  if (current !== observedAtStart) {
    return { action: "skip", attached: false, reason: "rebound-elsewhere" };
  }
  if (sourceId !== "" && current === sourceId) {
    return { action: "cas", expect: sourceId, next: newId, reason: "swapped" };
  }
  if (current === "") {
    return intent === "attach"
      ? { action: "cas", expect: "", next: newId, reason: "bound-unbound" }
      : { action: "skip", attached: false, reason: "source-inactive" };
  }
  return { action: "skip", attached: false, reason: "source-inactive" };
}

/**
 * Operator-facing sentence for an outcome. One place, so the two premium
 * buttons, the plain compact button and the `compact` dispatch card cannot
 * drift into describing the same state three different ways — and so the
 * unattached cases are never left implicit, which is the bad state #179 is
 * about.
 */
export function describeAttachOutcome(
  outcome: AttachOutcome,
  ids: { newId: string; sourceId: string }
): string {
  switch (outcome.reason) {
    case "swapped":
      return `🟢 This thread is now bound to \`${ids.newId}\`.`;
    case "bound-unbound":
      return `🟢 This thread had no active session, so it is now bound to \`${ids.newId}\`.`;
    case "already-attached":
      return `🟢 This thread is bound to \`${ids.newId}\`.`;
    case "rebound-elsewhere":
      return (
        `⚪ **Left unattached** — this thread's session changed while the compaction ran, ` +
        `so that newer choice was kept. Use **Attach** on \`${ids.newId}\` if you want it instead.`
      );
    case "source-inactive":
      return (
        `⚪ **Left unattached** — \`${ids.sourceId}\` is not this thread's active session, ` +
        `so the binding was not moved. Use **Attach** on \`${ids.newId}\` if you want it.`
      );
    case "record-gone":
      return `⚪ **Left unattached** — this thread's session record no longer exists.`;
  }
}

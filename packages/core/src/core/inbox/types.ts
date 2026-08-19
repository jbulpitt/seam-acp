/**
 * Agent inbox (#61) — a durable, per-session message queue.
 *
 * The inbox is the foundation primitive for pull-based delivery: any producer
 * (a human, another agent, a watch/event, the orchestrator) PUSHES a message
 * into a thread's inbox, and the owning agent DRAINS it by POLLING an MCP tool
 * (`poll_inbox`). Delivery is pull-only — the agent receives queued messages
 * only when it checks, mid-turn or on its next turn.
 *
 * This exists because seam-acp is an ACP *client*: there is no ACP method to
 * push/append into a running turn, so "the agent watches a queue" is the only
 * shape the stack allows (docs/hitl-steering-plan.md §1). Unlike the earlier
 * in-memory HITL buffer (cleared on turn end), the inbox is SQLite-backed so a
 * message pushed while the agent is idle survives turn boundaries and restarts
 * and is delivered on the next poll.
 *
 * Semantics: consumed-on-drain (deliver-once-then-delete — a missed message is
 * better than a duplicated instruction), coalesced (all queued messages return
 * in one block per poll), self-scoped (a caller drains only its OWN inbox), and
 * capped per session to bound growth if it is never polled.
 */

/** One persisted inbox message. Deleted the moment its owner drains it. */
export interface InboxMessage {
  /** Per-message id (a UUID). Distinct from `sessionRef` — many messages share
   *  one owning session. */
  id: string;
  /** The OWNING session key: `${platform}:${channelRef}` (i.e. `record.id`) —
   *  the immutable routing key, the same rule as wakes/watches. Never the
   *  mutable `acpSessionId`. */
  sessionRef: string;
  /** The producer's channel ref (its `record.channelRef`), for attribution.
   *  Null when a producer left no identity. */
  fromRef: string | null;
  /** The message body delivered to the owner on drain. */
  body: string;
  /** Priority steering flag (#66). When true, the message is URGENT: the owner
   *  should ABANDON its current plan and reorient to this at its next poll (vs a
   *  normal note it merely absorbs). Still pull-only and queued — priority does
   *  NOT cancel or interrupt a turn (that is the separate #67 interrupt tier). */
  priority: boolean;
  createdUtc: string;
}

/**
 * Per-session cap on queued inbox messages. When a push would exceed this, the
 * OLDEST messages are dropped so the newest (most relevant) survive — a bound
 * on growth for an inbox that is never polled, not a delivery guarantee. Chosen
 * loosely; the inbox is observability-grade, not a durable job queue.
 */
export const INBOX_MAX_PER_SESSION = 50;

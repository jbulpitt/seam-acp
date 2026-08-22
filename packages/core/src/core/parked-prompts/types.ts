/**
 * One parked user prompt — at most one per thread.
 *
 * #88: waiting for a remote bridge to finish hello + prepare() so it can run
 * as a live turn (`kind: "bridge_offline"`).
 * #89: waiting for the current turn on this thread to finish
 * (`kind: "user_queue"`). Same row, same replace/cancel/fire helpers.
 *
 * Distinct from wakes (#59): no due time, no catch-up window. Latest write
 * replaces. Delivery is event-driven (`onBridgeReady` and, for #89, turn-end),
 * not a sweeper.
 */

/** Why the row is waiting. Fire hooks cover both. */
export type ParkedKind = "bridge_offline" | "user_queue";

/** One persisted attachment. Bytes live under data/parked-attachments/<id>/. */
export interface ParkedAttachment {
  filename: string;
  mime: string;
  size: number;
}

export interface ParkedPrompt {
  id: string;
  platform: string;
  /** The thread id — unique with platform (D1). */
  channelRef: string;
  parentRef: string | null;
  /** Remote bridge id this prompt must run on, or `"local"` for a #89 queue. */
  location: string;
  /** #88 offline-bridge vs #89 user-queued next turn. */
  kind: ParkedKind;
  prompt: string;
  authorId: string;
  authorName: string | null;
  /** Discord message id of the parked notice, so replace/cancel can edit it. */
  noticeMessageId: string | null;
  attachments: ParkedAttachment[];
  createdUtc: string;
}

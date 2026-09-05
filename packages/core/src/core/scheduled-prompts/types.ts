/**
 * Scheduled prompts — cron-style prompts tied to a Discord thread (channelRef).
 * See docs/scheduled-prompts-plan.md. Jobs are self-contained: each fire runs in
 * its own throwaway session and posts output back to the thread as cards.
 */

export interface ScheduledPrompt {
  id: string;
  platform: string;
  /** The thread id — the stable binding anchor (survives reset/attach). */
  channelRef: string;
  parentRef: string | null;
  name: string;
  promptText: string;
  /** Cron expression (croner syntax). */
  cron: string;
  /** IANA timezone, e.g. "America/Chicago". */
  timezone: string;
  /** Model id to run the job under. null = inherit the binding thread's
   *  *effective* model at fire time (`describeConfig`), not the durable
   *  session column. Isolated only; live mode ignores this. */
  model: string | null;
  /** Working directory to run the job in. null = inherit the binding thread's
   *  *effective* cwd at fire time (`describeConfig`). Isolated only. */
  cwd: string | null;
  /** Channel/thread id to post output to. null = the schedule's own thread. */
  targetChannel: string | null;
  /** How to render the result. "card" = blue embed card(s); "messages" = plain
   *  chunked text messages. The "running" announcement is always a card.
   *  Ignored when sessionMode === "live" (output streams into the thread). */
  outputType: "card" | "messages";
  /** Execution mode.
   *  "isolated" (default): each fire runs in a throwaway ACP session and posts
   *  captured output back as cards/messages.
   *  "live": the fire runs as a real turn inside the bound thread — sharing the
   *  thread's persistent session, streaming like a user message, and permanently
   *  accumulating in that session's context. In "live" mode `model`, `cwd`,
   *  `targetChannel`, and `outputType` are meaningless and ignored at fire time
   *  (D1); the thread's own runtime config governs the turn. */
  sessionMode: "isolated" | "live";
  /** Retained on the row / builder for compatibility. Catch-up no longer
   *  consults this: a missed `nextRunUtc` always fires once on boot. */
  catchupSeconds: number;
  enabled: boolean;
  /** Legacy-only (#158). Scheduled prompts no longer support file attachments:
   *  there is no route to add one, and nothing is ever re-sent at fire time.
   *  This is the *count* of entries still recorded in the row's legacy
   *  `attachments_json`, kept readable so an operator can find rows that were
   *  written before the removal. A row with a non-zero count is QUARANTINED —
   *  the manager refuses to arm or fire it (see `legacyAttachmentQuarantine`).
   *
   *  Writes: the store never overwrites a stored legacy manifest on update, so
   *  spreading an existing row preserves the count (and the quarantine). Setting
   *  this to 0 explicitly is the deliberate "I revised this schedule" act — it
   *  clears the manifest and lifts the quarantine. The bytes on disk under
   *  `data/scheduled-attachments/<id>/` are NEVER deleted by Seam. */
  legacyAttachmentCount: number;
  /** Discord user id of the creator (auth stamp). */
  createdBy: string;
  createdUtc: string;
  updatedUtc: string;
  lastRunUtc: string | null;
  /** "ok" | "skipped: locked" | "error: …" | null (never run). */
  lastStatus: string | null;
  nextRunUtc: string | null;
  /** Reserved and unused. Live mode (sessionMode === "live") binds via
   *  `channelRef` (the durable thread id), not a raw ACP session id, so this
   *  stays null (D8). */
  pinnedSessionId: string | null;
}

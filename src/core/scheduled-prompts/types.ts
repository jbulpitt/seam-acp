/**
 * Scheduled prompts — cron-style prompts tied to a Discord thread (channelRef).
 * See docs/scheduled-prompts-plan.md. Jobs are self-contained: each fire runs in
 * its own throwaway session and posts output back to the thread as cards.
 */

/** One persisted reference file, re-sent to the agent on every run. The bytes
 *  live on disk under data/scheduled-attachments/<id>/<filename>. */
export interface ScheduledAttachment {
  filename: string;
  mime: string;
  size: number;
}

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
  /** Model id to run the job under. null = use the thread session's model. */
  model: string | null;
  /** Working directory to run the job in. null = the thread's repoPath. */
  cwd: string | null;
  /** Channel/thread id to post output to. null = the schedule's own thread. */
  targetChannel: string | null;
  /** How to render the result. "card" = blue embed card(s); "messages" = plain
   *  chunked text messages. The "running" announcement is always a card. */
  outputType: "card" | "messages";
  /** Missed-fire catch-up window in seconds. 0 = never catch up. Default 900. */
  catchupSeconds: number;
  enabled: boolean;
  attachments: ScheduledAttachment[];
  /** Discord user id of the creator (auth stamp). */
  createdBy: string;
  createdUtc: string;
  updatedUtc: string;
  lastRunUtc: string | null;
  /** "ok" | "skipped: locked" | "error: …" | null (never run). */
  lastStatus: string | null;
  nextRunUtc: string | null;
  /** Reserved for a future "pin to session" mode; null in v1. */
  pinnedSessionId: string | null;
}

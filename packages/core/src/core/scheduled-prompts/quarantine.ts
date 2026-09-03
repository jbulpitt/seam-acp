/**
 * Legacy-attachment quarantine (#158).
 *
 * Scheduled-prompt file attachments were removed: nothing adds them, and the
 * fire path no longer reloads or injects anything from disk. A row written
 * before the removal can still carry entries in the legacy `attachments_json`
 * column, and its prompt was probably authored assuming those files would be
 * re-sent. Silently running such a prompt with the files missing is the failure
 * we refuse: the row is QUARANTINED — never armed, never fired — until an
 * operator revises it.
 *
 * Revising means editing the schedule (the `/seam schedule` builder card, or a
 * `config_propose` schedule update) so the prompt points at a repository
 * runbook instead. That write clears the legacy manifest and lifts the
 * quarantine. The bytes under `data/scheduled-attachments/<id>/` are never
 * deleted by Seam; remove them by hand when you no longer want them.
 */
import type { ScheduledPrompt } from "./types.js";

/** True when the row still carries pre-#158 attachment metadata. */
export function hasLegacyAttachments(row: Pick<ScheduledPrompt, "legacyAttachmentCount">): boolean {
  return (row.legacyAttachmentCount ?? 0) > 0;
}

/** Short `last_status` breadcrumb for a quarantined row, or null when runnable. */
export function legacyAttachmentStatus(
  row: Pick<ScheduledPrompt, "legacyAttachmentCount">
): string | null {
  if (!hasLegacyAttachments(row)) return null;
  const n = row.legacyAttachmentCount;
  return `quarantined: ${n} legacy attachment${n === 1 ? "" : "s"} (#158) — edit this schedule to re-arm it`;
}

/** Full operator-facing explanation, for logs and confirmation cards. */
export function legacyAttachmentQuarantine(
  row: Pick<ScheduledPrompt, "legacyAttachmentCount">
): string | null {
  if (!hasLegacyAttachments(row)) return null;
  const n = row.legacyAttachmentCount;
  return (
    `This schedule still carries ${n} legacy reference file${n === 1 ? "" : "s"} and will NOT run (#158). ` +
    `Scheduled prompts no longer send files: move those instructions into a repository runbook and edit ` +
    `the schedule so its prompt references the runbook. Saving that edit clears the legacy files and ` +
    `re-arms it. The stored bytes are left on disk under data/scheduled-attachments/.`
  );
}

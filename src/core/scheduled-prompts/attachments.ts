/**
 * Persisted storage for scheduled-prompt attachments. Discord CDN URLs expire
 * (~24h), so we download the bytes at create time and re-attach them on every
 * run. Bytes live under <dataDir>/scheduled-attachments/<scheduleId>/<filename>.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import type { MessageAttachment } from "../../platforms/chat-adapter.js";
import type { ScheduledAttachment } from "./types.js";

function dirFor(dataDir: string, scheduleId: string): string {
  return path.join(dataDir, "scheduled-attachments", scheduleId);
}

/** Sanitize a filename to a safe basename (no traversal). */
function safeName(name: string): string {
  const base = path.basename(name).replace(/[^\w.\-]+/g, "_");
  return base || "file";
}

/** Persist one downloaded file; returns its manifest entry. */
export async function saveScheduledAttachment(
  dataDir: string,
  scheduleId: string,
  file: { filename: string; mime: string; bytes: Buffer }
): Promise<ScheduledAttachment> {
  const dir = dirFor(dataDir, scheduleId);
  await fsp.mkdir(dir, { recursive: true });
  const filename = safeName(file.filename);
  await fsp.writeFile(path.join(dir, filename), file.bytes);
  return { filename, mime: file.mime, size: file.bytes.length };
}

/** Remove one stored file (e.g. a removefile action). */
export async function deleteScheduledAttachment(
  dataDir: string,
  scheduleId: string,
  filename: string
): Promise<void> {
  await fsp.rm(path.join(dirFor(dataDir, scheduleId), safeName(filename)), { force: true });
}

/** Delete all stored files for a schedule (on schedule/thread delete). */
export async function deleteScheduledAttachmentDir(dataDir: string, scheduleId: string): Promise<void> {
  await fsp.rm(dirFor(dataDir, scheduleId), { recursive: true, force: true });
}

/** Rehydrate stored attachments into the MessageAttachment shape the turn
 *  pipeline consumes (base64 data URL), skipping any that are missing on disk. */
export async function loadScheduledAttachments(
  dataDir: string,
  scheduleId: string,
  manifest: ScheduledAttachment[]
): Promise<MessageAttachment[]> {
  const out: MessageAttachment[] = [];
  const dir = dirFor(dataDir, scheduleId);
  for (const a of manifest) {
    try {
      const bytes = await fsp.readFile(path.join(dir, safeName(a.filename)));
      out.push({
        filename: a.filename,
        contentType: a.mime,
        url: `data:${a.mime};base64,${bytes.toString("base64")}`,
        size: bytes.length,
      });
    } catch { /* file gone — skip */ }
  }
  return out;
}

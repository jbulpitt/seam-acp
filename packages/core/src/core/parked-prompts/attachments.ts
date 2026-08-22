/**
 * Persisted storage for parked-prompt attachments (#88 D6). Discord CDN URLs
 * expire, so we download at park time and ferry bytes via `writeAttachment`
 * after the host reconnects. Bytes live under
 * <dataDir>/parked-attachments/<parkedId>/<filename>.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import type { MessageAttachment } from "../../platforms/chat-adapter.js";
import type { ParkedAttachment } from "./types.js";

/** Honor the existing 25 MB attach cap at park time (issue #88 risks). */
export const PARKED_ATTACH_MAX_BYTES = 25 * 1024 * 1024;

function dirFor(dataDir: string, parkedId: string): string {
  return path.join(dataDir, "parked-attachments", parkedId);
}

function safeName(name: string): string {
  const base = path.basename(name).replace(/[^\w.\-]+/g, "_");
  return base || "file";
}

export async function saveParkedAttachment(
  dataDir: string,
  parkedId: string,
  file: { filename: string; mime: string; bytes: Buffer }
): Promise<ParkedAttachment> {
  const dir = dirFor(dataDir, parkedId);
  await fsp.mkdir(dir, { recursive: true });
  const filename = safeName(file.filename);
  await fsp.writeFile(path.join(dir, filename), file.bytes);
  return { filename, mime: file.mime, size: file.bytes.length };
}

export async function deleteParkedAttachmentDir(dataDir: string, parkedId: string): Promise<void> {
  await fsp.rm(dirFor(dataDir, parkedId), { recursive: true, force: true });
}

/** Rehydrate stored files as MessageAttachments (data URLs) for tests / debug.
 *  Fire uses {@link loadParkedAttachmentBytes} so we can `writeAttachment`. */
export async function loadParkedAttachments(
  dataDir: string,
  parkedId: string,
  manifest: ParkedAttachment[]
): Promise<MessageAttachment[]> {
  const out: MessageAttachment[] = [];
  for (const a of manifest) {
    const loaded = await loadParkedAttachmentBytes(dataDir, parkedId, a);
    if (!loaded) continue;
    out.push({
      filename: a.filename,
      contentType: a.mime,
      url: `data:${a.mime};base64,${loaded.toString("base64")}`,
      size: loaded.length,
    });
  }
  return out;
}

export async function loadParkedAttachmentBytes(
  dataDir: string,
  parkedId: string,
  a: ParkedAttachment
): Promise<Buffer | null> {
  try {
    return await fsp.readFile(path.join(dirFor(dataDir, parkedId), safeName(a.filename)));
  } catch {
    return null;
  }
}

/**
 * Staging for attachments that can't be turned into a model-consumable content
 * block (PDFs, office docs, HEIC/other non-viewable images, archives, unknown
 * binaries). Instead of silently dropping them, we write the bytes to a temp
 * directory and hand the agent the path so it can open them with its own file
 * tools (Claude Code's Read handles PDFs/text/images; office formats via Bash
 * converters; etc.).
 *
 * Files live under the OS temp dir, so the host cleans them up as a backstop;
 * we also sweep them after MAX_AGE_MS for predictable cleanup. Anything the
 * agent wants to keep, it copies into the workspace (that copy persists).
 */
import { promises as fsp } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import os from "node:os";

const STAGING_ROOT = path.join(os.tmpdir(), "seam-attachments");
const MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48h

/** Write bytes to `<tmp>/seam-attachments/<batchId>/<safe-filename>` and return
 *  the absolute path the agent can read. `batchId` groups one message's files. */
export async function stageAttachment(
  filename: string,
  bytes: Buffer,
  batchId: string
): Promise<string> {
  const dir = path.join(STAGING_ROOT, batchId);
  await fsp.mkdir(dir, { recursive: true });
  const base =
    path.basename(filename).replace(/[^\w.\- ]+/g, "_").trim() || "file";
  const dest = path.join(dir, base);
  await fsp.writeFile(dest, bytes);
  return dest;
}

/** Best-effort TTL sweep: delete staged batches older than `maxAgeMs`. Safe to
 *  call on startup and opportunistically; never throws. */
export async function sweepStagedAttachments(maxAgeMs = MAX_AGE_MS): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(STAGING_ROOT, { withFileTypes: true });
  } catch {
    return; // dir doesn't exist yet — nothing to sweep
  }
  const cutoff = Date.now() - maxAgeMs;
  await Promise.all(
    entries.map(async (e) => {
      const p = path.join(STAGING_ROOT, e.name);
      try {
        const st = await fsp.stat(p);
        if (st.mtimeMs < cutoff) await fsp.rm(p, { recursive: true, force: true });
      } catch {
        /* ignore — best effort */
      }
    })
  );
}

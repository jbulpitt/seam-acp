/**
 * Persisted storage for scheduled-prompt attachments. Discord CDN URLs expire
 * (~24h), so we download the bytes at create time and re-attach them on every
 * run. Bytes live under <dataDir>/scheduled-attachments/<scheduleId>/<filename>.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
function dirFor(dataDir, scheduleId) {
    return path.join(dataDir, "scheduled-attachments", scheduleId);
}
/** Sanitize a filename to a safe basename (no traversal). */
function safeName(name) {
    const base = path.basename(name).replace(/[^\w.\-]+/g, "_");
    return base || "file";
}
/** Persist one downloaded file; returns its manifest entry. */
export async function saveScheduledAttachment(dataDir, scheduleId, file) {
    const dir = dirFor(dataDir, scheduleId);
    await fsp.mkdir(dir, { recursive: true });
    const filename = safeName(file.filename);
    await fsp.writeFile(path.join(dir, filename), file.bytes);
    return { filename, mime: file.mime, size: file.bytes.length };
}
/** Remove one stored file (e.g. a removefile action). */
export async function deleteScheduledAttachment(dataDir, scheduleId, filename) {
    await fsp.rm(path.join(dirFor(dataDir, scheduleId), safeName(filename)), { force: true });
}
/** Delete all stored files for a schedule (on schedule/thread delete). */
export async function deleteScheduledAttachmentDir(dataDir, scheduleId) {
    await fsp.rm(dirFor(dataDir, scheduleId), { recursive: true, force: true });
}
/** Rehydrate stored attachments into the MessageAttachment shape the turn
 *  pipeline consumes (base64 data URL), skipping any that are missing on disk. */
export async function loadScheduledAttachments(dataDir, scheduleId, manifest) {
    const out = [];
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
        }
        catch { /* file gone — skip */ }
    }
    return out;
}
//# sourceMappingURL=attachments.js.map
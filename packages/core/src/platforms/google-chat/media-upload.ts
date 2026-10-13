import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import type { GoogleApi } from "./api.js";

export type ChatMediaFile = { data: Buffer; filename: string; mimeType: string; caption?: string };
export type ChatMediaAttachment = { attachmentDataRef: { resourceName: string; [key: string]: unknown } };

export function imageMimeType(file: ChatMediaFile): string | undefined {
  if (file.mimeType.startsWith("image/")) return file.mimeType;
  if (file.mimeType !== "application/octet-stream") return undefined;
  const extensions: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp" };
  return extensions[extname(file.filename).toLowerCase()];
}

/** Google's simple media upload protocol carries filename metadata and raw bytes. */
export function uploadChatImage(api: GoogleApi, space: string, file: ChatMediaFile, mimeType: string): Promise<ChatMediaAttachment> {
  const boundary = `seam-${randomUUID()}`;
  const data = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ filename: file.filename })}\r\n`
      + `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    file.data, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return api.request("media", { method: "POST", url: `https://chat.googleapis.com/upload/v1/${space}/attachments:upload`,
    params: { uploadType: "multipart" }, headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, data });
}

import type {
  ContentBlock,
  PromptCapabilities,
} from "@agentclientprotocol/sdk";
import type { Logger } from "../lib/logger.js";
import type { MessageAttachment } from "../platforms/chat-adapter.js";

export const MAX_ATTACHMENTS = 8;
export const MAX_BYTES_PER_ATTACHMENT = 5 * 1024 * 1024; // 5 MB
export const MAX_INLINE_TEXT_BYTES = 256 * 1024; // 256 KB
export const DOWNLOAD_TIMEOUT_MS = 10_000;

export interface RejectedAttachment {
  filename: string;
  reason: string;
}

export interface AttachmentMapResult {
  blocks: ContentBlock[];
  rejected: RejectedAttachment[];
}

export interface AttachmentMapOptions {
  capabilities?: PromptCapabilities;
  logger?: Logger;
  /** Override fetch for tests. */
  fetchFn?: typeof fetch;
  /** Override max attachment count. */
  maxAttachments?: number;
}

/**
 * Map a list of platform attachments to ACP `ContentBlock`s, picking the
 * richest representation each agent capability allows and falling back to
 * `resource_link` (which is always supported per ACP baseline). Audio is
 * rejected when the agent doesn't advertise `audio` support — every other
 * type degrades gracefully.
 */
export async function mapAttachmentsToBlocks(
  attachments: ReadonlyArray<MessageAttachment>,
  opts: AttachmentMapOptions = {}
): Promise<AttachmentMapResult> {
  const caps = opts.capabilities;
  const fetchFn = opts.fetchFn ?? fetch;
  const maxCount = opts.maxAttachments ?? MAX_ATTACHMENTS;
  const blocks: ContentBlock[] = [];
  const rejected: RejectedAttachment[] = [];

  const limited = attachments.slice(0, maxCount);
  for (const a of attachments.slice(maxCount)) {
    rejected.push({
      filename: a.filename,
      reason: `attachment limit (${maxCount}) exceeded`,
    });
  }

  for (const a of limited) {
    if (a.size > MAX_BYTES_PER_ATTACHMENT) {
      rejected.push({
        filename: a.filename,
        reason: `larger than ${formatBytes(MAX_BYTES_PER_ATTACHMENT)}`,
      });
      continue;
    }

    const mime = (a.contentType ?? "").toLowerCase();

    try {
      if (isImageMime(mime)) {
        if (caps?.image) {
          const data = await downloadBase64(a.url, fetchFn);
          blocks.push({
            type: "image",
            data,
            mimeType: mime || "application/octet-stream",
          });
          continue;
        }
        rejected.push({
          filename: a.filename,
          reason: "this agent does not support image attachments",
        });
        continue;
      }

      if (isAudioMime(mime)) {
        if (caps?.audio) {
          const data = await downloadBase64(a.url, fetchFn);
          blocks.push({
            type: "audio",
            data,
            mimeType: mime || "application/octet-stream",
          });
          continue;
        }
        rejected.push({
          filename: a.filename,
          reason: "audio attachments are not supported by this agent",
        });
        continue;
      }

      if (isTextLikeMime(mime, a.filename)) {
        if (caps?.embeddedContext && a.size <= MAX_INLINE_TEXT_BYTES) {
          const text = await downloadText(a.url, fetchFn);
          blocks.push({
            type: "resource",
            resource: {
              // Use a local URI — the content is already inlined and the agent
              // must not attempt to fetch the (ephemeral, auth-gated) source URL.
              uri: `attachment://${a.filename}`,
              mimeType: mime || "text/plain",
              text,
            },
          });
          continue;
        }
        if (!caps?.embeddedContext) {
          rejected.push({
            filename: a.filename,
            reason: "this agent does not support inline file content",
          });
        } else {
          rejected.push({
            filename: a.filename,
            reason: `file too large to inline (limit is ${formatBytes(MAX_INLINE_TEXT_BYTES)}); save it to the repo and reference the path`,
          });
        }
        continue;
      }

      // Unknown / generic binary (e.g. docx, pdf, zip): cannot be inlined.
      rejected.push({
        filename: a.filename,
        reason: "binary format cannot be sent to the agent; save the file to your repo and reference the path instead",
      });
    } catch (err) {
      opts.logger?.warn(
        { err, filename: a.filename, url: a.url },
        "attachment download failed; falling back to resource_link"
      );
      blocks.push(toResourceLink(a));
    }
  }

  return { blocks, rejected };
}

function toResourceLink(a: MessageAttachment): ContentBlock {
  return {
    type: "resource_link",
    name: a.filename,
    // Use a local URI — the source URL is ephemeral and auth-gated (e.g.
    // Discord CDN) and must not be forwarded to the agent.
    uri: `attachment://${a.filename}`,
    ...(a.contentType ? { mimeType: a.contentType } : {}),
    ...(typeof a.size === "number" ? { size: a.size } : {}),
  };
}

function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

function isAudioMime(mime: string): boolean {
  return mime.startsWith("audio/");
}

const TEXT_MIME_PREFIXES = ["text/"];
const TEXT_MIME_EXACT = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/x-yaml",
  "application/x-sh",
  "application/x-toml",
  "application/sql",
  "application/x-httpd-php",
]);
const TEXT_MIME_SUFFIXES = ["+json", "+xml", "+yaml"];
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "rst", "log", "csv", "tsv",
  "json", "yaml", "yml", "toml", "ini", "env", "conf", "cfg",
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "rb", "go", "rs", "java", "kt", "swift", "c", "cc", "cpp", "h", "hpp",
  "cs", "php", "sh", "bash", "zsh", "fish", "ps1",
  "html", "htm", "css", "scss", "sass", "less",
  "xml", "svg", "sql", "graphql", "gql",
  "dockerfile", "makefile", "gitignore", "editorconfig",
]);

function isTextLikeMime(mime: string, filename: string): boolean {
  if (mime) {
    if (TEXT_MIME_PREFIXES.some((p) => mime.startsWith(p))) return true;
    if (TEXT_MIME_EXACT.has(mime)) return true;
    if (TEXT_MIME_SUFFIXES.some((s) => mime.endsWith(s))) return true;
  }
  const ext = filename.includes(".")
    ? filename.split(".").pop()!.toLowerCase()
    : filename.toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

async function downloadBase64(
  url: string,
  fetchFn: typeof fetch
): Promise<string> {
  const buf = await downloadBytes(url, fetchFn);
  return Buffer.from(buf).toString("base64");
}

async function downloadText(
  url: string,
  fetchFn: typeof fetch
): Promise<string> {
  const buf = await downloadBytes(url, fetchFn);
  return Buffer.from(buf).toString("utf8");
}

async function downloadBytes(
  url: string,
  fetchFn: typeof fetch
): Promise<ArrayBuffer> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { signal: ctrl.signal });
    if (!res.ok) {
      throw new Error(`download failed: ${res.status} ${res.statusText}`);
    }
    return await res.arrayBuffer();
  } finally {
    clearTimeout(timer);
  }
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${Math.round(n / (1024 * 1024))} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

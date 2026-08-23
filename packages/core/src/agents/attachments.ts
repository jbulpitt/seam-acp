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
        if (caps?.image && MODEL_IMAGE_MIMES.has(mime)) {
          const data = await downloadBase64(a.url, fetchFn);
          blocks.push({
            type: "image",
            data,
            mimeType: mime || "application/octet-stream",
          });
          continue;
        }
        // No vision capability, or a format the model can't decode directly
        // (HEIC/HEIF/TIFF/BMP/SVG — see MODEL_IMAGE_MIMES) — send as a link
        // so a local agent can still reference/convert it via its own tools.
        blocks.push(toResourceLink(a));
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
        // Too large to inline or no capability — send as a link.
        blocks.push(toResourceLink(a));
        continue;
      }

      // Unknown / generic binary (e.g. docx, pdf, zip).
      // Inline as a blob if the agent supports embedded context; otherwise send
      // as a resource_link so a local agent with network tools can fetch it.
      if (caps?.embeddedContext && a.size <= MAX_BYTES_PER_ATTACHMENT) {
        const blob = await downloadBase64(a.url, fetchFn);
        blocks.push({
          type: "resource",
          resource: {
            uri: `attachment://${a.filename}`,
            mimeType: mime || "application/octet-stream",
            blob,
          },
        } as import("@agentclientprotocol/sdk").ContentBlock);
        continue;
      }
      blocks.push(toResourceLink(a));
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
    uri: `attachment://${a.filename}`,
    ...(a.contentType ? { mimeType: a.contentType } : {}),
    ...(typeof a.size === "number" ? { size: a.size } : {}),
  };
}

function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

export function isAudioMime(mime: string): boolean {
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

/** MIME types the model reads directly as an image content block. Discord's
 *  other image formats (HEIC/HEIF/TIFF/BMP/SVG) are NOT model-viewable and must
 *  be staged to a file path instead, not sent as an (unsupported) image block. */
const MODEL_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/** True when an attachment can be turned into a content block the model reads
 *  directly — inline text, or a supported image. Everything else (PDF, office
 *  docs, HEIC, archives, audio, unknown binary) can't be inlined and should be
 *  staged to a file path for the agent's tools instead. */
export function isModelInlineableAttachment(mime: string, filename: string): boolean {
  const m = (mime || "").toLowerCase();
  if (MODEL_IMAGE_MIMES.has(m)) return true;
  if (isTextLikeMime(m, filename)) return true;
  return false;
}

/** Whether an attachment should be sent inline to a *specific* agent, given the
 *  agent's ACP-advertised image prompt capability (`promptCapabilities.image`).
 *  A standard image is only inlineable when the agent can actually decode it as
 *  an image block; when the agent advertises `image:false` (e.g. the Grok CLI's
 *  `agent stdio` bridge — grok-4.5 has vision, but its ACP layer doesn't accept
 *  image prompt blocks), an image must be staged to a file path instead, so the
 *  caller treats it as non-inlineable and stages it. Text stays inlineable
 *  regardless (delivered via embeddedContext). `undefined` vision (capability
 *  not known) preserves the legacy inline behavior. */
export function isInlineableForAgent(
  mime: string,
  filename: string,
  agentHasVision?: boolean
): boolean {
  if (!isModelInlineableAttachment(mime, filename)) return false;
  const isImage = (mime || "").toLowerCase().startsWith("image/");
  return !(isImage && agentHasVision === false);
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

/**
 * Pure helpers for inspecting ACP `ContentBlock`s emitted by agents and
 * turning the non-text variants into something we can upload to a chat
 * platform. Imported by `agent-runtime.ts`; kept here for unit testing.
 */

export interface BlockFile {
  filename: string;
  mimeType: string;
  /** Base64 for binary (image/audio/blob); plain text for text resources. */
  data: string;
  base64: boolean;
  uri?: string;
}

/** Extract a downloadable file from any non-text ContentBlock variant. */
export function blockToFile(block: unknown): BlockFile | undefined {
  if (!block || typeof block !== "object") return undefined;
  const b = block as Record<string, unknown>;
  switch (b.type) {
    case "image":
    case "audio": {
      const data = typeof b.data === "string" ? b.data : "";
      if (!data) return undefined;
      const mimeType =
        typeof b.mimeType === "string" ? b.mimeType : "application/octet-stream";
      return {
        filename: synthFilename(b, mimeType, b.type === "image" ? "image" : "audio"),
        mimeType,
        data,
        base64: true,
        ...(typeof b.uri === "string" ? { uri: b.uri } : {}),
      };
    }
    case "resource": {
      const r = (b.resource ?? {}) as Record<string, unknown>;
      const uri = typeof r.uri === "string" ? r.uri : undefined;
      const mimeType =
        typeof r.mimeType === "string" ? r.mimeType : "application/octet-stream";
      if (typeof r.text === "string") {
        return {
          filename: synthFilenameFromUri(uri, mimeType, "resource"),
          mimeType,
          data: r.text,
          base64: false,
          ...(uri ? { uri } : {}),
        };
      }
      if (typeof r.blob === "string") {
        return {
          filename: synthFilenameFromUri(uri, mimeType, "resource"),
          mimeType,
          data: r.blob,
          base64: true,
          ...(uri ? { uri } : {}),
        };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

function synthFilename(
  block: Record<string, unknown>,
  mimeType: string,
  fallbackBase: string
): string {
  const uri = typeof block.uri === "string" ? block.uri : undefined;
  return synthFilenameFromUri(uri, mimeType, fallbackBase);
}

function synthFilenameFromUri(
  uri: string | undefined,
  mimeType: string,
  fallbackBase: string
): string {
  if (uri) {
    try {
      const u = new URL(uri);
      const last = u.pathname.split("/").filter(Boolean).pop();
      if (last) return last;
    } catch {
      const last = uri.split(/[/\\]/).filter(Boolean).pop();
      if (last) return last;
    }
  }
  const ext = mimeToExt(mimeType);
  const stamp = Date.now();
  return ext ? `${fallbackBase}-${stamp}.${ext}` : `${fallbackBase}-${stamp}`;
}

function mimeToExt(mime: string): string | undefined {
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/webm": "webm",
    "text/plain": "txt",
    "text/markdown": "md",
    "text/csv": "csv",
    "text/html": "html",
    "application/json": "json",
    "application/xml": "xml",
    "application/pdf": "pdf",
  };
  return map[mime.toLowerCase()];
}

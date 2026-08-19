/**
 * Host-side `readAttachment` ferry (§4.2). Project-cwd-relative first, then
 * the host workspace root; `realpath` must stay within the workspace root.
 * Same 25 MB cap as the Discord attach path.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import type { AttachmentBytes } from "./agent-profile.js";

export const ATTACH_MAX_BYTES = 25 * 1024 * 1024;

export class AttachmentPathError extends Error {
  readonly code: "escape" | "not_found" | "too_large" | "not_file" | "empty";
  constructor(code: AttachmentPathError["code"], message: string) {
    super(message);
    this.name = "AttachmentPathError";
    this.code = code;
  }
}

function normalizeRoot(root: string): string {
  const resolved = path.resolve(root);
  return resolved.endsWith(path.sep) ? resolved : resolved + path.sep;
}

export function isPathWithinRoot(fullPath: string, rootFullPath: string): boolean {
  const fp = path.resolve(fullPath);
  const rp = normalizeRoot(rootFullPath);
  const fpCmp = fp.toLowerCase();
  const rpCmp = rp.toLowerCase();
  return fpCmp === rpCmp.slice(0, -1) || fpCmp.startsWith(rpCmp);
}

/**
 * Resolve `requested` against `cwd` first (if relative), then `workspaceRoot`.
 * Absolute paths are realpath'd and still must stay inside `workspaceRoot`.
 */
export async function resolveAttachmentPath(
  cwd: string,
  requested: string,
  workspaceRoot: string
): Promise<string> {
  const cleaned = requested.trim().replace(/^["']|["']$/g, "");
  if (!cleaned) {
    throw new AttachmentPathError("empty", "attachment path is empty");
  }

  const root = path.resolve(workspaceRoot);
  const candidates: string[] = [];
  if (path.isAbsolute(cleaned)) {
    candidates.push(path.resolve(cleaned));
  } else {
    candidates.push(path.resolve(cwd, cleaned));
    const fromRoot = path.resolve(root, cleaned);
    if (!candidates.includes(fromRoot)) candidates.push(fromRoot);
  }

  let lastErr: unknown;
  for (const candidate of candidates) {
    try {
      const real = await fsp.realpath(candidate);
      if (!isPathWithinRoot(real, root)) {
        throw new AttachmentPathError(
          "escape",
          `path escapes workspace root: ${cleaned}`
        );
      }
      const st = await fsp.stat(real);
      if (!st.isFile()) {
        throw new AttachmentPathError("not_file", `not a regular file: ${cleaned}`);
      }
      if (st.size > ATTACH_MAX_BYTES) {
        throw new AttachmentPathError(
          "too_large",
          `file exceeds ${ATTACH_MAX_BYTES} byte attach cap (${st.size} B)`
        );
      }
      return real;
    } catch (err) {
      if (err instanceof AttachmentPathError && err.code === "escape") throw err;
      if (err instanceof AttachmentPathError && err.code === "too_large") throw err;
      if (err instanceof AttachmentPathError && err.code === "not_file") {
        lastErr = err;
        continue;
      }
      lastErr = err;
    }
  }

  if (lastErr instanceof AttachmentPathError) throw lastErr;
  throw new AttachmentPathError("not_found", `attachment not found: ${cleaned}`);
}

export async function readAttachmentWithinRoot(
  cwd: string,
  requested: string,
  workspaceRoot: string
): Promise<AttachmentBytes> {
  const realPath = await resolveAttachmentPath(cwd, requested, workspaceRoot);
  const buf = await fsp.readFile(realPath);
  if (buf.byteLength > ATTACH_MAX_BYTES) {
    throw new AttachmentPathError(
      "too_large",
      `file exceeds ${ATTACH_MAX_BYTES} byte attach cap (${buf.byteLength} B)`
    );
  }
  return {
    bytes: buf,
    filename: path.basename(realPath),
    size: buf.byteLength,
  };
}

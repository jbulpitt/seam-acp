/**
 * Path-watcher: scans tool-emitted text for file paths, and if the file
 * exists under one of the configured safe roots, returns the bytes so the
 * runtime can emit them as `agent-file` events.
 *
 * This catches MCP tools (and the agent's own filesystem tools) that
 * "produce a file" by writing it to disk and narrating the path, rather
 * than returning a proper `image` / `resource` content block.
 *
 * Safety: we only read files under explicitly-allowed roots, only with
 * known/safe extensions, and only up to a hard size cap.
 */

import fs from "node:fs/promises";
import path from "node:path";

export interface WatchedFile {
  absPath: string;
  /** Path as the agent referred to it (raw match from the text). */
  rawPath: string;
  filename: string;
  mimeType: string;
  data: Buffer;
}

const MAX_FILE_BYTES = 25 * 1024 * 1024; // Discord free-tier upload limit.

/** Extensions we'll consider for upload. Mapped to their MIME type. */
const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  txt: "text/plain",
  log: "text/plain",
  yaml: "text/yaml",
  yml: "text/yaml",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  webm: "audio/webm",
  mp4: "video/mp4",
};

/**
 * Pull file paths out of arbitrary text. We look for tokens that contain a
 * `.` followed by a known extension. The regex is permissive on path
 * characters but excludes whitespace, quotes, parens, and brackets so we
 * don't grab markdown bracketing punctuation.
 */
export function extractCandidatePaths(text: string): string[] {
  if (!text) return [];
  const exts = Object.keys(EXT_MIME).join("|");
  // Path token: any run of safe path characters ending in .<ext>
  const re = new RegExp(
    String.raw`(?:^|[\s(\[\]"'<>` + "`])([./~\\w][\\w./~+-]*\\.(" + exts + "))(?=[\\s)\\]\"'<>`,;:!?]|$)",
    "gi"
  );
  const out = new Set<string>();
  for (const m of text.matchAll(re)) {
    if (m[1]) out.add(m[1]);
  }
  return Array.from(out);
}

/**
 * For each candidate path in `text`, resolve under `roots`, read the file
 * if it exists and is under the size cap, and return a WatchedFile.
 *
 * `seen` is mutated with absolute paths we've already returned, so callers
 * can dedupe across multiple tool results in the same turn.
 */
export async function readFilesFromText(
  text: string,
  opts: { roots: string[]; seen: Set<string> }
): Promise<WatchedFile[]> {
  const candidates = extractCandidatePaths(text);
  if (candidates.length === 0) return [];

  const out: WatchedFile[] = [];
  for (const raw of candidates) {
    const abs = resolveUnderRoots(raw, opts.roots);
    if (!abs) continue;
    if (opts.seen.has(abs)) continue;

    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size === 0 || stat.size > MAX_FILE_BYTES) continue;

    const ext = path.extname(abs).slice(1).toLowerCase();
    const mimeType = EXT_MIME[ext];
    if (!mimeType) continue;

    let data: Buffer;
    try {
      data = await fs.readFile(abs);
    } catch {
      continue;
    }

    opts.seen.add(abs);
    out.push({
      absPath: abs,
      rawPath: raw,
      filename: path.basename(abs),
      mimeType,
      data,
    });
  }
  return out;
}

/**
 * Resolve `p` against the given safe roots. Accepts absolute paths (must
 * literally start with one of the roots), `~`-prefixed home paths, and
 * relative paths (joined to each root in order). Rejects anything that
 * resolves outside every root.
 */
function resolveUnderRoots(p: string, roots: string[]): string | undefined {
  if (roots.length === 0) return undefined;

  const expanded = p.startsWith("~/")
    ? path.join(process.env.HOME ?? "", p.slice(2))
    : p;

  if (path.isAbsolute(expanded)) {
    const resolved = path.resolve(expanded);
    return roots.some((r) => isUnder(resolved, r)) ? resolved : undefined;
  }

  for (const r of roots) {
    const candidate = path.resolve(r, expanded);
    if (isUnder(candidate, r)) return candidate;
  }
  return undefined;
}

function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

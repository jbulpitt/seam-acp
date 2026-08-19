/**
 * Unrestricted host-path resolution for admin-only `/seam upload` commands.
 * Relative paths (no leading `/`) resolve against `process.cwd()`. Absolute
 * paths are used as-is. No allowlist, no repo jail.
 */
import path from "node:path";

export function resolveHostPath(input: string): string {
  const trimmed = (input ?? "").trim();
  if (!trimmed) throw new Error("path is empty");
  if (trimmed.startsWith("/")) return trimmed;
  return path.resolve(trimmed);
}

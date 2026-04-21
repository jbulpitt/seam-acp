import path from "node:path";

/** Resolve to an absolute, normalized path. Strips surrounding quotes. */
export function normalizeFullPath(p: string): string {
  return path.resolve(p.trim().replace(/^"|"$/g, ""));
}

/**
 * Returns true if `fullPath` is the same as or a descendant of `rootFullPath`.
 * Case-insensitive (matches the C# behavior, important on macOS/Windows).
 */
export function isWithinRoot(fullPath: string, rootFullPath: string): boolean {
  const fp = normalizeFullPath(fullPath);
  let rp = normalizeFullPath(rootFullPath);
  if (!rp.endsWith(path.sep)) rp += path.sep;

  const fpCmp = fp.toLowerCase();
  const rpCmp = rp.toLowerCase();
  return (
    fpCmp === rpCmp.slice(0, -1) || // exact root match
    fpCmp.startsWith(rpCmp)
  );
}

/**
 * Resolve user input as a repo path. Absolute paths pass through; relative
 * paths are joined under `reposRoot`. Caller still must check `isWithinRoot`.
 */
export function resolveRepoPath(reposRoot: string, userInput: string): string {
  const input = userInput.trim().replace(/^"|"$/g, "");
  if (!input) {
    throw new Error("Repo path is required");
  }
  const combined = path.isAbsolute(input)
    ? input
    : path.join(reposRoot, input);
  return normalizeFullPath(combined);
}

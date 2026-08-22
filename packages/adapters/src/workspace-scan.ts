/**
 * Host-side workspace enumeration (D11 / §7).
 *
 * Each host has one workspace root. `listWorkspaces()` lists immediate
 * child directories under that root and returns their absolute paths.
 * Hidden (dot) entries are skipped. Symbolic links are skipped too — a
 * relocate leftover (`old-name` → `new-name`) must not show up as a
 * second project in the repo picker. The control plane uses the returned
 * paths as-is — no cwd rewrite.
 */
import fs from "node:fs";
import path from "node:path";
import type { WorkspaceInfo } from "./agent-profile.js";

/** Immediate children the repo picker will offer. Hidden + symlink dirs out. */
export function isListedWorkspaceDirent(e: fs.Dirent): boolean {
  if (e.name.startsWith(".")) return false;
  // Check the link first: Dirent.isDirectory() is false for a symlink on
  // most platforms, but some filesystems report DT_DIR for a link-to-dir.
  if (e.isSymbolicLink()) return false;
  return e.isDirectory();
}

export function scanWorkspaces(root: string): WorkspaceInfo[] {
  const resolved = path.resolve(root);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return [];
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(resolved, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(isListedWorkspaceDirent)
    .map((e) => {
      const abs = path.join(resolved, e.name);
      return { id: e.name, path: abs, name: e.name };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

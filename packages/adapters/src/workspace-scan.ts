/**
 * Host-side workspace enumeration (D11 / §7).
 *
 * Each host has one workspace root. `listWorkspaces()` lists immediate
 * child directories under that root and returns their absolute paths.
 * Hidden (dot) entries are skipped. The control plane uses the returned
 * paths as-is — no cwd rewrite.
 */
import fs from "node:fs";
import path from "node:path";
import type { WorkspaceInfo } from "./agent-profile.js";

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
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => {
      const abs = path.join(resolved, e.name);
      return { id: e.name, path: abs, name: e.name };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

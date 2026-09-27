import fs from "node:fs";
import path from "node:path";

export const LOCAL_BRIDGE_TARGETS_RELATIVE = "docs/local/bridge-targets.json";
export const LEGACY_BRIDGE_TARGETS_RELATIVE = "ops/bridge/targets.json";

function configuredPath(repoRoot, value) {
  return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}

/**
 * Resolve the operator-owned bridge target map.
 *
 * An explicit SEAM_BRIDGE_TARGETS_FILE is authoritative. Without it, prefer
 * the gitignored deployment notes and retain the old tracked location only as
 * a compatibility fallback for existing installations.
 */
export function resolveBridgeTargetsFile(
  repoRoot,
  env = process.env,
  exists = fs.existsSync,
) {
  const explicit = env.SEAM_BRIDGE_TARGETS_FILE?.trim();
  if (explicit) {
    const file = configuredPath(repoRoot, explicit);
    if (!exists(file)) throw new Error(`bridge target map not found: ${file}`);
    return file;
  }

  for (const relative of [
    LOCAL_BRIDGE_TARGETS_RELATIVE,
    LEGACY_BRIDGE_TARGETS_RELATIVE,
  ]) {
    const file = path.join(repoRoot, relative);
    if (exists(file)) return file;
  }

  throw new Error(
    "bridge target map not found; create docs/local/bridge-targets.json " +
    "from ops/bridge/targets.example.json or set SEAM_BRIDGE_TARGETS_FILE",
  );
}

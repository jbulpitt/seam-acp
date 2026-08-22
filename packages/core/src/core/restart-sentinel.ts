/**
 * PM2 restart is requested by writing DATA_DIR/.restart-pending.
 * `npm run redeploy` writes an empty file → drain in-flight turns, then restart.
 * A file whose trimmed body is `force` skips the drain so SIGTERM hits live
 * ACP processes; turn-resume (#76) continues them after boot.
 */
import fs from "node:fs";
import path from "node:path";

export const RESTART_SENTINEL_NAME = ".restart-pending";
export const RESTART_SENTINEL_FORCE_BODY = "force\n";

export function restartSentinelPath(dataDir: string): string {
  return path.join(dataDir, RESTART_SENTINEL_NAME);
}

export function sentinelIsForce(contents: string): boolean {
  return contents.trim().toLowerCase() === "force";
}

/** Write the force sentinel. Returns the path written. */
export function writeForceRestartSentinel(dataDir: string): string {
  const file = restartSentinelPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, RESTART_SENTINEL_FORCE_BODY, "utf8");
  return file;
}

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

export interface RestartDrainResult {
  drained: boolean;
  activeTurns: number;
}

/**
 * Wait for the restart-drain counter without ever waiting forever. The caller
 * owns what "force" means after a timeout; this helper only reports the final
 * counter snapshot and cleans up both timers on every exit.
 */
export function waitForRestartDrain(
  activeTurns: () => number,
  timeoutMs: number,
  pollMs = 500
): Promise<RestartDrainResult> {
  const initial = activeTurns();
  if (initial === 0) return Promise.resolve({ drained: true, activeTurns: 0 });

  return new Promise((resolve) => {
    let settled = false;
    let poll: ReturnType<typeof setInterval>;
    let timeout: ReturnType<typeof setTimeout>;
    const finish = (drained: boolean) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timeout);
      resolve({ drained, activeTurns: activeTurns() });
    };
    poll = setInterval(() => {
      if (activeTurns() === 0) finish(true);
    }, Math.max(1, pollMs));
    timeout = setTimeout(() => finish(false), Math.max(1, timeoutMs));
  });
}

/** Spawn the same detached PM2 restart for graceful, force, and timed-out drains. */
export async function restartSeamAcpProcess(): Promise<void> {
  const { spawn } = await import("node:child_process");
  const child = spawn("pm2", ["restart", "seam-acp"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

/** Write the force sentinel. Returns the path written. */
export function writeForceRestartSentinel(dataDir: string): string {
  const file = restartSentinelPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, RESTART_SENTINEL_FORCE_BODY, "utf8");
  return file;
}

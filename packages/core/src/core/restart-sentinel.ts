/**
 * A managed-process restart is requested by writing DATA_DIR/.restart-pending.
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

export type ProcessSignaler = (pid: number, signal: NodeJS.Signals) => boolean;

/**
 * End this process after the sentinel drain. The process supervisor owns the
 * restart: PM2 does so during migration, and the production systemd unit uses
 * `Restart=always`. Signalling ourselves keeps redeploy independent of either
 * supervisor and still enters the normal bounded SIGTERM shutdown path.
 *
 * The historical export name remains during the PM2-to-systemd migration so
 * callers do not need a flag-day rename.
 */
export async function restartSeamAcpProcess(
  signalProcess: ProcessSignaler = process.kill.bind(process)
): Promise<void> {
  signalProcess(process.pid, "SIGTERM");
}

/** Write the force sentinel. Returns the path written. */
export function writeForceRestartSentinel(dataDir: string): string {
  const file = restartSentinelPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, RESTART_SENTINEL_FORCE_BODY, "utf8");
  return file;
}

/** Stage a restart without overwriting a request already being drained. */
export function stageRestartSentinel(
  dataDir: string,
  mode: "drain" | "force"
): { path: string; staged: boolean } {
  const file = restartSentinelPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, mode === "force" ? RESTART_SENTINEL_FORCE_BODY : "", {
      encoding: "utf8",
      flag: "wx",
    });
    return { path: file, staged: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return { path: file, staged: false };
    }
    throw err;
  }
}

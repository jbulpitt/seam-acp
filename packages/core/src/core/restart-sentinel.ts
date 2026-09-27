/**
 * A managed-process restart is requested by writing DATA_DIR/.restart-pending.
 * The controller exits promptly; sessiond keeps agent processes alive while
 * the bounded SIGTERM shutdown flushes controller-owned work.
 */
import fs from "node:fs";
import path from "node:path";

export const RESTART_SENTINEL_NAME = ".restart-pending";

export function restartSentinelPath(dataDir: string): string {
  return path.join(dataDir, RESTART_SENTINEL_NAME);
}

export type ProcessSignaler = (pid: number, signal: NodeJS.Signals) => boolean;

/**
 * End this process through the normal bounded SIGTERM shutdown. The process
 * supervisor owns the restart.
 */
export async function restartSeamAcpProcess(
  signalProcess: ProcessSignaler = process.kill.bind(process)
): Promise<void> {
  signalProcess(process.pid, "SIGTERM");
}

/** Write the restart sentinel. Returns the path written. */
export function writeRestartSentinel(dataDir: string): string {
  const file = restartSentinelPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "", "utf8");
  return file;
}

/** Stage a restart without overwriting an existing request. */
export function stageRestartSentinel(dataDir: string): { path: string; staged: boolean } {
  const file = restartSentinelPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, "", {
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

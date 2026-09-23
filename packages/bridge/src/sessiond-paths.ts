import os from "node:os";
import path from "node:path";

export function defaultSessiondPaths(environment: NodeJS.ProcessEnv = process.env): {
  socketPath: string;
  statePath: string;
} {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const runtimeBase = environment.XDG_RUNTIME_DIR || os.tmpdir();
  const runtimeDir = path.join(runtimeBase, `seam-sessiond-${uid}`);
  return {
    socketPath: environment.SEAM_SESSIOND_SOCKET ?? path.join(runtimeDir, "control.sock"),
    statePath: environment.SEAM_SESSIOND_STATE ?? path.join(runtimeDir, "slots.json"),
  };
}

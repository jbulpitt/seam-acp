import path from "node:path";

/** #595: sessiond outlives login sessions by design — that is the whole point
 * of a supervisor that owns agent children across a bridge restart. So its
 * paths must NOT be session-scoped. XDG_RUNTIME_DIR is exactly that: on Linux
 * systemd-logind deletes /run/user/<uid> when the last session ends unless the
 * user lingers, taking the control socket AND slots.json with it. The daemon
 * keeps running and holding its socket fd, so process-level health checks still
 * pass while nothing can reach it and the slot table is gone — silent, which is
 * worse than loud. $HOME matches the daemon's intended lifetime; stale entries
 * after a reboot are already refused by the pid/pgid/start-time identity check.
 *
 * Callers that genuinely want a managed runtime directory (the controller's
 * systemd unit sets RuntimeDirectory=seam-sessiond) pass the paths explicitly
 * via SEAM_SESSIOND_SOCKET / SEAM_SESSIOND_STATE, which still win here. */
export function defaultSessiondPaths(environment: NodeJS.ProcessEnv = process.env): {
  socketPath: string;
  statePath: string;
} {
  const socketOverride = environment.SEAM_SESSIOND_SOCKET;
  const stateOverride = environment.SEAM_SESSIOND_STATE;
  if (socketOverride && stateOverride) {
    return { socketPath: socketOverride, statePath: stateOverride };
  }
  // Refuse loudly rather than fall back to a directory that can vanish under a
  // live daemon. A tmpdir default would reintroduce exactly this bug on any
  // host that reaps /tmp, and would do it silently.
  const home = environment.HOME?.trim();
  if (!home) {
    throw new Error(
      "sessiond: cannot resolve a durable runtime directory — HOME is unset. " +
        "Set HOME, or pass both SEAM_SESSIOND_SOCKET and SEAM_SESSIOND_STATE.",
    );
  }
  const runtimeDir = path.join(home, ".seam", "sessiond");
  return {
    socketPath: socketOverride ?? path.join(runtimeDir, "control.sock"),
    statePath: stateOverride ?? path.join(runtimeDir, "slots.json"),
  };
}

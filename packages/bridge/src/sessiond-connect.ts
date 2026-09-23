import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SessiondClient } from "./sessiond-client.js";
import { defaultSessiondPaths } from "./sessiond-paths.js";

const START_TIMEOUT_MS = 5_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Connect to the descriptor owner, starting it when this user has none yet. */
export async function connectSessiond(): Promise<SessiondClient> {
  const paths = defaultSessiondPaths();
  try {
    return await SessiondClient.connect(paths.socketPath);
  } catch {
    const entrypoint = fileURLToPath(new URL("./sessiond.js", import.meta.url));
    const daemon = spawn(process.execPath, [entrypoint, "--socket", paths.socketPath, "--state", paths.statePath], {
      detached: true,
      stdio: "ignore",
      env: {
        PATH: process.env.PATH ?? "",
        // #595: the daemon resolves its durable runtime directory from HOME.
        // Both paths are passed on argv above, so this is belt-and-braces for
        // anything the daemon later derives from the same base.
        ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
        ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
      },
    });
    // Refuse bridge startup if its one descriptor owner cannot start. The raw
    // error is never logged: it may contain the executable path and argv.
    let launchFailed = false;
    daemon.once("error", () => { launchFailed = true; });
    daemon.unref();
    const deadline = Date.now() + START_TIMEOUT_MS;
    let lastError: unknown;
    while (!launchFailed && Date.now() < deadline) {
      try {
        return await SessiondClient.connect(paths.socketPath, { requestTimeoutMs: 2_000 });
      } catch (error) {
        lastError = error;
        await delay(50);
      }
    }
    throw new Error("seam-sessiond did not become ready", { cause: lastError });
  }
}

#!/usr/bin/env node
import "./load-bridge-config.js";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessiondServer, defaultSessiondResumeDir } from "./sessiond-server.js";
import { defaultSessiondPaths } from "./sessiond-paths.js";
import { readRunningReleaseSha } from "./release-receipt.js";

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

// #595: resolve defaults only for the flags argv did NOT supply. A fully
// specified launch (the controller's systemd unit, and connectSessiond's own
// spawn) must not depend on HOME being present in a deliberately scrubbed env.
const socketArg = valueAfter("--socket");
const stateArg = valueAfter("--state");
const defaults = socketArg && stateArg
  ? { socketPath: socketArg, statePath: stateArg }
  : defaultSessiondPaths();
const socketPath = socketArg ?? defaults.socketPath;
const statePath = stateArg ?? defaults.statePath;

const server = new SessiondServer({
  socketPath,
  statePath,
  resumeDir: valueAfter("--resume-dir") ?? defaultSessiondResumeDir(),
  supervisor: {
    pid: process.pid,
    entrypoint: realpathSync(fileURLToPath(import.meta.url)),
    releaseSha: await readRunningReleaseSha(),
  },
});
await server.start();
console.error(`[seam-sessiond] listening (${path.basename(socketPath)})`);

let stopping = false;
async function stop(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  // Running slots live in their holders and outlast this process (#631).
  console.error(`[seam-sessiond] ${signal}: closing; running slots keep running`);
  try {
    await server.close();
    process.exit(0);
  } catch {
    process.exit(1);
  }
}

process.on("SIGTERM", () => { void stop("SIGTERM"); });
process.on("SIGINT", () => { void stop("SIGINT"); });

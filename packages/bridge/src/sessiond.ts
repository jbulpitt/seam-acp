#!/usr/bin/env node
import path from "node:path";
import { SessiondServer } from "./sessiond-server.js";
import { defaultSessiondPaths } from "./sessiond-paths.js";

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

const defaults = defaultSessiondPaths();
const socketPath = valueAfter("--socket") ?? defaults.socketPath;
const statePath = valueAfter("--state") ?? defaults.statePath;

const server = new SessiondServer({ socketPath, statePath });
await server.start();
console.error(`[seam-sessiond] listening (${path.basename(socketPath)})`);

let stopping = false;
async function stop(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.error(`[seam-sessiond] ${signal}: terminating owned children and closing`);
  try {
    await server.close({ terminateChildren: true });
    process.exit(0);
  } catch {
    process.exit(1);
  }
}

process.on("SIGTERM", () => { void stop("SIGTERM"); });
process.on("SIGINT", () => { void stop("SIGINT"); });

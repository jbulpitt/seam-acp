#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { SessiondServer } from "./sessiond-server.js";

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

const uid = typeof process.getuid === "function" ? process.getuid() : 0;
const runtimeBase = process.env.XDG_RUNTIME_DIR || os.tmpdir();
const runtimeDir = path.join(runtimeBase, `seam-sessiond-${uid}`);
const socketPath = valueAfter("--socket") ?? process.env.SEAM_SESSIOND_SOCKET ?? path.join(runtimeDir, "control.sock");
const statePath = valueAfter("--state") ?? process.env.SEAM_SESSIOND_STATE ?? path.join(runtimeDir, "slots.json");

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

#!/usr/bin/env node
// Starts the bridge in config-file mode (#618): every setting, including the
// token, comes from ~/.config/seam/bridge.env, which the bridge reads itself.
// systemd hosts run this file so the rollout tool has a stable launcher path.
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const entrypoint = path.join(os.homedir(), ".seam/seam-acp/packages/bridge/dist/index.js");
process.argv = [process.execPath, entrypoint, "connect"];
await import(pathToFileURL(entrypoint).href);

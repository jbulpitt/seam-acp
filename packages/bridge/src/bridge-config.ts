import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";

/**
 * The bridge's own configuration file (#618): the one place a host's bridge
 * settings live, whatever supervises it. Values in the file replace the same
 * keys in the process environment, because pm2 replays a captured environment
 * on every restart and cannot unset a key — a removed agy pin kept coming back
 * that way on rhc-server.
 */
export function bridgeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME?.trim() || path.join(env.HOME?.trim() || os.homedir(), ".config");
  return path.join(base, "seam", "bridge.env");
}

export type BridgeConfigLoad =
  | { path: string; status: "loaded"; keys: string[] }
  | { path: string; status: "absent" }
  | { path: string; status: "unreadable"; reason: string };

export function loadBridgeConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfigLoad {
  const file = bridgeConfigPath(env);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? { path: file, status: "absent" }
      : { path: file, status: "unreadable", reason: code ?? "read failed" };
  }
  const values = parseEnv(text) as Record<string, string>;
  for (const [key, value] of Object.entries(values)) env[key] = value;
  return { path: file, status: "loaded", keys: Object.keys(values).sort() };
}

/** One startup line. Key names only: the file holds the bridge token. */
export function describeBridgeConfig(result: BridgeConfigLoad): string {
  if (result.status === "loaded") {
    return `[bridge] config: ${result.path} set ${result.keys.length} keys: ${result.keys.join(", ")}`;
  }
  if (result.status === "absent") {
    return `[bridge] config: ${result.path} not found; using the supervisor's environment`;
  }
  return `[bridge] config: ${result.path} unreadable (${result.reason}); using the supervisor's environment`;
}

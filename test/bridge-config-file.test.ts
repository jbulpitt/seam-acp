/**
 * #618 — a bridge host's settings live in one file the bridge reads itself.
 * On rhc-server the config was split between a pm2 dump and an ecosystem file,
 * so an unpin rebuilt from the dump silently dropped grok and two MCP secrets.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { bridgeConfigPath, describeBridgeConfig, loadBridgeConfig } from "../packages/bridge/src/bridge-config.js";
import { SessiondServer } from "../packages/bridge/src/sessiond-server.js";

const bridgeSource = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers/bridge-source.mjs");
const roots: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function configHome(contents?: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "seam-618-"));
  roots.push(root);
  await fs.chmod(root, 0o700);
  if (contents !== undefined) {
    await fs.mkdir(path.join(root, "seam"), { recursive: true });
    await fs.writeFile(path.join(root, "seam", "bridge.env"), contents, { mode: 0o600 });
  }
  return root;
}

describe("#618 bridge config file loader", () => {
  it("replaces supervisor-provided keys and reports key names, never values", async () => {
    const home = await configHome("AGY_PIN=unpinned\nGROK_CLI_PATH=/opt/grok\nSEAM_BRIDGE_TOKEN=\"s3cret value\"\n");
    const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: home, AGY_PIN: "stale", KEEP: "supervisor" };
    const result = loadBridgeConfig(env);
    expect(result).toEqual({
      path: path.join(home, "seam", "bridge.env"),
      status: "loaded",
      keys: ["AGY_PIN", "GROK_CLI_PATH", "SEAM_BRIDGE_TOKEN"],
    });
    expect(env).toMatchObject({ AGY_PIN: "unpinned", GROK_CLI_PATH: "/opt/grok", SEAM_BRIDGE_TOKEN: "s3cret value", KEEP: "supervisor" });
    const line = describeBridgeConfig(result);
    expect(line).toBe(`[bridge] config: ${result.path} set 3 keys: AGY_PIN, GROK_CLI_PATH, SEAM_BRIDGE_TOKEN`);
    expect(line).not.toContain("s3cret");
  });

  it("runs on the supervisor's environment when the file is absent or unreadable, and says so", async () => {
    const absent = await configHome();
    const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: absent, AGY_PIN: "supervisor" };
    const missing = loadBridgeConfig(env);
    expect(describeBridgeConfig(missing)).toBe(
      `[bridge] config: ${path.join(absent, "seam", "bridge.env")} not found; using the supervisor's environment`,
    );
    expect(env.AGY_PIN).toBe("supervisor");

    const locked = await configHome("AGY_PIN=unpinned\n");
    await fs.chmod(path.join(locked, "seam", "bridge.env"), 0o000);
    const refused = loadBridgeConfig({ XDG_CONFIG_HOME: locked });
    expect(refused).toMatchObject({ status: "unreadable", reason: "EACCES" });
    expect(describeBridgeConfig(refused)).toContain("unreadable (EACCES); using the supervisor's environment");
  });

  it("defaults to ~/.config/seam/bridge.env", () => {
    expect(bridgeConfigPath({ HOME: "/home/someone" })).toBe("/home/someone/.config/seam/bridge.env");
  });
});

describe("#618 bridge started with only `connect`", () => {
  it("connects with the server, id and token from the config file", async () => {
    const root = await configHome();
    const sessiond = new SessiondServer({ socketPath: path.join(root, "sd.sock"), statePath: path.join(root, "slots.json") });
    await sessiond.start();
    cleanups.push(() => sessiond.close({ terminateChildren: true }));

    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    const connected = new Promise<{ authorization?: string; hello: Record<string, unknown> }>((resolve) => {
      server.on("connection", (socket, request) => {
        socket.once("message", (raw) => resolve({ authorization: request.headers.authorization, hello: JSON.parse(String(raw)) }));
      });
    });

    await fs.mkdir(path.join(root, "seam"), { recursive: true });
    await fs.writeFile(path.join(root, "seam", "bridge.env"), [
      `SEAM_BRIDGE_SERVER=ws://127.0.0.1:${port}/bridge`,
      "SEAM_BRIDGE_ID=config-host",
      "SEAM_BRIDGE_TOKEN=file-token",
      `SEAM_BRIDGE_CWD=${root}`,
    ].join("\n"), { mode: 0o600 });

    let stderr = "";
    const bridge: ChildProcess = spawn(process.execPath, [bridgeSource, "connect"], {
      cwd: root,
      env: {
        HOME: root,
        XDG_CONFIG_HOME: root,
        PATH: path.dirname(process.execPath),
        SEAM_SESSIOND_SOCKET: path.join(root, "sd.sock"),
        SEAM_SESSIOND_STATE: path.join(root, "slots.json"),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    bridge.stderr!.on("data", (chunk) => { stderr += String(chunk); });
    cleanups.push(() => { bridge.kill("SIGKILL"); });

    const { authorization, hello } = await connected;
    expect(authorization).toBe("Bearer file-token");
    expect(hello).toMatchObject({ type: "hello", bridgeId: "config-host" });
    expect(stderr).toContain(`[bridge] config: ${path.join(root, "seam", "bridge.env")} set 4 keys: SEAM_BRIDGE_CWD, SEAM_BRIDGE_ID, SEAM_BRIDGE_SERVER, SEAM_BRIDGE_TOKEN`);
    expect(stderr).not.toContain("file-token");
  }, 30_000);
});

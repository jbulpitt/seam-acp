import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessiondClient } from "../packages/bridge/src/sessiond-client.js";
import { SessiondServer } from "../packages/bridge/src/sessiond-server.js";

const fixtures: Array<{ root: string; daemon: ChildProcess; socketPath: string; statePath: string }> = [];

async function launch(configured: boolean) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "seam-sessiond-runtime-"));
  const socketPath = path.join(root, "control.sock");
  const statePath = path.join(root, "slots.json");
  const config = path.join(root, "bridge.env");
  await fs.writeFile(config, `SEAM_SESSIOND_SOCKET=${socketPath}\nSEAM_SESSIOND_STATE=${statePath}\n`);
  const entrypoint = path.resolve("packages/bridge/src/sessiond.ts");
  const daemon = spawn(process.execPath, [
    "--import", "tsx", entrypoint,
    ...configured ? [] : ["--socket", socketPath, "--state", statePath],
    "--resume-dir", path.join(root, "resume"),
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, ".config"),
      SEAM_BRIDGE_CONFIG_PATH: config, SEAM_SESSIOND_SOCKET: "", SEAM_SESSIOND_STATE: "",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  fixtures.push({ root, daemon, socketPath, statePath });
  let stderr = "";
  daemon.stderr?.on("data", chunk => { stderr += chunk.toString(); });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const client = await SessiondClient.connect(socketPath, { requestTimeoutMs: 2_000 });
      return { client, daemon, root, statePath, entrypoint };
    } catch {
      if (daemon.exitCode !== null) throw new Error(`sessiond exited: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  throw new Error(`sessiond did not open the configured socket: ${stderr}`);
}

afterEach(async () => {
  for (const { root, daemon, socketPath, statePath } of fixtures.splice(0)) {
    if (daemon.exitCode === null && daemon.signalCode === null) {
      const exited = new Promise(resolve => daemon.once("exit", resolve));
      daemon.kill("SIGTERM");
      await exited;
    }
    const cleanup = new SessiondServer({ socketPath, statePath, resumeDir: path.join(root, "resume") });
    try { await cleanup.start(); }
    finally { await cleanup.close({ terminateChildren: true }); }
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("sessiond rollout identity and shared configuration", () => {
  it("reports the daemon process and running entrypoint through listSlots", async () => {
    const { client, daemon, entrypoint } = await launch(false);
    try {
      expect(await client.listSlots()).toMatchObject({
        supervisor: { pid: daemon.pid, entrypoint, releaseSha: null },
      });
    } finally { client.close(); }
  });

  it("reads the bridge.env socket and state paths instead of another supervisor config", async () => {
    const { client, root, statePath } = await launch(true);
    try {
      await client.spawn({
        slot: 1, executable: process.execPath,
        args: ["-e", "process.stdin.resume(); setInterval(() => {}, 1000)"],
        cwd: root, env: {},
      });
      expect(JSON.parse(await fs.readFile(statePath, "utf8")).slots).toHaveLength(1);
    } finally { client.close(); }
  });
});

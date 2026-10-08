import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

it("the portable launcher execs the active daemon with bridge.env and no extra parent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "seam-sessiond-launcher-"));
  roots.push(root);
  const active = path.join(root, "release/packages/bridge/dist");
  const stable = path.join(root, ".seam/seam-acp/packages/bridge/dist");
  const config = path.join(root, "bridge.env");
  const node = path.join(root, "configured-node");
  await fs.link(process.execPath, node);
  await fs.mkdir(active, { recursive: true });
  await fs.mkdir(stable, { recursive: true });
  await fs.writeFile(path.join(root, "release/package.json"), '{"type":"module"}');
  await fs.writeFile(path.join(active, "index.js"), "export {};\n");
  await fs.symlink(path.join(active, "index.js"), path.join(stable, "index.js"));
  const loader = pathToFileURL(path.resolve("packages/bridge/src/load-bridge-config.ts")).href;
  await fs.writeFile(path.join(active, "load-bridge-config.js"), `await import(${JSON.stringify(loader)});`);
  await fs.writeFile(path.join(active, "sessiond.js"), `
    console.log(JSON.stringify({ pid: process.pid, argv: process.argv, socket: process.env.SEAM_SESSIOND_SOCKET, state: process.env.SEAM_SESSIOND_STATE, resume: process.env.SEAM_SESSIOND_RESUME_DIR }));
  `);
  await fs.writeFile(config, [
    `SEAM_NODE=${node}`, `SEAM_SESSIOND_SOCKET=${root}/configured.sock`,
    `SEAM_SESSIOND_STATE=${root}/configured.json`, `SEAM_SESSIOND_RESUME_DIR=${root}/resume`,
  ].join("\n"));
  const child = spawn("bash", [path.resolve("ops/bridge/seam-sessiond-launch.sh")], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: root, SEAM_NODE: process.execPath, SEAM_BRIDGE_CONFIG_PATH: config, NODE_OPTIONS: "--import tsx" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk.toString(); });
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject); child.once("close", resolve);
  });
  expect(code, stderr).toBe(0);
  expect(JSON.parse(stdout)).toEqual({
    pid: child.pid, argv: [node, path.join(active, "sessiond.js")],
    socket: `${root}/configured.sock`, state: `${root}/configured.json`, resume: `${root}/resume`,
  });
}, 15_000);

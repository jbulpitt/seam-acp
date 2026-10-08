import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SessiondClient } from "../../packages/bridge/src/sessiond-client.js";
import { SessiondServer } from "../../packages/bridge/src/sessiond-server.js";

const daemons: Array<{ pidFile: string; socketPath: string; statePath: string; resumeDir: string }> = [];

export async function prepareRolloutSessiond(root: string, entry: string, node: string) {
  const pidFile = path.join(root, "sessiond.pid");
  const socketPath = path.join(root, "sd/control.sock");
  const statePath = path.join(root, "sd/slots.json");
  const resumeDir = path.join(root, "resume");
  const configPath = path.join(root, "bridge.env");
  const tsx = pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href;
  const server = pathToFileURL(path.resolve("packages/bridge/src/sessiond-server.ts")).href;
  const holder = path.resolve("test/helpers/slot-holder-source.mjs");
  await fs.writeFile(configPath, `SEAM_SESSIOND_SOCKET=${socketPath}\nSEAM_SESSIOND_STATE=${statePath}\n`);
  const source = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { spawn } from 'node:child_process';
    import { fileURLToPath } from 'node:url';
    import { SessiondServer } from ${JSON.stringify(server)};
    const pidFile = ${JSON.stringify(pidFile)}, entry = ${JSON.stringify(entry)}, node = ${JSON.stringify(node)};
    const here = fileURLToPath(import.meta.url), release = path.resolve(here, '../../../..');
    const receipt = path.join(release, 'release-receipt.json');
    const daemon = new SessiondServer({
      socketPath: ${JSON.stringify(socketPath)}, statePath: ${JSON.stringify(statePath)}, resumeDir: ${JSON.stringify(resumeDir)},
      holderPath: ${JSON.stringify(holder)},
      supervisor: { pid: process.pid, entrypoint: here, releaseSha: fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt)).sourceSha : null },
    });
    fs.writeFileSync(pidFile, String(process.pid));
    await daemon.start();
    process.on('SIGTERM', async () => {
      await daemon.close();
      const next = path.join(path.dirname(fs.realpathSync(entry)), 'sessiond.js');
      const child = spawn(node, ['--import', ${JSON.stringify(tsx)}, next], { cwd: ${JSON.stringify(root)}, env: { ...process.env, HOME: ${JSON.stringify(root)} }, detached: true, stdio: 'ignore' });
      child.unref(); fs.writeFileSync(pidFile, String(child.pid)); process.exit(0);
    });
  `;
  const pm2Describe = `if (_n === 'seam-sessiond') {
    const pid = Number(fs.readFileSync(${JSON.stringify(pidFile)}, 'utf8'));
    setImmediate(() => cb(null, [{ pid, pm2_env: { name: 'seam-sessiond', treekill: false } }])); return;
  }`;
  await fs.writeFile(path.join(path.dirname(entry), "sessiond.js"), source);
  await fs.writeFile(path.join(path.dirname(entry), "package.json"), '{"type":"module"}');
  daemons.push({ pidFile, socketPath, statePath, resumeDir });
  const child = spawn(node, ["--import", tsx, path.join(path.dirname(entry), "sessiond.js")], {
    cwd: process.cwd(), env: { ...process.env, HOME: root }, detached: true, stdio: "ignore",
  });
  child.unref();
  await fs.writeFile(pidFile, String(child.pid));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { const client = await SessiondClient.connect(socketPath); client.close(); return { source, pm2Describe, configPath, socketPath, statePath, pidFile }; }
    catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  throw new Error("rollout fixture daemon did not start");
}

export async function cleanupRolloutDaemons() {
  for (const fixture of daemons.splice(0)) {
    const pid = Number(await fs.readFile(fixture.pidFile, "utf8"));
    try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); }
      catch { break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const server = new SessiondServer({ ...fixture, resumeDir: fixture.resumeDir });
    try { await server.start(); }
    finally { await server.close({ terminateChildren: true }); }
  }
}

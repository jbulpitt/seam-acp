import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "tsx/esm/api";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
register({ tsconfig: path.join(repo, "tsconfig.json") });
const { SessiondServer } = await import(path.join(repo, "packages/bridge/src/sessiond-server.ts"));
const { SessiondClient } = await import(path.join(repo, "packages/bridge/src/sessiond-client.ts"));
const root = process.argv[2];
const scope = path.join(root, "holder-owner");
await fs.mkdir(scope);
await fs.writeFile(path.join(scope, "owner.json"), JSON.stringify({ pid: process.pid }));
const holderPath = path.join(scope, "slot-holder-source.mjs");
await fs.writeFile(holderPath, `import ${JSON.stringify(pathToFileURL(path.join(repo, "test/helpers/slot-holder-source.mjs")).href)};\n`);
process.env.SEAM_SLOT_HOLDER_PATH = holderPath;
const server = new SessiondServer({ socketPath: path.join(root, "control.sock"),
  statePath: path.join(root, "slots.json"), resumeDir: path.join(root, "resume") });
await server.start();
const client = await SessiondClient.connect(path.join(root, "control.sock"));
const { pid } = await client.spawn({ slot: 884, executable: process.execPath,
  args: ["-e", "process.on('SIGTERM', () => {}); process.stdin.resume(); setInterval(() => {}, 1000)"],
  cwd: root, env: {} });
const state = JSON.parse(await fs.readFile(path.join(root, "slots.json"), "utf8"));
process.send({ type: "ready", childPid: pid, holder: state.slots[0] });
process.on("message", async mode => {
  if (mode === "throw") {
    throw new Error("fixture body threw before its finally");
  }
  if (mode === "teardown") {
    await fs.unlink(path.join(scope, "owner.json"));
    process.send({ type: "released" });
  }
  if (mode === "signal") {
    process.kill(-state.slots[0].identity.pgid, "SIGTERM");
    process.send({ type: "signalled" });
  }
});

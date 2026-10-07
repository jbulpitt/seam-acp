import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(import.meta.url);
const root = process.env.SEAM_NATIVE_TREE_FIXTURE;
if (!root) throw new Error("native-tree fixture root is required");

if (process.argv.includes("--native")) {
  const tool = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  tool.once("spawn", () => {
    writeFileSync(path.join(root, `${process.env.SEAM_NATIVE_TREE_SLOT}.json`), JSON.stringify({
      wrapper: process.ppid, native: process.pid, tool: tool.pid,
    }));
  });
  setInterval(() => {}, 1000);
} else {
  const input = readline.createInterface({ input: process.stdin });
  const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  input.on("line", (line) => {
    const request = JSON.parse(line);
    if (request.method === "initialize") reply(request.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
    else if (request.method === "session/new" || request.method === "session/load") {
      reply(request.id, { sessionId: "native-tree-session" });
    } else if (request.method === "session/prompt") {
      // Same detached-wrapper/native/tool topology as the observed Claude run.
      spawn(process.execPath, [source, "--native"], { env: process.env, stdio: "ignore" });
    }
  });
}

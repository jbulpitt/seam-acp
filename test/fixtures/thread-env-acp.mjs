#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { execFileSync } from "node:child_process";

if (process.argv.includes("--version")) { console.log("thread-env-fixture 1.0"); process.exit(0); }
const keys = ["SEAM_THREAD_ID", "SEAM_CHANNEL_ID", "SEAM_AGENT_ID"];
const identity = () => Object.fromEntries(keys.map(key => [key, process.env[key] ?? null]));
const script = `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(k=>[k,process.env[k]??null]))))`;
const receipt = method => {
  const grandchild = JSON.parse(execFileSync("/bin/sh", ["-c", 'exec "$1" -e "$2"', "thread-env", process.execPath, script], { encoding: "utf8" }));
  const value = { pid: process.pid, method, identity: identity(), grandchild,
    resumeFile: Boolean(process.env.SEAM_SESSIOND_RESUME_FILE), bridgeId: process.env.SEAM_BRIDGE_ID,
    bridgeTokenUnchanged: process.env.SEAM_BRIDGE_TOKEN === "fixture-token" };
  fs.appendFileSync(path.join(process.cwd(), "env-receipts.jsonl"), `${JSON.stringify(value)}\n`);
  return value;
};
const send = value => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  else if (message.method === "session/new" || message.method === "session/load") {
    receipt(message.method);
    send({ id: message.id, result: { sessionId: "env-session" } });
  } else if (message.method === "session/prompt") {
    const value = receipt(message.method);
    send({ method: "session/update", params: { sessionId: message.params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(value) } } } });
    if (!message.params.prompt.some(p => p.text === "hold")) send({ id: message.id, result: { stopReason: "end_turn" } });
  }
});

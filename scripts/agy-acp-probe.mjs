#!/usr/bin/env node
/**
 * End-to-end smoke test for packages/adapters/src/profiles/agy.ts.
 *
 * Drives the fake-ChildProcess returned by `makeAgyProfile().spawn()` with a
 * real `ClientSideConnection`, the same way `AgentRuntime` does. Prints each
 * ACP `sessionUpdate` it receives so we can confirm the streaming → ACP
 * translation works before wiring this into the Discord orchestrator.
 *
 *   node scripts/agy-acp-probe.mjs "your prompt"
 */
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const { makeAgyProfile } = await import(
  pathToFileURL(path.join(repoRoot, "packages/adapters/src/profiles/agy.ts")).href
);
const acp = await import("@agentclientprotocol/sdk");

const prompt = process.argv.slice(2).join(" ").trim() ||
  "view /etc/hostname, then run uname -a via bash. Announce each step.";

const profile = makeAgyProfile({});
const proc = profile.spawn();

const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(2).padStart(6);

proc.on("exit", (code) => console.log(`[${ts()}s] agy process exited code=${code}`));
proc.on("error", (e) => console.log(`[${ts()}s] agy process error`, e.message));

// ClientSideConnection talks to the agent over the pipe.
const stream = acp.ndJsonStream(
  Writable.toWeb(proc.stdin),
  Readable.toWeb(proc.stdout),
);

const client = {
  async sessionUpdate(params) {
    const u = params.update;
    const tag = u.sessionUpdate;
    if (tag === "agent_message_chunk" || tag === "agent_thought_chunk" || tag === "user_message_chunk") {
      const text = u.content?.text ?? "";
      const label = tag === "agent_thought_chunk" ? "thought" : tag === "agent_message_chunk" ? "agent " : "user  ";
      console.log(`[${ts()}s] ${label} +${text.length}ch: ${JSON.stringify(text).slice(0, 100)}`);
    } else if (tag === "tool_call") {
      console.log(`[${ts()}s] tool  start id=${u.toolCallId} title=${u.title} status=${u.status}`);
    } else if (tag === "tool_call_update") {
      console.log(`[${ts()}s] tool  update id=${u.toolCallId} status=${u.status}`);
    } else {
      console.log(`[${ts()}s] update ${tag}`, JSON.stringify(u).slice(0, 200));
    }
  },
  async requestPermission() { return { outcome: { outcome: "selected", optionId: "allow_once" } }; },
};

const conn = new acp.ClientSideConnection(() => client, stream);

try {
  console.log(`[${ts()}s] initialize`);
  const init = await conn.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  console.log(`[${ts()}s] initialized: protocolVersion=${init.protocolVersion}`);

  console.log(`[${ts()}s] newSession`);
  const ns = await conn.newSession({ cwd: process.cwd(), mcpServers: [] });
  console.log(`[${ts()}s] session=${ns.sessionId}`);

  console.log(`[${ts()}s] prompt: ${prompt}`);
  const result = await conn.prompt({
    sessionId: ns.sessionId,
    prompt: [{ type: "text", text: prompt }],
  });
  console.log(`[${ts()}s] prompt done stopReason=${result.stopReason}`);
} catch (e) {
  console.error(`[${ts()}s] error:`, e.message ?? e);
} finally {
  proc.kill();
}

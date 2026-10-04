#!/usr/bin/env node
// A minimal ACP agent for restart tests. "long job" never finishes; any
// prompt containing "continue" finishes with "resumed ok". Its pid goes to
// $FAKE_AGENT_PIDS so a test can kill it like a host shutdown would.
import fs from "node:fs";
if (process.env.FAKE_AGENT_PIDS) fs.appendFileSync(process.env.FAKE_AGENT_PIDS, `${process.pid}\n`);
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
let buffer = "";
let currentModeId = "agent";
const modes = () => process.env.FAKE_AGENT_REQUIRE_MODE ? { modes: { currentModeId, availableModes: [
  { id: "agent", name: "Auto review" }, { id: "agent-full-access", name: "Full access" },
] } } : {};
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    const update = (text) => send({ method: "session/update", params: { sessionId: message.params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
    if (message.method === "initialize") {
      send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    } else if (message.method === "session/new") {
      currentModeId = "agent";
      send({ id: message.id, result: { sessionId: "s1", ...modes() } });
    } else if (message.method === "session/load") {
      currentModeId = "agent";
      update("replayed history");
      send({ id: message.id, result: modes() });
    } else if (message.method === "session/set_mode") {
      currentModeId = message.params.modeId;
      send({ id: message.id, result: {} });
    } else if (message.method === "session/prompt") {
      const text = message.params.prompt.map((part) => part.text ?? "").join("");
      if (text.includes("continue")) {
        if (process.env.FAKE_AGENT_REQUIRE_MODE && currentModeId !== process.env.FAKE_AGENT_REQUIRE_MODE) {
          send({ id: message.id, error: { code: -32000, message: "Codex mode lost on resume" } });
          continue;
        }
        update("resumed ok");
        send({ id: message.id, result: { stopReason: "end_turn" } });
      } else {
        update("working on it");
      }
    }
  }
});
setInterval(() => {}, 1000);

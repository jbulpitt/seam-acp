#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const send = frame => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
let prompt;
let sessionId;
let mode = "agent";
const modes = () => ({ currentModeId: mode, availableModes: [
  { id: "agent", name: "Agent" }, { id: "agent-full-access", name: "Full access" },
] });
for await (const line of readline.createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  fs.appendFileSync(process.env.FAKE_AGENT_REQUESTS, `${JSON.stringify({ pid: process.pid, ...frame })}\n`);
  if (frame.method === "initialize") send({ id: frame.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  else if (frame.method === "session/new" || frame.method === "session/load") {
    sessionId = frame.params.sessionId ?? `isolated-${process.pid}`;
    send({ id: frame.id, result: { sessionId, modes: modes() } });
  } else if (frame.method === "session/set_mode") {
    mode = frame.params.modeId;
    send({ id: frame.id, result: {} });
  } else if (frame.method === "session/set_config_option") {
    send({ id: frame.id, result: { configOptions: [] } });
  } else if (frame.method === "session/prompt") {
    prompt = frame.id;
    const text = frame.params.prompt.map(part => part.text ?? "").join("");
    if (text === "parallel live turn") continue;
    send({ method: "session/update", params: { sessionId, update: {
      sessionUpdate: "tool_call", toolCallId: "isolated-tool", title: "Read snapshots", kind: "execute", status: "pending",
    } } });
    send({ id: "isolated-permission", method: "session/request_permission", params: {
      sessionId, toolCall: { toolCallId: "isolated-tool", title: "Read snapshots", kind: "execute" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }],
    } });
  } else if (frame.id === "isolated-permission" && frame.result) {
    send({ method: "session/update", params: { sessionId, update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: "isolated finished once" },
    } } });
    send({ id: prompt, result: { stopReason: "end_turn" } });
  }
}

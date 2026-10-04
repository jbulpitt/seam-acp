#!/usr/bin/env node
import readline from "node:readline";
const send = frame => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
let prompt;
let calls = 0;
for await (const line of readline.createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.method === "initialize") send({ id: frame.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  else if (frame.method === "session/new") send({ id: frame.id, result: { sessionId: "retained-session" } });
  else if (frame.method === "session/prompt") {
    prompt = frame.id;
    calls += 1;
    send({ id: "original-request", method: "session/request_permission", params: {
      sessionId: "retained-session", toolCall: { toolCallId: `tool-${calls}`, title: "echo retained", kind: "execute" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }],
    } });
  } else if (frame.id === "original-request") {
    send({ method: "session/update", params: { sessionId: "retained-session", update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(frame.result) },
    } } });
    send({ id: prompt, result: { stopReason: "end_turn" } });
  }
}

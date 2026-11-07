import readline from "node:readline";
import { appendFileSync } from "node:fs";

const write = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const sessions = new Map();
let next = 0;
function options(session) {
  const model = {
    id: "model", name: "Model", category: "model", type: "select",
    currentValue: session.model,
    options: [{ value: "fixture-flash", name: "Fixture Flash" }, { value: "fixture-deep", name: "Fixture Deep" }, { value: "fixture-fixed", name: "Fixture Fixed" }],
  };
  if (session.model === "fixture-fixed") return [model];
  return [model, {
    id: "thought_level", name: "Thinking", type: "select", currentValue: session.effort,
    options: (session.model === "fixture-deep" ? ["high", "extra", "max"] : ["low", "medium", "high"])
      .map(value => ({ value, name: value })),
  }];
}
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (process.env.AGY_ACP_TEST_REQUESTS) appendFileSync(process.env.AGY_ACP_TEST_REQUESTS, line + "\n");
  const { id, method, params } = message;
  let result = {};
  if (method === "initialize") {
    result = { protocolVersion: 1, agentInfo: { name: "Fixture AGY", version: "fixture-1" },
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true } } };
  } else if (method === "session/new") {
    if (process.env.AGY_ACP_TEST_NEW_ERROR) {
      write({ jsonrpc: "2.0", id, error: JSON.parse(process.env.AGY_ACP_TEST_NEW_ERROR) }); continue;
    }
    const sessionId = "fixture-" + ++next;
    const session = { model: "fixture-flash", effort: "medium" }; sessions.set(sessionId, session);
    result = { sessionId, configOptions: options(session) };
  } else if (method === "session/load") {
    const session = { model: "fixture-flash", effort: "medium" }; sessions.set(params.sessionId, session);
    result = { configOptions: options(session) };
  } else if (method === "session/set_config_option") {
    const session = sessions.get(params.sessionId);
    if (params.configId === "model") {
      if (!["fixture-flash", "fixture-deep", "fixture-fixed"].includes(params.value)) {
        write({ jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown fixture model" } }); continue;
      }
      session.model = params.value;
      if (session.model === "fixture-deep") session.effort = "high";
    } else session.effort = params.value;
    result = { configOptions: options(session) };
  } else if (method === "session/prompt") {
    for (const update of [
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Fixture reasoning α" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fixture response" } },
      { sessionUpdate: "usage_update", used: 1234, size: 32768 },
    ]) write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId, update } });
    result = { stopReason: "end_turn", usage: { inputTokens: 17, outputTokens: 5, totalTokens: 22 } };
  } else if (method === "session/close") sessions.delete(params.sessionId);
  if (id !== undefined) write({ jsonrpc: "2.0", id, result });
}

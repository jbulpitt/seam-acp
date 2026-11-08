import readline from "node:readline";
import { appendFileSync, readFileSync } from "node:fs";

const write = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const lifecycle = (event) => {
  if (!process.env.AGY_ACP_TEST_LIFECYCLE) return;
  appendFileSync(process.env.AGY_ACP_TEST_LIFECYCLE, JSON.stringify({ event, pid: process.pid,
    start: process.platform === "linux" ? readFileSync(`/proc/${process.pid}/stat`, "utf8").split(")").at(-1).trim().split(/\s+/)[19] : undefined }) + "\n");
};
lifecycle("start");
process.stdin.on("end", () => lifecycle("eof"));
process.on("exit", () => lifecycle("exit"));
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
    if (process.env.AGY_ACP_TEST_INIT_ERROR) {
      write({ jsonrpc: "2.0", id, error: JSON.parse(process.env.AGY_ACP_TEST_INIT_ERROR) }); continue;
    }
    result = { protocolVersion: 1, agentInfo: { name: "Fixture AGY", version: "fixture-1" },
      agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} },
        promptCapabilities: { image: true, embeddedContext: true } } };
  } else if (method === "session/new") {
    if (process.env.AGY_ACP_TEST_NEW_ERROR) {
      write({ jsonrpc: "2.0", id, error: JSON.parse(process.env.AGY_ACP_TEST_NEW_ERROR) }); continue;
    }
    const sessionId = "fixture-" + ++next;
    const session = { model: "fixture-flash", effort: "medium" }; sessions.set(sessionId, session);
    result = { sessionId, configOptions: options(session) };
  } else if (method === "session/load") {
    if (process.env.AGY_ACP_TEST_TRANSCRIPT) {
      const replay = [
        ["user_message_chunk", "Question 🧪\n", "u1"],
        ["user_message_chunk", "line", "u1"],
        ["agent_thought_chunk", "not transcript", "thought"],
        ["agent_message_chunk", "Answer α", "a1"],
        ["agent_message_chunk", "β", "a1"],
        ["agent_message_chunk", "Separate assistant", "a2"],
        ["user_message_chunk", "Next"],
        ["agent_message_chunk", "Done"],
      ];
      for (const [sessionUpdate, text, messageId] of replay) {
        const bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
          sessionId: params.sessionId, update: { sessionUpdate, content: { type: "text", text }, messageId },
        } }) + "\n");
        const at = bytes.indexOf(Buffer.from("🧪"));
        process.stdout.write(bytes.subarray(0, at < 0 ? 17 : at + 1));
        await new Promise(resolve => setImmediate(resolve));
        process.stdout.write(bytes.subarray(at < 0 ? 17 : at + 1));
      }
      for (const notification of [
        { sessionId: "wrong-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "wrong SID" } } },
        { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "AA==", mimeType: "image/png" } } },
        { sessionId: params.sessionId, update: { sessionUpdate: "usage_update", used: 12, size: 200 } },
        { sessionId: params.sessionId, update: { sessionUpdate: "tool_call", toolCallId: "fixture-tool", title: "not transcript", status: "completed" } },
      ]) write({ jsonrpc: "2.0", method: "session/update", params: notification });
    }
    if (process.env.AGY_ACP_TEST_LOAD_OVERFLOW) process.stdout.write("x".repeat(1_000_100));
    if (process.env.AGY_ACP_TEST_LOAD_HANG) continue;
    if (process.env.AGY_ACP_TEST_LOAD_ERROR) {
      write({ jsonrpc: "2.0", id, error: JSON.parse(process.env.AGY_ACP_TEST_LOAD_ERROR) }); continue;
    }
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
  } else if (method === "session/close") {
    lifecycle("close");
    if (process.env.AGY_ACP_TEST_CLOSE_ERROR) {
      write({ jsonrpc: "2.0", id, error: JSON.parse(process.env.AGY_ACP_TEST_CLOSE_ERROR) }); continue;
    }
    sessions.delete(params.sessionId);
  }
  if (id !== undefined) write({ jsonrpc: "2.0", id, result });
}

#!/usr/bin/env node
// A minimal ACP agent for restart tests. "long job" never finishes; any
// prompt containing "continue" finishes with "resumed ok". Its pid goes to
// $FAKE_AGENT_PIDS so a test can kill it like a host shutdown would.
import fs from "node:fs";
if (process.env.FAKE_AGENT_PIDS) fs.appendFileSync(process.env.FAKE_AGENT_PIDS, `${process.pid}\n`);
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
let buffer = "";
let clientReply;
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
    if (message.method && process.env.FAKE_AGENT_REQUESTS) {
      fs.appendFileSync(process.env.FAKE_AGENT_REQUESTS, `${JSON.stringify({ pid: process.pid, method: message.method, params: message.params })}\n`);
    }
    if (message.id === "fixture-client-reply" && "result" in message && clientReply) {
      clientReply(); clientReply = undefined; continue;
    }
    const update = (text) => send({ method: "session/update", params: { sessionId: message.params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
    if (message.method === "initialize") {
      send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    } else if (message.method === "session/new") {
      currentModeId = "agent";
      const reply = () => send({ id: message.id, result: { sessionId: process.env.FAKE_AGENT_NEW_SESSION_ID ?? "s1", ...modes() } });
      if (process.env.FAKE_AGENT_NEW_GATE && !fs.existsSync(process.env.FAKE_AGENT_NEW_GATE)) {
        const timer = setInterval(() => {
          if (fs.existsSync(process.env.FAKE_AGENT_NEW_GATE)) { clearInterval(timer); reply(); }
        }, 20);
      } else reply();
    } else if (message.method === "session/load") {
      if (process.env.FAKE_AGENT_WRITER_LOCK) {
        let writer;
        try { writer = JSON.parse(fs.readFileSync(process.env.FAKE_AGENT_WRITER_LOCK, "utf8")); } catch {}
        let alive = false;
        if (writer && writer.pid !== process.pid) {
          try { process.kill(writer.pid, 0); alive = true; } catch {}
        }
        if (alive && writer.session === message.params.sessionId) {
          send({ id: message.id, error: { code: -32603, message: "Internal error", data: {
            details: `thread ${message.params.sessionId} already has an active writer`,
          } } });
          continue;
        }
        fs.writeFileSync(process.env.FAKE_AGENT_WRITER_LOCK, JSON.stringify({ pid: process.pid, session: message.params.sessionId }));
      }
      if (process.env.FAKE_AGENT_MISSING_SESSION === message.params.sessionId) {
        const details = `no rollout found for session ${message.params.sessionId}`;
        process.stderr.write(`${details}\n`);
        setTimeout(() => send({ id: message.id,
          error: { code: -32603, message: "Internal error", data: { details } } }), 20);
        continue;
      }
      if (process.env.FAKE_AGENT_LOAD_FAILURE && fs.existsSync(process.env.FAKE_AGENT_LOAD_FAILURE)) {
        process.stderr.write("native thread/resume failed: fixture load outage\n");
        setTimeout(() => send({ id: message.id,
          error: { code: -32603, message: "Internal error", data: { trace: "fixture-resume" } } }), 20);
        continue;
      }
      currentModeId = "agent";
      update("replayed history");
      const reply = () => send({ id: message.id, result: modes() });
      if (process.env.FAKE_AGENT_LOAD_GATE && !fs.existsSync(process.env.FAKE_AGENT_LOAD_GATE)) {
        const timer = setInterval(() => {
          if (fs.existsSync(process.env.FAKE_AGENT_LOAD_GATE)) { clearInterval(timer); reply(); }
        }, 20);
      } else reply();
    } else if (message.method === "session/set_mode") {
      currentModeId = message.params.modeId;
      send({ id: message.id, result: {} });
    } else if (message.method === "session/set_config_option") {
      send({ id: message.id, result: { configOptions: [] } });
    } else if (message.method === "session/prompt") {
      const text = message.params.prompt.map((part) => part.text ?? "").join("");
      if (process.env.FAKE_AGENT_CONNECTION_FAILURE && fs.existsSync(process.env.FAKE_AGENT_CONNECTION_FAILURE)) {
        fs.unlinkSync(process.env.FAKE_AGENT_CONNECTION_FAILURE);
        const cause = 'Error running remote compact task: unexpected status 503 Service Unavailable: {"detail":"Unable to verify Daybreak Blue access. Please try again."}';
        send({ id: message.id, error: { code: -32603, message: cause, data: { sessionFailure: {
          id: "fixture-503", category: "connection", severity: "error", title: cause,
          actions: ["retry", "new_session"],
        } } } });
        continue;
      }
      if (process.env.FAKE_AGENT_AUTH_FAILURE && fs.existsSync(process.env.FAKE_AGENT_AUTH_FAILURE)) {
        fs.unlinkSync(process.env.FAKE_AGENT_AUTH_FAILURE);
        send({ id: message.id, error: { code: -32000, message: "Authentication required" } });
        continue;
      }
      if (text.includes("continue")) {
        if (process.env.FAKE_AGENT_REQUIRE_MODE && currentModeId !== process.env.FAKE_AGENT_REQUIRE_MODE) {
          send({ id: message.id, error: { code: -32000, message: "Codex mode lost on resume" } });
          continue;
        }
        const finish = () => {
          update("resumed ok");
          send({ id: message.id, result: { stopReason: "end_turn" } });
        };
        if (text.includes("client reply")) {
          clientReply = finish;
          send({ id: "fixture-client-reply", method: "session/request_permission", params: {
            sessionId: message.params.sessionId, toolCall: { toolCallId: "fixture-call", title: "Fixture" },
            options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
          } });
        } else finish();
      } else {
        update("working on it");
      }
    }
  }
});
setInterval(() => {}, 1000);

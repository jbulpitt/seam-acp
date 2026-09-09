#!/usr/bin/env node
/**
 * Fake `claude-agent-acp` for the #232 live-catalog probe tests.
 *
 * Speaks just enough newline-delimited JSON-RPC for `ClientSideConnection` to
 * initialize and open a session, then reports a model/effort config-option
 * shape driven by env so a test can assert what the probe published.
 *
 * Every process appends one JSON line to `$FAKE_ACP_LOG` recording its pid and
 * the `ANTHROPIC_MODEL` it was spawned with. That log is the evidence for the
 * isolation contract: one FRESH process per advertised model, each carrying the
 * environment runtime spawn would use for that model.
 *
 *   FAKE_ACP_LOG        required; append-only invocation log
 *   FAKE_ACP_MODELS     JSON [{value,name}] advertised by the model select
 *   FAKE_ACP_CURRENT    the model select's currentValue
 *   FAKE_ACP_EFFORT     JSON map of model value -> string[] (absent = no effort option)
 *   FAKE_ACP_FAIL           when "1", exit non-zero immediately
 *   FAKE_ACP_SILENT_INIT    never answer `initialize` (stays alive, mute)
 *   FAKE_ACP_SILENT_CLOSE   answer everything EXCEPT `session/close`
 */
import { appendFileSync } from "node:fs";

const log = process.env.FAKE_ACP_LOG;
if (log) {
  appendFileSync(
    log,
    JSON.stringify({
      pid: process.pid,
      anthropicModel: process.env.ANTHROPIC_MODEL ?? null,
      configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
    }) + "\n"
  );
}

if (process.env.FAKE_ACP_FAIL === "1") {
  process.stderr.write("fake claude-agent-acp: refusing to start\n");
  process.exit(3);
}

const advertised = JSON.parse(process.env.FAKE_ACP_MODELS ?? "[]");
const effortByModel = JSON.parse(process.env.FAKE_ACP_EFFORT ?? "{}");
// The session's model is whatever ANTHROPIC_MODEL selected, else the wrapper's
// own current value — the same shape the real wrapper exhibits. An alias is NOT
// selected by the environment, so it stays on the wrapper's model until the
// client explicitly selects it.
let current = process.env.ANTHROPIC_MODEL || process.env.FAKE_ACP_CURRENT || advertised[0]?.value || "default";

function configOptions() {
  const efforts = effortByModel[current];
  const options = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: current,
      options: advertised.map((entry) => ({ value: entry.value, name: entry.name })),
    },
  ];
  if (Array.isArray(efforts) && efforts.length > 0) {
    options.push({
      id: "effort",
      name: "Effort",
      category: "thought_level",
      type: "select",
      currentValue: efforts[0],
      options: efforts.map((value) => ({ value, name: value })),
    });
  }
  return options;
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id == null) continue;
    // Recording every received method is what lets a test prove the probe spends
    // no model tokens: `session/prompt` must never appear.
    if (log) appendFileSync(log, JSON.stringify({ pid: process.pid, method: message.method }) + "\n");
    if (process.env.FAKE_ACP_SILENT_INIT === "1") continue;
    if (process.env.FAKE_ACP_SILENT_CLOSE === "1" && message.method === "session/close") {
      // Alive, but never replies. A collector that awaits this unbounded hangs
      // the refresh and the shutdown drain.
      continue;
    }
    if (message.method === "initialize") {
      reply(message.id, {
        protocolVersion: message.params?.protocolVersion ?? 1,
        agentCapabilities: { loadSession: true, promptCapabilities: {} },
        authMethods: [],
      });
    } else if (message.method === "session/new") {
      reply(message.id, { sessionId: `fake-${process.pid}`, configOptions: configOptions() });
    } else if (message.method === "session/set_config_option") {
      if (message.params?.configId === "model") {
        current = message.params.value;
        if (log) {
          appendFileSync(log, JSON.stringify({ pid: process.pid, selected: current }) + "\n");
        }
      }
      reply(message.id, { configOptions: configOptions() });
    } else {
      reply(message.id, {});
    }
  }
});
process.stdin.on("end", () => process.exit(0));

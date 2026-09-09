import fs from "node:fs";
import readline from "node:readline";

const logPath = process.env.GROK_FAKE_LOG;
const mode = process.env.GROK_FAKE_MODE ?? "success";
const argv = process.argv.slice(2);
const appendLog = (method) => {
  if (!logPath) return;
  fs.appendFileSync(logPath, JSON.stringify({
    pid: process.pid,
    method,
    argv,
    cwd: process.cwd(),
    marker: process.env.GROK_FAKE_MARKER,
  }) + "\n");
};

if (argv.at(-1) === "models") {
  appendLog("models");
  process.stdout.write(`You are logged in with grok.com.

Default model: grok-test

Available models:
  * grok-test (default)
`);
  process.exit(0);
}
const input = readline.createInterface({ input: process.stdin });

input.on("line", (line) => {
  const request = JSON.parse(line);
  appendLog(request.method);
  if (mode === "hang") return;
  if (request.method !== "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: "unexpected method" },
    }) + "\n");
    return;
  }
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id: request.id,
    result: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: false },
      authMethods: [{ id: "cached_token", name: "Cached login" }],
      _meta: mode === "missing" ? {} : {
        modelState: {
          currentModelId: "grok-test",
          availableModels: [{
            modelId: "grok-test",
            name: "Grok Test",
            description: "Fixture",
            _meta: {
              totalContextTokens: 123456,
              supportsReasoningEffort: true,
              reasoningEffort: "high",
              reasoningEfforts: [{ id: "high", value: "high", default: true }],
            },
          }],
        },
      },
    },
  }) + "\n");
});

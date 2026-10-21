import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const logPath = process.env.GROK_FAKE_LOG;
const mode = process.env.GROK_FAKE_MODE ?? "success";
const argv = process.argv.slice(2);
if (mode === "hang") setInterval(() => {}, 60_000);
if (mode === "models-ignore-term") {
  process.on("SIGTERM", () => {
    if (process.env.GROK_FAKE_SIGNAL_LOG) {
      fs.appendFileSync(process.env.GROK_FAKE_SIGNAL_LOG, "SIGTERM-IGNORED\n");
    }
  });
}
if (process.env.GROK_FAKE_SIGNAL_LOG && mode !== "models-ignore-term") {
  process.on("SIGTERM", () => {
    fs.appendFileSync(process.env.GROK_FAKE_SIGNAL_LOG, "SIGTERM\n");
    process.exit(0);
  });
}
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
  if (mode === "models-error") {
    process.stderr.write(`credential=${process.env.GROK_FAKE_SECRET ?? ""}\n`);
    process.stderr.write(`cwd=${process.cwd()}\n`);
    process.stderr.write(`executable=${process.execPath}\n`);
    process.exit(9);
  }
  if (mode === "models-ignore-term") {
    setInterval(() => {}, 60_000);
  } else {
  process.stdout.write(`You are logged in with grok.com.

Default model: grok-test

Available models:
  * grok-test (default)
`);
  process.exit(0);
  }
}
if (mode === "early-exit") {
  process.stderr.write(`early failure ${process.env.GROK_FAKE_SECRET ?? ""}\n`);
  process.exit(7);
}
const input = readline.createInterface({ input: process.stdin });

input.on("line", (line) => {
  const request = JSON.parse(line);
  appendLog(request.method);
  if (mode === "hang") return;
  // #361: answer `initialize` normally, then never answer billing. Holds the
  // process alive across the initialize -> billing transition so an abort can
  // be swept across that whole window.
  if (mode === "initialize-then-hang" && request.method !== "initialize") return;
  if (mode === "malformed-protocol") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32600, message: "malformed initialize response" },
    }) + "\n");
    return;
  }
  if (mode === "stdout-flood") {
    process.stdout.write("x".repeat(1_100_000));
    return;
  }
  if (request.method !== "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: "unexpected method" },
    }) + "\n");
    return;
  }
  const renewalMode = ["renew-session", "renew-always", "renew-then-hang"].includes(mode);
  let renewing = false;
  if (renewalMode) {
    const authPath = path.join(process.env.GROK_HOME, "auth.json");
    const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
    const record = Object.values(auth)[0];
    renewing = mode === "renew-always" || !record.expires_at;
    if (!renewing && mode === "renew-then-hang") return;
    if (renewing) {
      record.create_time = new Date().toISOString();
      record.expires_at = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(authPath, JSON.stringify(auth));
    }
  }
  const modelIds = renewalMode
    ? (renewing ? ["grok-4.6", "grok-4.5"] : ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"])
    : ["grok-test"];
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id: request.id,
    result: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: false },
      authMethods: [{ id: "cached_token", name: "Cached login" }],
      _meta: mode === "missing" ? {} : {
        modelState: {
          currentModelId: renewalMode ? "grok-4.6" : "grok-test",
          availableModels: modelIds.map(modelId => ({
            modelId,
            name: "Grok Test",
            description: "Fixture",
            _meta: {
              totalContextTokens: 123456,
              supportsReasoningEffort: true,
              reasoningEffort: "high",
              reasoningEfforts: [{ id: "high", value: "high", default: true }],
            },
          })),
        },
      },
    },
  }) + "\n");
});

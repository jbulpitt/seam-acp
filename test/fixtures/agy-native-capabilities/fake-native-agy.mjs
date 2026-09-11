#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const fixtureDir = process.env.SEAM_AGY_CAPABILITY_FIXTURE_DIR;
const invocationLog = process.env.SEAM_AGY_CAPABILITY_INVOCATIONS;

if (!fixtureDir) {
  process.stderr.write("missing sanitized capability fixture directory\n");
  process.exit(2);
}

const argValue = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const prompt = argValue("-p") ?? "";
const logFile = argValue("--log-file");
const resumedConversation = argValue("--conversation");
const schemaFile = argValue("--json-schema");

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const appendInvocation = (record) => {
  if (invocationLog) fs.appendFileSync(invocationLog, `${JSON.stringify(record)}\n`);
};

if (args.includes("--version")) {
  process.stdout.write("agy fixture 1.1.28\n");
  process.exit(0);
}

if (argValue("--model") === "__seam_probe_invalid__") {
  process.stderr.write(
    "Unknown model\nAvailable models:\n" +
    "  Fixture Native Model\n" +
    "  Fixture Native Model (Low)\n\n",
  );
  process.exit(1);
}

const scenarioFile = prompt === "ok"
  ? undefined
  : prompt.includes("capability-model-") && prompt.includes("-resume")
    ? "turn-two-resume.json"
    : prompt.includes("capability-model-")
      ? "turn-one.json"
  : prompt.includes("capability-turn-one") || prompt === "r5-closing"
    ? "turn-one.json"
    : prompt.includes("capability-turn-two")
      ? "turn-two-resume.json"
      : prompt.includes("capability-structured")
        ? "structured-turn.json"
        : prompt.includes("capability-interrupt") || prompt.startsWith("r5-")
          ? "interrupted-turn.json"
          : undefined;

if (prompt !== "ok" && !scenarioFile) {
  process.stderr.write("unknown sanitized fixture prompt\n");
  process.exit(2);
}

const trace = scenarioFile ? readJson(path.join(fixtureDir, scenarioFile)) : undefined;
const conversationId = resumedConversation ?? trace?.conversationId ??
  "22222222-2222-4222-8222-222222222222";
const mcpFile = process.env.HOME
  ? path.join(process.env.HOME, ".gemini", "config", "mcp_config.json")
  : undefined;
let mcpConfig;
if (mcpFile) {
  try { mcpConfig = readJson(mcpFile); } catch { /* no session MCP */ }
}
let jsonSchema;
if (schemaFile) {
  try { jsonSchema = readJson(schemaFile); } catch { /* asserted by the caller */ }
}
appendInvocation({
  pid: process.pid,
  scenario: trace?.scenario ?? "catalog",
  prompt,
  conversationId,
  resumedConversation: resumedConversation ?? null,
  home: process.env.HOME ?? null,
  mcpConfig: mcpConfig ?? null,
  jsonSchema: jsonSchema ?? null,
  args,
  cwd: process.cwd(),
});

if (prompt === "r5-exit" || (prompt === "ok" && process.env.SEAM_AGY_R5_CATALOG_MODE === "fail")) {
  process.stderr.write(`private diagnostic synthetic-password ${process.env.HOME}\n`);
  process.exit(3);
}
if (prompt === "r5-stderr") process.stderr.write(Buffer.alloc(300_000, "x"));
if (prompt === "r5-stdout") process.stdout.write(Buffer.alloc(1_100_000, "x"));
if (prompt === "r5-tree") {
  const descendant = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: "ignore" });
  appendInvocation({ scenario: "descendant", pid: descendant.pid });
}
if (prompt === "r5-no-ls") {
  process.on("SIGTERM", () => appendInvocation({ scenario: "no-ls", signal: "SIGTERM" }));
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}

const envelope = (flag, value) => {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = flag;
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
};

const writeFragmented = async (response, frame) => {
  const marker = Buffer.from("🧭", "utf8");
  const markerAt = frame.indexOf(marker);
  const splitAt = markerAt >= 0 ? markerAt + 2 : Math.min(frame.length, 11);
  response.write(frame.subarray(0, splitAt));
  await new Promise((resolve) => setImmediate(resolve));
  response.write(frame.subarray(splitAt));
};

const server = http.createServer(async (request, response) => {
  if (request.url === "/healthz") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: "ok", instanceId: `fixture-${process.pid}` }));
    return;
  }

  if (request.url?.endsWith("/GetAvailableModels")) {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      response: {
        models: {
          "fixture-native-model": {
            displayName: "Fixture Native Model",
            maxTokens: 4096,
            recommended: true,
            supportsThinking: true,
            supportsImages: false,
            isInternal: false
          },
          "fixture-native-model-low": {
            displayName: "Fixture Native Model (Low)",
            maxTokens: 4096,
            recommended: false,
            supportsThinking: true,
            supportsImages: false,
            isInternal: false
          }
        }
      }
    }));
    return;
  }

  if (request.url?.endsWith("/RetrieveUserQuotaSummary")) {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      response: {
        description: "Sanitized fixture quota",
        groups: [{
          displayName: "Fixture plan",
          buckets: [{
            bucketId: "fixture-weekly",
            displayName: "Weekly",
            window: "weekly",
            remainingFraction: 0.75,
          }],
        }],
      },
    }));
    return;
  }

  if (request.url?.endsWith("/StreamAgentStateUpdates") && trace) {
    response.statusCode = 200;
    response.setHeader("content-type", "application/connect+json");
    if (prompt === "r5-malformed") { response.end(Buffer.from([0, 0, 0, 0, 1, 123])); return; }
    if (prompt === "r5-oversized-frame") { response.write(Buffer.from([0, 127, 255, 255, 255])); return; }
    for (const update of trace.updates) {
      await writeFragmented(response, envelope(0, { update }));
    }
    if (trace.holdOpen) return;
    response.end(envelope(2, {}));
    if (trace.stdoutEnvelope) {
      process.stdout.write(JSON.stringify(trace.stdoutEnvelope));
      setTimeout(() => {
        server.close();
        server.closeAllConnections?.();
      }, 20).unref();
    }
    return;
  }

  response.statusCode = 404;
  response.end();
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string" || !logFile) process.exit(2);
  fs.writeFileSync(
    logFile,
    `Language server listening on random port at ${address.port} for HTTP\n` +
      `Created conversation ${conversationId}\n`,
  );
});

process.on("SIGTERM", () => {
  appendInvocation({ scenario: trace?.scenario ?? "catalog", signal: "SIGTERM" });
  if (prompt === "r5-term" || prompt === "r5-tree") return;
  if (prompt === "r5-closing") { setTimeout(() => process.exit(0), 300); return; }
  server.close();
  server.closeAllConnections?.();
  process.exit(0);
});

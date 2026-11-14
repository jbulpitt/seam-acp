#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const fixtureDir = process.env.SEAM_AGY_CAPABILITY_FIXTURE_DIR;
const invocationLog = process.env.SEAM_AGY_CAPABILITY_INVOCATIONS;
let streamFinished;
const afterStream = new Promise(resolve => { streamFinished = resolve; });

if (!fixtureDir) {
  process.stderr.write("missing sanitized capability fixture directory\n");
  process.exit(2);
}

const argValue = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const submittedPrompt = argValue("-p") ?? "";
let prompt = submittedPrompt;
/**
 * #260: the catalog is now discovered with `agy models`, which takes no prompt.
 * Row shape is the observed one from agy 1.1.27 — `<modelId>\t<displayName>`,
 * one per line, after a "Fetching available models..." progress line — and the
 * subcommand also brings a language server up, which is how the rich metadata
 * is still reachable without paying for a turn.
 */
const isModelsCommand = args.includes("models");
const logFile = argValue("--log-file");
const resumedConversation = argValue("--conversation");
const schemaFile = argValue("--json-schema");
const csrfArg = args.find((arg) => arg.startsWith("--csrf_token="));
const csrfToken = csrfArg?.slice("--csrf_token=".length);
const csrfFingerprint = csrfToken
  ? createHash("sha256").update(csrfToken).digest("hex")
  : null;
const safeArgs = args.map((arg) => arg.startsWith("--csrf_token=")
  ? "--csrf_token=[redacted]"
  : arg);

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
// #361: how many 500s to emit before the quota RPC starts answering.
let quotaFiveHundredsLeft = Number(process.env.SEAM_AGY_QUOTA_500S ?? 1);
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
  process.exit(Number(process.env.SEAM_AGY_VALIDATOR_EXIT ?? 1));
}

const isContinuation = /^continue(?:\s|$)/.test(prompt);
if (isContinuation && resumedConversation && invocationLog) {
  const previous = fs.readFileSync(invocationLog, "utf8").trim().split("\n")
    .map(line => JSON.parse(line)).findLast(row => row.conversationId === resumedConversation
      && row.prompt && !/^continue(?:\s|$)/.test(row.prompt));
  prompt = previous?.prompt === "r5-turn-unknown-exit-once"
    ? "capability-turn-two" : previous?.prompt ?? prompt;
}

const scenarioFile = prompt === "ok" || isModelsCommand
  ? undefined
  : prompt.includes("capability-model-") && prompt.includes("-resume")
    ? "turn-two-resume.json"
    : prompt.includes("capability-model-")
      ? "turn-one.json"
  : prompt.includes("capability-generated-image")
    ? "turn-generated-image.json"
  : prompt.includes("capability-correction")
    ? "turn-correction.json"
  : prompt.includes("capability-turn-one") || prompt === "r5-closing"
    ? "turn-one.json"
    : prompt.includes("capability-turn-two")
      ? "turn-two-resume.json"
      : prompt.includes("capability-structured")
        ? "structured-turn.json"
        : prompt.includes("capability-interrupt") || prompt.startsWith("r5-")
          ? "interrupted-turn.json"
          : undefined;

const trace = scenarioFile ? readJson(path.join(fixtureDir, scenarioFile)) : undefined;
if (trace?.scenario === "turn-generated-image") {
  const imagePath = path.join(process.cwd(), "generated.png");
  fs.writeFileSync(imagePath, Buffer.from("89504e470d0a1a0a", "hex"));
  trace.updates[1].mainTrajectoryUpdate.stepsUpdate.steps[0].content =
    `Generated image is saved at ${imagePath}.`;
}
if (isContinuation && prompt === "capability-turn-two") {
  // The interrupted fixture already emitted step 7; resumed work follows it.
  for (const update of trace.updates) {
    const steps = update.mainTrajectoryUpdate?.stepsUpdate;
    if (steps) steps.indices = steps.indices.map(index => index >= 5 ? index + 3 : index);
  }
}
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
  prompt: submittedPrompt,
  conversationId,
  resumedConversation: resumedConversation ?? null,
  home: process.env.HOME ?? null,
  mcpConfig: mcpConfig ?? null,
  jsonSchema: jsonSchema ?? null,
  args: safeArgs,
  csrfFingerprint,
  cwd: process.cwd(),
});

if (prompt !== "ok" && !isModelsCommand && !scenarioFile) {
  process.stderr.write("unknown sanitized fixture prompt\n");
  process.exit(2);
}

if (process.env.SEAM_AGY_CSRF_FLAG_MODE === "unsupported" && csrfToken) {
  fs.writeSync(2, `unknown flag: --csrf_token=${csrfToken}\n`);
  await new Promise((resolve) => setTimeout(resolve, 25));
  process.exit(2);
}
// The wording real agy actually uses. 1.2.9 rejects the flag through Go's flag
// package, which says "flags provided but not defined" and never "unknown
// flag" — the phrase the old detector required. This mode reproduces the
// production failure the "unsupported" mode above could not.
if (process.env.SEAM_AGY_CSRF_FLAG_MODE === "unsupported-go" && csrfToken) {
  fs.writeSync(2, `Error: flags provided but not defined: -csrf_token\n`);
  await new Promise((resolve) => setTimeout(resolve, 25));
  process.exit(2);
}
if (process.env.SEAM_AGY_CSRF_FLAG_MODE === "echo-fail" && csrfToken) {
  fs.writeSync(2, `synthetic child rejected csrf capability ${csrfToken}\n`);
  await new Promise((resolve) => setTimeout(resolve, 25));
  process.exit(42);
}

if (isModelsCommand && process.env.SEAM_AGY_R5_CATALOG_MODE === "auth-wait") {
  process.stderr.write(
    `Verification required. Please complete verification in your browser to continue. ` +
    `Authorization: Bearer synthetic-secret-token-481 ${process.env.HOME}\n`,
  );
  process.stdin.resume();
  process.stdin.once("end", () => {
    appendInvocation({ scenario: "catalog-stdin-end", pid: process.pid });
    process.exit(41);
  });
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
}
if (prompt === "r5-exit" || ((prompt === "ok" || isModelsCommand) && process.env.SEAM_AGY_R5_CATALOG_MODE === "fail")) {
  process.stderr.write(`private diagnostic password=synthetic-password ${process.env.HOME}\n`);
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

  const rpc = request.url?.split("/").at(-1) ?? "unknown";
  const suppliedCsrf = request.headers["x-codeium-csrf-token"];
  const csrfStatus = suppliedCsrf === undefined
    ? "missing"
    : suppliedCsrf === csrfToken
      ? "match"
      : "wrong";
  if (process.env.SEAM_AGY_CSRF_MODE === "enforce") {
    appendInvocation({ scenario: "csrf-rpc", rpc, csrfStatus, csrfFingerprint });
    if (!csrfToken || csrfStatus !== "match") {
      if (request.url?.endsWith("/StreamAgentStateUpdates")) {
        response.statusCode = 200;
        response.setHeader("content-type", "application/connect+json");
        response.end(envelope(2, { error: {
          code: "unauthenticated",
          message: csrfStatus === "missing" ? "missing CSRF token" : "invalid CSRF token",
        } }));
      } else {
        response.statusCode = 403;
        response.end(JSON.stringify({ error: {
          code: "unauthenticated",
          message: csrfStatus === "missing" ? "missing CSRF token" : "invalid CSRF token",
        } }));
      }
      return;
    }
  }

  if (request.url?.endsWith("/GetAvailableModels")) {
    if (process.env.SEAM_AGY_WINDOW_REQUESTS) {
      fs.appendFileSync(process.env.SEAM_AGY_WINDOW_REQUESTS, `${JSON.stringify({ rpc, pid: process.pid })}\n`);
    }
    const metadataMode = process.env.SEAM_AGY_R4B_METADATA_MODE_FILE
      ? fs.readFileSync(process.env.SEAM_AGY_R4B_METADATA_MODE_FILE, "utf8").trim()
      : process.env.SEAM_AGY_R4B_METADATA_MODE;
    if (metadataMode === "late" || prompt.startsWith("r5-replay-")) await afterStream;
    if (metadataMode === "unavailable") {
      response.statusCode = 403;
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    const primaryModelId = metadataMode === "mismatch"
      ? "fixture-native-model-alias"
      : "fixture-native-model";
    response.end(JSON.stringify({
      response: {
        models: {
          [primaryModelId]: {
            displayName: "Fixture Native Model",
            maxTokens: Number(process.env.SEAM_AGY_WINDOW_VALUE_FILE
              ? fs.readFileSync(process.env.SEAM_AGY_WINDOW_VALUE_FILE, "utf8")
              : process.env.SEAM_AGY_R4B_CONTEXT_WINDOW ?? 4096),
            recommended: true,
            supportsThinking: true,
            supportsImages: false,
            isInternal: false
          },
          "fixture-native-model-low": {
            displayName: "Fixture Native Model (Low)",
            maxTokens: Number(process.env.SEAM_AGY_R4B_CONTEXT_WINDOW ?? 4096),
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
    if (process.env.SEAM_AGY_QUOTA_REJECT === "1") {
      response.statusCode = 401;
      response.end(JSON.stringify({ code: "unauthenticated", message: "missing CSRF token" }));
      return;
    }
    if (process.env.SEAM_AGY_QUOTA_DROP_CONNECTION === "1") {
      // #481: make the real quota callback fail with an unknown diagnostic so
      // the production probe boundary—not a test-local classifier call—has to
      // preserve `unclassified` while destroying the raw detail.
      request.socket.destroy();
      return;
    }
    // #361, observed on agy 1.1.27: the LS answers 500 while silent-auth is
    // still landing, then 200. The retry loop exists for exactly this.
    if (quotaFiveHundredsLeft > 0) {
      quotaFiveHundredsLeft -= 1;
      response.statusCode = 500;
      response.end("{}");
      return;
    }
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
    if (prompt.startsWith("r5-replay-")) {
      response.once("close", streamFinished);
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      if (body[0] !== 0 || body.readUInt32BE(1) !== body.length - 5) throw new Error("invalid fixture Connect request");
      const subscription = JSON.parse(body.subarray(5).toString("utf8"));
      const floor = prompt === "r5-replay-large" ? 512 : prompt === "r5-replay-db" ? 4 : -1;
      const first = floor + 1;
      const planner = (text, thought, used) => ({
        type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE", status: "CORTEX_STEP_STATUS_GENERATING",
        plannerResponse: { modifiedResponse: text, thinking: thought },
        metadata: { generatorModel: "fixture-native-model", modelUsage: { inputTokens: String(used), outputTokens: "0" } },
      });
      const history = Array.from({ length: floor + 1 }, (_, index) => [index,
        planner(prompt === "r5-replay-large" ? "H".repeat(128 * 1024) : "HISTORICAL", "OLD THOUGHT", 999)]);
      const current = planner(prompt === "r5-replay-eligible-overflow" ? "x".repeat(64 * 1024 * 1024) : "Replay ", "Inspect ", 101);
      const updateFor = entries => ({ status: "CASCADE_RUN_STATUS_RUNNING", mainTrajectoryUpdate: {
        stepsUpdate: { indices: entries.map(([index]) => index), steps: entries.map(([, step]) => step) },
      } });
      // Native page bounds select against each update's current total; absent end stays open.
      const select = entries => {
        const bounds = subscription.initialStepsPageBounds;
        if (!bounds) return entries;
        const total = Math.max(...entries.map(([index]) => index)) + 1;
        const start = Math.max(0, Math.min(bounds.startIndex, total));
        const end = bounds.endIndexExclusive === undefined ? total : Math.max(start, Math.min(bounds.endIndexExclusive, total));
        return entries.filter(([index]) => index >= start && index < end);
      };
      const initial = [...history, [first, current]];
      const unbounded = envelope(0, { update: updateFor(initial) });
      const selected = envelope(0, { update: updateFor(select(initial)) });
      const parsed = JSON.parse(unbounded.subarray(5).toString("utf8"));
      appendInvocation({ scenario: "replay-subscription", request: subscription,
        unboundedBytes: unbounded.length - 5, selectedBytes: selected.length - 5,
        validJson: parsed.update.mainTrajectoryUpdate.stepsUpdate.steps.length === initial.length,
        historicalCount: history.length, selectedIndices: select(initial).map(([index]) => index) });
      await writeFragmented(response, selected);
      if (prompt === "r5-replay-eligible-overflow") return;
      const tool = status => ({ type: "CORTEX_STEP_TYPE_RUN_COMMAND", status,
        runCommand: { command: "printf synthetic", stdout: "SYNTHETIC TOOL OUTPUT" } });
      const cumulative = planner("Replay safe🧭", "Inspect once🧭", 122);
      const updates = [
        updateFor([[first, cumulative], [first + 1, tool("CORTEX_STEP_STATUS_WAITING")]]),
        updateFor([[first, cumulative], [first + 1, tool("CORTEX_STEP_STATUS_RUNNING")]]),
        updateFor([[first + 1, tool("CORTEX_STEP_STATUS_DONE")]]),
        { status: "CASCADE_RUN_STATUS_IDLE", fullyIdle: false },
        updateFor([[first + 2, planner(" Future.", " Future thought.", 144)]]),
      ];
      for (const update of updates) {
        const steps = update.mainTrajectoryUpdate?.stepsUpdate;
        if (steps) {
          const selectedEntries = select(steps.indices.map((index, i) => [index, steps.steps[i]]));
          update.mainTrajectoryUpdate.stepsUpdate = updateFor(selectedEntries).mainTrajectoryUpdate.stepsUpdate;
        }
      }
      // Split a header, then coalesce later envelopes, including fullyIdle.
      const frames = Buffer.concat(updates.map(update => envelope(0, { update })));
      response.write(frames.subarray(0, 2));
      await new Promise(resolve => setImmediate(resolve));
      appendInvocation({ scenario: "replay-fully-idle" });
      response.write(Buffer.concat([frames.subarray(2), envelope(0, { update: { status: "CASCADE_RUN_STATUS_IDLE", fullyIdle: true } })]));
      return;
    }
    if (prompt === "r5-turn-auth-exit" || prompt === "r5-turn-unknown-exit" || prompt === "r5-turn-unknown-exit-once") {
      // #491: the real incident emitted a message before the nested `agy -p`
      // child exited. Keep the stream open after one real update so the child
      // exit—not a synthetic response error—is what ends the production path.
      await writeFragmented(response, envelope(0, { update: trace.updates[0] }));
      setTimeout(() => {
        process.stderr.write(prompt === "r5-turn-auth-exit"
          ? `Verification required. Authorization: Bearer synthetic-secret-token-491 ${process.env.HOME}\n`
          : `future AGY child failure synthetic-secret-token-491 ${process.env.HOME}\n`);
        process.exit(prompt === "r5-turn-auth-exit" ? 41 : 52);
      }, 75);
      return;
    }
    if (prompt.startsWith("r5-stream-")) {
      if (!schemaFile) process.stdout.write("STDOUT ONLY ");
      if (prompt === "r5-stream-partial") {
        await writeFragmented(response, envelope(0, { update: {
          status: "CASCADE_RUN_STATUS_RUNNING",
          mainTrajectoryUpdate: { stepsUpdate: { indices: [1], steps: [{
            type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE", status: "CORTEX_STEP_STATUS_DONE",
            plannerResponse: { modifiedResponse: "PARTIAL STREAM" },
          }] } },
        } }));
      }
      response.end(envelope(2, { error: prompt === "r5-stream-unimplemented"
        ? { code: "unimplemented", message: "RPC unavailable in this version" }
        : { code: "unauthenticated", message: "missing CSRF token" } }));
      if (prompt === "r5-stream-hang") return;
      setTimeout(() => {
        process.stdout.write(schemaFile ? JSON.stringify({ status: "SUCCESS", structured_output: { answer: "OK" } })
          : prompt === "r5-stream-overflow" ? "x".repeat(1_100_000) : "OK🧭\n");
        server.close();
        server.closeAllConnections?.();
        process.exitCode = prompt === "r5-stream-exit" ? 3 : 0;
      }, 50);
      return;
    }
    // A working stream must never substitute this deliberately different stdout.
    if (!schemaFile) process.stdout.write("DO NOT USE STDOUT\n");
    if (prompt === "r5-malformed") { response.end(Buffer.from([0, 0, 0, 0, 1, 123])); return; }
    if (prompt === "r5-oversized-frame") { response.write(Buffer.from([0, 4, 0, 0, 1])); return; }
    for (const update of trace.updates) {
      await writeFragmented(response, envelope(0, { update }));
    }
    streamFinished();
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
  if (!address || typeof address === "string") process.exit(2);
  // Catalog reads stdout only; quota and turn probes own a private LS log.
  if (logFile) {
    fs.writeFileSync(
      logFile,
      `Language server listening on random port at ${address.port} for HTTP\n` +
        `Created conversation ${conversationId}\n`,
    );
  }
  if (!isModelsCommand) return;
  // Observed on agy 1.1.27: `models` prints its rows and exits after ~1.7-2.8s,
  // and its language server is answerable for part of that window — 500 during
  // silent-auth, then 200. #260 takes ids and names only because
  // GetAvailableModels stayed 400 throughout; #361 reads quota, which does
  // answer. SEAM_AGY_MODELS_NO_LS=1 models the cold-auth miss: exit at once,
  // so the window never opens.
  process.stdout.write(
    "Fetching available models...\n" +
    "fixture-native-model\tFixture Native Model\n" +
    "fixture-native-model-low\tFixture Native Model (Low)\n"
  );
  const holdMs = process.env.SEAM_AGY_MODELS_NO_LS === "1"
    ? 0
    : Number(process.env.SEAM_AGY_MODELS_HOLD_MS ?? 2000);
  setTimeout(() => {
    server.close();
    server.closeAllConnections?.();
    process.exit(0);
  }, holdMs).unref?.();
});

let terminating = false;
process.on("SIGTERM", () => {
  if (terminating) return;
  terminating = true;
  const delayMs = Number(process.env.SEAM_AGY_CAPABILITY_SIGTERM_DELAY_MS ?? 0);
  if (Number.isFinite(delayMs) && delayMs > 0) {
    setTimeout(() => {
      appendInvocation({ scenario: trace?.scenario ?? "catalog", signal: "SIGTERM" });
      server.close();
      server.closeAllConnections?.();
      process.exit(0);
    }, delayMs);
    return;
  }
  appendInvocation({ scenario: trace?.scenario ?? "catalog", signal: "SIGTERM" });
  if (prompt === "r5-term" || prompt === "r5-tree") return;
  if (prompt === "r5-closing") { setTimeout(() => process.exit(0), 300); return; }
  server.close();
  server.closeAllConnections?.();
  process.exit(0);
});

import fs from "node:fs";
import path from "node:path";
import { REST } from "discord.js";

const dataDir = process.env.DATA_DIR;
const mode = process.env.REDEPLOY_HEALTH_CASE;
const eventsFile = path.join(dataDir, "events.jsonl");
fs.mkdirSync(dataDir, { recursive: true });
const record = event => fs.appendFileSync(eventsFile, JSON.stringify(event) + "\n");
const previous = { pid: 123, started: "linux:10" };
const controller = { pid: 124, started: "linux:20" };
let elapsed = 0;
let healthCalls = 0;
let restarted = false;

// Advance only the CLI's observation clock/backoff; no controller is running.
Date.now = () => elapsed;
const setTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, ms, ...args) => {
  if (ms > 0 && ms <= 1000) {
    elapsed += ms;
    return setTimeout(callback, 0, ...args);
  }
  return setTimeout(callback, ms, ...args);
};
const deadlines = new WeakMap();
const timeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = ms => {
  const signal = timeout(ms);
  deadlines.set(signal, ms);
  return signal;
};

globalThis.fetch = async (url, options) => {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/health$/.test(String(url))) throw new Error(`unexpected fixture fetch: ${url}`);
  healthCalls++;
  record({ type: "health", call: healthCalls, elapsed, restarted, timeoutMs: deadlines.get(options.signal) });
  if (mode === "timeout" || (mode === "recover" && healthCalls === 1)) {
    elapsed += deadlines.get(options.signal);
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  }
  if (mode === "http503") return new Response("database opening", { status: 503 });
  return Response.json({ status: "ok", controller: { identity: restarted ? controller : previous } });
};

const writeFileSync = fs.writeFileSync;
fs.writeFileSync = (file, ...args) => {
  const written = writeFileSync(file, ...args);
  if (path.resolve(String(file)) === path.join(dataDir, ".restart-pending")) {
    record({ type: "sentinel", elapsed, healthCalls });
    if (!process.env.SEAM_TEST_DRIVER_ACTOR_ID) {
      const request = JSON.parse(fs.readFileSync(path.join(dataDir, "deploy-canary-request.json"), "utf8"));
      record({ type: "request", request });
      restarted = true;
      writeFileSync(path.join(dataDir, "deploy-canary-result.json"), JSON.stringify({
        id: request.id, target: "self", branch: request.branch, commit: request.commit,
        startedAt: request.startedAt, finishedAt: new Date().toISOString(),
        deploy: { requestId: request.id, previous: request.previous, controller },
        rows: [
          { host: "controller", agent: "deploy", status: "passed", durationMs: 1 },
          { host: "fixture", agent: "reconnect", check: "fleet update", status: "passed", durationMs: 1 },
        ],
      }));
    }
  }
  return written;
};

// Keep publication real through the card builder, with only Discord I/O replaced.
REST.prototype.get = async () => ({ guild_id: "1553545915535597629" });
REST.prototype.post = async () => {
  record({ type: "card", elapsed });
  return { id: "1563090279567720549" };
};
REST.prototype.put = async () => {};
REST.prototype.delete = async () => {};

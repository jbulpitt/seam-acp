#!/usr/bin/env node
/**
 * Manual smoke-test for packages/adapters/src/agy-stream.ts.
 *
 * Spawns `agy -p "<prompt>"`, finds its language server, subscribes to
 * `StreamAgentStateUpdates`, and prints a compact timeline of step
 * deltas as they arrive. Use it to confirm streaming behavior end-to-end
 * before wiring the primitive into the ACP profile.
 *
 *   node scripts/agy-stream-probe.mjs "your prompt here"
 *   DUMP=1 node scripts/agy-stream-probe.mjs ...   # dump raw step JSON
 *
 * Exits 0 when the LS stream ends naturally (agy finished); non-zero on
 * a discovery / subscribe error.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const modUrl = pathToFileURL(path.join(repoRoot, "packages/adapters/src/agy-stream.ts")).href;
const { discoverAgyLs, subscribeToAgyStream } = await import(modUrl);

const DUMP = process.env.DUMP === "1";
const prompt = process.argv.slice(2).join(" ").trim() ||
  "view /etc/hostname, then view /etc/os-release, then run 'uname -a' via bash. Announce each step.";

const fs = await import("node:fs/promises");
const convDir = path.join(process.env.HOME, ".gemini/antigravity-cli/conversations");
const before = new Set(await fs.readdir(convDir).catch(() => []));

const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(2).padStart(6);

console.log(`[${ts()}s] spawning agy -p ...`);
const agyStart = Date.now();
const proc = spawn(
  path.join(process.env.HOME, ".local/bin/agy"),
  ["-p", prompt, "--print-timeout", "180s", "--dangerously-skip-permissions"],
  { cwd: "/tmp", stdio: ["ignore", "pipe", "pipe"] },
);
proc.stdout.on("data", () => {});
proc.stderr.on("data", () => {});

let ls;
try {
  ls = await discoverAgyLs({ timeoutMs: 30_000, newerThanMs: agyStart - 1_000 });
  console.log(`[${ts()}s] LS port=${ls.port} instance=${ls.instanceId}`);
} catch (e) {
  console.error("LS discovery failed:", e.message);
  proc.kill();
  process.exit(1);
}

let cid;
for (let i = 0; i < 40 && !cid; i++) {
  const now = new Set(await fs.readdir(convDir).catch(() => []));
  for (const f of now) {
    if (!before.has(f) && f.endsWith(".pb")) {
      cid = f.slice(0, -3);
      break;
    }
  }
  if (!cid) await new Promise((r) => setTimeout(r, 250));
}
if (!cid) {
  console.error("no new conversation appeared");
  proc.kill();
  process.exit(1);
}
console.log(`[${ts()}s] cascade=${cid}`);

const ac = new AbortController();
proc.on("exit", () => ac.abort());

let count = 0;
let firstPlannerDumped = false;
try {
  for await (const u of subscribeToAgyStream({
    port: ls.port,
    conversationId: cid,
    signal: ac.signal,
  })) {
    count++;
    const sup = u.mainTrajectoryUpdate?.stepsUpdate;
    if (sup?.indices && sup.steps) {
      for (let i = 0; i < sup.indices.length; i++) {
        const idx = sup.indices[i];
        const step = sup.steps[i] ?? {};
        if (DUMP && step.type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE") {
          console.log(`--- DUMP step ${idx} (${step.status}) ---`);
          console.log(JSON.stringify(step, null, 2).slice(0, 4000));
          console.log("--- END DUMP ---");
        }
        const text = step.plannerResponse?.modifiedResponse ?? "";
        const thinking = step.plannerResponse?.thinking ?? "";
        const summary = [
          `step=${idx}`,
          `type=${(step.type ?? "?").replace(/^CORTEX_STEP_TYPE_/, "")}`,
          `status=${(step.status ?? "?").replace(/^CORTEX_STEP_STATUS_/, "")}`,
          text ? `text=${text.length}` : "",
          thinking ? `think=${thinking.length}` : "",
        ].filter(Boolean).join(" ");
        console.log(`[${ts()}s] ${summary}`);
      }
    } else if (u.status && u.status !== "CASCADE_RUN_STATUS_RUNNING") {
      console.log(`[${ts()}s] status=${u.status}`);
    }
  }
} catch (e) {
  if (!ac.signal.aborted) console.error("stream error:", e.message);
}
console.log(`[${ts()}s] done, ${count} update(s)`);
proc.kill();

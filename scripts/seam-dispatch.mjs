#!/usr/bin/env node
/**
 * seam-dispatch — the operator's doorway to the dispatch bridge.
 *
 * Writes a dispatch spec into <DATA_DIR>/dispatch/pending/<uuid>.json; the
 * running seam-acp process picks it up, runs the prompt as a turn in the target
 * Discord thread, and writes <DATA_DIR>/dispatch/done/<uuid>.json. With --wait
 * this polls for that result and prints it.
 *
 * Auth is the filesystem — if you can write to the dispatch dir you are the
 * operator. Don't expose this path to anything you don't trust.
 *
 * Usage:
 *   scripts/seam-dispatch.mjs --target <threadId> --prompt "..." [options]
 *   scripts/seam-dispatch.mjs --target <threadId> --prompt-file plan.md --wait
 *
 * Options:
 *   --target <id>           Discord thread/channel id to dispatch into (required)
 *   --prompt <text>         Prompt text (or use --prompt-file)
 *   --prompt-file <path>    Read the prompt from a file
 *   --session <live|isolated>  Default: live (reuses the thread's session)
 *   --model <id>            Isolated runs only — a live turn uses the thread's model
 *   --effort <level>        Isolated runs only
 *   --cwd <path>            Working directory for the turn
 *   --correlation <id>      Opaque id echoed into the result file
 *   --return-to <id>        On completion, auto-dispatch the captured output back into this thread
 *   --wait                  Poll for the result and print it
 *   --timeout <secs>        With --wait; default 900
 *   --output-only           With --wait; print just the agent's text
 *   --data-dir <path>       Default: $DATA_DIR, else ./data
 */
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as url from "node:url";

const FLAGS_WITH_VALUES = new Set([
  "target",
  "prompt",
  "prompt-file",
  "session",
  "model",
  "effort",
  "cwd",
  "correlation",
  "return-to",
  "timeout",
  "data-dir",
]);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    if (FLAGS_WITH_VALUES.has(key)) {
      const value = argv[++i];
      if (value === undefined) fail(`--${key} needs a value`);
      out[key] = value;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function fail(msg) {
  process.stderr.write(`seam-dispatch: ${msg}\n`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.h) {
    // The usage block above is the help text — print it verbatim.
    const self = await readFile(url.fileURLToPath(import.meta.url), "utf8");
    const doc = self.slice(self.indexOf("/**"), self.indexOf("*/") + 2);
    process.stdout.write(`${doc.replace(/^ *\/?\*+ ?/gm, "")}\n`);
    return;
  }

  const target = args.target;
  if (!target) fail("--target <threadId> is required");

  let prompt = args.prompt;
  if (args["prompt-file"]) {
    if (prompt) fail("use either --prompt or --prompt-file, not both");
    prompt = await readFile(args["prompt-file"], "utf8");
  }
  if (!prompt || !prompt.trim()) fail("--prompt <text> or --prompt-file <path> is required");

  const session = args.session ?? "live";
  if (session !== "live" && session !== "isolated") {
    fail(`--session must be "live" or "isolated" (got "${session}")`);
  }
  if (session === "live" && (args.model || args.effort)) {
    process.stderr.write(
      "seam-dispatch: warning — --model/--effort are ignored for --session live " +
        "(the thread's own session config wins); use --session isolated to override.\n"
    );
  }

  const dataDir = args["data-dir"] ?? process.env.DATA_DIR ?? "./data";
  // Mirrors dispatchDirs() in src/core/dispatch/types.ts.
  const dispatchRoot = path.resolve(dataDir, "dispatch");
  const pendingDir = path.join(dispatchRoot, "pending");
  const doneDir = path.join(dispatchRoot, "done");

  const id = randomUUID();
  const spec = {
    id,
    target,
    prompt,
    session,
    ...(args.model ? { model: args.model } : {}),
    ...(args.effort ? { effort: args.effort } : {}),
    ...(args.cwd ? { cwd: path.resolve(args.cwd) } : {}),
    ...(args.correlation ? { correlationId: args.correlation } : {}),
    ...(args["return-to"] ? { returnTo: args["return-to"] } : {}),
    createdUtc: new Date().toISOString(),
  };

  await mkdir(pendingDir, { recursive: true });
  // Write to a temp name and rename in, so the watcher can never claim a
  // half-written spec.
  const finalPath = path.join(pendingDir, `${id}.json`);
  const tmpPath = path.join(pendingDir, `.${id}.json.tmp`);
  await writeFile(tmpPath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  await rename(tmpPath, finalPath);

  if (!args.wait) {
    process.stdout.write(`${JSON.stringify({ id, target, queued: finalPath }, null, 2)}\n`);
    return;
  }

  const timeoutSecs = Number(args.timeout ?? 900);
  if (!Number.isFinite(timeoutSecs) || timeoutSecs <= 0) fail("--timeout must be a positive number");
  const donePath = path.join(doneDir, `${id}.json`);
  const deadline = Date.now() + timeoutSecs * 1000;

  while (Date.now() < deadline) {
    let raw;
    try {
      raw = await readFile(donePath, "utf8");
    } catch {
      await sleep(500);
      continue;
    }
    const result = JSON.parse(raw);
    if (args["output-only"]) {
      process.stdout.write(`${result.output ?? result.error ?? ""}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
    process.exit(result.status === "completed" ? 0 : 1);
  }

  process.stderr.write(
    `seam-dispatch: timed out after ${timeoutSecs}s waiting for ${donePath}\n` +
      `The dispatch may still be running — check that file later.\n`
  );
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`seam-dispatch: ${err?.stack ?? err}\n`);
  process.exit(1);
});

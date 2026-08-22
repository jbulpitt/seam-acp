#!/usr/bin/env npx tsx
/**
 * Relocate / rename a project folder through seam configs.
 *
 * Default is dry-run. Pass --apply to write. Optional --move copies the
 * folder, --symlink leaves the old name as an alias (the repo picker skips
 * symlink dirs), --vendor remaps Claude / AGY / Grok sessions (PATH CLIs
 * clamp / claude-mv / cc-port if present, plus native cwd/jsonl rewrite).
 * Successful --apply writes a force-restart sentinel unless --no-restart.
 *
 *   npx tsx scripts/relocate-repo.ts --from /old --to /new
 *   npx tsx scripts/relocate-repo.ts --from /old --to /new --apply --move --symlink --vendor
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyRelocatePlan,
  collectRelocatePlan,
  type RelocateHit,
} from "../packages/core/src/core/relocate-repo.js";
import { writeForceRestartSentinel } from "../packages/core/src/core/restart-sentinel.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv(root: string): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    for (const line of fs.readFileSync(path.join(root, ".env"), "utf8").split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m?.[1]) env[m[1]] = (m[2] ?? "").trim().replace(/^"|"$/g, "");
    }
  } catch {
    /* process.env only */
  }
  return env;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) return undefined;
  return v;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function help(): string {
  return `Relocate a project path through seam configs (sessions, named presets,
scheduled cwd, ingest-endpoint cwd, channel-presets.json, in-flight dispatch specs).

Usage:
  npx tsx scripts/relocate-repo.ts --from <old> --to <new> [options]
  npm run relocate-repo -- --from <old> --to <new> [options]

Required:
  --from PATH          Current project path stored in seam configs
  --to PATH            New project path

Write flags (off by default — dry-run prints the plan and exits):
  --apply              Write the remaps
  --move               Move the folder on this host (before rewriting configs)
  --symlink            Leave a symlink at --from pointing at --to
                       (repo picker ignores symlink dirs)
  --vendor             Remap agent sessions: Claude (jsonl cwd, history.jsonl,
                       ~/.claude.json, plus clamp/claude-mv/cc-port if on PATH),
                       AGY (agy-sessions.json, trustedWorkspaces, history,
                       conversation_summaries.db), Grok (encoded session dir +
                       working_directory / git_root_dir)
  --no-restart         After --apply, do not write the force-restart sentinel.
                       Default is to write it so seam-acp SIGTERMs live turns;
                       turn-resume continues them after boot.

Paths (defaults from .env):
  --data-dir PATH      DATA_DIR (default ./data)
  --db PATH            SQLite file (default <data-dir>/seam.db)
  --presets PATH       channel-presets.json
  --dispatch-dir PATH  dispatch/{pending,running}

Does not rewrite rider prose or .env. channel-presets.json hot-reloads on write.
A successful --apply writes data/.restart-pending with body "force" unless
--no-restart: seam-acp skips the drain, pm2-restarts, and turn-resume continues
interrupted turns at the new cwd.`;
}

function formatHit(h: RelocateHit): string {
  const who = h.label ? `${h.id} (${h.label})` : h.id;
  return `• ${h.surface}  ${who}\n    ${h.from}\n    → ${h.to}`;
}

function main(): void {
  if (flag("--help") || flag("-h")) {
    console.log(help());
    return;
  }
  const from = arg("--from");
  const to = arg("--to");
  if (!from || !to) {
    console.error(help());
    process.exit(1);
  }

  const fileEnv = loadEnv(ROOT);
  const dataDir = path.resolve(ROOT, arg("--data-dir") ?? fileEnv.DATA_DIR ?? process.env.DATA_DIR ?? "./data");
  const dbPath = path.resolve(arg("--db") ?? path.join(dataDir, "seam.db"));
  const presetsPath = path.resolve(
    arg("--presets") ??
      fileEnv.CHANNEL_PRESETS_FILE ??
      process.env.CHANNEL_PRESETS_FILE ??
      path.join(dataDir, "channel-presets.json")
  );
  const dispatchDir = path.resolve(arg("--dispatch-dir") ?? path.join(dataDir, "dispatch"));
  const apply = flag("--apply");
  const move = flag("--move");
  const symlink = flag("--symlink");
  const vendor = flag("--vendor");
  const noRestart = flag("--no-restart");

  const plan = collectRelocatePlan({
    from,
    to,
    dbPath: fs.existsSync(dbPath) ? dbPath : undefined,
    presetsPath: fs.existsSync(presetsPath) ? presetsPath : undefined,
    dispatchDir: fs.existsSync(dispatchDir) ? dispatchDir : undefined,
    vendor,
    move,
    symlink,
    agySessionsPath: fs.existsSync(path.join(dataDir, "agy-sessions.json"))
      ? path.join(dataDir, "agy-sessions.json")
      : undefined,
  });

  console.log(`Relocate plan${apply ? " (APPLY)" : " (dry-run)"}`);
  console.log(`from: ${plan.from}`);
  console.log(`to:   ${plan.to}`);
  console.log(`hits: ${plan.hits.length}`);
  if (plan.hits.length === 0) {
    console.log("No matching seam configs (or vendor dirs) for that path.");
  } else {
    for (const h of plan.hits) console.log(formatHit(h));
  }
  for (const w of plan.warnings) console.log(`warning: ${w}`);

  if (!apply) {
    console.log("Re-run with --apply to write. Add --move / --symlink / --vendor as needed.");
    if (!noRestart) {
      console.log("A successful --apply writes a force-restart sentinel (seam-acp SIGTERMs; turn-resume continues). Pass --no-restart to skip.");
    }
    return;
  }

  const result = applyRelocatePlan(plan, {
    dbPath: fs.existsSync(dbPath) ? dbPath : undefined,
    presetsPath: fs.existsSync(presetsPath) ? presetsPath : undefined,
    dispatchDir: fs.existsSync(dispatchDir) ? dispatchDir : undefined,
    move,
    symlink,
    vendor,
  });
  console.log(`applied: ${result.applied.length}`);
  for (const h of result.applied) console.log(formatHit(h));
  if (result.skipped.length > 0) {
    console.log(`skipped: ${result.skipped.length}`);
    for (const s of result.skipped) {
      console.log(`• ${s.hit.surface}  ${s.hit.id}: ${s.reason}`);
    }
  }
  if (result.backups.length > 0) {
    console.log("backups:");
    for (const b of result.backups) console.log(`• ${b}`);
  }
  for (const w of result.warnings) console.log(`warning: ${w}`);

  if (!noRestart && result.applied.length > 0) {
    const sentinel = writeForceRestartSentinel(dataDir);
    console.log(`force-restart sentinel written: ${sentinel}`);
    console.log("seam-acp will skip the drain, SIGTERM live turns, and turn-resume them after boot.");
  }
}

try {
  main();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

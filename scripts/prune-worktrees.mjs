#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { executeWorktreePrune, planWorktreePrune } from "./lib/worktree-prune.mjs";

function usage() {
  return `usage: node scripts/prune-worktrees.mjs [--repo <main-checkout>] [--data-dir <dir>] [--wt <path>] [--apply]\n\n` +
    `Default is a read-only dry-run. --apply tears down only clean branch worktrees whose exact head has a terminal GitHub PR and no unsettled dispatch binding.\n`;
}

export function parseWorktreePruneArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      apply: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      repo: { type: "string" },
      "data-dir": { type: "string" },
      wt: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  return values;
}

export function main(argv) {
  const values = parseWorktreePruneArgs(argv);
  if (values.help) {
    process.stdout.write(usage());
    return;
  }

  const repo = path.resolve(values.repo ?? process.cwd());
  const dataDir = path.resolve(values["data-dir"] ?? path.join(repo, "data"));
  const plan = planWorktreePrune({ repo, dataDir });
  const result = executeWorktreePrune({
    plan,
    apply: values.apply,
    wtBin: values.wt ?? process.env.WT_BIN ?? "wt",
  });
  process.stdout.write(`${JSON.stringify({
    mode: values.apply ? "apply" : "dry-run",
    repo: plan.repo,
    repository: plan.repository,
    candidates: plan.decisions,
    summary: {
      registered: plan.decisions.length,
      eligible: result.eligible.length,
      removed: result.removed.length,
      refusedAtApply: result.refused,
    },
  }, null, 2)}\n`);
  if (result.refused.length > 0) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`worktree-prune: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

#!/usr/bin/env node
/**
 * patch-claude-agent-acp.mjs
 *
 * Re-applies seam-acp's local patch to the globally-installed
 * `@agentclientprotocol/claude-agent-acp` package. A global `npm install -g`
 * overwrites the package, wiping the patch — so this MUST be re-run after every
 * update to that package (see docs/model-management-runbook.md §3).
 *
 * WHAT IT PATCHES & WHY
 * ---------------------
 * In claude-agent-acp 0.39, `unstable_setSessionModel` runs EVERY model string
 * (including full canonical IDs like `claude-opus-4-6[1m]`) through
 * `resolveModelPreference`, which fuzzy-matches against a tiny curated model
 * list ([default, sonnet, sonnet[1m], haiku]). Full Opus IDs find no Opus entry,
 * fuzzy-match, and the `[1m]` token drags them to Sonnet. Net effect: selecting
 * `claude-opus-4-6[1m]` silently runs Sonnet; `claude-sonnet-4-6[1m]` silently
 * runs at 200K. The raw Claude Code CLI resolves all of these correctly — the
 * wrapper is the sole source of the defect.
 *
 * THE FIX (one line, surgical bypass):
 * When the input is already a canonical full ID (`/^claude-…(\[1m\])?$/`), skip
 * `resolveModelPreference` entirely and pass the string straight to
 * `query.setModel`, which handles it correctly. Aliases (opus[1m], sonnet, …)
 * still go through the resolver unchanged, so nothing else regresses. Verified:
 * full IDs resolve to the exact model + window, and the effort option survives.
 *
 * IDEMPOTENT: safe to run repeatedly. Exits 0 if already patched or freshly
 * patched; exits 1 (loudly) if the anchor can't be found — which means the
 * upstream code moved and the patch must be re-derived against the new version.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";

const MARKER = "SEAM-PATCH: full IDs bypass broken resolver";

const ANCHOR =
  "const resolved = resolveModelPreference(session.modelInfos, params.modelId);";

const REPLACEMENT =
  "const resolved = /^claude-[a-z0-9.-]+(\\[1m\\])?$/i.test(params.modelId.trim())" +
  " ? null : resolveModelPreference(session.modelInfos, params.modelId);" +
  ` /*${MARKER}*/`;

function globalRoot() {
  return execSync("npm root -g", { encoding: "utf8" }).trim();
}

function main() {
  const pkgFile = path.join(
    globalRoot(),
    "@agentclientprotocol",
    "claude-agent-acp",
    "dist",
    "acp-agent.js"
  );

  let src;
  try {
    src = readFileSync(pkgFile, "utf8");
  } catch (err) {
    console.error(`[patch] cannot read ${pkgFile}: ${err.message}`);
    console.error("[patch] is @agentclientprotocol/claude-agent-acp installed globally?");
    process.exit(1);
  }

  if (src.includes(MARKER)) {
    console.log("[patch] already patched — no change.");
    process.exit(0);
  }

  if (!src.includes(ANCHOR)) {
    console.error("[patch] ANCHOR NOT FOUND. The upstream code has changed shape.");
    console.error("[patch] Re-derive the patch against the new version:");
    console.error("[patch]   1. Find where unstable_setSessionModel calls resolveModelPreference");
    console.error("[patch]   2. Make full canonical IDs bypass it (see this file's header)");
    console.error("[patch]   3. Update ANCHOR/REPLACEMENT here, then re-run + re-verify (runbook §4)");
    process.exit(1);
  }

  copyFileSync(pkgFile, pkgFile + ".seam-bak");
  const patched = src.replace(ANCHOR, REPLACEMENT);
  writeFileSync(pkgFile, patched);

  // Syntax-check the result so a bad patch fails here, not at runtime.
  try {
    execSync(`node --check "${pkgFile}"`, { stdio: "pipe" });
  } catch (err) {
    copyFileSync(pkgFile + ".seam-bak", pkgFile);
    console.error("[patch] patched file failed syntax check — reverted. Error:");
    console.error(err.stderr?.toString() ?? err.message);
    process.exit(1);
  }

  console.log(`[patch] applied to ${pkgFile}`);
  console.log("[patch] backup at " + pkgFile + ".seam-bak");
  console.log("[patch] RE-VERIFY now with the runbook §4 probe before trusting it.");
}

main();

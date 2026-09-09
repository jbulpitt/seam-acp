#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildArtifact, commandRunner, loadTargetMap, makeScpCommand, makeSshCommand, parseArgs, resolveTarget, rollbackPlan, runPreflight } from "./lib/bridge-rollout.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

function usage() {
  console.log("Usage:");
  console.log("  node scripts/bridge-rollout.mjs --target <bridge-id>");
  console.log("  node scripts/bridge-rollout.mjs --target <bridge-id> --stage --apply");
  console.log("  node scripts/bridge-rollout.mjs --target <bridge-id> --activate --sha <40-hex> --checksum <64-hex> --apply");
  console.log("  node scripts/bridge-rollout.mjs --target <bridge-id> --rollback --apply");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return usage();
  const targets = await loadTargetMap(path.join(repoRoot, "ops/bridge/targets.json"));
  const target = resolveTarget(targets, options.target);
  const remoteScript = await fs.readFile(path.join(scriptDir, "bridge-rollout-remote.sh"), "utf8");
  const preflight = await runPreflight(target, remoteScript);
  process.stdout.write(preflight.stdout);
  if (options.action === "preflight") {
    console.log("mode=dry-run");
    console.log("remote_mutation=no");
    console.log(`next_stage=npm run bridge:rollout -- --target ${target.bridgeId} --stage --apply`);
    return;
  }
  if (options.action === "stage") {
    const artifact = await buildArtifact(repoRoot);
    await commandRunner(makeSshCommand(target, ["prepare-upload", target.pm2App, target.bridgeId, target.verifyAgent], remoteScript));
    await commandRunner(makeScpCommand(target, artifact.archive, artifact.remoteName));
    const staged = await commandRunner(makeSshCommand(target, ["stage", target.pm2App, target.bridgeId, target.verifyAgent, artifact.sha, artifact.checksum, artifact.remoteName], remoteScript));
    process.stdout.write(staged.stdout);
    console.log(`activate_command=npm run bridge:rollout -- --target ${target.bridgeId} --activate --sha ${artifact.sha} --checksum ${artifact.checksum} --apply`);
    return;
  }
  if (options.action === "activate") {
    console.log(`rollback_command=${rollbackPlan(target).command}`);
    const result = await commandRunner(makeSshCommand(target, ["activate", target.pm2App, target.bridgeId, target.verifyAgent, options.sha, options.checksum, String(options.timeoutSeconds)], remoteScript));
    process.stdout.write(result.stdout);
    return;
  }
  const result = await commandRunner(makeSshCommand(target, ["rollback", target.pm2App, target.bridgeId, target.verifyAgent, String(options.timeoutSeconds)], remoteScript));
  process.stdout.write(result.stdout);
}

main().catch((error) => {
  console.error(`bridge rollout refused: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

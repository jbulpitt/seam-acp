#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { activationRefusal, buildArtifact, commandRunner, loadTargetMap, makeScpCommand, makeSshCommand, parseArgs, parseKeyValues, renderRemoteScript, resolveTarget, rollbackPlan, runPreflight } from "./lib/bridge-rollout.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const nonce = () => randomBytes(32).toString("hex");

function usage() {
  console.log("Usage:");
  console.log("  node scripts/bridge-rollout.mjs --target <bridge-id>");
  console.log("  node scripts/bridge-rollout.mjs --target <bridge-id> --stage --apply");
  console.log("  node scripts/bridge-rollout.mjs --target <bridge-id> --enroll --apply");
  console.log("  node scripts/bridge-rollout.mjs --target <bridge-id> --restore-baseline --enrollment-id <64-hex> --apply");
  console.log("  node scripts/bridge-rollout.mjs --target <bridge-id> --activate --sha <40-hex> --checksum <64-hex> --stage-id <64-hex> --apply");
  console.log("  node scripts/bridge-rollout.mjs --target <bridge-id> --rollback --activation-id <64-hex> --apply");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return usage();
  const targets = await loadTargetMap(path.join(repoRoot, "ops/bridge/targets.json"));
  const target = resolveTarget(targets, options.target);
  const remoteScript = await renderRemoteScript(path.join(scriptDir, "bridge-rollout-remote.sh"), path.join(scriptDir, "bridge-rollout-remote.mjs"));
  const preflight = await runPreflight(target, remoteScript);
  process.stdout.write(preflight.stdout);
  if (options.action === "preflight") {
    console.log("mode=dry-run"); console.log("remote_mutation=no");
    console.log(`next_stage=npm run bridge:rollout -- --target ${target.bridgeId} --stage --apply`);
    return;
  }
  if (options.action === "stage") {
    const artifact = await buildArtifact(repoRoot);
    const operationId = nonce();
    await commandRunner(makeSshCommand(target, ["prepare-upload", operationId], remoteScript));
    const uploadName = `${artifact.remoteName}.upload-${operationId}`;
    await commandRunner(makeScpCommand(target, artifact.archive, uploadName));
    const staged = await commandRunner(makeSshCommand(target, ["stage", artifact.sha, artifact.checksum, uploadName, operationId], remoteScript));
    process.stdout.write(staged.stdout);
    const stageId = parseKeyValues(staged.stdout).stage_id;
    if (!/^[0-9a-f]{64}$/.test(stageId ?? "")) throw new Error("remote stage did not return an immutable stage id");
    console.log(`activate_command=npm run bridge:rollout -- --target ${target.bridgeId} --activate --sha ${artifact.sha} --checksum ${artifact.checksum} --stage-id ${stageId} --apply`);
    return;
  }
  if (options.action === "enroll") {
    // Enrollment records a baseline for the host as it is. It deliberately does
    // NOT require rollout readiness: an unmanaged host that is not yet
    // receipt-capable is exactly the host that needs a recorded baseline. It
    // does not alter or signal the RUNNABLE deployment — no entrypoint switch,
    // no install, no signal beyond a liveness probe — though it does write
    // rollout metadata and take the target lock, so activation stays a
    // separate, later, explicitly invoked phase.
    const enrollmentId = nonce(); const operationId = nonce();
    const result = await commandRunner(makeSshCommand(target, ["enroll", enrollmentId, operationId], remoteScript));
    process.stdout.write(result.stdout);
    const report = parseKeyValues(result.stdout);
    if (report.process_signaled !== "no" || report.artifact_changed !== "no") throw new Error("enrollment reported a mutation it must never perform");
    console.log(`restore_command=npm run bridge:rollout -- --target ${target.bridgeId} --restore-baseline --enrollment-id ${report.enrollment_id} --apply`);
    return;
  }
  if (options.action === "restore-baseline") {
    const operationId = nonce();
    const result = await commandRunner(makeSshCommand(target, ["restore-baseline", options.enrollmentId, operationId], remoteScript));
    process.stdout.write(result.stdout);
    return;
  }
  if (preflight.report.rollout_ready !== "yes") throw new Error(activationRefusal(preflight.report));
  if (options.action === "activate") {
    const activationId = nonce(); const operationId = nonce();
    console.log(`activation_id=${activationId}`);
    console.log(`rollback_command=${rollbackPlan(target, activationId).command}`);
    const result = await commandRunner(makeSshCommand(target, ["activate", options.sha, options.checksum, options.stageId, activationId, String(options.timeoutSeconds), operationId], remoteScript));
    process.stdout.write(result.stdout);
    return;
  }
  const rollbackId = nonce(); const operationId = nonce();
  const result = await commandRunner(makeSshCommand(target, ["rollback", options.activationId, rollbackId, String(options.timeoutSeconds), operationId], remoteScript));
  process.stdout.write(result.stdout);
}

main().catch((error) => {
  console.error(`bridge rollout refused: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { activationRefusal, buildArtifact, firstActivationFromBaselineAllowed, commandRunner, loadTargetMap, makeScpCommand, makeSshCommand, parseArgs, parseKeyValues, renderRemoteScript, resolveTarget, runActivation, runPreflight } from "./lib/bridge-rollout.mjs";
import { blockingOnly, collectBlockers, describeTargetFleet, fleetRunExitCode, formatBlockers, formatFleetCoverage, formatFleetRunSummary, loadBridgeRegistry, makeReachabilityProbe, partitionReachability, planFleetRun } from "./lib/bridge-fleet.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const nonce = () => randomBytes(32).toString("hex");

function usage() {
  console.log("Usage:");
  console.log("  node scripts/bridge-rollout.mjs --target <bridge-id>");
  console.log("  node scripts/bridge-rollout.mjs --all                        # preflight every managed host");
  console.log("  node scripts/bridge-rollout.mjs --target <bridge-id> --rollout --apply   # stage + activate");
  console.log("  node scripts/bridge-rollout.mjs --all --rollout --apply [--auto-enroll]");
  console.log("  node scripts/bridge-rollout.mjs --target <bridge-id> --stage --apply");
  console.log("  node scripts/bridge-rollout.mjs --target <bridge-id> --enroll --apply");
  console.log("  node scripts/bridge-rollout.mjs --target <bridge-id> --restore-baseline --enrollment-id <64-hex> --apply");
  console.log("  node scripts/bridge-rollout.mjs --target <bridge-id> --activate --sha <40-hex> --checksum <64-hex> --stage-id <64-hex> --apply");
  console.log("  node scripts/bridge-rollout.mjs --target <bridge-id> --rollback --activation-id <64-hex> --apply");
}

/**
 * One SSH preflight, reused for both the authoritative verdict and the
 * blocker report (#484).
 *
 * `runPreflight` takes an injectable runner, so handing it the result already
 * in hand costs no second round trip and changes nothing about what it
 * concludes — it runs exactly the same validations against exactly the same
 * evidence. The raw report is kept so refusals can be gathered and shown
 * together instead of one per invocation.
 */
async function preflightOnce(target, remoteScript) {
  const command = makeSshCommand(target, ["preflight"], remoteScript);
  const raw = await commandRunner(command);
  const report = parseKeyValues(raw.stdout);
  let verdict = null;
  let verdictError = null;
  try {
    verdict = await runPreflight(target, remoteScript, async () => raw);
  } catch (error) {
    verdictError = error;
  }
  return { raw, report, verdict, verdictError };
}

/** Stage an already-built artifact onto one host and return its stage id. */
async function stageArtifact(target, remoteScript, artifact) {
  const operationId = nonce();
  await commandRunner(makeSshCommand(target, ["prepare-upload", operationId], remoteScript));
  const uploadName = `${artifact.remoteName}.upload-${operationId}`;
  await commandRunner(makeScpCommand(target, artifact.archive, uploadName));
  const staged = await commandRunner(makeSshCommand(target, ["stage", artifact.sha, artifact.checksum, uploadName, operationId], remoteScript));
  process.stdout.write(staged.stdout);
  const stageId = parseKeyValues(staged.stdout).stage_id;
  if (!/^[0-9a-f]{64}$/.test(stageId ?? "")) throw new Error("remote stage did not return an immutable stage id");
  return stageId;
}

/**
 * Enrollment records a baseline for the host as it is. It deliberately does
 * NOT require rollout readiness: an unmanaged host that is not yet
 * receipt-capable is exactly the host that needs a recorded baseline. It does
 * not alter or signal the RUNNABLE deployment — no entrypoint switch, no
 * install, no signal beyond a liveness probe — though it does write rollout
 * metadata and take the target lock.
 */
async function enrollHost(target, remoteScript) {
  const enrollmentId = nonce(); const operationId = nonce();
  const result = await commandRunner(makeSshCommand(target, ["enroll", enrollmentId, operationId], remoteScript));
  process.stdout.write(result.stdout);
  const report = parseKeyValues(result.stdout);
  if (report.process_signaled !== "no" || report.artifact_changed !== "no") throw new Error("enrollment reported a mutation it must never perform");
  return report;
}

/**
 * Stage and activate in one invocation (#484 item 4).
 *
 * Staging already printed a 200-character activate command carrying three
 * hashes it had just generated itself. Nothing about the split was a safety
 * property — the operator was transcribing values the tool produced — so the
 * combined path runs them, and `--stage` alone stays available for staged or
 * manual flows.
 */
async function rolloutHost({ target, remoteScript, artifact, options, preflight }) {
  let { report, verdict, verdictError } = preflight;

  // #484 item 5: enrollment is the one blocker that can be cleared without
  // touching the running deployment, so when it is the SOLE blocker and the
  // operator asked for it, clear it inline rather than making it a discovered
  // round trip. Any other blocker still refuses.
  if (options.autoEnroll && report.enrolled === "no") {
    const others = collectBlockers(report, target).filter((row) => row.code !== "not_enrolled" && row.code !== "not_rollout_ready");
    if (others.length) {
      throw new Error(`auto-enroll declined: ${others.length} other blocker(s) remain — ${others.map((r) => r.code).join(", ")}`);
    }
    console.log(`auto_enroll=${target.bridgeId}`);
    await enrollHost(target, remoteScript);
    ({ report, verdict, verdictError } = await preflightOnce(target, remoteScript));
  }

  if (verdictError) throw verdictError;
  const stageId = await stageArtifact(target, remoteScript, artifact);
  const firstFromBaseline = firstActivationFromBaselineAllowed(report);
  if (report.rollout_ready !== "yes" && !firstFromBaseline) throw new Error(activationRefusal(report));
  if (firstFromBaseline) {
    console.log("first_activation_from=enrolled-baseline");
    console.log(`baseline_rollback_proof=${report.baseline_rollback_proof}`);
  }
  const activationId = nonce(); const operationId = nonce();
  const result = await runActivation({
    target,
    options: { ...options, sha: artifact.sha, checksum: artifact.checksum, stageId },
    activationId, operationId, remoteScript, before: verdict?.report ?? report,
  });
  process.stdout.write(result.stdout);
  if (result.exitCode !== 0) throw new Error(`activation reported failure for ${target.bridgeId}`);
  return { activationId };
}

/**
 * Walk every rollout-managed host and print one summary (#484 item 1).
 *
 * The fleet was already described and printed on every run and then never
 * iterated. Sequential by choice: predictability beats speed for an operation
 * that restarts production bridges one at a time.
 */
async function runFleet({ targets, fleet, options, remoteScript }) {
  const plan = planFleetRun(fleet);
  const results = [];

  // Reachability first. Six of ten hosts were unreachable on 2026-09-21; for a
  // fleet of laptops that is ordinary, so it is a counted skip and not an
  // error. Probes are read-only, so they run together.
  const probes = await Promise.all(plan.attempt.map(async (id) => {
    const target = targets.get(id);
    try {
      await commandRunner(makeReachabilityProbe(target));
      return { id, reachable: true };
    } catch (error) {
      return { id, reachable: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }));
  const reach = partitionReachability(probes);
  console.log(`fleet_reachable=${reach.reachable.length}${reach.reachable.length ? `: ${reach.reachable.join(", ")}` : ""}`);
  if (reach.unreachable.length) {
    console.log(`fleet_unreachable=${reach.unreachable.length}: ${reach.unreachable.map((r) => r.id).join(", ")}`);
  }
  for (const row of reach.unreachable) results.push({ id: row.id, outcome: "skipped-unreachable", reason: row.detail });

  // One artifact for the whole fleet: every host gets the same bytes, and a
  // dirty worktree is caught once rather than per host.
  let artifact = null;
  if (options.action === "rollout") {
    artifact = await buildArtifact(repoRoot);
    console.log(`fleet_artifact_sha=${artifact.sha}`);
    console.log(`fleet_artifact_checksum=${artifact.checksum}`);
  }

  for (const id of reach.reachable) {
    const target = targets.get(id);
    console.log(`\nhost=${id}`);
    try {
      const preflight = await preflightOnce(target, remoteScript);
      process.stdout.write(preflight.raw.stdout);
      const blockers = collectBlockers(preflight.report, target, targets);
      console.log(formatBlockers(id, blockers));
      if (options.action === "preflight") {
        // Only a BLOCKING finding means this host would be turned away. An
        // advisory is reported and counted, but calling it a refusal would
        // invent one — a real fleet preflight flagged a managed, rollout-ready
        // host as refused purely over a stale rollback baseline.
        const blocking = blockingOnly(blockers);
        results.push({
          id,
          outcome: blocking.length ? "refused" : "succeeded",
          reason: blocking.length ? blocking.map((b) => b.code).join(", ") : undefined,
          blockers: blocking,
          advisories: blockers.filter((b) => b.severity !== "blocking"),
        });
        continue;
      }
      await rolloutHost({ target, remoteScript, artifact, options, preflight });
      results.push({ id, outcome: "succeeded" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`host_failed=${id}: ${reason}`);
      results.push({ id, outcome: "refused", reason });
    }
  }

  console.log(`\n${formatFleetRunSummary(results)}`);
  process.exitCode = fleetRunExitCode(results);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return usage();
  const targets = await loadTargetMap(path.join(repoRoot, "ops/bridge/targets.json"));
  const configuredRegistry = process.env.CHANNEL_PRESETS_FILE ??
    path.join(process.env.DATA_DIR ?? "data", "channel-presets.json");
  const registryFile = path.resolve(repoRoot, configuredRegistry);
  const registered = await loadBridgeRegistry(registryFile);
  const fleet = describeTargetFleet(targets, registered);
  console.log(formatFleetCoverage(fleet, options.target));
  const remoteScript = await renderRemoteScript(path.join(scriptDir, "bridge-rollout-remote.sh"), path.join(scriptDir, "bridge-rollout-remote.mjs"));

  if (options.all) return runFleet({ targets, fleet, options, remoteScript });

  const target = resolveTarget(targets, options.target);
  const preflight = await preflightOnce(target, remoteScript);
  process.stdout.write(preflight.raw.stdout);

  if (options.action === "preflight") {
    // #484 item 3: every blocker this report can see, each with its
    // remediation, instead of one per round trip.
    console.log(formatBlockers(target.bridgeId, collectBlockers(preflight.report, target, targets)));
    if (preflight.verdictError) throw preflight.verdictError;
    console.log("mode=dry-run"); console.log("remote_mutation=no");
    console.log(`next_rollout=npm run bridge:rollout -- --target ${target.bridgeId} --rollout --apply`);
    return;
  }

  if (options.action === "rollout") {
    const artifact = await buildArtifact(repoRoot);
    await rolloutHost({ target, remoteScript, artifact, options, preflight });
    return;
  }

  if (preflight.verdictError) throw preflight.verdictError;
  const report = preflight.report;

  if (options.action === "stage") {
    const artifact = await buildArtifact(repoRoot);
    const stageId = await stageArtifact(target, remoteScript, artifact);
    console.log(`activate_command=npm run bridge:rollout -- --target ${target.bridgeId} --activate --sha ${artifact.sha} --checksum ${artifact.checksum} --stage-id ${stageId} --apply`);
    return;
  }
  if (options.action === "enroll") {
    const enrolled = await enrollHost(target, remoteScript);
    console.log(`restore_command=npm run bridge:rollout -- --target ${target.bridgeId} --restore-baseline --enrollment-id ${enrolled.enrollment_id} --apply`);
    return;
  }
  if (options.action === "restore-baseline") {
    const operationId = nonce();
    const result = await commandRunner(makeSshCommand(target, ["restore-baseline", options.enrollmentId, operationId], remoteScript));
    process.stdout.write(result.stdout);
    return;
  }
  // A first managed activation from a verified enrolled baseline is the one
  // exception, and only for ACTIVATE: rollback and every managed-to-managed
  // transition keep the full capability requirement unchanged.
  const firstFromBaseline = options.action === "activate" && firstActivationFromBaselineAllowed(report);
  if (report.rollout_ready !== "yes" && !firstFromBaseline) {
    throw new Error(activationRefusal(report));
  }
  if (firstFromBaseline) {
    console.log("first_activation_from=enrolled-baseline");
    console.log(`baseline_rollback_proof=${report.baseline_rollback_proof}`);
  }
  if (options.action === "activate") {
    const activationId = nonce(); const operationId = nonce();
    const result = await runActivation({ target, options, activationId, operationId, remoteScript, before: report });
    process.stdout.write(result.stdout);
    process.exitCode = result.exitCode;
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

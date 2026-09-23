import fs from "node:fs/promises";
import { firstActivationFromBaselineAllowed } from "./bridge-rollout.mjs";

const SAFE_BRIDGE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function validateBridgeRegistry(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      !input.bridges || typeof input.bridges !== "object" || Array.isArray(input.bridges)) {
    throw new Error("invalid channel-presets bridge registry");
  }
  const ids = Object.keys(input.bridges);
  for (const id of ids) {
    if (!SAFE_BRIDGE_ID.test(id)) throw new Error(`unsafe registered bridge ${JSON.stringify(id)}`);
  }
  return new Set(ids);
}

export async function loadBridgeRegistry(file) {
  return validateBridgeRegistry(JSON.parse(await fs.readFile(file, "utf8")));
}

export function describeTargetFleet(targets, registered = new Set(targets.keys())) {
  const targetIds = new Set(targets.keys());
  const missingTargets = [...registered].filter((id) => !targetIds.has(id)).sort();
  const unregisteredTargets = [...targetIds].filter((id) => !registered.has(id)).sort();

  // #413 is why divergence must never be silent: plex-server and rhc-server
  // existed only in the live registry, so five "all hosts" checks quietly
  // never considered them. The answer to a silent gap is LOUD, not STOPPED.
  //
  // Refusing the whole fleet because one host diverges punishes nine healthy
  // machines for one anomaly, and a retired host or an unreachable laptop is
  // an ordinary state, not an emergency. `cli-health-report.mjs` already got
  // this right with `unchecked-registry-divergence`: narrow the scope to the
  // affected host and keep going. This now matches it.
  //
  // Divergent hosts are reported, excluded from managed scope, and named in
  // every coverage line, so a run can never claim coverage it does not have.
  // A caller that targets a divergent host specifically still fails — the
  // thing #413 actually needed was that you cannot operate on a host whose
  // registration you do not understand.
  const diverged = [
    ...missingTargets.map((id) => ({ id, reason: "registered bridge absent from targets.json" })),
    ...unregisteredTargets.map((id) => ({ id, reason: "targets.json host absent from the bridge registry" })),
  ].sort((a, b) => a.id.localeCompare(b.id));

  const rolloutManaged = [];
  const rolloutExcluded = [];
  for (const id of [...registered].sort()) {
    if (!targetIds.has(id)) continue; // diverged; reported below, never managed
    const target = targets.get(id);
    if (target.rolloutEnabled) rolloutManaged.push(id);
    else rolloutExcluded.push({ id, reason: target.unmanagedReason });
  }
  for (const row of diverged) rolloutExcluded.push({ id: row.id, reason: `registry divergence: ${row.reason}` });

  return Object.freeze({
    registered: Object.freeze([...registered].sort()),
    rolloutManaged: Object.freeze(rolloutManaged),
    rolloutExcluded: Object.freeze(rolloutExcluded.sort((a, b) => a.id.localeCompare(b.id)).map((row) => Object.freeze(row))),
    diverged: Object.freeze(diverged.map((row) => Object.freeze(row))),
  });
}

/** Refuse ONLY when the host being operated on is itself divergent. */
export function assertTargetRegistered(fleet, targetId) {
  const row = fleet.diverged.find((d) => d.id === targetId);
  if (row) {
    throw new Error(
      `bridge fleet registry divergence for ${targetId}: ${row.reason}. ` +
      `Other hosts are unaffected and remain operable.`
    );
  }
}

export function formatFleetCoverage(fleet, selectedHost = null) {
  const lines = [
    `fleet_registered=${fleet.registered.length}`,
    `fleet_rollout_managed=${fleet.rolloutManaged.length} of ${fleet.registered.length}`,
    `fleet_rollout_excluded=${fleet.rolloutExcluded.length}`,
  ];
  if (selectedHost) lines.push(`operation_scope=1 of ${fleet.registered.length} registered hosts: ${selectedHost}`);
  else lines.push(`operation_scope=${fleet.rolloutManaged.length} of ${fleet.registered.length} registered hosts: ${fleet.rolloutManaged.join(", ") || "none"}`);
  for (const row of fleet.rolloutExcluded) lines.push(`fleet_excluded=${row.id}: ${row.reason}`);
  return lines.join("\n");
}

/**
 * #484 — the fleet was described on every run and then never walked.
 *
 * `describeTargetFleet` and `formatFleetCoverage` were already called by
 * `main()` on every invocation, so the tool printed what the whole fleet was
 * and then acted on exactly one host, because `parseArgs` took a single
 * `--target`. Upgrading four hosts on 2026-09-21 cost roughly ten invocations.
 *
 * Everything below is reporting and sequencing. No check changes what it
 * concludes: the same refusals fire, they are simply gathered and shown
 * together instead of one per round trip.
 */

/**
 * A read-only "can I even reach this host" probe.
 *
 * Deliberately not `makeSshCommand`: that carries the full deployment identity
 * and is the shape used for operations. This asks one question and mutates
 * nothing, with a short timeout because the expected answer for a laptop is no.
 */
export function makeReachabilityProbe(target) {
  if (!SAFE_BRIDGE_ID.test(target?.sshAlias ?? "")) {
    throw new Error(`target ${target?.bridgeId ?? "unknown"} has no verified SSH management path`);
  }
  return {
    file: "ssh",
    args: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=accept-new", "--", target.sshAlias, "true"],
    mutates: false,
    timeoutMs: 15_000,
  };
}

/** Hosts a fleet run will actually attempt, in a stable order. */
export function planFleetRun(fleet) {
  return Object.freeze({
    attempt: Object.freeze([...fleet.rolloutManaged]),
    excluded: fleet.rolloutExcluded,
  });
}

/**
 * Split probe results into reachable and unreachable.
 *
 * Six of ten hosts were unreachable on 2026-09-21. For a fleet of laptops that
 * is an ordinary state, not a failure, so a fleet run reports a count and
 * carries on rather than erroring into each one.
 */
export function partitionReachability(probes) {
  const reachable = [];
  const unreachable = [];
  for (const probe of probes) {
    if (probe.reachable) reachable.push(probe.id);
    else unreachable.push(Object.freeze({ id: probe.id, detail: probe.detail ?? "ssh probe failed" }));
  }
  return Object.freeze({ reachable: Object.freeze(reachable), unreachable: Object.freeze(unreachable) });
}

/** Fleet-standard major/minor, derived from the targets rather than hardcoded. */
function fleetNodeBaseline(targets) {
  const counts = new Map();
  for (const target of targets.values()) {
    const match = /\/v(\d+\.\d+\.\d+)\//.exec(target?.nodePath ?? "");
    if (match) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  }
  let best = null;
  for (const [version, n] of counts) if (!best || n > best.n) best = { version, n };
  return best?.version ?? null;
}

/**
 * Every blocker visible in one preflight report, each with its remediation.
 *
 * ## What the issue asked and what is actually true
 *
 * The issue flagged as unknown whether `runPreflight` can continue past a
 * failed check. It can, for most of them, and the reason matters: `runPreflight`
 * makes **one** SSH round trip and then runs roughly a dozen *local*
 * validations against the report it already holds. Nothing after the first
 * check needs the network.
 *
 * So the "one blocker per round trip" experience was never preflight stopping
 * early on the remote. The blockers are spread across three phases that each
 * throw independently — `buildArtifact`'s worktree check, `runPreflight`'s
 * validations, and `main`'s activation gate — and you only reach the next
 * phase by fixing the one in front of you.
 *
 * The distinction that decides what is safe to collect:
 *
 *   - **Integrity** checks ("evidence is incomplete") say the report cannot be
 *     trusted. Reading further fields from it would be reporting on garbage,
 *     so those still stop, and this returns what it has.
 *   - **Policy** refusals — no reviewed prebuild, not rollout-ready, not
 *     enrolled, no disk — are conclusions drawn from a report already proven
 *     well-formed. Those are collectable, and they are the ones that cost the
 *     morning.
 *
 * This function draws no new conclusions. It reads the same fields the same
 * checks read and states them together.
 */
export function collectBlockers(report, target, targets = new Map()) {
  const blockers = [];
  const add = (code, severity, detail, remediation) => blockers.push(Object.freeze({ code, severity, detail, remediation }));
  if (!report || typeof report !== "object") return Object.freeze([]);
  const id = target?.bridgeId ?? report.bridge_id ?? "target";
  // Severity is read off the gates that already exist rather than invented
  // here. A real fleet preflight on 2026-09-21 marked macbook-air "refused"
  // over a stale baseline while it was managed, rollout-ready and serving —
  // a refusal this reporting layer had made up. Advisory findings are still
  // shown; they simply do not claim a rollout would be turned away.
  const firstFromBaseline = firstActivationFromBaselineAllowed(report);
  const legacy = report.artifact_mode === "legacy-checkout";

  // #412: every fact was present and nothing assembled them. The declared node
  // path, its version, and the ABI the prebuild needs were each reported
  // separately, and the operator saw only "no reviewed prebuild".
  if (report.native_install_ready === "no") {
    const abi = /-node-(v\d+)-/.exec(report.native_prebuild ?? "")?.[1] ?? "unknown-abi";
    const declared = /\/v(\d+\.\d+\.\d+)\//.exec(target?.nodePath ?? "")?.[1];
    const baseline = fleetNodeBaseline(targets);
    const drift = declared && baseline && declared !== baseline
      ? ` The declared nodePath pins v${declared} while the fleet standard is v${baseline}.`
      : "";
    add(
      "native_prebuild_unavailable",
      "blocking",
      `${report.native_dependency ?? "native dependency"} has no reviewed prebuild for ABI ${abi} ` +
      `(node ${report.node_version ?? "unknown"} at ${report.node_path ?? "unknown path"}).${drift}`,
      drift
        ? `point nodePath at the fleet standard v${baseline} in ops/bridge/targets.json, or add a reviewed prebuild for ${abi}`
        : `add a reviewed prebuild for ${abi}, or move this host to a node whose ABI already has one`
    );
  }

  // Declared vs observed, which is a different fault from the one above and
  // can be true while the prebuild is fine.
  if (report.node_path && target?.nodePath && report.node_path !== target.nodePath) {
    add(
      "node_path_drift",
      "advisory",
      `targets.json declares ${target.nodePath}; the host resolved ${report.node_path}`,
      `reconcile ops/bridge/targets.json with the host, or repoint the host's node`
    );
  }

  if (report.enrolled === "no") {
    add(
      "not_enrolled",
      legacy ? "blocking" : "advisory",
      "no baseline is recorded for this host, so there is no rollback target yet (legacy_previous_release_not_receipt_capable)",
      `npm run bridge:rollout -- --target ${id} --enroll --apply`
    );
  } else if (report.enrolled === "drifted") {
    add(
      "enrolled_baseline_drift",
      "advisory",
      "the recorded baseline no longer matches this host (enrolled_baseline_state_drift)",
      legacy
        ? `re-enroll this host: npm run bridge:rollout -- --target ${id} --enroll --apply`
        : `record the current managed release: npm run bridge:rollout -- --target ${id} --rebaseline --apply`
    );
  }

  if (report.rollout_ready === "no") {
    add(
      "not_rollout_ready",
      firstFromBaseline ? "advisory" : "blocking",
      `active bridge lacks verified drain/protocol/catalog capability ` +
      `(protocol=${report.protocol_version ?? "?"} drain=${report.drain_SIGUSR2 ?? "?"} ` +
      `describe=${report.describeModelCatalog ?? "?"} fetch=${report.fetchModelCatalog ?? "?"})`,
      report.enrolled === "no"
        ? `enroll first, then a first managed activation from the recorded baseline is permitted`
        : `upgrade the running bridge before it can be rolled forward`
    );
  }

  if (report.disk_bytes_available !== undefined && /^\d+$/.test(report.disk_bytes_available)) {
    const bytes = BigInt(report.disk_bytes_available);
    if (bytes < 536_870_912n) {
      add("low_disk", "blocking", `${bytes} bytes free at ${report.disk_path ?? "the checkout path"}`, "free space on the target before staging");
    }
  }

  return Object.freeze(blockers.map((row) => Object.freeze(row)));
}

/** Blockers that would actually turn a rollout away, as opposed to facts worth knowing. */
export function blockingOnly(blockers) {
  return blockers.filter((row) => row.severity === "blocking");
}

export function formatBlockers(hostId, blockers) {
  if (!blockers.length) return `host_clear=${hostId}`;
  const blocking = blockingOnly(blockers);
  const lines = blocking.length
    ? [`host_blocked=${hostId} blocking=${blocking.length} advisory=${blockers.length - blocking.length}`]
    : [`host_clear=${hostId} advisory=${blockers.length}`];
  for (const row of blockers) {
    lines.push(`  ${row.severity}=${row.code}: ${row.detail}`);
    lines.push(`    remediation=${row.remediation}`);
  }
  return lines.join("\n");
}

/**
 * One summary at the end of a fleet run.
 *
 * Deliberately counts every host the run considered, so "nothing happened"
 * and "nothing was attempted" cannot look alike.
 */
export function formatFleetRunSummary(results) {
  const by = (outcome) => results.filter((row) => row.outcome === outcome);
  const succeeded = by("succeeded");
  const unreachable = by("skipped-unreachable");
  const refused = by("refused");
  const failed = by("failed");
  const lines = [
    "fleet_run_summary",
    `  considered=${results.length}`,
    `  succeeded=${succeeded.length}${succeeded.length ? `: ${succeeded.map((r) => r.id).join(", ")}` : ""}`,
    `  skipped_unreachable=${unreachable.length}${unreachable.length ? `: ${unreachable.map((r) => r.id).join(", ")}` : ""}`,
    `  refused=${refused.length}`,
    `  failed=${failed.length}`,
  ];
  for (const row of [...refused, ...failed]) {
    lines.push(`  ${row.outcome}=${row.id}: ${row.reason ?? "no reason recorded"}`);
    for (const blocker of row.blockers ?? []) lines.push(`    remediation=${blocker.remediation}`);
  }
  return lines.join("\n");
}

/**
 * A fleet run fails if any host failed or was refused. Unreachable does not
 * fail the run — a closed laptop is not a broken rollout — but it is always
 * counted above so it can never pass unnoticed.
 */
export function fleetRunExitCode(results) {
  return results.some((row) => row.outcome === "refused" || row.outcome === "failed") ? 1 : 0;
}

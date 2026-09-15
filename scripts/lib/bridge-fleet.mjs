import fs from "node:fs/promises";

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

  // This refuses only a fleet-wide rollout/preflight claim. Bridges, adapters,
  // single-host dispatch, and every already-running host keep serving. The
  // reachable incident is #413: plex-server and rhc-server existed only in the
  // live registry, so five "all hosts" checks silently never considered them.
  if (missingTargets.length || unregisteredTargets.length) {
    const parts = [];
    if (missingTargets.length) parts.push(`registered bridge(s) absent from targets.json: ${missingTargets.join(", ")}`);
    if (unregisteredTargets.length) parts.push(`targets.json host(s) absent from the bridge registry: ${unregisteredTargets.join(", ")}`);
    throw new Error(`bridge fleet registry divergence: ${parts.join("; ")}`);
  }

  const rolloutManaged = [];
  const rolloutExcluded = [];
  for (const id of [...registered].sort()) {
    const target = targets.get(id);
    if (target.rolloutEnabled) rolloutManaged.push(id);
    else rolloutExcluded.push({ id, reason: target.unmanagedReason });
  }
  return Object.freeze({
    registered: Object.freeze([...registered].sort()),
    rolloutManaged: Object.freeze(rolloutManaged),
    rolloutExcluded: Object.freeze(rolloutExcluded.map((row) => Object.freeze(row))),
  });
}

export function formatFleetCoverage(fleet, selectedHost = null) {
  const lines = [
    `fleet_registered=${fleet.registered.length}`,
    `fleet_rollout_managed=${fleet.rolloutManaged.length} of ${fleet.registered.length}`,
    `fleet_rollout_excluded=${fleet.rolloutExcluded.length}`,
  ];
  if (selectedHost) lines.push(`operation_scope=1 of ${fleet.registered.length} registered hosts: ${selectedHost}`);
  for (const row of fleet.rolloutExcluded) lines.push(`fleet_excluded=${row.id}: ${row.reason}`);
  return lines.join("\n");
}

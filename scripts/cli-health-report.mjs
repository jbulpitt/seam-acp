#!/usr/bin/env node
/** Nightly report only (#504). Usage:
 *   npm run cli:health-report                    # collect one read-only run
 *   npm run cli:health-report -- --report YYYY-MM-DD  # merged daily report, no probes
 * Optional: --data-dir DIR --targets FILE --registry FILE
 *           --incumbent-evidence FILE --candidate-evidence FILE
 * Evidence files are existing separately approved R10 canary reports. This job
 * never obtains them itself. No promotion verdict or activation is performed.
 * Install/enable the example timer separately; this command does neither.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderRemoteScript, validateTargetMap } from "./lib/bridge-rollout.mjs";
import { validateBridgeRegistry } from "./lib/bridge-fleet.mjs";
import { observeHost } from "./cli-health-observe.mjs";
import {
  beginRun, bridgeObservation, discoverReleases, finishRun, inspectTarget,
  qualifyCanary, readDay, reachabilityHistory, renderDay, reportDay, sanitizeInventory,
} from "./lib/cli-health-report.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function parseReportArgs(argv) {
  const allowed = new Set(["report", "data-dir", "targets", "registry", "incumbent-evidence", "candidate-evidence"]);
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "");
    if (!argv[i].startsWith("--") || !allowed.has(key) || !argv[i + 1] || argv[i + 1].startsWith("--") || key in options) throw new Error("invalid report arguments; no mutation flags are supported");
    options[key] = argv[i + 1];
  }
  if (options.report && !/^\d{4}-\d{2}-\d{2}$/.test(options.report)) throw new Error("invalid report day");
  return options;
}

async function json(file) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; } }

export function reportTargets(input) {
  if (input?.schemaVersion !== 3 || !input.targets || typeof input.targets !== "object" || Array.isArray(input.targets)) throw new Error("target map unreadable");
  const targets = new Map();
  for (const [id, target] of Object.entries(input.targets)) {
    // Reuse rollout's identity validation per host. Refuse that host's probe,
    // not every other observation, when one operator mapping is malformed.
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) throw new Error("unsafe target id");
    try { targets.set(id, validateTargetMap({ schemaVersion: 3, targets: { [id]: target } }).get(id)); }
    catch { targets.set(id, null); }
  }
  return targets;
}

export function reportConfiguration(targetInput, registryInput) {
  let targets = new Map(), registered = new Set();
  const issues = [];
  // A broken coverage file cannot invalidate independent publisher discovery.
  // Keep host coverage explicitly unknown while other observations continue.
  try { targets = reportTargets(targetInput); } catch { issues.push("target-map-unreadable"); }
  try { registered = validateBridgeRegistry(registryInput); } catch { issues.push("bridge-registry-unreadable"); }
  return { targets, registered, issues };
}

export async function collectReport({ targets, registered, scripts, cache, cacheMtime, canary, local }, deps = {}) {
  const presenceCheckedAt = Date.now();
  const releases = await (deps.discover ?? discoverReleases)();
  const hosts = [];
  // Registry divergence narrows just the missing host to unchecked. A bad mapping
  // must not hide otherwise observable hosts, or silently shrink fleet coverage.
  for (const id of [...new Set([...registered, ...targets.keys()])].sort()) {
    const target = targets.get(id);
    const observation = !target || !registered.has(id)
      ? { host: id, management: "unchecked-registry-divergence", preflight: "unchecked", inventory: null, serviceNode: null }
      : await (deps.inspect ?? inspectTarget)(target, scripts);
    hosts.push({ ...observation, bridge: bridgeObservation(cache, cacheMtime, id, presenceCheckedAt),
      bridgeObservedAt: Number.isFinite(cacheMtime) ? new Date(cacheMtime).toISOString() : null });
  }
  hosts.push({ host: "control-plane", management: "local", bridge: "not-applicable", preflight: "unchecked-bridge-preflight-not-applicable",
    serviceNode: null, inventory: sanitizeInventory(await (deps.observe ?? observeHost)(local)) });
  return { releases, hosts, canary };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseReportArgs(argv);
  const data = path.resolve(options["data-dir"] ?? process.env.DATA_DIR ?? path.join(root, "data"));
  const output = path.join(data, "cli-health-reports");
  const day = options.report ?? reportDay();
  if (!options.report) {
    const run = await beginRun(output, day);
    // If configuration cannot be read, leave the started receipt incomplete and
    // report it below. Never publish a previous clean run as today's result.
    try {
      const { targets, registered, issues } = reportConfiguration(
        await json(options.targets ?? path.join(root, "ops/bridge/targets.json")),
        await json(options.registry ?? path.join(data, "channel-presets.json")));
      const cachePath = path.join(data, "server-status-card.json");
      let cacheMtime = NaN;
      try { cacheMtime = (await fs.stat(cachePath)).mtimeMs; } catch { /* presence unknown */ }
      const shell = path.join(root, "scripts/bridge-rollout-remote.sh");
      const scripts = {
        preflight: await renderRemoteScript(shell, path.join(root, "scripts/bridge-rollout-remote.mjs")),
        observe: await renderRemoteScript(shell, path.join(root, "scripts/cli-health-observe.mjs")),
      };
      const result = await collectReport({ targets, registered, scripts, cache: await json(cachePath), cacheMtime,
        canary: qualifyCanary(await json(options["incumbent-evidence"]), await json(options["candidate-evidence"])),
        local: { checkout: root } });
      await finishRun(run, { ...result, coverageIssues: issues });
    } catch {
      // Do not echo raw SSH/configuration errors: those can contain private paths,
      // environment values or credential-bearing URLs. The receipt says unknown.
      process.exitCode = 1;
    }
  }
  const runs = await readDay(output, day);
  console.log(renderDay(day, runs, await reachabilityHistory(output, day)));
  if (!runs.length || runs.some((r) => r.incomplete)) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("CLI report unavailable; no checks may be inferred to have passed."); process.exitCode = 1; });
}

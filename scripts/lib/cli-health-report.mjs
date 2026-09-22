/** #504: observations only. R9 forbids auto-download/auth; R10 owns promotion.
 * None of these results changes a pin, binding, configuration or serving status.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AGY_UPGRADE_REQUIRED_CAPABILITIES } from "../agy-upgrade-gate.mjs";
import { collectBlockers, makeReachabilityProbe } from "./bridge-fleet.mjs";
import { commandRunner, makeSshCommand, parseKeyValues, runPreflight } from "./bridge-rollout.mjs";

export const PUBLISHERS = Object.freeze({
  grok: { url: "https://x.ai/cli/stable", format: "text" },
  agy: { url: "https://api.github.com/repos/google-antigravity/antigravity-cli/releases/latest", format: "github" },
  codex: { url: "https://registry.npmjs.org/@openai%2Fcodex/latest", format: "npm" },
  claude: { url: "https://registry.npmjs.org/@anthropic-ai%2Fclaude-code/latest", format: "npm" },
  copilot: { url: "https://registry.npmjs.org/@github%2Fcopilot/latest", format: "npm" },
  "codex-acp": { url: "https://registry.npmjs.org/@agentclientprotocol%2Fcodex-acp/latest", format: "npm" },
  "claude-agent-acp": { url: "https://registry.npmjs.org/@agentclientprotocol%2Fclaude-agent-acp/latest", format: "npm" },
});
const VERSION = /^v?(\d+\.\d+\.\d+)$/;
const semver = (s) => typeof s === "string" ? VERSION.exec(s)?.[1] ?? null : null;
const token = (s) => typeof s === "string" && /^[a-zA-Z0-9._:-]{1,100}$/.test(s) ? s : "unknown";

export async function discoverReleases(fetcher = fetch) {
  return Object.fromEntries(await Promise.all(Object.entries(PUBLISHERS).map(async ([agent, source]) => {
    try {
      // #505: this request deliberately cannot read CLI ceilings or invoke update
      // --check. A bad publisher response narrows just this agent to unknown.
      const response = await fetcher(source.url, {
        signal: AbortSignal.timeout(10_000), redirect: "error",
        headers: { "User-Agent": "seam-release-report", Accept: "application/json,text/plain" },
      });
      if (!response.ok || !response.body) throw new Error("publisher unavailable");
      let body = "";
      for await (const chunk of response.body) {
        body += Buffer.from(chunk).toString("utf8");
        if (Buffer.byteLength(body) > 128 * 1024) throw new Error("publisher response too large");
      }
      const raw = source.format === "text" ? body.trim() : JSON.parse(body)[source.format === "github" ? "tag_name" : "version"];
      const latest = semver(raw);
      if (!latest) throw new Error("publisher version unrecognized");
      return [agent, { status: "observed", latest, publisher: source.url }];
    } catch {
      return [agent, { status: "unknown", latest: null, publisher: source.url }];
    }
  })));
}

export function compareRelease(installed, release) {
  if (!semver(installed) || release?.status !== "observed" || !semver(release.latest)) return "unknown";
  const a = semver(installed).split(".").map(Number), b = semver(release.latest).split(".").map(Number);
  const first = a.findIndex((n, i) => n !== b[i]);
  return first < 0 ? "matches-publisher" : a[first] < b[first] ? "update-available" : "ahead-of-publisher";
}

export function bridgeObservation(cache, mtimeMs, host, now = Date.now()) {
  // #550: cached presence is neither an SSH probe nor an eternal connected bit.
  if (!Number.isFinite(mtimeMs) || now - mtimeMs > 120_000 || now < mtimeMs) return "unknown";
  const row = cache?.lastSeen?.[host];
  if (!row || !Array.isArray(row.agents)) return "unknown";
  return Number.isFinite(row.offlineSince) ? "observed-disconnected" : "observed-connected";
}

export function reachabilityReason(error) {
  const message = String(error);
  if (/Could not resolve hostname/i.test(message)) return "alias-or-dns-unresolved";
  if (/channel.*open failed.*connect failed.*Connection refused/i.test(message)) return "tunnel-forward-refused";
  if (/Connection refused/i.test(message)) return "ssh-connection-refused";
  if (/Permission denied/i.test(message)) return "ssh-auth-refused";
  if (/Host key verification failed/i.test(message)) return "ssh-host-key-unverified";
  return "unreachable-or-probe-failed";
}

export function sanitizeInventory(raw) {
  if (raw?.schemaVersion !== 1 || !Array.isArray(raw.artifacts)) return null;
  return {
    reason: raw.reason === "ssh-user-differs-from-service-owner" ? raw.reason : null,
    artifacts: raw.artifacts.filter((a) => a && Object.hasOwn(PUBLISHERS, a.agent) && semver(a.version)
      && ["npm-package-manifest", "version-addressed-link"].includes(a.source)
      && a.binding === "installation-only").map((a) => ({ agent: a.agent, version: semver(a.version), source: a.source, binding: a.binding })),
    defaultNode: {
      version: semver(raw.defaultNode?.version),
      floating: raw.defaultNode?.floating === true,
      basis: "nvm-alias-files-and-installed-directories",
    },
  };
}

export function nodeDrift(service, defaultNode) {
  const current = semver(service), selected = semver(defaultNode?.version);
  if (!selected || !current) return "unknown";
  if (current !== selected) return "different-on-recreation";
  return defaultNode.floating ? "matches-today-floating-default" : "matches-today";
}

export async function inspectTarget(target, scripts, run = commandRunner) {
  const result = { host: target.bridgeId, management: "unchecked", preflight: "unchecked", inventory: null, serviceNode: null };
  if (!target.rolloutEnabled) return { ...result, management: "excluded" };
  try {
    const command = makeReachabilityProbe(target);
    // An unattended report must not enroll a new SSH host key.
    command.args = command.args.map((a) => a === "StrictHostKeyChecking=accept-new" ? "StrictHostKeyChecking=yes" : a);
    await run(command);
    result.management = "reachable";
  } catch (error) { return { ...result, management: reachabilityReason(error) }; }
  try {
    const raw = await run(observationCommand(target, scripts.preflight));
    const values = parseKeyValues(raw.stdout);
    result.preflightFindings = collectBlockers(values, target).map(({ code, severity }) => ({ code, severity }));
    // Run the SAME evaluator against the SAME captured reply; no second gate,
    // no second preflight. Even a refusal can contain an observed interpreter.
    if (values.bridge_id === target.bridgeId && values.identity_bound === "yes") result.serviceNode = semver(values.node_version);
    try { await runPreflight(target, scripts.preflight, async () => raw); result.preflight = "passed"; }
    catch { result.preflight = "refused-by-existing-preflight"; }
  } catch { result.preflight = "unknown-preflight-unavailable"; }
  try {
    const raw = await run(observationCommand(target, scripts.observe));
    result.inventory = sanitizeInventory(JSON.parse(raw.stdout));
  } catch { /* This host's passive inventory remains unknown; fleet continues. */ }
  return result;
}

function observationCommand(target, script) {
  const command = makeSshCommand(target, ["preflight"], script);
  command.args.unshift("-o", "StrictHostKeyChecking=yes");
  return command;
}

export function qualifyCanary(incumbent, candidate) {
  // #537: v1's baseline identity/performance rows do not prove baseline capability
  // assertions passed. Require TWO existing, comparable R10 evidence reports.
  // This reports recorded comparisons only; it never issues a promotion verdict.
  const valid = (e) => e?.schemaVersion === 1 && e.kind === "agy-upgrade-evidence"
    && e.sanitized === true && e.evidenceLevel === "live-verified"
    && semver(e.candidate?.version) && /^[a-f0-9]{64}$/.test(e.candidate?.sha256 ?? "")
    && Number.isFinite(Date.parse(e.capturedAt)) && Array.isArray(e.capabilities);
  if (!valid(incumbent) || !valid(candidate)) return { status: "unchecked", assertions: [] };
  const keys = ["adapterCommit", "scenarioVersion", "hostClass", "declaredHostLoad", "modelId"];
  const comparable = keys.every((k) => typeof incumbent.comparison?.[k] === "string"
    && incumbent.comparison[k].length > 0 && incumbent.comparison[k] === candidate.comparison?.[k])
    && incumbent.candidate.sha256 === candidate.baseline?.sha256
    && incumbent.candidate.version === candidate.baseline?.version;
  const assertions = AGY_UPGRADE_REQUIRED_CAPABILITIES.map((id) => {
    const a = incumbent.capabilities.filter((c) => c?.id === id);
    const b = candidate.capabilities.filter((c) => c?.id === id);
    const qualified = comparable && a.length === 1 && a[0].observations > 0 && a[0].verdict === "pass";
    const observed = b.length === 1 && b[0].observations > 0;
    return { id, outcome: !qualified ? "unqualified-baseline" : !observed ? "unknown"
      : b[0].verdict === "fail" ? "recorded-regression" : b[0].verdict === "pass" ? "recorded-pass" : "unknown" };
  });
  return { status: "recorded-comparison-not-promotion", incumbentVersion: semver(incumbent.candidate.version),
    candidateVersion: semver(candidate.candidate.version), capturedAt: new Date(candidate.capturedAt).toISOString(), assertions };
}

export function reportDay(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export async function beginRun(root, day = reportDay()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("invalid report day");
  const dir = path.join(root, day);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  // #540: write intent BEFORE checks. A killed run is visibly incomplete, not
  // silently replaced by tomorrow's or a rerun's clean result. No turn ledger.
  await fs.writeFile(path.join(dir, `${id}.started.json`), JSON.stringify({ id, startedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
  return { dir, id };
}

export async function finishRun(run, result) {
  const temporary = path.join(run.dir, `${run.id}.tmp`);
  await fs.writeFile(temporary, JSON.stringify({ ...result, schemaVersion: 1, id: run.id, completedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
  await fs.rename(temporary, path.join(run.dir, `${run.id}.json`));
}

export async function readDay(root, day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("invalid report day");
  const dir = path.join(root, day);
  let names;
  try { names = await fs.readdir(dir); } catch (e) { if (e.code === "ENOENT") return []; throw e; }
  const records = [];
  for (const name of names.filter((n) => n.endsWith(".started.json")).sort()) {
    const id = name.slice(0, -13);
    try {
      const record = JSON.parse(await fs.readFile(path.join(dir, `${id}.json`), "utf8"));
      if (record.id !== id || record.schemaVersion !== 1 || !Array.isArray(record.hosts) || !record.releases) throw new Error("invalid receipt");
      records.push(record);
    } catch { records.push({ id, incomplete: true }); }
  }
  return records;
}

export async function reachabilityHistory(root, day) {
  // #550: missed nightly probes across days must remain visible. These are
  // sampled observations, NOT a downtime clock or a new health verdict.
  let days;
  try { days = await fs.readdir(root); } catch (e) { if (e.code === "ENOENT") return []; throw e; }
  const history = new Map();
  for (const previous of days.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < day).sort().slice(-30)) {
    for (const run of await readDay(root, previous)) {
      if (run.incomplete) continue;
      for (const host of run.hosts) {
        const row = history.get(host.host) ?? { host: token(host.host), lastReachableDay: null, missedProbeDays: new Set() };
        if (host.management === "reachable") row.lastReachableDay = previous;
        else if (!["local", "excluded", "unchecked-registry-divergence", "unchecked"].includes(host.management)) row.missedProbeDays.add(previous);
        history.set(host.host, row);
      }
    }
  }
  return [...history.values()].map((row) => ({ ...row, missedProbeDays: [...row.missedProbeDays] }));
}

export function renderDay(day, runs, history = []) {
  const lines = [`CLI release and drift report — ${day} (America/Chicago)`,
    "Report only: no update, promotion, rollback, pin, repair or model prompt. R9/R10 own those boundaries.",
    "Artifact inventory does not prove the active binding. Versions are manifest/link labels, not binary-content verification; no agent CLI was executed.",
    "All observations for this day are retained below; a rerun cannot supersede an earlier refusal/unknown."];
  for (const host of history) {
    if (host.missedProbeDays.length) lines.push(`Prior daily samples — ${token(host.host)}: last observed SSH reachable ${host.lastReachableDay ?? "unknown"}; missed probes on ${host.missedProbeDays.join(", ")}. Not continuous downtime (up to 30 prior recorded days).`);
  }
  if (!runs.length) lines.push("Unchecked: no run recorded.");
  for (const run of runs) {
    if (run.incomplete) { lines.push("Run incomplete/receipt unreadable — checks unknown, not passed."); continue; }
    lines.push(`Run completed ${token(run.completedAt)}`);
    for (const issue of run.coverageIssues ?? []) lines.push(`Fleet coverage unknown: ${token(issue)}.`);
    for (const [agent, release] of Object.entries(run.releases)) {
      lines.push(`- Publisher ${token(agent)}: ${release.status === "observed" && semver(release.latest) ? semver(release.latest) : "unknown"}`);
    }
    for (const host of run.hosts) {
      lines.push(`- ${token(host.host)}: SSH ${token(host.management)}; bridge ${token(host.bridge)} (cache as of ${token(host.bridgeObservedAt)}); rollout preflight ${token(host.preflight)}.`);
      for (const finding of host.preflightFindings ?? []) lines.push(`  Existing preflight finding: ${token(finding.code)} (${token(finding.severity)}).`);
      if (host.inventory?.reason) lines.push(`  Inventory unchecked: ${token(host.inventory.reason)}.`);
      lines.push(`  Service Node ${semver(host.serviceNode) ?? "unknown"}; nvm recreation default ${semver(host.inventory?.defaultNode?.version) ?? "unknown"}; ${nodeDrift(host.serviceNode, host.inventory?.defaultNode)}.`);
      for (const agent of Object.keys(PUBLISHERS)) {
        const artifacts = host.inventory?.artifacts?.filter((a) => a.agent === agent) ?? [];
        lines.push(`  ${agent}: ${artifacts.length ? artifacts.map((a) => `${semver(a.version) ?? "unknown"} (${compareRelease(a.version, run.releases[agent])}; ${token(a.source)}; installation-only)`).join(", ") : "unchecked/installed version unknown"}.`);
      }
    }
    if (run.canary?.status === "recorded-comparison-not-promotion") {
      lines.push(`- R10 historical evidence ${run.canary.incumbentVersion} → ${run.canary.candidateVersion}, ${run.canary.capturedAt}; NOT a claim that either is today's active binding:`);
      for (const assertion of run.canary.assertions) lines.push(`  ${token(assertion.id)}: ${token(assertion.outcome)}.`);
    } else lines.push("- R10 candidate assertions unchecked: no comparable incumbent/candidate evidence supplied.");
  }
  return lines.join("\n") + "\n";
}

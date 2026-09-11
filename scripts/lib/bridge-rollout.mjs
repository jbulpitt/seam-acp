import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SAFE_PATH = /^\/[A-Za-z0-9._/-]{1,511}$/;
const SHA = /^[0-9a-f]{40}$/;
const CHECKSUM = /^[0-9a-f]{64}$/;
const TOKEN = /^[0-9a-f]{64}$/;
const TARGET_KEYS = new Set([
  "sshAlias", "pm2App", "verifyAgent", "checkoutPath", "entrypointPath",
  "pidFilePath", "expectedUid", "nodePath", "pm2ModulePath", "workspaceArg",
  "devMode", "releaseRoot", "rolloutEnabled", "unmanagedReason",
]);
const SAFE_REASON = /^[A-Za-z0-9][A-Za-z0-9 .,:;#/_()-]{0,255}$/;

function exactAbsolute(value, label) {
  if (typeof value !== "string" || !SAFE_PATH.test(value) || path.posix.normalize(value) !== value || value.includes("//") || value.endsWith("/")) {
    throw new Error(`unsafe ${label}`);
  }
  return value;
}

export function validateTargetMap(input) {
  if (!input || input.schemaVersion !== 3 || !input.targets || typeof input.targets !== "object" || Array.isArray(input.targets)) {
    throw new Error("invalid bridge rollout target map");
  }
  const targets = new Map();
  for (const [bridgeId, value] of Object.entries(input.targets)) {
    if (!SAFE_NAME.test(bridgeId) || !value || typeof value !== "object" || Array.isArray(value)) throw new Error(`unsafe bridge target ${JSON.stringify(bridgeId)}`);
    for (const key of Object.keys(value)) if (!TARGET_KEYS.has(key)) throw new Error(`unknown target property ${JSON.stringify(key)}`);
    if (typeof value.rolloutEnabled !== "boolean") throw new Error(`missing rolloutEnabled for ${bridgeId}`);
    if (!value.rolloutEnabled) {
      if (Object.keys(value).some((key) => !["sshAlias", "pm2App", "verifyAgent", "rolloutEnabled", "unmanagedReason"].includes(key)) || value.pm2App !== null || value.verifyAgent !== null) {
        throw new Error(`disabled target ${bridgeId} must not guess deployment identity`);
      }
      if (value.sshAlias === null) {
        if (typeof value.unmanagedReason !== "string" || !SAFE_REASON.test(value.unmanagedReason)) {
          throw new Error(`explicitly unmanaged target ${bridgeId} requires a safe reason`);
        }
      } else {
        if (!SAFE_NAME.test(value.sshAlias ?? "")) throw new Error(`unsafe SSH alias for ${bridgeId}`);
        if (value.unmanagedReason !== undefined) throw new Error(`mapped disabled target ${bridgeId} must not declare an unmanaged reason`);
      }
      targets.set(bridgeId, { bridgeId, ...value });
      continue;
    }
    if (!SAFE_NAME.test(value.sshAlias ?? "")) throw new Error(`unsafe SSH alias for ${bridgeId}`);
    if (value.unmanagedReason !== undefined) throw new Error(`enabled target ${bridgeId} must not declare an unmanaged reason`);
    if (!SAFE_NAME.test(value.pm2App ?? "")) throw new Error(`unsafe PM2 app for ${bridgeId}`);
    if (!SAFE_NAME.test(value.verifyAgent ?? "")) throw new Error(`unsafe verification agent for ${bridgeId}`);
    if (!Number.isInteger(value.expectedUid) || value.expectedUid < 1 || value.expectedUid > 0x7fffffff) throw new Error(`unsafe expected UID for ${bridgeId}`);
    if (typeof value.devMode !== "boolean") throw new Error(`missing devMode identity for ${bridgeId}`);
    for (const key of ["checkoutPath", "entrypointPath", "pidFilePath", "nodePath", "pm2ModulePath", "releaseRoot"]) exactAbsolute(value[key], `${key} for ${bridgeId}`);
    if (value.workspaceArg !== null) exactAbsolute(value.workspaceArg, `workspaceArg for ${bridgeId}`);
    if (value.entrypointPath !== `${value.checkoutPath}/packages/bridge/dist/index.js`) throw new Error(`entrypoint is not the managed stable launcher for ${bridgeId}`);
    if (value.releaseRoot === value.checkoutPath || value.releaseRoot.startsWith(`${value.checkoutPath}/`) || value.checkoutPath.startsWith(`${value.releaseRoot}/`)) {
      throw new Error(`checkout and release roots overlap for ${bridgeId}`);
    }
    targets.set(bridgeId, { bridgeId, ...value });
  }
  return targets;
}

export async function loadTargetMap(file) { return validateTargetMap(JSON.parse(await fs.readFile(file, "utf8"))); }

export function resolveTarget(targets, bridgeId) {
  if (!SAFE_NAME.test(bridgeId ?? "")) throw new Error("target contains unsafe characters");
  const target = targets.get(bridgeId);
  if (!target) throw new Error(`unknown bridge target ${JSON.stringify(bridgeId)}`);
  requireManagedTarget(target);
  return target;
}

function requireManagedTarget(target) {
  if (!target?.rolloutEnabled) {
    if (target?.sshAlias === null) {
      throw new Error(`${target.bridgeId} is explicitly unmanaged: ${target.unmanagedReason}`);
    }
    throw new Error(`${target?.bridgeId ?? "target"} is mapped but rollout is disabled (AGY-only hosts are outside #241)`);
  }
  if (!SAFE_NAME.test(target.sshAlias ?? "")) throw new Error(`target ${target.bridgeId ?? "unknown"} has no verified SSH management path`);
}

export function parseArgs(argv) {
  const values = new Map();
  const booleans = new Set();
  const valueFlags = new Set(["--target", "--sha", "--checksum", "--stage-id", "--activation-id", "--enrollment-id", "--timeout-seconds"]);
  const boolFlags = new Set(["--apply", "--stage", "--enroll", "--restore-baseline", "--activate", "--rollback", "--help"]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (valueFlags.has(arg)) {
      if (values.has(arg)) throw new Error(`duplicate option ${arg}`);
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      values.set(arg, value);
    } else if (boolFlags.has(arg)) {
      if (booleans.has(arg)) throw new Error(`duplicate option ${arg}`);
      booleans.add(arg);
    } else throw new Error(`unknown option ${JSON.stringify(arg)}`);
  }
  if (booleans.has("--help")) return { help: true };
  const target = values.get("--target");
  if (!target) throw new Error("--target is required (exactly one host; fan-out is unsupported)");
  const actions = ["--stage", "--enroll", "--restore-baseline", "--activate", "--rollback"].filter((flag) => booleans.has(flag));
  if (actions.length > 1) throw new Error("choose only one of --stage, --enroll, --restore-baseline, --activate, or --rollback");
  const action = actions[0]?.slice(2) ?? "preflight";
  const apply = booleans.has("--apply");
  if (action !== "preflight" && !apply) throw new Error(`${actions[0]} mutates a remote host and requires --apply`);
  if (action === "preflight" && apply) throw new Error("--apply requires one of --stage, --enroll, --restore-baseline, --activate, or --rollback");
  const sha = values.get("--sha");
  const checksum = values.get("--checksum");
  const stageId = values.get("--stage-id");
  const activationId = values.get("--activation-id");
  if (action === "activate") {
    if (!SHA.test(sha ?? "")) throw new Error("--activate requires a lowercase 40-character --sha");
    if (!CHECKSUM.test(checksum ?? "")) throw new Error("--activate requires a lowercase 64-character --checksum");
    if (!TOKEN.test(stageId ?? "")) throw new Error("--activate requires the exact 64-character --stage-id printed by staging");
  } else if (sha || checksum || stageId) throw new Error("--sha, --checksum, and --stage-id are valid only with --activate");
  if (action === "rollback") {
    if (!TOKEN.test(activationId ?? "")) throw new Error("--rollback requires an exact immutable --activation-id");
  } else if (activationId) throw new Error("--activation-id is valid only with --rollback");
  const enrollmentId = values.get("--enrollment-id");
  // Enrollment mints its own immutable id; a restore must name the exact one it
  // is putting back, so there is no "restore whatever was last recorded".
  if (action === "restore-baseline") {
    if (!TOKEN.test(enrollmentId ?? "")) throw new Error("--restore-baseline requires the exact immutable --enrollment-id printed by enrollment");
  } else if (enrollmentId) throw new Error("--enrollment-id is valid only with --restore-baseline");
  const timeoutSeconds = Number(values.get("--timeout-seconds") ?? "420");
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 900) throw new Error("--timeout-seconds must be an integer from 10 through 900");
  return { help: false, target, action, apply, sha, checksum, stageId, activationId, enrollmentId, timeoutSeconds };
}

function targetArgs(target) {
  return [
    target.bridgeId, target.pm2App, target.verifyAgent, String(target.expectedUid),
    target.checkoutPath, target.entrypointPath, target.pidFilePath, target.nodePath,
    target.pm2ModulePath, target.workspaceArg ?? "-", target.devMode ? "yes" : "no", target.releaseRoot,
  ];
}

export function makeSshCommand(target, actionArgs, remoteScript) {
  requireManagedTarget(target);
  const args = [...targetArgs(target), ...actionArgs];
  for (const value of args) {
    if (typeof value !== "string" || value.length > 512 || /[\0-\x20\x7f'"`$;&|<>\\]/.test(value)) throw new Error(`unsafe remote argument ${JSON.stringify(value)}`);
  }
  return {
    file: "ssh",
    args: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", target.sshAlias, "sh", "-s", "--", target.nodePath, ...args],
    input: remoteScript,
    mutates: actionArgs[0] !== "preflight",
    timeoutMs: actionArgs[0] === "preflight" ? 30_000 : 960_000,
  };
}

export function makeScpCommand(target, localArtifact, remoteName) {
  requireManagedTarget(target);
  if (!SAFE_NAME.test(target.sshAlias) || !/^bridge-[0-9a-f]{40}-[0-9a-f]{64}\.tgz(?:\.upload-[0-9a-f]{64})?$/.test(remoteName)) throw new Error("unsafe artifact delivery argument");
  return { file: "scp", args: ["-q", "--", localArtifact, `${target.sshAlias}:${target.releaseRoot}/incoming/${remoteName}`], mutates: true, timeoutMs: 120_000 };
}

export function parseKeyValues(stdout) {
  const result = {};
  for (const line of stdout.split(/\r?\n/)) { const offset = line.indexOf("="); if (offset > 0) result[line.slice(0, offset)] = line.slice(offset + 1); }
  return result;
}

export function verifyChecksum(expected, actual) {
  if (!CHECKSUM.test(expected) || !CHECKSUM.test(actual) || expected !== actual) throw new Error("artifact checksum mismatch");
  return true;
}

export function validateReadyReceipt(receipt, expected) {
  const times = [receipt?.startedAt, receipt?.helloAcceptedAt, receipt?.controllerVerifiedAt, receipt?.completedAt].map(Date.parse);
  if (!receipt || receipt.formatVersion !== 2 || receipt.activationId !== expected.activationId || receipt.bridgeId !== expected.bridgeId || receipt.sourceSha !== expected.sha || receipt.artifactChecksum !== expected.checksum || receipt.stageId !== expected.stageId) throw new Error("ready receipt does not identify this activation");
  if (receipt.oldPid !== expected.oldPid || receipt.pid !== expected.pid || receipt.pid === receipt.oldPid || receipt.instanceId !== expected.instanceId || receipt.protocolVersion !== expected.protocolVersion) throw new Error("ready receipt process identity mismatch");
  if (times.some((time) => !Number.isFinite(time)) || times.some((time, index) => index && time < times[index - 1]) || times[0] < expected.notBefore || times.at(-1) > expected.notAfter) throw new Error("ready receipt is stale or outside the activation window");
  const calls = receipt.catalogRpcs?.[expected.agentId];
  if (!calls?.describeModelCatalogAt || !calls?.fetchModelCatalogAt || receipt.controllerAck?.activationId !== expected.activationId || receipt.controllerAck?.bridgeId !== expected.bridgeId || receipt.controllerAck?.instanceId !== expected.instanceId || receipt.controllerAck?.pid !== expected.pid || receipt.controllerAck?.sourceSha !== expected.sha || receipt.controllerAck?.artifactChecksum !== expected.checksum) throw new Error(`catalog/controller verification failed for ${expected.agentId}`);
  return true;
}

export function rollbackPlan(target, activationId) {
  requireManagedTarget(target);
  if (!TOKEN.test(activationId ?? "")) throw new Error("an immutable activation id is required for rollback");
  return { target: target.bridgeId, command: `npm run bridge:rollout -- --target ${target.bridgeId} --rollback --activation-id ${activationId} --apply`, automatic: false };
}

export function artifactName(sha, checksum) {
  if (!SHA.test(sha) || !CHECKSUM.test(checksum)) throw new Error("invalid artifact identity");
  return `bridge-${sha}-${checksum}.tgz`;
}

function safeDiagnostic(value) {
  return String(value).replace(/[\x00-\x1f\x7f]/g, " ").replace(/(token|secret|password|authorization|key)\s*[=:]\s*\S+/gi, "$1=[redacted]").slice(0, 2048).trim();
}

export function commandRunner(command, limits = {}) {
  const timeoutMs = limits.timeoutMs ?? command.timeoutMs ?? 120_000;
  const maxStdoutBytes = limits.maxStdoutBytes ?? 1_048_576;
  const maxStderrBytes = limits.maxStderrBytes ?? 262_144;
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, { cwd: command.cwd, stdio: [command.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    const out = []; const err = [];
    let outBytes = 0; let errBytes = 0; let terminalError; let closed = false;
    const stop = (error) => { if (!terminalError) terminalError = error; if (!child.killed) child.kill("SIGKILL"); };
    const timer = setTimeout(() => stop(new Error(`${command.file} timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    const onStdout = (chunk) => { outBytes += chunk.length; if (outBytes > maxStdoutBytes) stop(new Error(`${command.file} exceeded stdout limit`)); else out.push(chunk); };
    const onStderr = (chunk) => { errBytes += chunk.length; if (errBytes > maxStderrBytes) stop(new Error(`${command.file} exceeded stderr limit`)); else err.push(chunk); };
    const onError = (error) => { terminalError ??= error; };
    child.stdout.on("data", onStdout); child.stderr.on("data", onStderr); child.on("error", onError);
    child.on("close", (code, signal) => {
      if (closed) return; closed = true; clearTimeout(timer);
      child.stdout.off("data", onStdout); child.stderr.off("data", onStderr); child.off("error", onError); child.stdin?.removeAllListeners("error");
      const stdout = Buffer.concat(out).toString("utf8"); const stderr = Buffer.concat(err).toString("utf8");
      if (terminalError) reject(terminalError);
      else if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command.file} failed (${code ?? signal ?? "unknown"}): ${safeDiagnostic(stderr || stdout) || "no safe diagnostic"}`));
    });
    if (command.input !== undefined) {
      child.stdin.on("error", (error) => { if (error.code !== "EPIPE") stop(error); });
      child.stdin.end(command.input);
    }
  });
}

async function collectArtifactFiles(repoRoot) {
  const fixed = ["package.json", "package-lock.json", "packages/adapters/package.json", "packages/bridge/package.json", "packages/core/package.json"];
  const result = [...fixed];
  for (const dir of ["packages/adapters/dist", "packages/bridge/dist"]) {
    const walk = async (relative) => {
      const entries = await fs.readdir(path.join(repoRoot, relative), { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const child = path.posix.join(relative, entry.name);
        if (entry.isDirectory()) await walk(child);
        else if (entry.isFile()) result.push(child);
        else throw new Error(`artifact source contains a link or special file: ${child}`);
      }
    };
    await walk(dir);
  }
  return result.sort();
}

export async function buildArtifact(repoRoot, run = commandRunner) {
  const status = await run({ file: "git", args: ["status", "--porcelain", "--untracked-files=all"], cwd: repoRoot });
  if (status.stdout.trim()) throw new Error("source worktree is dirty; commit every source change before staging");
  const sha = (await run({ file: "git", args: ["rev-parse", "HEAD"], cwd: repoRoot })).stdout.trim();
  if (!SHA.test(sha)) throw new Error("could not resolve an exact committed source SHA");
  await run({ file: "npm", args: ["run", "build", "-w", "@seam/adapters"], cwd: repoRoot, timeoutMs: 300_000 });
  await run({ file: "npm", args: ["run", "build", "-w", "@seam/bridge"], cwd: repoRoot, timeoutMs: 300_000 });
  if ((await run({ file: "git", args: ["status", "--porcelain", "--untracked-files=all"], cwd: repoRoot })).stdout.trim()) throw new Error("build changed tracked or untracked source; refusing artifact");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "seam-bridge-release-"));
  const payload = path.join(temp, "payload"); await fs.mkdir(payload, { mode: 0o700 });
  const files = await collectArtifactFiles(repoRoot);
  const manifestFiles = [];
  for (const relative of files) {
    const bytes = await fs.readFile(path.join(repoRoot, relative));
    const destination = path.join(payload, relative); await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 }); await fs.writeFile(destination, bytes, { mode: 0o600 });
    manifestFiles.push({ path: relative, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  await fs.writeFile(path.join(payload, "bridge-release.json"), JSON.stringify({ formatVersion: 2, sourceSha: sha, files: manifestFiles }) + "\n", { mode: 0o600 });
  const archive = path.join(temp, `bridge-${sha}.tgz`);
  await run({ file: "tar", args: ["--format=ustar", "--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-czf", archive, "-C", payload, "bridge-release.json", ...files], timeoutMs: 120_000 });
  const checksum = createHash("sha256").update(await fs.readFile(archive)).digest("hex");
  return { sha, checksum, archive, remoteName: artifactName(sha, checksum) };
}

export async function renderRemoteScript(shellTemplatePath, nodeProgramPath) {
  const [shell, program] = await Promise.all([fs.readFile(shellTemplatePath, "utf8"), fs.readFile(nodeProgramPath, "utf8")]);
  const marker = "__SEAM_BRIDGE_ROLLOUT_NODE_PROGRAM__";
  if (shell.split(marker).length !== 2) throw new Error("remote shell template marker is missing or ambiguous");
  if (program.includes("\nSEAM_REMOTE_NODE\n")) throw new Error("remote node program collides with shell delimiter");
  return shell.replace(marker, program);
}

export async function runPreflight(target, remoteScript, run = commandRunner) {
  const command = makeSshCommand(target, ["preflight"], remoteScript);
  const result = await run(command);
  const report = parseKeyValues(result.stdout);
  if (report.bridge_id !== target.bridgeId || report.pm2_app !== target.pm2App || report.identity_bound !== "yes" || report.remote_mutation !== "no") throw new Error("remote deployment identity did not match the operator mapping");
  if (!/^[a-z0-9._-]+$/.test(report.platform ?? "") || !/^(managed|legacy-checkout)$/.test(report.artifact_mode ?? "") || !CHECKSUM.test(report.entrypoint_sha256 ?? "")) throw new Error("remote artifact identity evidence is incomplete");
  if (report.artifact_mode === "managed" && (!SHA.test(report.artifact_source_sha ?? "") || !CHECKSUM.test(report.artifact_checksum ?? "") || report.checkout_source_sha !== "not-applicable" || report.artifact_identity !== `${report.artifact_source_sha}:${report.artifact_checksum}`)) throw new Error("managed artifact checksum evidence is incomplete");
  if (report.artifact_mode === "legacy-checkout" && (report.artifact_source_sha !== "unmanaged" || report.artifact_checksum !== "unmanaged" || !SHA.test(report.checkout_source_sha ?? "") || report.artifact_identity !== `entrypoint-sha256:${report.entrypoint_sha256}`)) throw new Error("legacy checkout artifact evidence is incomplete");
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(report.bridge_version ?? "") || !/^(?:\d+|unknown)$/.test(report.protocol_version ?? "") || ![report.drain_SIGUSR2,report.describeModelCatalog,report.fetchModelCatalog,report.rollout_ready].every((value)=>value === "yes" || value === "no")) throw new Error("remote bridge capability evidence is incomplete");
  const expectedReadiness = report.protocol_version === "1" && report.drain_SIGUSR2 === "yes" && report.describeModelCatalog === "yes" && report.fetchModelCatalog === "yes" ? "yes" : "no";
  if (report.rollout_ready !== expectedReadiness) throw new Error("remote bridge readiness evidence is inconsistent");
  if (!/^(yes|no|drifted)$/.test(report.enrolled ?? "")) throw new Error("remote enrollment evidence is incomplete");
  if (report.enrolled === "no") {
    if (report.enrollment_id !== "none" || report.baseline_digest !== "none" || report.baseline_rollback_proof !== "none") throw new Error("remote enrollment evidence is inconsistent");
  } else if (!TOKEN.test(report.enrollment_id ?? "") || !CHECKSUM.test(report.baseline_digest ?? "") || !/^(receipt|reduced-baseline)$/.test(report.baseline_rollback_proof ?? "")) throw new Error("remote enrollment evidence is incomplete");
  if (report.node_path !== target.nodePath || !/^v(?:2[2-9]|[3-9]\d)\.\d+\.\d+/.test(report.node_version ?? "") || !/^\d+\.\d+\.\d+/.test(report.npm_version ?? "") || report.disk_path !== target.checkoutPath || !/^\d+$/.test(report.disk_bytes_available ?? "") || BigInt(report.disk_bytes_available) <= 0n) throw new Error("remote runtime capacity evidence is incomplete");
  return { command, report, stdout: result.stdout };
}

export function newOperationId() { return randomBytes(32).toString("hex"); }

/**
 * The capability gate is unchanged — it still refuses — but the operator sees
 * WHY, from the enrollment evidence already in the preflight report. Before
 * this the local gate short-circuited first and every legacy host got the same
 * generic capability message, so the remote program's specific refusals were
 * unreachable in normal operation (#281 QA).
 */
/**
 * A legacy host may take the FIRST managed activation from a verified enrolled
 * baseline (#288). The capability gate is decomposed rather than relaxed: the
 * OLD process must be drainable and speak protocol 1, because that is what the
 * transition itself depends on. The two catalog RPCs are NOT required of it —
 * they are served by the NEW release and proven on the new connection by the
 * ordinary receipt, which this path still demands.
 *
 * This retires itself while the host stays managed: once the entrypoint
 * resolves into a managed release `artifact_mode` is `managed` and this returns
 * false. It applies again whenever the host returns to a verified legacy
 * baseline, by any route — see docs/bridge-rollout.md §1b for the precondition.
 */
export function firstActivationFromBaselineAllowed(report) {
  return report.artifact_mode === "legacy-checkout"
    && report.enrolled === "yes"
    && report.protocol_version === "1"
    && report.drain_SIGUSR2 === "yes";
}

export function activationRefusal(report) {
  const generic = "active bridge lacks the verified drain/protocol/catalog capabilities required for activation or rollback";
  if (report.artifact_mode !== "legacy-checkout") return generic;
  if (report.enrolled === "no") return `${generic}; nothing is enrolled on this host, so no rollback target exists yet (legacy_previous_release_not_receipt_capable) — run --enroll --apply first`;
  if (report.enrolled === "drifted") return `${generic}; the recorded baseline no longer matches this host (enrolled_baseline_state_drift)`;
  if (report.drain_SIGUSR2 !== "yes") return `${generic}; the enrolled baseline cannot be drained with SIGUSR2, so no transition onto it can be proven (enrolled_baseline_not_drainable)`;
  if (report.protocol_version !== "1") return `${generic}; the enrolled baseline does not speak protocol 1 (enrolled_baseline_protocol_unsupported)`;
  return generic;
}

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SAFE_REMOTE_ARG = /^[a-z0-9][a-z0-9._-]{0,191}$/;
const SHA = /^[0-9a-f]{40}$/;
const CHECKSUM = /^[0-9a-f]{64}$/;

export function validateTargetMap(input) {
  if (!input || input.schemaVersion !== 1 || !input.targets || typeof input.targets !== "object") {
    throw new Error("invalid bridge rollout target map");
  }
  const targets = new Map();
  for (const [bridgeId, value] of Object.entries(input.targets)) {
    if (!SAFE_NAME.test(bridgeId) || !value || typeof value !== "object") {
      throw new Error(`unsafe bridge target ${JSON.stringify(bridgeId)}`);
    }
    const allowedKeys = new Set(["sshAlias", "pm2App", "verifyAgent", "rolloutEnabled"]);
    for (const key of Object.keys(value)) {
      if (!allowedKeys.has(key)) throw new Error(`unknown target property ${JSON.stringify(key)}`);
    }
    const { sshAlias, pm2App, verifyAgent, rolloutEnabled } = value;
    if (!SAFE_NAME.test(sshAlias ?? "")) throw new Error(`unsafe SSH alias for ${bridgeId}`);
    if (typeof rolloutEnabled !== "boolean") throw new Error(`missing rolloutEnabled for ${bridgeId}`);
    if (rolloutEnabled) {
      if (!SAFE_NAME.test(pm2App ?? "")) throw new Error(`unsafe PM2 app for ${bridgeId}`);
      if (!SAFE_NAME.test(verifyAgent ?? "")) throw new Error(`unsafe verification agent for ${bridgeId}`);
    } else if (pm2App !== null || verifyAgent !== null) {
      throw new Error(`disabled target ${bridgeId} must not guess PM2 or agent identities`);
    }
    targets.set(bridgeId, { bridgeId, sshAlias, pm2App, verifyAgent, rolloutEnabled });
  }
  return targets;
}

export async function loadTargetMap(file) {
  return validateTargetMap(JSON.parse(await fs.readFile(file, "utf8")));
}

export function resolveTarget(targets, bridgeId) {
  if (!SAFE_NAME.test(bridgeId ?? "")) throw new Error("target contains unsafe characters");
  const target = targets.get(bridgeId);
  if (!target) throw new Error(`unknown bridge target ${JSON.stringify(bridgeId)}`);
  if (!target.rolloutEnabled) {
    throw new Error(`${bridgeId} is mapped but rollout is disabled (AGY-only hosts are outside #241)`);
  }
  return target;
}

export function parseArgs(argv) {
  const values = new Map();
  const booleans = new Set();
  const valueFlags = new Set(["--target", "--sha", "--checksum", "--timeout-seconds"]);
  const boolFlags = new Set(["--apply", "--stage", "--activate", "--rollback", "--help"]);
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
    } else {
      throw new Error(`unknown option ${JSON.stringify(arg)}`);
    }
  }
  if (booleans.has("--help")) return { help: true };
  const target = values.get("--target");
  if (!target) throw new Error("--target is required (exactly one host; fan-out is unsupported)");
  const actions = ["--stage", "--activate", "--rollback"].filter((flag) => booleans.has(flag));
  if (actions.length > 1) throw new Error("choose only one of --stage, --activate, or --rollback");
  const action = actions[0]?.slice(2) ?? "preflight";
  const apply = booleans.has("--apply");
  if (action !== "preflight" && !apply) throw new Error(`${actions[0]} mutates a remote host and requires --apply`);
  if (action === "preflight" && apply) throw new Error("--apply requires --stage, --activate, or --rollback");
  const sha = values.get("--sha");
  const checksum = values.get("--checksum");
  if (action === "activate") {
    if (!SHA.test(sha ?? "")) throw new Error("--activate requires a lowercase 40-character --sha");
    if (!CHECKSUM.test(checksum ?? "")) throw new Error("--activate requires a lowercase 64-character --checksum");
  } else if (sha || checksum) {
    throw new Error("--sha and --checksum are valid only with --activate");
  }
  const timeoutSeconds = Number(values.get("--timeout-seconds") ?? "420");
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 900) {
    throw new Error("--timeout-seconds must be an integer from 10 through 900");
  }
  return { help: false, target, action, apply, sha, checksum, timeoutSeconds };
}

export function makeSshCommand(target, remoteArgs, remoteScript) {
  for (const value of [target.sshAlias, target.pm2App, target.bridgeId, ...remoteArgs]) {
    if (!SAFE_REMOTE_ARG.test(String(value))) throw new Error(`unsafe remote argument ${JSON.stringify(value)}`);
  }
  return {
    file: "ssh",
    args: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", target.sshAlias,
      "sh", "-s", "--", ...remoteArgs],
    input: remoteScript,
    mutates: remoteArgs[0] !== "preflight",
  };
}

export function makeScpCommand(target, localArtifact, remoteName) {
  if (!SAFE_NAME.test(target.sshAlias) || !/^bridge-[0-9a-f]{40}-[0-9a-f]{64}\.tgz$/.test(remoteName)) {
    throw new Error("unsafe artifact delivery argument");
  }
  return {
    file: "scp",
    args: ["-q", "--", localArtifact, `${target.sshAlias}:.seam/bridge-rollouts/incoming/${remoteName}`],
    mutates: true,
  };
}

export function parseKeyValues(stdout) {
  const result = {};
  for (const line of stdout.split(/\r?\n/)) {
    const offset = line.indexOf("=");
    if (offset > 0) result[line.slice(0, offset)] = line.slice(offset + 1);
  }
  return result;
}

export function verifyChecksum(expected, actual) {
  if (!CHECKSUM.test(expected) || !CHECKSUM.test(actual) || expected !== actual) {
    throw new Error(`artifact checksum mismatch (expected ${expected}, got ${actual})`);
  }
  return true;
}

export async function waitForNewPid(readPid, options) {
  const deadline = options.now() + options.timeoutMs;
  while (options.now() <= deadline) {
    const pid = await readPid();
    if (Number.isInteger(pid) && pid > 0 && pid !== options.oldPid) return pid;
    await options.sleep(options.intervalMs);
  }
  throw new Error(`timed out waiting for a new PID after ${options.timeoutMs}ms`);
}

export function validateReadyReceipt(receipt, expected) {
  if (!receipt || receipt.sourceSha !== expected.sha || receipt.artifactChecksum !== expected.checksum) {
    throw new Error("ready receipt does not identify the staged artifact");
  }
  if (receipt.pid !== expected.pid || !receipt.helloAcceptedAt || !receipt.controllerVerifiedAt || receipt.protocolVersion !== expected.protocolVersion) {
    throw new Error("fresh bridge ready handshake was not proven");
  }
  const calls = receipt.catalogRpcs?.[expected.agentId];
  if (!calls?.describeModelCatalogAt || !calls?.fetchModelCatalogAt) {
    throw new Error(`catalog RPC verification failed for ${expected.agentId}`);
  }
  return true;
}

export function rollbackPlan(target) {
  return {
    target: target.bridgeId,
    command: `npm run bridge:rollout -- --target ${target.bridgeId} --rollback --apply`,
    automatic: false,
  };
}

export function artifactName(sha, checksum) {
  if (!SHA.test(sha) || !CHECKSUM.test(checksum)) throw new Error("invalid artifact identity");
  return `bridge-${sha}-${checksum}.tgz`;
}

export function commandRunner(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      cwd: command.cwd,
      stdio: [command.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command.file} failed with exit ${code}: ${stderr.trim() || stdout.trim()}`));
    });
    if (command.input !== undefined) child.stdin.end(command.input);
  });
}

async function copyArtifactFiles(repoRoot, payload) {
  const files = ["package.json", "package-lock.json", "packages/adapters/package.json", "packages/bridge/package.json", "packages/core/package.json"];
  for (const relative of files) {
    const destination = path.join(payload, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(repoRoot, relative), destination);
  }
  for (const relative of ["packages/adapters/dist", "packages/bridge/dist"]) {
    await fs.cp(path.join(repoRoot, relative), path.join(payload, relative), { recursive: true });
  }
}

export async function buildArtifact(repoRoot, run = commandRunner) {
  const status = await run({ file: "git", args: ["status", "--porcelain", "--untracked-files=all"], mutates: false, cwd: repoRoot });
  if (status.stdout.trim()) throw new Error("source worktree is dirty; commit every source change before staging");
  const shaResult = await run({ file: "git", args: ["rev-parse", "HEAD"], mutates: false, cwd: repoRoot });
  const sha = shaResult.stdout.trim();
  if (!SHA.test(sha)) throw new Error("could not resolve an exact committed source SHA");
  await run({ file: "npm", args: ["run", "build", "-w", "@seam/adapters"], mutates: false, cwd: repoRoot });
  await run({ file: "npm", args: ["run", "build", "-w", "@seam/bridge"], mutates: false, cwd: repoRoot });
  const after = await run({ file: "git", args: ["status", "--porcelain", "--untracked-files=all"], mutates: false, cwd: repoRoot });
  if (after.stdout.trim()) throw new Error("build changed tracked or untracked source; refusing artifact");

  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "seam-bridge-release-"));
  const payload = path.join(temp, "payload");
  await fs.mkdir(payload);
  await copyArtifactFiles(repoRoot, payload);
  await fs.writeFile(path.join(payload, "bridge-release.json"), JSON.stringify({ formatVersion: 1, sourceSha: sha }) + "\n");
  const archive = path.join(temp, `bridge-${sha}.tgz`);
  await run({ file: "tar", args: ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-czf", archive, "-C", payload, "."], mutates: false });
  const checksum = createHash("sha256").update(await fs.readFile(archive)).digest("hex");
  return { sha, checksum, archive, remoteName: artifactName(sha, checksum) };
}

export async function runPreflight(target, remoteScript, run = commandRunner) {
  const command = makeSshCommand(target, ["preflight", target.pm2App, target.bridgeId, target.verifyAgent], remoteScript);
  const result = await run(command);
  const report = parseKeyValues(result.stdout);
  if (report.pm2_app !== target.pm2App) throw new Error("remote PM2 app did not match the operator mapping");
  return { command, report, stdout: result.stdout };
}

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { gunzipSync } from "node:zlib";

const require = createRequire(import.meta.url);
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const INSTANCE = /^[A-Za-z0-9._-]{8,128}$/;
const SAFE_PATH = /^\/[A-Za-z0-9._/-]{1,511}$/;
const MAX_ARCHIVE = 32 * 1024 * 1024;
const MAX_EXPANDED = 128 * 1024 * 1024;
const MAX_MEMBER = 16 * 1024 * 1024;
const MAX_MEMBERS = 2_000;
const LOCK_STALE_MS = 15 * 60 * 1_000;

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function exactPath(value, code) { if (!SAFE_PATH.test(value ?? "") || path.posix.normalize(value) !== value || value.includes("//") || value.endsWith("/")) fail(code); return value; }
function exactFileInside(root, value, code) { exactPath(root, code); exactPath(value, code); if (!value.startsWith(`${root}/`)) fail(code); }
function safeJson(value) { return `${JSON.stringify(value)}\n`; }
function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function nowIso() { return new Date().toISOString(); }
function parseJson(bytes, code) { try { return JSON.parse(bytes); } catch { fail(code); } }
function assertObject(value, code) { if (!value || typeof value !== "object" || Array.isArray(value)) fail(code); }
function parsePid(value, code) { const pid = Number(String(value).trim()); if (!Number.isSafeInteger(pid) || pid < 2) fail(code); return pid; }
function live(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function assertUid(stat, uid, code) { if (stat.uid !== uid) fail(code); }

const argv = process.argv.slice(2);
if (argv.length < 13) fail("argument_count");
const [bridgeId, pm2App, verifyAgent, uidText, checkoutPath, entrypointPath, pidFilePath, nodePath, pm2ModulePath, workspaceText, devModeText, releaseRoot, mode, ...actionArgs] = argv;
let safePhase = "arguments";
if (![bridgeId, pm2App, verifyAgent].every((v) => NAME.test(v))) fail("unsafe_identity_name");
const expectedUid = Number(uidText);
if (!Number.isSafeInteger(expectedUid) || expectedUid < 1) fail("unsafe_expected_uid");
for (const [value, code] of [[checkoutPath,"unsafe_checkout"],[entrypointPath,"unsafe_entrypoint"],[pidFilePath,"unsafe_pid_file"],[nodePath,"unsafe_node"],[pm2ModulePath,"unsafe_pm2_module"],[releaseRoot,"unsafe_release_root"]]) exactPath(value, code);
const workspaceArg = workspaceText === "-" ? null : exactPath(workspaceText, "unsafe_workspace");
if (devModeText !== "yes" && devModeText !== "no") fail("unsafe_dev_mode");
const expectedDevMode = devModeText === "yes";
if (entrypointPath !== `${checkoutPath}/packages/bridge/dist/index.js`) fail("entrypoint_not_stable_launcher");
if (releaseRoot === checkoutPath || releaseRoot.startsWith(`${checkoutPath}/`) || checkoutPath.startsWith(`${releaseRoot}/`)) fail("roots_overlap");

async function runBounded(file, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const stdoutLimit = options.stdoutLimit ?? 256 * 1024;
  const stderrLimit = options.stderrLimit ?? 64 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = []; const stderr = []; let outSize = 0; let errSize = 0; let reason;
    const stop = (code) => { reason ??= code; if (!child.killed) child.kill("SIGKILL"); };
    const timer = setTimeout(() => stop("subprocess_timeout"), timeoutMs); timer.unref?.();
    const onStdout = (chunk) => { outSize += chunk.length; if (outSize > stdoutLimit) stop("subprocess_stdout_limit"); else stdout.push(chunk); };
    const onStderr = (chunk) => { errSize += chunk.length; if (errSize > stderrLimit) stop("subprocess_stderr_limit"); else stderr.push(chunk); };
    const onError = () => { reason ??= "subprocess_spawn_failed"; };
    child.stdout.on("data",onStdout); child.stderr.on("data",onStderr); child.on("error",onError);
    child.on("close", (code) => { clearTimeout(timer); child.stdout.off("data",onStdout); child.stderr.off("data",onStderr); child.off("error",onError); if (reason) reject(new Error(reason)); else if (code !== 0) reject(new Error("subprocess_failed")); else resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }); });
  });
}

async function pm2Describe() {
  let pm2;
  try { pm2 = require(pm2ModulePath); } catch { fail("configured_pm2_module_unavailable"); }
  if (!pm2 || typeof pm2.connect !== "function") fail("configured_pm2_connect_missing");
  if (typeof pm2.describe !== "function") fail("configured_pm2_describe_missing");
  if (typeof pm2.disconnect !== "function") fail("configured_pm2_disconnect_missing");
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); try { pm2.disconnect(); } catch {} error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(new Error("pm2_api_timeout")), 10_000); timer.unref?.();
    try {
      pm2.connect((connectError) => {
        if (connectError) return finish(new Error("pm2_connect_failed"));
        try { pm2.describe(pm2App, (describeError, rows) => finish(describeError ? new Error("pm2_describe_failed") : null, rows)); }
        catch { finish(new Error("pm2_describe_threw")); }
      });
    } catch { finish(new Error("pm2_connect_threw")); }
  });
}

async function pidCwd(pid) {
  if (process.platform === "linux") {
    try { return await fsp.realpath(`/proc/${pid}/cwd`); } catch { fail("process_cwd_unavailable"); }
  }
  try {
    const result = await runBounded("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeoutMs: 10_000 });
    const values = result.stdout.split(/\r?\n/).filter((line) => line.startsWith("n")).map((line) => line.slice(1));
    if (values.length !== 1) fail("process_cwd_ambiguous");
    return await fsp.realpath(values[0]);
  } catch (error) { if (error?.code) throw error; fail("process_cwd_unavailable"); }
}

async function processUid(pid) {
  if (process.platform === "linux") {
    try { return (await fsp.stat(`/proc/${pid}`)).uid; } catch { fail("process_owner_unavailable"); }
  }
  try { return Number((await runBounded("/bin/ps", ["-o", "uid=", "-p", String(pid)], { timeoutMs: 10_000 })).stdout.trim()); }
  catch { fail("process_owner_unavailable"); }
}

async function processExecutable(pid) {
  if (process.platform === "linux") {
    try { return await fsp.realpath(`/proc/${pid}/exe`); } catch { fail("process_executable_unavailable"); }
  }
  try {
    const result = await runBounded("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "txt", "-Fn"], { timeoutMs: 10_000 });
    const values = result.stdout.split(/\r?\n/).filter((line) => line.startsWith("n")).map((line) => line.slice(1));
    for (const value of values) {
      try { if (await fsp.realpath(value) === nodePath) return nodePath; } catch {}
    }
    fail("process_executable_mismatch");
  } catch (error) { if (error?.code) throw error; fail("process_executable_unavailable"); }
}

function validatePm2Args(raw) {
  const args = Array.isArray(raw) ? raw.map(String) : [];
  if (!args.length || args.some((value) => !value || /[\x00-\x1f\x7f]/.test(value))) fail("pm2_argv_invalid");
  const idOffsets = args.flatMap((value, index) => value === "--id" ? [index] : []);
  if (idOffsets.length !== 1 || args[idOffsets[0] + 1] !== bridgeId) fail("pm2_bridge_id_mismatch");
  const cwdOffsets = args.flatMap((value, index) => value === "--cwd" ? [index] : []);
  if (workspaceArg === null ? cwdOffsets.length !== 0 : cwdOffsets.length !== 1 || args[cwdOffsets[0] + 1] !== workspaceArg) fail("pm2_workspace_mismatch");
  const devOffsets = args.flatMap((value,index)=>value === "--dev" ? [index] : []);
  if (expectedDevMode ? devOffsets.length !== 1 : devOffsets.length !== 0) fail("pm2_dev_mode_mismatch");
  const start = args[0] === "connect" ? 1 : 0;
  const flags = new Map(); let positional = 0;
  for (let index = start; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--dev") continue;
    if (value.startsWith("--")) {
      if (!["--server","--token","--id","--cwd","--gist"].includes(value) || flags.has(value) || index + 1 >= args.length || args[index + 1].startsWith("--")) fail("pm2_argv_unexpected");
      flags.set(value,args[++index]);
    } else positional += 1;
  }
  if (start === 1) {
    if (positional !== 0 || !flags.has("--server") || !flags.has("--token")) fail("pm2_connect_argv_mismatch");
  } else if (positional !== 2 || flags.has("--server") || flags.has("--token")) fail("pm2_legacy_argv_mismatch");
}

async function readLiveIdentity() {
  safePhase = `${safePhase}_pid_file`;
  const pidStat = await fsp.lstat(pidFilePath).catch(() => fail("pid_file_missing")); assertUid(pidStat, expectedUid, "pid_file_wrong_owner");
  if (!pidStat.isFile() || pidStat.isSymbolicLink()) fail("pid_file_wrong_type");
  if (await fsp.realpath(pidFilePath) !== pidFilePath) fail("pid_file_symlink_escape");
  const pid = parsePid(await fsp.readFile(pidFilePath, "utf8"), "pid_file_invalid");
  safePhase = "identity_process";
  if (!live(pid)) fail("configured_pid_not_live");
  if (await processUid(pid) !== expectedUid) fail("process_wrong_owner");
  if (await processExecutable(pid) !== nodePath) fail("process_executable_mismatch");
  safePhase = "identity_checkout";
  const checkoutReal = await fsp.realpath(checkoutPath).catch(() => fail("checkout_missing"));
  if (checkoutReal !== checkoutPath) fail("checkout_symlink_or_escape");
  assertUid(await fsp.lstat(checkoutPath), expectedUid, "checkout_wrong_owner");
  const cwd = await pidCwd(pid);
  if (cwd !== checkoutPath) fail("process_cwd_mismatch");
  const nodeReal = await fsp.realpath(nodePath).catch(() => fail("configured_node_missing"));
  if (nodeReal !== nodePath) fail("configured_node_symlink");
  assertUid(await fsp.lstat(nodePath), expectedUid, "configured_node_wrong_owner");
  const pm2Real = await fsp.realpath(pm2ModulePath).catch(() => fail("configured_pm2_module_unavailable"));
  if (pm2Real !== pm2ModulePath) fail("configured_pm2_module_symlink");
  assertUid(await fsp.lstat(pm2ModulePath), expectedUid, "configured_pm2_module_wrong_owner");
  safePhase = "identity_pm2";
  const rows = await pm2Describe();
  safePhase = "identity_pm2_rows";
  if (!Array.isArray(rows) || rows.length !== 1) fail("pm2_app_ambiguous");
  const row = rows[0]; const env = row?.pm2_env;
  safePhase = "identity_pm2_fields";
  if (!env || env.name !== pm2App || parsePid(row.pid, "pm2_pid_invalid") !== pid) fail("pm2_app_pid_mismatch");
  if (env.pm_cwd !== checkoutPath || env.pm_exec_path !== entrypointPath) fail("pm2_launcher_mismatch");
  if (env.exec_interpreter !== nodePath) fail("pm2_interpreter_mismatch");
  safePhase = "identity_pm2_args";
  validatePm2Args(env.args);
  safePhase = "identity_entrypoint";
  const entryStat = await fsp.lstat(entrypointPath).catch(() => fail("entrypoint_missing")); assertUid(entryStat, expectedUid, "entrypoint_wrong_owner");
  if (!entryStat.isFile() && !entryStat.isSymbolicLink()) fail("entrypoint_wrong_type");
  const entryReal = await fsp.realpath(entrypointPath).catch(() => fail("entrypoint_broken"));
  const legacy = entryReal === entrypointPath;
  if (!legacy && !entryReal.startsWith(`${releaseRoot}/releases/`)) fail("entrypoint_escape");
  if (entryReal !== entrypointPath && !entryReal.endsWith("/packages/bridge/dist/index.js")) fail("entrypoint_unexpected_target");
  assertUid(await fsp.stat(entryReal), expectedUid, "entrypoint_target_wrong_owner");
  return { pid, cwd, entryReal, legacy };
}

function tarString(block, start, length) {
  const slice = block.subarray(start, start + length);
  const nul = slice.indexOf(0); const bytes = nul < 0 ? slice : slice.subarray(0, nul);
  return bytes.toString("utf8");
}
function tarPathString(block,start,length) {
  const slice=block.subarray(start,start+length); const nul=slice.indexOf(0);
  if(nul>=0 && slice.subarray(nul).some((byte)=>byte!==0)) fail("archive_ambiguous_header_string");
  return (nul<0?slice:slice.subarray(0,nul)).toString("utf8");
}
function tarNumber(block, start, length) {
  const raw = tarString(block, start, length).trim();
  if (!/^[0-7]+$/.test(raw || "0")) fail("archive_invalid_numeric_field");
  return Number.parseInt(raw || "0", 8);
}
function normalizeMember(raw) {
  if (!raw || raw.startsWith("/") || raw.includes("\\") || /[\x00-\x1f\x7f]/.test(raw)) fail("archive_unsafe_path");
  if (raw.startsWith("./")) raw = raw.slice(2);
  if (!raw || raw === "." || raw.endsWith("/") || raw.includes("//")) fail("archive_ambiguous_path");
  const parts = raw.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) fail("archive_traversal");
  const normalized = path.posix.normalize(raw);
  if (normalized !== raw || normalized.startsWith("../")) fail("archive_normalization_mismatch");
  return normalized;
}

function parseArchive(bytes) {
  if (bytes.length > MAX_ARCHIVE) fail("archive_compressed_size_limit");
  let tar;
  try { tar = gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED }); } catch { fail("archive_invalid_or_expansion_limit"); }
  const members = []; const paths = new Set(); let offset = 0; let total = 0; let zeroBlocks = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512); offset += 512;
    if (header.every((byte) => byte === 0)) { zeroBlocks += 1; if (zeroBlocks === 2) break; continue; }
    if (zeroBlocks) fail("archive_data_after_zero_block");
    const storedChecksum = tarNumber(header, 148, 8);
    const checksumBlock = Buffer.from(header); checksumBlock.fill(0x20, 148, 156);
    const actualChecksum = checksumBlock.reduce((sum, byte) => sum + byte, 0);
    if (storedChecksum !== actualChecksum) fail("archive_header_checksum_mismatch");
    if (tarString(header,257,6) !== "ustar" || tarString(header,263,2) !== "00") fail("archive_format_not_ustar");
    const type = String.fromCharCode(header[156] || 0);
    if (type !== "\0" && type !== "0") fail("archive_non_regular_member");
    if (tarPathString(header, 157, 100)) fail("archive_link_target_forbidden");
    const name = normalizeMember([tarPathString(header, 345, 155), tarPathString(header, 0, 100)].filter(Boolean).join("/"));
    const size = tarNumber(header, 124, 12);
    if (size > MAX_MEMBER) fail("archive_member_size_limit");
    total += size; if (total > MAX_EXPANDED) fail("archive_total_size_limit");
    if (members.length >= MAX_MEMBERS) fail("archive_member_count_limit");
    if (paths.has(name)) fail("archive_duplicate_path");
    for (const existing of paths) if (existing.startsWith(`${name}/`) || name.startsWith(`${existing}/`)) fail("archive_path_prefix_conflict");
    paths.add(name);
    if (offset + size > tar.length) fail("archive_truncated_member");
    members.push({ name, size, bytes: tar.subarray(offset, offset + size) });
    offset += Math.ceil(size / 512) * 512;
  }
  if (zeroBlocks !== 2 || members.length === 0) fail("archive_missing_terminator");
  if (tar.length % 512 !== 0 || tar.subarray(offset).some((byte)=>byte!==0)) fail("archive_data_after_terminator");
  return members;
}

function validateManifest(members, sourceSha) {
  const byName = new Map(members.map((member) => [member.name, member]));
  const envelope = byName.get("bridge-release.json"); if (!envelope) fail("archive_manifest_missing");
  const manifest = parseJson(envelope.bytes, "archive_manifest_invalid"); assertObject(manifest, "archive_manifest_invalid");
  if (manifest.formatVersion !== 2 || manifest.sourceSha !== sourceSha || !Array.isArray(manifest.files)) fail("archive_manifest_identity_mismatch");
  const declared = new Set(["bridge-release.json"]);
  for (const item of manifest.files) {
    assertObject(item, "archive_manifest_file_invalid"); const relative = normalizeMember(item.path);
    const allowed = relative === "package.json" || relative === "package-lock.json" || /^packages\/(adapters|bridge)\/(package\.json|dist\/[A-Za-z0-9._/-]+)$/.test(relative) || relative === "packages/core/package.json";
    if (!allowed || declared.has(relative)) fail("archive_unexpected_file");
    const member = byName.get(relative); if (!member || item.size !== member.size || !HASH.test(item.sha256 ?? "") || hash(member.bytes) !== item.sha256) fail("archive_manifest_file_mismatch");
    declared.add(relative);
  }
  if (declared.size !== byName.size || [...byName.keys()].some((name) => !declared.has(name))) fail("archive_unexpected_extra");
  for (const required of ["package.json","package-lock.json","packages/adapters/package.json","packages/bridge/package.json","packages/core/package.json","packages/adapters/dist/index.js","packages/bridge/dist/index.js","packages/bridge/dist/rpc.js"]) if (!declared.has(required)) fail("archive_required_file_missing");
  const rootPackage = parseJson(byName.get("package.json").bytes, "root_package_invalid");
  const adaptersPackage = parseJson(byName.get("packages/adapters/package.json").bytes, "adapters_package_invalid");
  const bridgePackage = parseJson(byName.get("packages/bridge/package.json").bytes, "bridge_package_invalid");
  const corePackage = parseJson(byName.get("packages/core/package.json").bytes, "core_package_invalid");
  const lock = parseJson(byName.get("package-lock.json").bytes, "lockfile_invalid");
  if (rootPackage.name !== "seam-acp" || adaptersPackage.name !== "@seam/adapters" || bridgePackage.name !== "@seam/bridge" || corePackage.name !== "@seam/core") fail("package_identity_mismatch");
  if (lock.name !== "seam-acp" || !lock.packages?.[""] || lock.packages["packages/adapters"]?.name !== "@seam/adapters" || lock.packages["packages/bridge"]?.name !== "@seam/bridge" || lock.packages["packages/core"]?.name !== "@seam/core") fail("lockfile_identity_mismatch");
  return manifest;
}

async function extractMembers(members, destination) {
  for (const member of members) {
    const output = path.join(destination, ...member.name.split("/"));
    exactFileInside(destination, output, "archive_extraction_escape");
    await fsp.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
    await fsp.writeFile(output, member.bytes, { flag: "wx", mode: 0o600 });
  }
}

async function materializeLinks(root) {
  const visit = async (directory) => {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const resolved = await fsp.realpath(child).catch(() => fail("installed_link_broken"));
        exactFileInside(root, resolved, "installed_link_escape");
        const stat = await fsp.stat(child); await fsp.unlink(child);
        if (stat.isDirectory()) await fsp.cp(resolved, child, { recursive: true, dereference: true });
        else if (stat.isFile()) await fsp.copyFile(resolved, child);
        else fail("installed_link_special_target");
      }
    }
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) await visit(path.join(directory, entry.name));
  };
  await visit(root);
}

async function treeDigest(root, options = {}) {
  const lines = [];
  const visit = async (directory, relative = "") => {
    const entries = await fsp.readdir(directory, { withFileTypes: true }); entries.sort((a,b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (options.exclude?.has(rel)) continue;
      const full = path.join(directory, entry.name); const stat = await fsp.lstat(full);
      assertUid(stat, expectedUid, "release_tree_wrong_owner");
      if (entry.isSymbolicLink()) fail("release_tree_link_forbidden");
      if (entry.isDirectory()) { lines.push(`d ${rel}`); await visit(full, rel); }
      else if (entry.isFile()) { const bytes = await fsp.readFile(full); lines.push(`f ${rel} ${bytes.length} ${hash(bytes)}`); }
      else fail("release_tree_special_file");
    }
  };
  await visit(root); return hash(Buffer.from(`${lines.join("\n")}\n`));
}

async function validateExactLayout(root, manifest) {
  const expectedFiles = new Set(["bridge-release.json","release-receipt.json",...manifest.files.map((item) => item.path)]);
  if (fs.existsSync(path.join(root,"activation-envelope.json"))) expectedFiles.add("activation-envelope.json");
  const expectedDirs = new Set(["packages"]);
  for (const file of expectedFiles) { let current = path.posix.dirname(file); while (current !== ".") { expectedDirs.add(current); current = path.posix.dirname(current); } }
  const lock = parseJson(await fsp.readFile(path.join(root,"package-lock.json")),"lockfile_invalid");
  const dependencyRoots = Object.keys(lock.packages ?? {}).filter((item) => item.startsWith("node_modules/")).sort((a,b)=>b.length-a.length);
  const walk = async (directory, relative="") => {
    for (const entry of await fsp.readdir(directory,{withFileTypes:true})) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name; const full = path.join(directory,entry.name);
      if (rel === "node_modules" || rel.startsWith("node_modules/")) {
        if (rel === "node_modules") { if (!entry.isDirectory()) fail("release_node_modules_wrong_type"); await walk(full,rel); continue; }
        const withinDependency = dependencyRoots.some((dependency) => rel === dependency || rel.startsWith(`${dependency}/`));
        const dependencyPrefix = dependencyRoots.some((dependency) => dependency.startsWith(`${rel}/`));
        const generatedLock = rel === "node_modules/.package-lock.json";
        if (!withinDependency && !dependencyPrefix && !generatedLock) fail("release_unexpected_dependency_path");
        if (entry.isDirectory()) await walk(full,rel);
        else if (!entry.isFile() || entry.isSymbolicLink()) fail("release_dependency_wrong_type");
        continue;
      }
      if (entry.isDirectory()) { if (!expectedDirs.has(rel)) fail("release_unexpected_directory"); await walk(full,rel); }
      else if (!entry.isFile() || entry.isSymbolicLink() || !expectedFiles.has(rel)) fail("release_unexpected_file");
    }
  };
  await walk(root);
  for (const expected of expectedFiles) if (!fs.existsSync(path.join(root,expected))) fail("release_expected_file_missing");
}

const mutableReleaseFiles = new Set(["release-receipt.json", "activation-envelope.json"]);
async function validateRelease(release, expectedSha, expectedChecksum, expectedStageId) {
  exactFileInside(`${releaseRoot}/releases`, release, "release_path_escape");
  const real = await fsp.realpath(release).catch(() => fail("release_missing")); if (real !== release) fail("release_symlink_or_escape");
  const stat = await fsp.lstat(release); if (!stat.isDirectory()) fail("release_wrong_type"); assertUid(stat, expectedUid, "release_wrong_owner");
  const receiptPath = path.join(release, "release-receipt.json");
  const receiptStat = await fsp.lstat(receiptPath).catch(() => fail("release_receipt_missing"));
  if (!receiptStat.isFile() || receiptStat.isSymbolicLink()) fail("release_receipt_wrong_type"); assertUid(receiptStat, expectedUid, "release_receipt_wrong_owner");
  const envelopePath = path.join(release, "activation-envelope.json");
  if (fs.existsSync(envelopePath)) { const envelopeStat = await fsp.lstat(envelopePath); if (!envelopeStat.isFile() || envelopeStat.isSymbolicLink()) fail("activation_envelope_wrong_type"); assertUid(envelopeStat, expectedUid, "activation_envelope_wrong_owner"); }
  const receipt = parseJson(await fsp.readFile(receiptPath).catch(() => fail("release_receipt_missing")), "release_receipt_invalid");
  if (receipt.formatVersion !== 2 || receipt.bridgeId !== bridgeId || receipt.sourceSha !== expectedSha || receipt.artifactChecksum !== expectedChecksum || (expectedStageId && receipt.stageId !== expectedStageId) || !HASH.test(receipt.stageId ?? "") || !HASH.test(receipt.treeDigest ?? "")) fail("release_receipt_identity_mismatch");
  const manifest = parseJson(await fsp.readFile(path.join(release, "bridge-release.json")), "release_manifest_invalid");
  if (manifest.formatVersion !== 2 || manifest.sourceSha !== expectedSha || !Array.isArray(manifest.files)) fail("release_manifest_identity_mismatch");
  for (const item of manifest.files) {
    const full = path.join(release, ...normalizeMember(item.path).split("/")); exactFileInside(release, full, "release_manifest_escape");
    const fileStat = await fsp.lstat(full).catch(() => fail("release_manifest_file_missing"));
    if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size !== item.size || hash(await fsp.readFile(full)) !== item.sha256) fail("release_manifest_file_changed");
  }
  await validateExactLayout(release,manifest);
  for (const packageFile of ["packages/adapters/package.json","packages/bridge/package.json"]) {
    const packageJson=parseJson(await fsp.readFile(path.join(release,packageFile)),"release_package_invalid");
    for(const dependency of Object.keys(packageJson.dependencies??{})) {
      if(!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(dependency)) fail("release_dependency_name_invalid");
      const installed=path.join(release,"node_modules",...dependency.split("/")); const installedStat=await fsp.lstat(installed).catch(()=>fail("release_dependency_missing"));
      if(!installedStat.isDirectory()||installedStat.isSymbolicLink()) fail("release_dependency_wrong_type");
    }
  }
  const top = (await fsp.readdir(release)).sort();
  if (top.some((name) => !["activation-envelope.json","bridge-release.json","node_modules","package-lock.json","package.json","packages","release-receipt.json"].includes(name))) fail("release_unexpected_top_level");
  const packages = (await fsp.readdir(path.join(release,"packages"))).sort(); if (packages.join(",") !== "adapters,bridge,core") fail("release_unexpected_packages");
  const digest = await treeDigest(release, { exclude: mutableReleaseFiles }); if (digest !== receipt.treeDigest) fail("release_tree_digest_mismatch");
  return receipt;
}

async function acquireLock(operationId) {
  if (!HASH.test(operationId ?? "")) fail("operation_id_invalid");
  const locks = `${releaseRoot}/locks`; const lock = `${locks}/${bridgeId}`;
  await fsp.mkdir(locks, { recursive: true, mode: 0o700 });
  try { await fsp.mkdir(lock, { mode: 0o700 }); }
  catch {
    let owner; try { owner = parseJson(await fsp.readFile(`${lock}/owner.json`), "lock_owner_invalid"); } catch (error) { if (error?.code) throw error; fail("lock_owner_invalid"); }
    const created = Date.parse(owner.createdAt); if (!HASH.test(owner.operationId ?? "") || !Number.isFinite(created) || !Number.isSafeInteger(owner.pid)) fail("lock_owner_invalid");
    if (Date.now() - created <= LOCK_STALE_MS || live(owner.pid)) fail("target_lock_busy");
    const staleRoot = `${releaseRoot}/stale-locks`; await fsp.mkdir(staleRoot, { recursive: true, mode: 0o700 });
    await fsp.rename(lock, `${staleRoot}/${bridgeId}-${owner.operationId}-${Date.now()}`).catch(() => fail("stale_lock_race"));
    await fsp.mkdir(lock, { mode: 0o700 }).catch(() => fail("target_lock_race"));
  }
  await fsp.writeFile(`${lock}/owner.json`, safeJson({ formatVersion: 1, bridgeId, operationId, pid: process.pid, createdAt: nowIso() }), { flag: "wx", mode: 0o600 });
  return async () => {
    const owner = parseJson(await fsp.readFile(`${lock}/owner.json`).catch(() => fail("lock_lost")), "lock_owner_invalid");
    if (owner.operationId !== operationId || owner.pid !== process.pid) fail("lock_ownership_changed");
    await fsp.unlink(`${lock}/owner.json`); await fsp.rmdir(lock);
  };
}

async function requireManagedDirectory(directory) {
  const real = await fsp.realpath(directory).catch(() => fail("managed_directory_missing"));
  if (real !== directory) fail("managed_directory_symlink");
  const stat = await fsp.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) fail("managed_directory_wrong_type"); assertUid(stat, expectedUid, "managed_directory_wrong_owner");
}

async function prepareManagedRoot() {
  const parent = path.dirname(releaseRoot); const parentReal = await fsp.realpath(parent).catch(() => fail("release_parent_missing"));
  if (parentReal !== parent) fail("release_parent_symlink"); assertUid(await fsp.lstat(parent), expectedUid, "release_parent_wrong_owner");
  await fsp.mkdir(releaseRoot, { mode: 0o700 }).catch((error) => { if (error?.code !== "EEXIST") throw error; });
  await requireManagedDirectory(releaseRoot); await fsp.chmod(releaseRoot,0o700);
  for (const part of ["incoming","releases","activations","rollbacks","locks","stale-locks","failed-staging"]) {
    const directory = `${releaseRoot}/${part}`; await fsp.mkdir(directory,{mode:0o700}).catch((error)=>{if(error?.code!=="EEXIST")throw error;}); await requireManagedDirectory(directory); await fsp.chmod(directory,0o700);
  }
}

async function withLock(operationId, fn) { const release = await acquireLock(operationId); try { return await fn(); } finally { await release(); } }

async function waitForReplacement(oldPid, seconds) {
  const deadline = Date.now() + seconds * 1000; let oldExited = false;
  while (Date.now() <= deadline) {
    if (!live(oldPid)) oldExited = true;
    let candidate;
    try { candidate = parsePid(await fsp.readFile(pidFilePath,"utf8"), "pid_file_invalid"); } catch {}
    if (oldExited && candidate && candidate !== oldPid && live(candidate)) return candidate;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail("replacement_pid_timeout");
}

async function writeActivationEnvelope(release, envelope) {
  const file = `${release}/activation-envelope.json`; const temp = `${file}.next-${envelope.activationId}`;
  await fsp.writeFile(temp, safeJson(envelope), { flag: "wx", mode: 0o600 }); await fsp.rename(temp, file);
}

async function verifyActivationReceipt(release, expected) {
  const receiptPath = `${release}/release-receipt.json`; const deadline = expected.deadline;
  while (Date.now() <= deadline) {
    try {
      const value = parseJson(await fsp.readFile(receiptPath), "activation_receipt_invalid");
      const sequence = [value.startedAt,value.helloAcceptedAt,value.catalogRpcs?.[verifyAgent]?.describeModelCatalogAt,value.catalogRpcs?.[verifyAgent]?.fetchModelCatalogAt,value.controllerVerifiedAt,value.completedAt].map(Date.parse);
      if (value.formatVersion === 2 && value.activationId === expected.activationId && value.bridgeId === bridgeId && value.sourceSha === expected.sourceSha && value.artifactChecksum === expected.artifactChecksum && value.stageId === expected.stageId && value.oldPid === expected.oldPid && value.pid === expected.newPid && INSTANCE.test(value.instanceId ?? "") && value.protocolVersion === 1 && sequence.every(Number.isFinite) && sequence.every((time,index) => !index || time >= sequence[index-1]) && sequence[0] >= expected.started && sequence.at(-1) <= expected.deadline && value.controllerAck?.activationId === expected.activationId && value.controllerAck?.bridgeId === bridgeId && value.controllerAck?.instanceId === value.instanceId && value.controllerAck?.pid === expected.newPid) return value;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail("activation_receipt_timeout");
}

async function switchEntrypoint(target) {
  const temp = `${entrypointPath}.seam-next-${process.pid}`;
  await fsp.symlink(target, temp); await fsp.rename(temp, entrypointPath);
  const real = await fsp.realpath(entrypointPath); if (real !== target) fail("entrypoint_switch_not_atomic");
}

async function preflight() {
  if (actionArgs.length) fail("preflight_argument_count");
  const identity = await readLiveIdentity();
  console.log("reachable=yes"); console.log(`bridge_id=${bridgeId}`); console.log(`pm2_app=${pm2App}`); console.log(`pid=${identity.pid}`);
  console.log(`cwd=${identity.cwd}`); console.log(`entrypoint=${entrypointPath}`); console.log(`entrypoint_target=${identity.entryReal}`);
  console.log(`expected_uid=${expectedUid}`); console.log(`node_path=${nodePath}`); console.log(`release_root=${releaseRoot}`); console.log("identity_bound=yes"); console.log("remote_mutation=no");
}

async function prepareUpload() {
  if (actionArgs.length !== 1 || !HASH.test(actionArgs[0])) fail("prepare_argument_count");
  await readLiveIdentity();
  await prepareManagedRoot();
  await withLock(actionArgs[0], async () => {});
  console.log("upload_ready=yes");
}

async function stage() {
  safePhase = "stage_arguments";
  if (actionArgs.length !== 4) fail("stage_argument_count");
  const [sourceSha, checksum, filename, operationId] = actionArgs;
  const canonicalName = `bridge-${sourceSha}-${checksum}.tgz`;
  if (!SHA.test(sourceSha) || !HASH.test(checksum) || !HASH.test(operationId) || filename !== `${canonicalName}.upload-${operationId}`) fail("stage_identity_invalid");
  safePhase = "stage_identity"; await readLiveIdentity(); await requireManagedDirectory(releaseRoot); await requireManagedDirectory(`${releaseRoot}/incoming`); await requireManagedDirectory(`${releaseRoot}/releases`); await requireManagedDirectory(`${releaseRoot}/locks`); await requireManagedDirectory(`${releaseRoot}/stale-locks`);
  safePhase = "stage_lock";
  await withLock(operationId, async () => {
    safePhase = "stage_archive";
    const uploadPath = `${releaseRoot}/incoming/${filename}`; const archiveStat = await fsp.lstat(uploadPath).catch(() => fail("archive_missing"));
    if (!archiveStat.isFile() || archiveStat.isSymbolicLink() || archiveStat.size > MAX_ARCHIVE) fail("archive_wrong_type_or_size"); assertUid(archiveStat, expectedUid, "archive_wrong_owner");
    const archive = await fsp.readFile(uploadPath); if (hash(archive) !== checksum) fail("archive_checksum_mismatch");
    const archivePath = `${releaseRoot}/incoming/${canonicalName}`;
    if (fs.existsSync(archivePath)) {
      const existing = await fsp.readFile(archivePath); if (hash(existing) !== checksum) fail("canonical_archive_mismatch");
      await fsp.unlink(uploadPath);
    } else await fsp.rename(uploadPath, archivePath);
    const members = parseArchive(archive); validateManifest(members, sourceSha);
    const release = `${releaseRoot}/releases/${sourceSha}-${checksum}`;
    if (fs.existsSync(release)) {
      const receipt = await validateRelease(release, sourceSha, checksum);
      console.log(`staged_release=${release}`); console.log(`stage_id=${receipt.stageId}`); console.log(`artifact_checksum=${checksum}`); console.log("release_reused=revalidated"); return;
    }
    const partial = await fsp.mkdtemp(`${releaseRoot}/releases/.stage-${sourceSha}-`); await fsp.chmod(partial, 0o700);
    let stageStep = "extract";
    try {
      await extractMembers(members, partial);
      validateManifest(parseArchive(archive), sourceSha);
      stageStep = "install";
      safePhase = "stage_install";
      const npmPath = `${path.dirname(nodePath)}/npm`; const npmStat = await fsp.lstat(npmPath).catch(() => fail("configured_npm_missing")); if (!npmStat.isFile() && !npmStat.isSymbolicLink()) fail("configured_npm_wrong_type");
      await runBounded(npmPath, ["ci","--omit=dev","--bin-links=false","--install-links=true","--workspace=@seam/adapters","--workspace=@seam/bridge","--no-audit","--no-fund"], { cwd: partial, timeoutMs: 600_000, stdoutLimit: 512*1024, stderrLimit: 256*1024, env: { PATH: `${path.dirname(nodePath)}:/usr/bin:/bin`, HOME: process.env.HOME ?? releaseRoot, TMPDIR: process.env.TMPDIR ?? "/tmp", npm_config_userconfig: "/dev/null" } });
      stageStep = "link_materialization";
      safePhase = "stage_link_materialization";
      await materializeLinks(partial);
      const stageId = operationId;
      stageStep = "tree_receipt";
      safePhase = "stage_tree_receipt";
      const digest = await treeDigest(partial, { exclude: mutableReleaseFiles });
      await fsp.writeFile(`${partial}/release-receipt.json`, safeJson({ formatVersion: 2, bridgeId, sourceSha, artifactChecksum: checksum, verificationAgent: verifyAgent, stageId, treeDigest: digest, stagedAt: nowIso() }), { flag: "wx", mode: 0o600 });
      if (await treeDigest(partial, { exclude: mutableReleaseFiles }) !== digest) fail("post_install_tree_changed");
      stageStep = "publish";
      safePhase = "stage_publish";
      await fsp.rename(partial, release).catch(() => fail("release_publish_race"));
      await validateRelease(release, sourceSha, checksum, stageId);
      console.log(`staged_release=${release}`); console.log(`stage_id=${stageId}`); console.log(`artifact_checksum=${checksum}`); console.log("release_reused=no");
    } catch (error) {
      const failed = `${releaseRoot}/failed-staging/${sourceSha}-${checksum}-${operationId}`;
      await fsp.rename(partial, failed).catch(() => {});
      if ((typeof error?.code === "string" && /^[a-z0-9_]+$/i.test(error.code)) || (typeof error?.message === "string" && /^[a-z0-9_]+$/i.test(error.message))) throw error;
      fail(`stage_${stageStep}_failed`);
    }
  });
}

async function activate() {
  if (actionArgs.length !== 6) fail("activate_argument_count");
  const [sourceSha, checksum, stageId, activationId, timeoutText, operationId] = actionArgs;
  const timeout = Number(timeoutText);
  if (!SHA.test(sourceSha) || !HASH.test(checksum) || !HASH.test(stageId) || !HASH.test(activationId) || !HASH.test(operationId) || !Number.isInteger(timeout) || timeout < 10 || timeout > 900) fail("activate_identity_invalid");
  await readLiveIdentity(); await requireManagedDirectory(releaseRoot); await requireManagedDirectory(`${releaseRoot}/activations`); await requireManagedDirectory(`${releaseRoot}/releases`); await requireManagedDirectory(`${releaseRoot}/locks`); await requireManagedDirectory(`${releaseRoot}/stale-locks`);
  await withLock(operationId, async () => {
    const before = await readLiveIdentity();
    if (before.legacy) fail("legacy_previous_release_not_receipt_capable");
    const previousDir = path.resolve(before.entryReal, "../../../..");
    const previousName = path.basename(previousDir); const match = /^([0-9a-f]{40})-([0-9a-f]{64})$/.exec(previousName); if (!match) fail("previous_release_name_invalid");
    const previousReceipt = await validateRelease(previousDir, match[1], match[2]);
    const release = `${releaseRoot}/releases/${sourceSha}-${checksum}`; const staged = await validateRelease(release, sourceSha, checksum, stageId);
    if (release === previousDir) fail("requested_release_already_active");
    const started = Date.now(); const deadline = started + timeout * 1000;
    const intent = { formatVersion: 2, kind: "activate", activationId, bridgeId, pm2App, sourceSha, artifactChecksum: checksum, stageId, previous: { sourceSha: previousReceipt.sourceSha, artifactChecksum: previousReceipt.artifactChecksum, stageId: previousReceipt.stageId, entrypoint: before.entryReal }, activatedEntrypoint: `${release}/packages/bridge/dist/index.js`, oldPid: before.pid, startedAt: new Date(started).toISOString(), deadlineAt: new Date(deadline).toISOString() };
    await fsp.writeFile(`${releaseRoot}/activations/${activationId}.intent.json`, safeJson(intent), { flag: "wx", mode: 0o600 });
    await writeActivationEnvelope(release, { formatVersion: 2, activationId, bridgeId, sourceSha, artifactChecksum: checksum, verificationAgent: verifyAgent, stageId: staged.stageId, oldPid: before.pid, startedAt: intent.startedAt, deadlineAt: intent.deadlineAt });
    await switchEntrypoint(intent.activatedEntrypoint);
    process.kill(before.pid, "SIGUSR2");
    const newPid = await waitForReplacement(before.pid, timeout);
    const after = await readLiveIdentity(); if (after.pid !== newPid || after.entryReal !== intent.activatedEntrypoint || after.legacy) fail("replacement_identity_mismatch");
    const observed = { ...intent, newPid, observedAt: nowIso() };
    await fsp.writeFile(`${releaseRoot}/activations/${activationId}.observed.json`, safeJson(observed), { flag: "wx", mode: 0o600 });
    const ready = await verifyActivationReceipt(release, { activationId, sourceSha, artifactChecksum: checksum, stageId, oldPid: before.pid, newPid, started, deadline });
    const readyReceiptSha256 = hash(await fsp.readFile(`${release}/release-receipt.json`));
    const outcome = { ...observed, instanceId: ready.instanceId, readyReceipt: `${release}/release-receipt.json`, readyReceiptSha256, verifiedAt: nowIso() };
    await fsp.writeFile(`${releaseRoot}/activations/${activationId}.verified.json`, safeJson(outcome), { flag: "wx", mode: 0o600 });
    console.log("activation=verified"); console.log(`activation_id=${activationId}`); console.log(`old_pid=${before.pid}`); console.log(`new_pid=${newPid}`); console.log(`instance_id=${ready.instanceId}`); console.log(`rollback_command=npm run bridge:rollout -- --target ${bridgeId} --rollback --activation-id ${activationId} --apply`);
  });
}

async function rollback() {
  if (actionArgs.length !== 4) fail("rollback_argument_count");
  const [failedActivationId, rollbackId, timeoutText, operationId] = actionArgs; const timeout = Number(timeoutText);
  if (![failedActivationId,rollbackId,operationId].every((v) => HASH.test(v)) || !Number.isInteger(timeout) || timeout < 10 || timeout > 900) fail("rollback_identity_invalid");
  await readLiveIdentity(); await requireManagedDirectory(releaseRoot); await requireManagedDirectory(`${releaseRoot}/activations`); await requireManagedDirectory(`${releaseRoot}/rollbacks`); await requireManagedDirectory(`${releaseRoot}/releases`); await requireManagedDirectory(`${releaseRoot}/locks`); await requireManagedDirectory(`${releaseRoot}/stale-locks`);
  await withLock(operationId, async () => {
    let record; let recordKind; const verifiedRecordPath = `${releaseRoot}/activations/${failedActivationId}.verified.json`;
    if (fs.existsSync(verifiedRecordPath)) { record = parseJson(await fsp.readFile(verifiedRecordPath), "verified_activation_record_invalid"); recordKind = "verified"; }
    else { record = parseJson(await fsp.readFile(`${releaseRoot}/activations/${failedActivationId}.observed.json`).catch(() => fail("activation_observation_missing")), "activation_observation_invalid"); recordKind = "observed"; }
    if (record.formatVersion !== 2 || record.activationId !== failedActivationId || record.bridgeId !== bridgeId || record.pm2App !== pm2App || !SHA.test(record.sourceSha) || !HASH.test(record.artifactChecksum) || !HASH.test(record.stageId) || !Number.isSafeInteger(record.oldPid) || !Number.isSafeInteger(record.newPid)) fail("verified_activation_record_mismatch");
    const current = await readLiveIdentity();
    if (current.pid !== record.newPid || current.entryReal !== record.activatedEntrypoint) fail("rollback_current_activation_mismatch");
    const currentDir = path.resolve(current.entryReal,"../../../.."); await validateRelease(currentDir, record.sourceSha, record.artifactChecksum, record.stageId);
    if (recordKind === "verified" && (!HASH.test(record.readyReceiptSha256 ?? "") || hash(await fsp.readFile(record.readyReceipt)) !== record.readyReceiptSha256)) fail("activation_ready_receipt_changed");
    const previous = record.previous; assertObject(previous,"rollback_previous_invalid");
    const previousDir = path.resolve(previous.entrypoint,"../../../.."); const previousReceipt = await validateRelease(previousDir, previous.sourceSha, previous.artifactChecksum, previous.stageId);
    const started = Date.now(); const deadline = started + timeout * 1000;
    const intent = { formatVersion: 2, kind: "rollback", rollbackId, failedActivationId, failedActivationRecordKind: recordKind, bridgeId, pm2App, from: { sourceSha: record.sourceSha, artifactChecksum: record.artifactChecksum, stageId: record.stageId, entrypoint: record.activatedEntrypoint, pid: record.newPid, readyReceiptSha256: record.readyReceiptSha256 ?? null }, to: previous, oldPid: current.pid, startedAt: new Date(started).toISOString(), deadlineAt: new Date(deadline).toISOString() };
    await fsp.writeFile(`${releaseRoot}/rollbacks/${failedActivationId}-${rollbackId}.intent.json`, safeJson(intent), { flag: "wx", mode: 0o600 });
    await writeActivationEnvelope(previousDir, { formatVersion: 2, activationId: rollbackId, bridgeId, sourceSha: previous.sourceSha, artifactChecksum: previous.artifactChecksum, verificationAgent: verifyAgent, stageId: previousReceipt.stageId, oldPid: current.pid, startedAt: intent.startedAt, deadlineAt: intent.deadlineAt });
    await switchEntrypoint(previous.entrypoint); process.kill(current.pid,"SIGUSR2");
    const newPid = await waitForReplacement(current.pid, timeout); const after = await readLiveIdentity();
    if (after.pid !== newPid || after.entryReal !== previous.entrypoint) fail("rollback_replacement_identity_mismatch");
    const ready = await verifyActivationReceipt(previousDir, { activationId: rollbackId, sourceSha: previous.sourceSha, artifactChecksum: previous.artifactChecksum, stageId: previous.stageId, oldPid: current.pid, newPid, started, deadline });
    const rollbackReadyReceiptSha256 = hash(await fsp.readFile(`${previousDir}/release-receipt.json`));
    await fsp.writeFile(`${releaseRoot}/rollbacks/${failedActivationId}-${rollbackId}.verified.json`, safeJson({ ...intent, newPid, instanceId: ready.instanceId, readyReceipt: `${previousDir}/release-receipt.json`, readyReceiptSha256: rollbackReadyReceiptSha256, verifiedAt: nowIso() }), { flag: "wx", mode: 0o600 });
    console.log("rollback=verified"); console.log(`rollback_id=${rollbackId}`); console.log(`old_pid=${current.pid}`); console.log(`new_pid=${newPid}`); console.log(`restored_sha=${previous.sourceSha}`); console.log(`restored_checksum=${previous.artifactChecksum}`);
  });
}

try {
  if (mode === "preflight") await preflight();
  else if (mode === "prepare-upload") await prepareUpload();
  else if (mode === "stage") await stage();
  else if (mode === "activate") await activate();
  else if (mode === "rollback") await rollback();
  else fail("unknown_mode");
} catch (error) {
  const safeCode = typeof error?.code === "string" && /^[a-z0-9_]+$/i.test(error.code) ? error.code : typeof error?.message === "string" && /^[a-z0-9_]+$/i.test(error.message) ? error.message : `unexpected_${safePhase}`;
  console.error(`error=${safeCode}`);
  process.exitCode = 1;
}

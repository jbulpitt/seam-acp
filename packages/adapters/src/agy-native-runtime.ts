import { createHash } from "node:crypto";
import {
  spawn,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AdapterRuntimeDescriptor } from "./agent-profile.js";

const SAFE_ENV_KEYS = [
  "HOME", "USERPROFILE", "PATH", "TMPDIR", "TMP", "TEMP",
  "LANG", "LC_ALL", "LC_CTYPE", "TZ", "SystemRoot", "ComSpec", "PATHEXT",
] as const;
const VERSION_TIMEOUT_MS = 5_000;
const VERSION_OUTPUT_LIMIT = 16_384;
const VERIFICATION_CACHE_LIMIT = 32;
const SNAPSHOT_CACHE_LIMIT = 4;

export interface AgyNativeRuntimeOptions {
  executable: string;
  runtimeRoot: string;
  version: string;
  sha256: string;
  credentialScope: string;
  cwd: string;
  baseEnv?: NodeJS.ProcessEnv;
  /** Explicit non-secret additions, primarily for hermetic host fixtures. */
  approvedEnvironment?: Readonly<Record<string, string>>;
}

export interface AgyNativeSpawnOptions {
  /** R5: own the LS/tool descendants as well as the CLI during teardown. */
  detached?: boolean;
  mcpHome?: string;
  stdio: readonly [
    "pipe" | "ignore" | "inherit",
    "pipe" | "ignore" | "inherit",
    "pipe" | "ignore" | "inherit",
  ];
}

export interface AgyNativePreparedLaunch {
  spawn(): ChildProcess;
  close(): void;
}

interface VerificationEntry {
  fingerprint: string;
  digest: string;
  version?: string;
}

const verificationCache = new Map<string, VerificationEntry>();

interface VerifiedSnapshot extends VerificationEntry {
  fd: number;
  executable: string;
  argvPrefix: string[];
  close(): void;
}

interface CachedSnapshot {
  fd: number;
  executable: string;
  argvPrefix: string[];
}

const snapshotCache = new Map<string, CachedSnapshot>();

const NODE_FD_MODULE_LOADER = [
  "import fs from 'node:fs';",
  "const source=fs.readFileSync(3,'utf8').replace(/^#![^\\n]*(?:\\n|$)/,'');",
  "await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));",
].join("");

function requireAbsolute(name: string, value: string): string {
  const normalized = path.normalize(value.trim());
  if (!value.trim() || !path.isAbsolute(normalized)) {
    throw new Error(`${name} must be an exact absolute path`);
  }
  return normalized;
}

function requireSemanticScope(value: string): string {
  const scope = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/.test(scope) || path.isAbsolute(scope)) {
    throw new Error("AGY_CREDENTIAL_SCOPE must be a non-secret semantic identifier");
  }
  return scope;
}

function validateExpectedVersion(value: string): string {
  const version = value.trim();
  if (!version || version.length > 256 || /[\r\n\0]/.test(version)) {
    throw new Error("AGY_VERSION must be the exact bounded first line from AGY_BIN --version");
  }
  return version;
}

function validateExpectedDigest(value: string): string {
  const digest = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error("AGY_SHA256 must be 64 lowercase hex characters");
  }
  return digest;
}

export function agyManagedExecutablePath(runtimeRoot: string, sha256: string): string {
  return path.join(path.normalize(runtimeRoot), validateExpectedDigest(sha256), process.platform === "win32" ? "agy.exe" : "agy");
}

function assertNotWritable(target: string, name: string): void {
  try {
    fs.accessSync(target, fs.constants.W_OK);
  } catch {
    return;
  }
  throw new Error(`${name} must be immutable to the Seam service user`);
}

export function verifyAgyManagedRuntimeArtifact(
  executable: string,
  runtimeRoot: string,
  expectedSha256: string
): VerificationEntry {
  let rootReal: string;
  let executableReal: string;
  try {
    rootReal = fs.realpathSync(runtimeRoot);
  } catch {
    throw new Error(`AGY_RUNTIME_ROOT does not exist: ${runtimeRoot}`);
  }
  if (rootReal !== runtimeRoot) {
    throw new Error("AGY_RUNTIME_ROOT must be its exact real path, not a symlinked path");
  }
  try {
    executableReal = fs.realpathSync(executable);
  } catch {
    throw new Error(`AGY executable does not exist: ${executable}`);
  }
  if (executableReal !== executable) {
    throw new Error("AGY executable must be its exact real path, not a symlinked path");
  }
  const expectedPath = agyManagedExecutablePath(rootReal, expectedSha256);
  if (executableReal !== expectedPath) {
    throw new Error(`AGY executable must use the managed content-addressed path ${expectedPath}`);
  }

  const releaseDir = path.dirname(executableReal);
  const stat = fs.statSync(executableReal);
  if (!stat.isFile()) throw new Error("AGY executable is not a regular file");
  fs.accessSync(executableReal, fs.constants.X_OK);
  assertNotWritable(rootReal, "AGY_RUNTIME_ROOT");
  assertNotWritable(releaseDir, "AGY release directory");
  assertNotWritable(executableReal, "AGY executable");

  const fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const cached = verificationCache.get(executableReal);
  let digest = cached?.fingerprint === fingerprint ? cached.digest : undefined;
  if (!digest) digest = createHash("sha256").update(fs.readFileSync(executableReal)).digest("hex");
  if (digest !== expectedSha256) {
    throw new Error("AGY executable sha256 does not match the configured immutable artifact");
  }
  const entry: VerificationEntry = {
    fingerprint,
    digest,
    ...(cached?.fingerprint === fingerprint && cached.version ? { version: cached.version } : {}),
  };
  verificationCache.delete(executableReal);
  verificationCache.set(executableReal, entry);
  while (verificationCache.size > VERIFICATION_CACHE_LIMIT) {
    const oldest = verificationCache.keys().next().value as string | undefined;
    if (!oldest) break;
    verificationCache.delete(oldest);
  }
  return entry;
}

function fdExecutable(fd: number): string {
  if (process.platform === "linux") return `/proc/self/fd/${fd}`;
  if (process.platform === "darwin") return `/dev/fd/${fd}`;
  throw new Error("native AGY requires descriptor-bound executable launch support");
}

function duplicateCachedSnapshot(
  verified: VerificationEntry,
  cached: CachedSnapshot,
): VerifiedSnapshot {
  const fd = fs.openSync(fdExecutable(cached.fd), fs.constants.O_RDONLY);
  let closed = false;
  return {
    ...verified,
    digest: verified.digest,
    fd,
    executable: cached.executable,
    argvPrefix: [...cached.argvPrefix],
    close() {
      if (closed) return;
      closed = true;
      fs.closeSync(fd);
    },
  };
}

function retainSnapshot(
  digest: string,
  snapshot: CachedSnapshot,
  verified: VerificationEntry,
): VerifiedSnapshot {
  const prior = snapshotCache.get(digest);
  if (prior) fs.closeSync(prior.fd);
  snapshotCache.delete(digest);
  snapshotCache.set(digest, snapshot);
  while (snapshotCache.size > SNAPSHOT_CACHE_LIMIT) {
    const oldestDigest = snapshotCache.keys().next().value as string | undefined;
    if (!oldestDigest) break;
    const oldest = snapshotCache.get(oldestDigest);
    snapshotCache.delete(oldestDigest);
    if (oldest) fs.closeSync(oldest.fd);
  }
  try {
    return duplicateCachedSnapshot(verified, snapshot);
  } catch (error) {
    snapshotCache.delete(digest);
    fs.closeSync(snapshot.fd);
    throw error;
  }
}

/**
 * Snapshot the candidate into a private file, hash those exact bytes, then
 * unlink the name while retaining a read-only descriptor. The configured path
 * remains a policy/input location only: every version probe and real child is
 * launched from this descriptor, so a post-verification rename cannot swap the
 * executed artifact.
 */
function openVerifiedSnapshot(
  executable: string,
  runtimeRoot: string,
  expectedSha256: string,
): VerifiedSnapshot {
  const verified = verifyAgyManagedRuntimeArtifact(executable, runtimeRoot, expectedSha256);
  const retained = snapshotCache.get(expectedSha256);
  if (retained) {
    snapshotCache.delete(expectedSha256);
    snapshotCache.set(expectedSha256, retained);
    try {
      return duplicateCachedSnapshot(verified, retained);
    } catch {
      snapshotCache.delete(expectedSha256);
      try { fs.closeSync(retained.fd); } catch { /* already unavailable */ }
    }
  }
  const bytes = fs.readFileSync(executable);
  const sourceDigest = createHash("sha256").update(bytes).digest("hex");
  if (sourceDigest !== expectedSha256) {
    throw new Error("AGY executable sha256 does not match the configured immutable artifact");
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agy-exec-"));
  fs.chmodSync(dir, 0o700);
  const snapshotPath = path.join(dir, "agy");
  let fd: number | undefined;
  try {
    fs.writeFileSync(snapshotPath, bytes, { flag: "wx", mode: 0o500 });
    fs.chmodSync(snapshotPath, 0o500);
    fd = fs.openSync(snapshotPath, fs.constants.O_RDONLY);
    const snapshotBytes = Buffer.allocUnsafe(bytes.length);
    let offset = 0;
    while (offset < snapshotBytes.length) {
      const read = fs.readSync(fd, snapshotBytes, offset, snapshotBytes.length - offset, offset);
      if (read === 0) throw new Error("AGY executable snapshot ended before its declared size");
      offset += read;
    }
    const digest = createHash("sha256").update(snapshotBytes).digest("hex");
    if (digest !== expectedSha256) {
      throw new Error("AGY executable snapshot sha256 does not match the configured artifact");
    }
    // Validate descriptor execution support even for the Node-only fixture
    // loader branch. Production AGY is an ELF binary and executes fd 3 itself.
    fdExecutable(fd);
    const nodeFixture = bytes.subarray(0, 64).toString("utf8").startsWith("#!/usr/bin/env node\n");
    const executableFd = nodeFixture ? process.execPath : fdExecutable(3);
    const argvPrefix = nodeFixture
      ? ["--input-type=module", "--eval", NODE_FD_MODULE_LOADER, "agy"]
      : [];
    fs.unlinkSync(snapshotPath);
    fs.rmdirSync(dir);
    const ownedFd = fd;
    fd = undefined;
    return retainSnapshot(digest, {
      fd: ownedFd,
      executable: executableFd,
      argvPrefix,
    }, verified);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(snapshotPath); } catch { /* absent or already unlinked */ }
    try { fs.rmdirSync(dir); } catch { /* retain no public launch surface */ }
    throw error;
  }
}

function buildApprovedEnvironment(
  base: NodeJS.ProcessEnv,
  additions: Readonly<Record<string, string>>
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    if (base[key] !== undefined) env[key] = base[key];
  }
  for (const [key, value] of Object.entries(additions)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /(?:TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|AUTH)/.test(key)) {
      throw new Error(`AGY approved environment key is not non-secret: ${key}`);
    }
    if (/[\0]/.test(value)) throw new Error(`AGY approved environment value for ${key} contains NUL`);
    env[key] = value;
  }
  const home = env.HOME ?? env.USERPROFILE;
  if (!home || !path.isAbsolute(home)) {
    throw new Error("AGY launch environment requires an absolute HOME or USERPROFILE");
  }
  return env;
}

export function verifyAgyManagedRuntimeIdentity(options: {
  executable: string;
  runtimeRoot: string;
  sha256: string;
  version: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): VerificationEntry {
  const snapshot = openVerifiedSnapshot(
    options.executable,
    options.runtimeRoot,
    options.sha256
  );
  try {
    const cached = verificationCache.get(options.executable);
    if (cached?.digest === snapshot.digest && cached.version === options.version) {
      return { ...snapshot, version: options.version };
    }
    const result = spawnSync(snapshot.executable, [...snapshot.argvPrefix, "--version"], {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      timeout: VERSION_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: VERSION_OUTPUT_LIMIT,
      stdio: ["ignore", "pipe", "ignore", snapshot.fd],
    });
    if (result.error || result.status !== 0 || result.signal) {
      throw new Error("AGY executable version verification failed within the bounded probe");
    }
    const observed = result.stdout.trim().split(/\r?\n/, 1)[0]?.slice(0, 256) ?? "";
    if (observed !== options.version) {
      throw new Error("AGY executable version does not match AGY_VERSION");
    }
    const current = verificationCache.get(options.executable);
    if (current?.digest === snapshot.digest) current.version = observed;
    return { ...snapshot, version: observed };
  } finally {
    snapshot.close();
  }
}

export class AgyNativeRuntime {
  readonly descriptor: AdapterRuntimeDescriptor;
  readonly identityKey: string;
  readonly credentialScope: string;
  private readonly executable: string;
  private readonly runtimeRoot: string;
  private readonly expectedVersion: string;
  private readonly expectedSha256: string;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly approvedEnvironment: Readonly<Record<string, string>>;

  constructor(options: AgyNativeRuntimeOptions) {
    this.executable = requireAbsolute("AGY_CLI_PATH", options.executable);
    this.runtimeRoot = requireAbsolute("AGY_RUNTIME_ROOT", options.runtimeRoot);
    this.expectedVersion = validateExpectedVersion(options.version);
    this.expectedSha256 = validateExpectedDigest(options.sha256);
    const credentialScope = requireSemanticScope(options.credentialScope);
    this.credentialScope = credentialScope;
    const cwd = requireAbsolute("AGY runtime cwd", options.cwd);
    this.baseEnv = { ...(options.baseEnv ?? process.env) };
    this.approvedEnvironment = { ...(options.approvedEnvironment ?? {}) };
    const env = buildApprovedEnvironment(this.baseEnv, this.approvedEnvironment);
    const environmentFingerprint = createHash("sha256").update(JSON.stringify(
      Object.entries(env).sort(([a], [b]) => a.localeCompare(b))
    )).digest("hex");
    verifyAgyManagedRuntimeIdentity({
      executable: this.executable,
      runtimeRoot: this.runtimeRoot,
      sha256: this.expectedSha256,
      version: this.expectedVersion,
      cwd,
      env,
    });
    this.identityKey = createHash("sha256").update(JSON.stringify({
      executable: this.executable,
      version: this.expectedVersion,
      sha256: this.expectedSha256,
      credentialScope,
      environmentKeys: Object.keys(env).sort(),
      environmentFingerprint,
    })).digest("hex");
    this.descriptor = {
      identity: this.identityKey,
      executable: "managed-artifact",
      argv: [],
      cwd: "session-workspace",
      environment: {},
      environmentKeys: Object.keys(env).sort(),
      topology: "virtual-acp-native-cli",
      cwdPolicy: "session",
      provenance: {
        source: "google:antigravity-native-cli",
        version: this.expectedVersion,
        sha256: this.expectedSha256,
      },
    };
  }

  prepare(
    argv: ReadonlyArray<string>,
    cwd: string,
    options: AgyNativeSpawnOptions,
  ): AgyNativePreparedLaunch {
    const normalizedCwd = requireAbsolute("AGY launch cwd", cwd);
    if (argv.some((arg) => arg.includes("\0"))) throw new Error("AGY launch argv contains NUL");
    const env = buildApprovedEnvironment(this.baseEnv, this.approvedEnvironment);
    if (options.mcpHome) {
      const home = requireAbsolute("AGY MCP HOME", options.mcpHome);
      const homeStat = fs.lstatSync(home);
      if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) {
        throw new Error("AGY MCP HOME must be a real directory");
      }
      if ((homeStat.mode & 0o077) !== 0) {
        throw new Error("AGY MCP HOME must not be accessible to group or other users");
      }
      env.HOME = home;
      delete env.USERPROFILE;
    }
    if (!Array.isArray(options.stdio) || options.stdio.length !== 3) {
      throw new Error("native AGY descriptor-bound launch requires exactly three stdio entries");
    }
    const snapshot = openVerifiedSnapshot(this.executable, this.runtimeRoot, this.expectedSha256);
    try {
      const cached = verificationCache.get(this.executable);
      if (cached?.digest !== snapshot.digest || cached.version !== this.expectedVersion) {
        const result = spawnSync(snapshot.executable, [...snapshot.argvPrefix, "--version"], {
          cwd: normalizedCwd,
          env,
          encoding: "utf8",
          timeout: VERSION_TIMEOUT_MS,
          killSignal: "SIGKILL",
          maxBuffer: VERSION_OUTPUT_LIMIT,
          stdio: ["ignore", "pipe", "ignore", snapshot.fd],
        });
        if (result.error || result.status !== 0 || result.signal) {
          throw new Error("AGY executable version verification failed within the bounded probe");
        }
        const observed = result.stdout.trim().split(/\r?\n/, 1)[0]?.slice(0, 256) ?? "";
        if (observed !== this.expectedVersion) {
          throw new Error("AGY executable version does not match AGY_VERSION");
        }
        const current = verificationCache.get(this.executable);
        if (current?.digest === snapshot.digest) current.version = observed;
      }
      let consumed = false;
      return {
        spawn(): ChildProcess {
          if (consumed) throw new Error("native AGY prepared launch was already consumed");
          consumed = true;
          let proc: ChildProcess;
          try {
            proc = spawn(snapshot.executable, [...snapshot.argvPrefix, ...argv], {
              cwd: normalizedCwd,
              env,
              detached: options.detached,
              stdio: [...options.stdio, snapshot.fd],
            });
          } catch (error) {
            snapshot.close();
            throw error;
          }
          // libuv has duplicated fd 3 into the child before spawn() returns.
          // The parent retains no descriptor or named snapshot afterward.
          snapshot.close();
          return proc;
        },
        close(): void {
          consumed = true;
          snapshot.close();
        },
      };
    } catch (error) {
      snapshot.close();
      throw error;
    }
  }

  async spawn(
    argv: ReadonlyArray<string>,
    cwd: string,
    options: AgyNativeSpawnOptions,
  ): Promise<ChildProcess> {
    return this.prepare(argv, cwd, options).spawn();
  }

  verify(cwd: string): void {
    const normalizedCwd = requireAbsolute("AGY verification cwd", cwd);
    const env = buildApprovedEnvironment(this.baseEnv, this.approvedEnvironment);
    verifyAgyManagedRuntimeIdentity({
      executable: this.executable,
      runtimeRoot: this.runtimeRoot,
      sha256: this.expectedSha256,
      version: this.expectedVersion,
      cwd: normalizedCwd,
      env,
    });
  }
}

export function makeAgyNativeRuntime(options: AgyNativeRuntimeOptions): AgyNativeRuntime {
  return new AgyNativeRuntime(options);
}

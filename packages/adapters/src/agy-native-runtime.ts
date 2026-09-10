import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AdapterRuntimeDescriptor } from "./agent-profile.js";

const SAFE_ENV_KEYS = [
  "HOME", "USERPROFILE", "PATH", "TMPDIR", "TMP", "TEMP",
  "LANG", "LC_ALL", "LC_CTYPE", "TZ", "SystemRoot", "ComSpec", "PATHEXT",
] as const;
const VERSION_TIMEOUT_MS = 5_000;
const VERSION_OUTPUT_LIMIT = 16_384;
const VERIFICATION_CACHE_LIMIT = 32;

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

export interface AgyNativeLaunchSpec {
  executable: string;
  argv: ReadonlyArray<string>;
  cwd: string;
  env: NodeJS.ProcessEnv;
  identityKey: string;
}

interface VerificationEntry {
  fingerprint: string;
  digest: string;
  version?: string;
}

const verificationCache = new Map<string, VerificationEntry>();

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
  const verified = verifyAgyManagedRuntimeArtifact(
    options.executable,
    options.runtimeRoot,
    options.sha256
  );
  if (verified.version === options.version) return verified;
  const result = spawnSync(options.executable, ["--version"], {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    timeout: VERSION_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: VERSION_OUTPUT_LIMIT,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0 || result.signal) {
    throw new Error("AGY executable version verification failed within the bounded probe");
  }
  const observed = result.stdout.trim().split(/\r?\n/, 1)[0]?.slice(0, 256) ?? "";
  if (observed !== options.version) {
    throw new Error("AGY executable version does not match AGY_VERSION");
  }
  const current = verificationCache.get(options.executable);
  if (current?.fingerprint === verified.fingerprint) current.version = observed;
  return { ...verified, version: observed };
}

export class AgyNativeRuntime {
  readonly descriptor: AdapterRuntimeDescriptor;
  readonly identityKey: string;
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
      executable: this.executable,
      argv: [],
      cwd,
      environment: {},
      environmentKeys: Object.keys(env).sort(),
      environmentFingerprint,
      credentialScope,
      topology: "virtual-acp-native-cli",
      immutableRoot: this.runtimeRoot,
      cwdPolicy: "session",
      provenance: {
        source: "google:antigravity-native-cli",
        version: this.expectedVersion,
        sha256: this.expectedSha256,
      },
    };
  }

  async resolve(
    argv: ReadonlyArray<string>,
    cwd: string,
    options: { mcpHome?: string } = {}
  ): Promise<AgyNativeLaunchSpec> {
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
    verifyAgyManagedRuntimeIdentity({
      executable: this.executable,
      runtimeRoot: this.runtimeRoot,
      sha256: this.expectedSha256,
      version: this.expectedVersion,
      cwd: normalizedCwd,
      env,
    });
    return {
      executable: this.executable,
      argv: [...argv],
      cwd: normalizedCwd,
      env,
      identityKey: this.identityKey,
    };
  }
}

export function makeAgyNativeRuntime(options: AgyNativeRuntimeOptions): AgyNativeRuntime {
  return new AgyNativeRuntime(options);
}

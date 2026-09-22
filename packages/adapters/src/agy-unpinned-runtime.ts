import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AdapterRuntimeDescriptor } from "./agent-profile.js";
import { AGY_UNPINNED_GIVE_UP } from "./agy-pin-mode.js";
import {
  type AgyLaunchRuntime,
  type AgyNativePreparedLaunch,
  type AgyNativeSpawnOptions,
  buildApprovedEnvironment,
} from "./agy-native-runtime.js";

const VERSION_TIMEOUT_MS = 5_000;
const VERSION_OUTPUT_LIMIT = 16_384;

export interface AgyUnpinnedRuntimeOptions {
  credentialScope: string;
  cwd: string;
  baseEnv?: NodeJS.ProcessEnv;
  approvedEnvironment?: Readonly<Record<string, string>>;
}

/**
 * Ordinary installed agy. No digest, no private snapshot, no re-hash.
 *
 * The pinned runtime copies the verified bytes and, on Linux, execs that
 * inode through /proc/self/fd. A rewrite of the path after verification
 * cannot change that child. This class spawns the `agy` PATH entry by name,
 * so a self-update is what the next child runs. That is the #415 shape and
 * it is the point of the mode: a standing pin ages out and hides the update
 * that would replace it (#505). Choosing it means accepting
 * {@link AGY_UNPINNED_GIVE_UP}.
 */
export class AgyUnpinnedRuntime implements AgyLaunchRuntime {
  readonly descriptor: AdapterRuntimeDescriptor;
  readonly identityKey: string;
  readonly credentialScope: string;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly approvedEnvironment: Readonly<Record<string, string>>;
  private readonly labelVersion: string;

  constructor(options: AgyUnpinnedRuntimeOptions) {
    const scope = options.credentialScope.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/.test(scope) || path.isAbsolute(scope)) {
      throw new Error("AGY_CREDENTIAL_SCOPE must be a non-secret semantic identifier");
    }
    this.credentialScope = scope;
    this.baseEnv = { ...(options.baseEnv ?? process.env) };
    this.approvedEnvironment = { ...(options.approvedEnvironment ?? {}) };
    const env = buildApprovedEnvironment(this.baseEnv, this.approvedEnvironment);
    const executable = resolveOrdinaryAgyExecutable(this.baseEnv);
    this.labelVersion = probeOrdinaryAgyVersion(executable, options.cwd, env);
    const environmentFingerprint = createHash("sha256").update(JSON.stringify(
      Object.entries(env).sort(([a], [b]) => a.localeCompare(b)),
    )).digest("hex");
    this.identityKey = createHash("sha256").update(JSON.stringify({
      mode: "unpinned",
      executable,
      credentialScope: scope,
      environmentKeys: Object.keys(env).sort(),
      environmentFingerprint,
    })).digest("hex");
    this.descriptor = {
      identity: this.identityKey,
      executable,
      argv: [],
      cwd: "session-workspace",
      environment: {},
      environmentKeys: Object.keys(env).sort(),
      topology: "virtual-acp-native-cli",
      cwdPolicy: "session",
      provenance: {
        source: "google:antigravity-native-cli",
        version: this.labelVersion,
      },
    };
  }

  prepare(
    argv: ReadonlyArray<string>,
    cwd: string,
    options: AgyNativeSpawnOptions,
  ): AgyNativePreparedLaunch {
    if (!path.isAbsolute(cwd)) throw new Error("AGY launch cwd must be an exact absolute path");
    if (argv.some((arg) => arg.includes("\0"))) throw new Error("AGY launch argv contains NUL");
    if (!Array.isArray(options.stdio) || options.stdio.length !== 3) {
      throw new Error("native AGY launch requires exactly three stdio entries");
    }
    const env = buildApprovedEnvironment(this.baseEnv, this.approvedEnvironment);
    if (options.mcpHome) applyMcpHome(env, options.mcpHome);
    // Resolve again. A self-update between turns is the binary this child
    // runs. Do not snapshot it and do not pass a retained descriptor.
    const executable = resolveOrdinaryAgyExecutable(this.baseEnv);
    let consumed = false;
    return {
      spawn(): ChildProcess {
        if (consumed) throw new Error("native AGY prepared launch was already consumed");
        consumed = true;
        return spawn(executable, [...argv], {
          cwd,
          env,
          detached: options.detached,
          stdio: [...options.stdio],
        });
      },
      close(): void {
        consumed = true;
      },
    };
  }

  async spawn(
    argv: ReadonlyArray<string>,
    cwd: string,
    options: AgyNativeSpawnOptions,
  ): Promise<ChildProcess> {
    return this.prepare(argv, cwd, options).spawn();
  }

  /** The binary is still on PATH and executable. Not a digest check. */
  verify(cwd: string): void {
    if (!path.isAbsolute(cwd)) throw new Error("AGY verification cwd must be an exact absolute path");
    const executable = resolveOrdinaryAgyExecutable(this.baseEnv);
    fs.accessSync(executable, fs.constants.X_OK);
  }
}

export function makeAgyUnpinnedRuntime(options: AgyUnpinnedRuntimeOptions): AgyUnpinnedRuntime {
  return new AgyUnpinnedRuntime(options);
}

/** The PATH entry, not its realpath. A symlink retarget is the self-update. */
export function resolveOrdinaryAgyExecutable(env: NodeJS.ProcessEnv): string {
  const names = process.platform === "win32" ? ["agy.exe"] : ["agy"];
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        const stat = fs.lstatSync(candidate);
        if (!stat.isFile() && !stat.isSymbolicLink()) continue;
        return candidate;
      } catch {
        // The next directory may have it.
      }
    }
  }
  throw new Error(
    "AGY_PIN=unpinned requires an executable agy on PATH. " +
    "A missing AGY_CLI_PATH is not this mode. " + AGY_UNPINNED_GIVE_UP,
  );
}

function probeOrdinaryAgyVersion(executable: string, cwd: string, env: NodeJS.ProcessEnv): string {
  const result = spawnSync(executable, ["--version"], {
    cwd: path.isAbsolute(cwd) ? cwd : undefined,
    env,
    encoding: "utf8",
    timeout: VERSION_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: VERSION_OUTPUT_LIMIT,
  });
  if (result.error || result.status !== 0 || result.signal) {
    throw new Error("ordinary agy --version failed; the unpinned binary is not usable");
  }
  const observed = result.stdout.trim().split(/\r?\n/, 1)[0]?.slice(0, 256) ?? "";
  return observed || "unpinned";
}

function applyMcpHome(env: NodeJS.ProcessEnv, mcpHome: string): void {
  if (!path.isAbsolute(mcpHome)) throw new Error("AGY MCP HOME must be an exact absolute path");
  const homeStat = fs.lstatSync(mcpHome);
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) {
    throw new Error("AGY MCP HOME must be a real directory");
  }
  if ((homeStat.mode & 0o077) !== 0) {
    throw new Error("AGY MCP HOME must not be accessible to group or other users");
  }
  env.HOME = mcpHome;
  delete env.USERPROFILE;
}

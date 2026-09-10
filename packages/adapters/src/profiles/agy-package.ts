import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type SessionConfigOption,
  type SessionConfigSelectGroup,
  type SessionConfigSelectOption,
  type SessionConfigSelectOptions,
} from "@agentclientprotocol/sdk";
import {
  AGENT_ADAPTER_VERSION,
  asLocalAdapter,
  type AdapterRuntimeDescriptor,
  type AgentProfile,
} from "../agent-profile.js";
import {
  manifestCatalogScope,
  manifestCatalogSource,
  type ManifestCatalogModel,
} from "../model-catalog.js";
import { redactProbeText, runBoundedProbe } from "../probe-process.js";
import { verifyAgyManagedRuntimeArtifact, verifyAgyManagedRuntimeIdentity } from "../agy-native-runtime.js";

/** Immutable upstream source reviewed for issue #228. */
export const AGY_ACP_UPSTREAM_VERSION = "1.1.0";
export const AGY_ACP_UPSTREAM_COMMIT = "e0a3d22c7515f0ca0692c668811879623b74519a";
export const AGY_ACP_UPSTREAM_SOURCE = "github:shubzkothekar/antigravity-acp";
const AGY_PERMISSION_POLICY_SCOPE = "unsafe-ack-v1";

/** GitHub release asset digests recorded by the release API for immutable v1.1.0. */
export const AGY_ACP_RELEASE_ARTIFACTS = {
  "darwin-arm64": { name: "agy-acp-darwin-arm64", sha256: "9ef7afa432341c05d6c049d143349ea71fbb48989813ba625054a7224e2804fc" },
  "darwin-x64": { name: "agy-acp-darwin-x64", sha256: "ed84139ad6d308e528cc2193100997c0e38a22da8cec4208cbcc88e9884caf95" },
  "linux-arm64": { name: "agy-acp-linux-arm64", sha256: "2138f694643bb473e077cb189eb5058ef6e28eaa468d29c17ffc0835833b5d8a" },
  "linux-x64": { name: "agy-acp-linux-x64", sha256: "742f703f97dfe54325198a21f54363196e8a0483052ce0f4661ed96eeef1fbe2" },
  "win32-arm64": { name: "agy-acp-windows-arm64.exe", sha256: "f81d050ff025d4968e6cffe86d1ca175a1944cedc5a289db6d77e57f8e13981f" },
  "win32-x64": { name: "agy-acp-windows-x64.exe", sha256: "42943eee35e7d9bb51ad03b80b397f416ecf8c65e6a5dc414c14f2ac3cec9029" },
} as const;

export function agyAcpReleaseArtifact(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): { name: string; sha256: string } {
  const key = `${platform}-${arch}` as keyof typeof AGY_ACP_RELEASE_ARTIFACTS;
  const artifact = AGY_ACP_RELEASE_ARTIFACTS[key];
  if (!artifact) throw new Error(`antigravity-acp v1.1.0 has no reviewed release artifact for ${platform}/${arch}`);
  return artifact;
}

export interface AgyDiscoveredModel {
  modelId: string;
  displayName: string;
}

export interface AgyCatalogProbe {
  agyVersion: string;
  wrapperVersion?: string;
  models: AgyDiscoveredModel[];
}

export interface AgyPackageProfileOptions {
  /** Exact compiled antigravity-acp executable for this host OS/architecture. */
  acpPath: string;
  /** Exact authenticated agy executable. Passed as AGY_BIN. */
  agyBin: string;
  /** Exact first line returned by `AGY_BIN --version`. */
  agyVersion: string;
  /** Exact SHA-256 of the configured AGY_BIN. */
  agySha256: string;
  /** Non-writable root containing `<sha256>/agy`; required in production. */
  runtimeRoot?: string;
  defaultModel: string;
  /** Effective upstream wrapper state directory (`$HOME/.agy-acp` in v1.1.0). */
  stateDir: string;
  conversationsDir: string;
  cwd: string;
  /** Non-secret semantic label, never an OAuth identity or credential value. */
  credentialScope: string;
  wrapperVersion: string;
  wrapperSha256: string;
  /** Required because v1.1.0 unconditionally disables agy's permission prompts. */
  permissionRiskAcknowledged: boolean;
  timeoutMs?: number;
  /** Test seam. Production always runs the exact two-runtime collector below. */
  catalogProbe?: () => Promise<AgyCatalogProbe>;
  /** Test seam for artifact verification. */
  verifyWrapper?: () => void;
  /** Test seam for exact underlying-runtime verification. */
  verifyRuntime?: () => void;
}

const AGY_SAFE_ENV_KEYS = [
  "HOME", "USERPROFILE", "PATH", "TMPDIR", "TMP", "TEMP",
  "LANG", "LC_ALL", "LC_CTYPE", "TZ", "SystemRoot", "ComSpec", "PATHEXT",
] as const;

const AGY_RUNTIME_STDERR_LIMIT = 256_000;
const AGY_RUNTIME_LINE_LIMIT = 16_384;
const AGY_VERSION_OUTPUT_LIMIT = 16_384;

function requireAbsolute(name: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) {
    throw new Error(`${name} must be an exact absolute path`);
  }
  return path.normalize(trimmed);
}

function requireSemanticScope(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/.test(trimmed) || path.isAbsolute(trimmed)) {
    throw new Error("AGY_CREDENTIAL_SCOPE must be a non-secret semantic identifier");
  }
  return trimmed;
}

/** Exact env shared by normal starts and catalog probes. */
export function buildAgyAcpEnvironment(
  base: NodeJS.ProcessEnv,
  opts: Pick<AgyPackageProfileOptions, "agyBin" | "conversationsDir">
): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const key of AGY_SAFE_ENV_KEYS) {
    if (base[key] !== undefined) safe[key] = base[key];
  }
  if (!safe.HOME && process.platform !== "win32") safe.HOME = os.homedir();
  return {
    ...safe,
    AGY_BIN: requireAbsolute("AGY_BIN", opts.agyBin),
    AGY_SKIP_DOWNLOAD: "1",
    AGY_CONVERSATIONS_DIR: requireAbsolute(
      "AGY_CONVERSATIONS_DIR",
      opts.conversationsDir
    ),
  };
}

/**
 * The reviewed wrapper copies agy's stderr into its own stderr and ACP error
 * messages. Keep runtime diagnostics bounded and redact every value that was
 * actually supplied to the child before core or bridge logging can see them.
 */
export function createAgyRuntimeStderrFilter(env: NodeJS.ProcessEnv): Transform {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let total = 0;
  let truncated = false;
  const emitLines = (stream: Transform, text: string, flush = false): void => {
    pending += text;
    const lines = pending.split(/(?<=\n)/);
    pending = flush || lines.at(-1)?.endsWith("\n") ? "" : (lines.pop() ?? "");
    for (const line of lines) stream.push(redactProbeText(line, env));
    if (flush && pending) {
      stream.push(redactProbeText(pending, env));
      pending = "";
    }
    if (Buffer.byteLength(pending) > AGY_RUNTIME_LINE_LIMIT) {
      pending = "";
      stream.push("[redacted oversized agy diagnostic]\n");
    }
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total <= AGY_RUNTIME_STDERR_LIMIT) {
        emitLines(this, decoder.write(chunk));
      } else if (!truncated) {
        truncated = true;
        pending = "";
        this.push("[agy diagnostic truncated]\n");
      }
      callback();
    },
    flush(callback) {
      if (!truncated) emitLines(this, decoder.end(), true);
      callback();
    },
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * antigravity-acp v1.1.0's reviewed title translator represents only the
 * title's post-heading thinking text as a completed `tool_call`. Normalize
 * that exact shape at the package-backed adapter boundary so core receives the
 * standard ACP thought notification. Everything else stays byte-for-byte on
 * the original wire path, including ordinary tools and native thought chunks.
 */
function normalizeAgyTitleThought(
  message: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (
    message.jsonrpc !== "2.0" ||
    message.method !== "session/update" ||
    Object.hasOwn(message, "id")
  ) return undefined;
  const params = asRecord(message.params);
  if (!params || typeof params.sessionId !== "string" || params.sessionId.length === 0) {
    return undefined;
  }
  const update = asRecord(params.update);
  if (!update) return undefined;
  const expectedKeys = [
    "sessionUpdate",
    "toolCallId",
    "title",
    "kind",
    "status",
    "content",
  ];
  if (
    Object.keys(update).length !== expectedKeys.length ||
    !expectedKeys.every((key) => Object.hasOwn(update, key)) ||
    update.sessionUpdate !== "tool_call" ||
    typeof update.toolCallId !== "string" ||
    update.toolCallId.length === 0 ||
    update.title !== "Think" ||
    update.kind !== "think" ||
    update.status !== "completed" ||
    !Array.isArray(update.content) ||
    update.content.length !== 1
  ) return undefined;
  const entry = asRecord(update.content[0]);
  if (
    !entry ||
    Object.keys(entry).length !== 2 ||
    entry.type !== "content" ||
    !Object.hasOwn(entry, "content")
  ) return undefined;
  const content = asRecord(entry.content);
  if (
    !content ||
    Object.keys(content).length !== 2 ||
    content.type !== "text" ||
    typeof content.text !== "string" ||
    content.text.length === 0
  ) return undefined;
  return {
    ...message,
    params: {
      ...params,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: content.text },
      },
    },
  };
}

export function createAgyAcpOutputFilter(env: NodeJS.ProcessEnv): Transform {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const sanitizeValue = (value: unknown): unknown => {
    if (typeof value === "string") return redactProbeText(value, env);
    if (Array.isArray(value)) return value.map(sanitizeValue);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .map(([key, entry]) => [key, sanitizeValue(entry)])
      );
    }
    return value;
  };
  const sanitize = (line: string): string => {
    try {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (!message.error) {
        const normalized = normalizeAgyTitleThought(message);
        return normalized ? JSON.stringify(normalized) : line;
      }
      message.error = sanitizeValue(message.error);
      return JSON.stringify(message);
    } catch {
      return JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "invalid antigravity-acp output" },
      });
    }
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      pending += decoder.write(chunk);
      if (Buffer.byteLength(pending) > 1_000_000) {
        pending = "";
        this.push(`${sanitize("")}\n`);
      }
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line) this.push(`${sanitize(line)}\n`);
        newline = pending.indexOf("\n");
      }
      callback();
    },
    flush(callback) {
      pending += decoder.end();
      if (pending.trim()) this.push(`${sanitize(pending.trim())}\n`);
      callback();
    },
  });
}

function protectAgyRuntimeStreams(
  child: ChildProcessWithoutNullStreams,
  env: NodeJS.ProcessEnv
): ChildProcessWithoutNullStreams {
  const stdout = child.stdout.pipe(createAgyAcpOutputFilter(env));
  const stderr = child.stderr.pipe(createAgyRuntimeStderrFilter(env));
  Object.defineProperty(child, "stdout", { configurable: true, enumerable: true, value: stdout });
  Object.defineProperty(child, "stderr", { configurable: true, enumerable: true, value: stderr });
  return child;
}

/**
 * Parse the exact `agy models` output used by upstream v1.1.0: raw id in the
 * first whitespace-delimited column and the untouched remainder as its label.
 * Duplicate ids, control bytes, and empty/fallback-shaped output fail closed.
 */
export function parseAgyModelsOutput(output: string): AgyDiscoveredModel[] {
  if (output.includes("\0")) throw new Error("agy models output contains NUL bytes");
  const rows: AgyDiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^(\S+)(?:\s+(.*))?$/.exec(line);
    if (!match) throw new Error("agy models output contains an invalid row");
    const modelId = match[1]!;
    const displayName = match[2]?.trim() || modelId;
    if (modelId.length > 256 || displayName.length > 512) {
      throw new Error("agy models output contains an oversized row");
    }
    if (seen.has(modelId)) throw new Error(`agy models output repeats ${JSON.stringify(modelId)}`);
    seen.add(modelId);
    rows.push({ modelId, displayName });
  }
  if (rows.length === 0) throw new Error("agy models returned no models");
  return rows;
}

function abortFailure(signal: AbortSignal, exited: Promise<never>): Promise<never> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  }).then(() => exited);
}

/** Run one finite AGY command through the shared #236 lifecycle. */
export async function runBoundedAgyCommand(options: {
  executable: string;
  args: ReadonlyArray<string>;
  /** Test-only argv inserted before the real AGY arguments. */
  argsPrefix?: ReadonlyArray<string>;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxStdoutBytes: number;
  label: string;
  killGraceMs?: number;
  finalizeDeadlineMs?: number;
  spawnOverride?: () => ChildProcessWithoutNullStreams;
}): Promise<string> {
  return runBoundedProbe({
    executable: options.executable,
    args: [...(options.argsPrefix ?? []), ...options.args],
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    maxStdoutBytes: options.maxStdoutBytes,
    label: options.label,
    killGraceMs: options.killGraceMs,
    finalizeDeadlineMs: options.finalizeDeadlineMs,
    allowCleanExit: true,
    spawnOverride: options.spawnOverride,
    async run(handle) {
      handle.stdin.end();
      let stdout = "";
      const outputEnded = new Promise<void>((resolve, reject) => {
        handle.stdout.setEncoding("utf8");
        handle.stdout.on("data", (chunk: string) => { stdout += chunk; });
        handle.stdout.once("end", resolve);
        handle.stdout.once("error", reject);
      });
      await Promise.race([
        Promise.all([outputEnded, handle.completed]),
        abortFailure(handle.signal, handle.exited),
        handle.exited,
      ]);
      return stdout;
    },
  });
}

function flattenSelectOptions(options: SessionConfigSelectOptions): SessionConfigSelectOption[] {
  return (options as Array<SessionConfigSelectOption | SessionConfigSelectGroup>).flatMap((option) =>
    "options" in option ? option.options : [option]
  );
}

function modelOption(value: unknown): Extract<SessionConfigOption, { type: "select" }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const option = value.find((entry): entry is SessionConfigOption =>
    Boolean(entry && typeof entry === "object" && "id" in entry && entry.id === "model")
  );
  return option?.type === "select" ? option : undefined;
}

function sameExactIds(
  direct: ReadonlyArray<string>,
  advertised: ReadonlyArray<SessionConfigSelectOption>
): boolean {
  const acpIds = advertised.map((row) => row.value);
  return direct.length === acpIds.length &&
    direct.every((id) => acpIds.includes(id)) &&
    acpIds.every((id) => direct.includes(id));
}

async function waitForClose<T>(promise: Promise<T>, signal: AbortSignal): Promise<void> {
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      promise.then(() => undefined, () => undefined),
      new Promise<void>((resolve) => {
        onAbort = resolve;
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Require ACP's exact selectable ids to agree with fresh direct discovery and
 * prove every selection is acknowledged. Cached/fallback ACP rows can never be
 * published merely because they appeared first at startup.
 */
export async function reconcileAgyAcpModels(options: {
  acpPath: string;
  /** Test seam; production compiled wrapper has no argv. */
  acpArgs?: ReadonlyArray<string>;
  cwd: string;
  env: NodeJS.ProcessEnv;
  direct: AgyDiscoveredModel[];
  defaultModel: string;
  timeoutMs?: number;
  /** Test seam inherited from the provider-neutral bounded probe helper. */
  spawnOverride?: () => ChildProcessWithoutNullStreams;
}): Promise<AgyDiscoveredModel[]> {
  return runBoundedProbe({
    executable: options.acpPath,
    args: options.acpArgs ?? [],
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs ?? 45_000,
    label: "antigravity-acp catalog reconciliation",
    spawnOverride: options.spawnOverride,
    async run(handle) {
      let sessionId: string | undefined;
      const directIds = options.direct.map((row) => row.modelId);
      const pendingModelSnapshots: SessionConfigSelectOption[][] = [];
      let wakeSnapshot: (() => void) | undefined;
      const connection = new ClientSideConnection(
        () => ({
          async requestPermission() {
            return { outcome: { outcome: "cancelled" as const } };
          },
          async sessionUpdate(notification) {
            const update = notification.update as unknown as {
              sessionUpdate?: string;
              configOptions?: SessionConfigOption[];
            };
            if (update.sessionUpdate !== "config_option_update") return;
            const advertised = modelOption(update.configOptions);
            if (!advertised) return;
            pendingModelSnapshots.push(flattenSelectOptions(advertised.options));
            wakeSnapshot?.();
            wakeSnapshot = undefined;
          },
        } satisfies Client),
        ndJsonStream(
          Writable.toWeb(handle.stdin) as unknown as WritableStream<Uint8Array>,
          Readable.toWeb(handle.stdout) as unknown as ReadableStream<Uint8Array>
        )
      );
      handle.onClose(async (signal) => {
        if (sessionId) await waitForClose(connection.closeSession({ sessionId }), signal);
      }, "session");
      handle.onClose(() => { handle.stdin.end(); }, "connection");

      try {
        await Promise.race([
          connection.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
          }),
          handle.exited,
        ]);
      } catch (err) {
        // ProbeHandle exposes only the #236-redacted tail; raw child stderr is
        // never available at this layer or attached as an Error cause.
        const safeTail = handle.stderrTail().trim();
        throw new Error(
          `${err instanceof Error ? err.message : String(err)}` +
            (safeTail ? `; redacted child diagnostic: ${safeTail}` : "")
        );
      }
      const session = await Promise.race([
        connection.newSession({ cwd: options.cwd, mcpServers: [] }),
        handle.exited,
      ]);
      sessionId = session.sessionId;
      // Never certify session/new options: upstream populates those from its
      // startup cache/fallback before asynchronous discovery. Only a later
      // config_option_update is positive post-discovery evidence.
      let acpRows: SessionConfigSelectOption[] | undefined;
      while (!acpRows) {
        const candidate = pendingModelSnapshots.shift();
        if (candidate && sameExactIds(directIds, candidate)) {
          acpRows = candidate;
          break;
        }
        let onAbort: (() => void) | undefined;
        const snapshotArrived = new Promise<void>((resolve, reject) => {
          const settle = () => {
            if (onAbort) handle.signal.removeEventListener("abort", onAbort);
            wakeSnapshot = undefined;
            resolve();
          };
          wakeSnapshot = settle;
          onAbort = () => {
            wakeSnapshot = undefined;
            reject(new Error(
              "fresh agy models and antigravity-acp selectable models did not reconcile"
            ));
          };
          if (handle.signal.aborted) onAbort();
          else handle.signal.addEventListener("abort", onAbort, { once: true });
        });
        try {
          await Promise.race([snapshotArrived, handle.exited]);
        } finally {
          if (onAbort) handle.signal.removeEventListener("abort", onAbort);
          wakeSnapshot = undefined;
        }
      }
      if (!directIds.includes(options.defaultModel)) {
        throw new Error(`configured AGY_DEFAULT_MODEL ${JSON.stringify(options.defaultModel)} is unavailable`);
      }
      const names = new Map(acpRows.map((row) => [row.value, row.name]));
      for (const id of directIds) {
        const selected = await Promise.race([
          connection.setSessionConfigOption({ sessionId, configId: "model", value: id }),
          handle.exited,
        ]);
        const echoed = modelOption(selected.configOptions);
        if (!echoed || echoed.currentValue !== id) {
          throw new Error(`antigravity-acp did not acknowledge exact model ${JSON.stringify(id)}`);
        }
      }
      return options.direct.map((row) => ({
        modelId: row.modelId,
        displayName: names.get(row.modelId)?.trim() || row.displayName,
      }));
    },
  });
}

/** Serial, bounded collector: exact agy discovery, then ACP reconciliation. */
export async function probeAgyPackageCatalog(options: {
  acpPath: string;
  agyBin: string;
  agyVersion: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  defaultModel: string;
  timeoutMs?: number;
  /** Test-only argv inserted before `--version` / `models`. */
  agyArgsPrefix?: ReadonlyArray<string>;
}): Promise<AgyCatalogProbe> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const versionOutput = await runBoundedAgyCommand({
    executable: options.agyBin,
    args: ["--version"],
    argsPrefix: options.agyArgsPrefix,
    cwd: options.cwd,
    env: options.env,
    timeoutMs: Math.min(timeoutMs, 5_000),
    maxStdoutBytes: AGY_VERSION_OUTPUT_LIMIT,
    label: "agy version discovery",
  });
  const agyVersion = versionOutput.trim().split(/\r?\n/, 1)[0]?.slice(0, 256);
  if (!agyVersion || agyVersion !== options.agyVersion) {
    throw new Error(
      `AGY_BIN version mismatch: expected ${JSON.stringify(options.agyVersion)}, ` +
        `observed ${JSON.stringify(agyVersion ?? "unavailable")}`
    );
  }
  const directOutput = await runBoundedAgyCommand({
    executable: options.agyBin,
    args: ["models"],
    argsPrefix: options.agyArgsPrefix,
    cwd: options.cwd,
    env: options.env,
    timeoutMs,
    maxStdoutBytes: 1_000_000,
    label: "agy models discovery",
  });
  const direct = parseAgyModelsOutput(directOutput);
  // The wrapper is an ACP stdio server, not a conventional CLI. Invoking it
  // with `--version` would start normal runtime resolution and could download
  // before a no-download environment is established. Its configured version
  // and verified release digest are the provenance authority instead.
  const wrapperVersion = AGY_ACP_UPSTREAM_VERSION;
  const models = await reconcileAgyAcpModels({
    acpPath: options.acpPath,
    cwd: options.cwd,
    env: options.env,
    direct,
    defaultModel: options.defaultModel,
    timeoutMs,
  });
  return { agyVersion, wrapperVersion, models };
}

const digestCache = new Map<string, { key: string; digest: string }>();

function verifyExecutableArtifact(
  file: string,
  expectedSha256: string,
  name: "AGY_ACP_BIN" | "AGY_BIN"
): void {
  const expected = expectedSha256.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error(`${name === "AGY_BIN" ? "AGY_SHA256" : "AGY_ACP_SHA256"} must be 64 lowercase hex characters`);
  }
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`${name} is not a regular file`);
  fs.accessSync(file, fs.constants.X_OK);
  const key = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  let digest = digestCache.get(file)?.key === key ? digestCache.get(file)!.digest : undefined;
  if (!digest) {
    digest = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    digestCache.set(file, { key, digest });
  }
  if (digest !== expected) throw new Error(`${name} sha256 does not match the configured immutable artifact`);
}

/** Verify the immutable compiled wrapper artifact before every spawn/refresh. */
export function verifyAgyWrapperArtifact(file: string, expectedSha256: string): void {
  if (fs.realpathSync(file) !== path.normalize(file)) {
    throw new Error("AGY_ACP_BIN must be the exact real wrapper path, not a symlinked path");
  }
  verifyExecutableArtifact(file, expectedSha256, "AGY_ACP_BIN");
}

/**
 * Prove upstream's sibling-first resolver cannot select anything other than
 * the configured, digest-pinned AGY_BIN. An executable sibling is permitted
 * only when it resolves to that exact configured path (including a symlink).
 */
export function verifyAgyRuntimeIdentity(
  acpPath: string,
  agyBin: string,
  expectedSha256: string,
  runtimeRoot?: string
): void {
  if (runtimeRoot) verifyAgyManagedRuntimeArtifact(agyBin, runtimeRoot, expectedSha256);
  else verifyExecutableArtifact(agyBin, expectedSha256, "AGY_BIN");
  const sibling = path.join(path.dirname(acpPath), process.platform === "win32" ? "agy.exe" : "agy");
  try {
    fs.accessSync(sibling, fs.constants.X_OK);
  } catch {
    return;
  }
  if (fs.realpathSync(sibling) !== fs.realpathSync(agyBin)) {
    throw new Error(
      "antigravity-acp would prefer an executable sibling agy over configured AGY_BIN; refusing runtime"
    );
  }
}

export function makeAgyPackageProfile(opts: AgyPackageProfileOptions): AgentProfile {
  const acpPath = requireAbsolute("AGY_ACP_BIN", opts.acpPath);
  const agyBin = requireAbsolute("AGY_BIN", opts.agyBin);
  const stateDir = requireAbsolute("AGY_ACP_STATE_DIR", opts.stateDir);
  const conversationsDir = requireAbsolute("AGY_CONVERSATIONS_DIR", opts.conversationsDir);
  const cwd = requireAbsolute("AGY_ACP_CWD", opts.cwd);
  const credentialScope = requireSemanticScope(opts.credentialScope);
  const agyVersion = opts.agyVersion.trim();
  if (!agyVersion || agyVersion.length > 256 || /[\r\n\0]/.test(agyVersion)) {
    throw new Error("AGY_VERSION must be the exact bounded first line from AGY_BIN --version");
  }
  const agySha256 = opts.agySha256.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(agySha256)) {
    throw new Error("AGY_SHA256 must be 64 lowercase hex characters");
  }
  if (!opts.runtimeRoot && !opts.verifyRuntime) {
    throw new Error("AGY_RUNTIME_ROOT is required for the production agy-package runtime");
  }
  if (opts.wrapperVersion !== AGY_ACP_UPSTREAM_VERSION) {
    throw new Error(`AGY_ACP_VERSION must be pinned to ${AGY_ACP_UPSTREAM_VERSION}`);
  }
  const officialArtifact = agyAcpReleaseArtifact();
  if (opts.wrapperSha256 !== officialArtifact.sha256) {
    throw new Error(
      `AGY_ACP_SHA256 must match reviewed v1.1.0 ${officialArtifact.name} (${officialArtifact.sha256})`
    );
  }
  if (!opts.permissionRiskAcknowledged) {
    throw new Error(
      "antigravity-acp v1.1.0 always uses --dangerously-skip-permissions; " +
        "set AGY_DANGEROUS_PERMISSIONS_ACKNOWLEDGED=true only after accepting that risk"
    );
  }
  const env = buildAgyAcpEnvironment(process.env, { agyBin, conversationsDir });
  const effectiveHome = env.HOME ?? env.USERPROFILE;
  if (!effectiveHome || path.normalize(stateDir) !== path.normalize(path.join(effectiveHome, ".agy-acp"))) {
    throw new Error("AGY_ACP_STATE_DIR must equal the wrapper's effective host-local ~/.agy-acp directory");
  }
  const verify = opts.verifyWrapper ?? (() => verifyAgyWrapperArtifact(acpPath, opts.wrapperSha256));
  const verifyRuntime = opts.verifyRuntime ?? (() => {
    if (opts.runtimeRoot) {
      verifyAgyManagedRuntimeIdentity({
        executable: agyBin,
        runtimeRoot: opts.runtimeRoot,
        sha256: agySha256,
        version: agyVersion,
        cwd,
        env,
      });
      verifyAgyRuntimeIdentity(acpPath, agyBin, agySha256, opts.runtimeRoot);
      return;
    }
    verifyAgyRuntimeIdentity(acpPath, agyBin, agySha256);
  });
  const runtime: AdapterRuntimeDescriptor = {
    executable: acpPath,
    argv: [],
    cwd,
    environment: {
      AGY_BIN: agyBin,
      AGY_SKIP_DOWNLOAD: "1",
      AGY_CONVERSATIONS_DIR: conversationsDir,
    },
    stateDir,
    conversationDir: conversationsDir,
    credentialScope,
    ...(opts.runtimeRoot ? { immutableRoot: path.normalize(opts.runtimeRoot) } : {}),
    provenance: {
      source: AGY_ACP_UPSTREAM_SOURCE,
      version: AGY_ACP_UPSTREAM_VERSION,
      commit: AGY_ACP_UPSTREAM_COMMIT,
      sha256: opts.wrapperSha256.toLowerCase(),
    },
    dependencies: [{ executable: agyBin, version: agyVersion, sha256: agySha256 }],
  };

  return asLocalAdapter({
    id: "agy-package",
    displayName: "Antigravity (package ACP)",
    defaultModel: opts.defaultModel,
    runtime,
    effort: { mechanism: "modelBaked", levels: [] },
    catalog: {
      scope: () => manifestCatalogScope({
        provider: "google-antigravity",
        credentialProfile: credentialScope,
        policy: AGY_PERMISSION_POLICY_SCOPE,
      }),
      async fetch() {
        verify();
        verifyRuntime();
        const observedAt = new Date().toISOString();
        const probe = opts.catalogProbe
          ? await opts.catalogProbe()
          : await probeAgyPackageCatalog({
              acpPath,
              agyBin,
              agyVersion,
              cwd,
              env,
              defaultModel: opts.defaultModel,
              timeoutMs: opts.timeoutMs,
            });
        if (probe.agyVersion !== agyVersion) {
          throw new Error(
            `AGY_BIN version mismatch: expected ${JSON.stringify(agyVersion)}, ` +
              `observed ${JSON.stringify(probe.agyVersion)}`
          );
        }
        if (!probe.models.length) throw new Error("authoritative agy catalog is empty");
        const scope = manifestCatalogScope({
          provider: "google-antigravity",
          credentialProfile: credentialScope,
          policy: AGY_PERMISSION_POLICY_SCOPE,
        });
        const rows: ManifestCatalogModel[] = probe.models.map((row) => ({
          modelId: row.modelId,
          runtimeId: row.modelId,
          name: row.displayName,
          aliases: [],
          evidence: [{
            kind: "live-observation",
            source: "agy-models+antigravity-acp-selection",
            observedAt,
            runtimeVersion: probe.agyVersion,
            adapterVersion: AGENT_ADAPTER_VERSION,
            scopeRef: scope.fingerprint,
            resolvedModel: row.modelId,
            effort: {
              choices: ["default"],
              selectionDefault: "default",
              method: "adapter-observed",
            },
          }],
          effort: {
            mechanism: "modelBaked",
            choices: ["default"],
            selectionDefault: "default",
          },
        }));
        const candidate = await manifestCatalogSource({
          provider: "google-antigravity",
          credentialProfile: credentialScope,
          policy: AGY_PERMISSION_POLICY_SCOPE,
          defaultModel: opts.defaultModel,
          models: () => rows,
          adapterVersion: AGENT_ADAPTER_VERSION,
          source: "agy-models+antigravity-acp-selection",
        }).fetch();
        candidate.sourceVersion = `${AGY_ACP_UPSTREAM_VERSION}-e0a3d22`;
        candidate.cliVersion = probe.agyVersion;
        return candidate;
      },
    },
    spawn() {
      verify();
      verifyRuntime();
      return protectAgyRuntimeStreams(spawn(acpPath, [], {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      }), env);
    },
  });
}

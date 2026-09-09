/**
 * Shared bounded child-process lifecycle for catalog collectors (#236).
 *
 * Every stdio/ACP collector needs the same guarantees, and each one writing its
 * own timeout/cleanup path is how a probe ends up leaking a wrapper per refresh
 * or hanging a scheduled job forever. This is the ONE implementation, and it is
 * ENFORCING rather than advisory: a provider cannot opt out of the bounds.
 *
 * Provider-neutral by construction — the caller supplies executable, argv, cwd
 * and env and does its own protocol work in `run`. This module knows no agent,
 * no CLI, and no model name, and it never writes to the child, so a catalog
 * probe cannot spend model tokens.
 *
 * Guaranteed on EVERY exit path (success, spawn error, early exit, protocol
 * error, malformed output, output flood, timeout, cancellation):
 *
 * - stdout AND stderr are bounded AT THE STREAM BOUNDARY; overflow fails the
 *   probe and kills the child rather than buffering an unbounded payload
 * - close steps run in explicit phases — SESSION before CONNECTION — never in
 *   registration order, which every provider would otherwise get to guess at
 * - a close registered LATE (after cleanup began, e.g. by a connection that
 *   finished constructing after the timeout fired) still runs
 * - `handle.signal` aborts, so the caller's own async work is cancelled too
 * - every listener and timer this module adds is removed
 * - SIGTERM, then a bounded SIGKILL, then the exit is AWAITED; failing to
 *   observe an exit is itself an error, not a silent success
 * - errors are structured codes with REDACTED detail: supplied env values and
 *   credential-shaped content never reach a log, a card, or a durable row
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough, type Readable, type Writable } from "node:stream";

/** Trailing bytes of stderr retained for (redacted) diagnostics. */
export const PROBE_STDERR_CAPTURE_BYTES = 4_000;
/** Hard ceiling on total stdout bytes a probe may receive. */
export const PROBE_STDOUT_LIMIT_BYTES = 1_000_000;
/** Hard ceiling on total stderr bytes a probe may receive. */
export const PROBE_STDERR_LIMIT_BYTES = 256_000;
export const PROBE_DEFAULT_TIMEOUT_MS = 45_000;
export const PROBE_DEFAULT_KILL_GRACE_MS = 2_000;
export const PROBE_DEFAULT_REAP_MS = 2_000;

export type ProbeErrorCode =
  | "spawn_failed"
  | "exited_early"
  | "output_overflow"
  | "timeout"
  | "cancelled"
  | "not_reaped"
  | "protocol_error";

/**
 * A probe failure. `code` is what callers and logs should branch on; `detail`
 * is already redacted and safe to render. Raw child output is NEVER attached.
 */
export class ProbeError extends Error {
  readonly code: ProbeErrorCode;
  readonly detail: string;
  constructor(code: ProbeErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ProbeError";
    this.code = code;
    this.detail = detail;
  }
}

export type ProbeClosePhase = "session" | "connection";

export interface ProbeHandle {
  stdin: Writable;
  /** Bounded view of the child's stdout. Overflow destroys it and fails the probe. */
  stdout: Readable;
  pid: number | undefined;
  /**
   * Aborts when the probe is ending for ANY reason (timeout, cancellation,
   * early exit, overflow). Pass it into provider async work so a late-finishing
   * connection is cancelled instead of resurrecting after cleanup.
   */
  readonly signal: AbortSignal;
  /**
   * Register a teardown step. `phase` decides ORDER, not registration time:
   * every `session` step runs before every `connection` step, because a session
   * must be closed politely while its transport is still up. Registering after
   * cleanup has begun still runs the step (bounded) rather than dropping it.
   */
  onClose(step: () => void | Promise<void>, phase?: ProbeClosePhase): void;
  /** Rejects when the child exits early; race protocol waits against it. */
  readonly exited: Promise<never>;
  /** Redacted trailing stderr, for tests and structured diagnostics. */
  stderrTail(): string;
}

export interface BoundedProbeOptions<T> {
  executable: string;
  args?: ReadonlyArray<string>;
  cwd?: string;
  /**
   * Environment for the child, supplied by the ADAPTER so a probe observes what
   * a real spawn would. Every non-trivial VALUE here is redacted out of any
   * error this helper produces.
   */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  killGraceMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  /** Label used in error detail. Must not carry secrets. */
  label?: string;
  run: (handle: ProbeHandle) => Promise<T>;
}

/** Credential-shaped content redacted from diagnostics regardless of env. */
const CREDENTIAL_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|xox[abprs]|AKIA|ASIA|AIza|glpat)[-_][A-Za-z0-9_-]{8,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
  /\bbearer\s+\S+/gi,
  /(?<=[A-Za-z0-9_.-]{2,}\s*[=:]\s*)\S{6,}/g,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /(?:\/home\/|\/Users\/)[^\s:,]*/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b[A-Za-z0-9_-]{40,}\b/g,
];

/**
 * Remove anything that could be a secret from diagnostic text.
 *
 * Two layers: every non-trivial VALUE from the env the adapter supplied (a
 * child that echoes its own environment is the exact hostile case), then
 * credential-shaped patterns for secrets that never appeared in that env.
 */
export function redactProbeText(text: string, env?: NodeJS.ProcessEnv): string {
  let out = text;
  if (env) {
    const values = Object.values(env)
      .filter((value): value is string => typeof value === "string" && value.length >= 4)
      // Longest first, so an overlapping shorter value cannot leave a fragment.
      .sort((a, b) => b.length - a.length);
    for (const value of values) out = out.split(value).join("[redacted]");
  }
  for (const pattern of CREDENTIAL_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}

interface CloseStep { step: () => void | Promise<void>; phase: ProbeClosePhase }

/**
 * Run `run` against a freshly spawned child and tear everything down.
 *
 * The result is returned only after close steps have run and the child has been
 * reaped, so "the probe returned" always means "the process is gone".
 */
export async function runBoundedProbe<T>(options: BoundedProbeOptions<T>): Promise<T> {
  const label = options.label ?? "probe";
  const timeoutMs = options.timeoutMs ?? PROBE_DEFAULT_TIMEOUT_MS;
  const stdoutLimit = options.maxStdoutBytes ?? PROBE_STDOUT_LIMIT_BYTES;
  const stderrLimit = options.maxStderrBytes ?? PROBE_STDERR_LIMIT_BYTES;
  const killGraceMs = options.killGraceMs ?? PROBE_DEFAULT_KILL_GRACE_MS;
  const redact = (text: string): string => redactProbeText(text, options.env);

  if (options.signal?.aborted) {
    throw new ProbeError("cancelled", `${label} cancelled before spawn`);
  }

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(options.executable, [...(options.args ?? [])], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    throw new ProbeError("spawn_failed", `${label}: ${redact(errorText(err))}`);
  }

  const controller = new AbortController();
  const closeSteps: CloseStep[] = [];
  let cleanupStarted = false;
  let succeeded = false;
  let exitReject: ((err: Error) => void) | undefined;

  /**
   * Signal a failure. `exitReject` settles once, so the FIRST failure is the
   * one callers see; later ones cannot mask the original cause.
   */
  const fail = (error: ProbeError): void => {
    if (!controller.signal.aborted) controller.abort();
    exitReject?.(error);
  };

  // ---- bounded stdout: count at the boundary, hand the caller a safe view ---
  // The helper owns the ONLY consumer of the raw stream and republishes it, so
  // nothing is lost to a late listener and nothing can exceed the ceiling.
  const stdout = new PassThrough();
  let stdoutBytes = 0;
  const onStdout = (chunk: Buffer): void => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > stdoutLimit) {
      fail(new ProbeError("output_overflow", `${label} stdout exceeded ${stdoutLimit} bytes`));
      stdout.destroy();
      return;
    }
    stdout.write(chunk);
  };
  const onStdoutEnd = (): void => { stdout.end(); };
  child.stdout.on("data", onStdout);
  child.stdout.once("end", onStdoutEnd);

  let stderrTail = "";
  let stderrBytes = 0;
  const onStderr = (chunk: Buffer): void => {
    stderrBytes += chunk.length;
    if (stderrBytes > stderrLimit) {
      fail(new ProbeError("output_overflow", `${label} stderr exceeded ${stderrLimit} bytes`));
      return;
    }
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-PROBE_STDERR_CAPTURE_BYTES);
  };
  child.stderr.on("data", onStderr);

  const onSpawnError = (err: Error): void => {
    fail(new ProbeError("spawn_failed", `${label}: ${redact(errorText(err))}`));
  };
  const onExit = (code: number | null, signalCode: NodeJS.Signals | null): void => {
    // Raw child stderr is NEVER attached; only its redacted tail.
    const tail = redact(stderrTail).trim();
    fail(new ProbeError(
      "exited_early",
      `${label} exited (code=${code}, signal=${signalCode})${tail ? `: ${tail}` : ""}`
    ));
  };

  const exited = new Promise<never>((_resolve, reject) => { exitReject = reject; });
  exited.catch(() => {});
  const started = new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    // Map to the CODED error here. Rejecting with Node's raw error would reach
    // `decorate` and be classified `protocol_error`, sending an operator to
    // debug a protocol when the executable is simply missing.
    child.once("error", (err: Error) =>
      reject(new ProbeError("spawn_failed", `${label}: ${redact(errorText(err))}`))
    );
  });
  started.catch(() => {});
  child.on("error", onSpawnError);
  child.on("exit", onExit);

  let timer: NodeJS.Timeout | undefined;
  let onOuterAbort: (() => void) | undefined;
  let bounded: Promise<never> | undefined;

  const handle: ProbeHandle = {
    stdin: child.stdin,
    stdout,
    pid: child.pid,
    signal: controller.signal,
    exited,
    stderrTail: () => redact(stderrTail),
    onClose: (step, phase = "connection") => {
      // A late registration means a connection finished constructing after the
      // deadline. Dropping it would leak exactly the session we are trying to
      // close, so run it now instead — still bounded.
      if (cleanupStarted) {
        void withDeadline(step, killGraceMs);
        return;
      }
      closeSteps.push({ step, phase });
    },
  };

  try {
    bounded = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new ProbeError("timeout", `${label} timed out after ${timeoutMs}ms`);
        fail(error);
        reject(error);
      }, timeoutMs);
      timer.unref?.();
      if (options.signal) {
        onOuterAbort = () => {
          const error = new ProbeError("cancelled", `${label} cancelled`);
          fail(error);
          reject(error);
        };
        options.signal.addEventListener("abort", onOuterAbort, { once: true });
      }
    });
    bounded.catch(() => {});
    // Node reports a failed spawn ASYNCHRONOUSLY on `error`, so a `run` that
    // returns without touching the child would otherwise report success for a
    // missing executable.
    await Promise.race([started, bounded, exited]);
    const value = await Promise.race([options.run(handle), bounded, exited]);
    succeeded = true;
    return value;
  } catch (err) {
    throw decorate(err, label, redact);
  } finally {
    cleanupStarted = true;
    if (!controller.signal.aborted) controller.abort();
    if (timer) clearTimeout(timer);
    if (options.signal && onOuterAbort) options.signal.removeEventListener("abort", onOuterAbort);
    child.removeListener("error", onSpawnError);
    child.removeListener("exit", onExit);
    child.stdout.removeListener("data", onStdout);
    child.stdout.removeListener("end", onStdoutEnd);
    child.stderr.removeListener("data", onStderr);
    if (!stdout.destroyed) stdout.end();
    // Explicit phases: a session is closed while its transport is still up.
    for (const phase of ["session", "connection"] as const) {
      for (const entry of closeSteps.filter((step) => step.phase === phase)) {
        await withDeadline(entry.step, killGraceMs);
      }
    }
    const reaped = await terminate(child, killGraceMs);
    // The documented guarantee is "awaited/reaped". If no exit was observed we
    // must say so rather than return as though the host were left clean. Only
    // on the success path: throwing here while already unwinding would mask the
    // original cause with a symptom of it.
    if (!reaped && succeeded) {
      throw new ProbeError("not_reaped", `${label} child ${child.pid ?? "?"} did not exit after SIGKILL`);
    }
  }
}

async function withDeadline(step: () => void | Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(step).catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * SIGTERM, then SIGKILL if it has not exited, then await the reap.
 * Returns whether an exit was actually OBSERVED.
 */
export async function terminate(
  child: ChildProcessWithoutNullStreams,
  graceMs: number = PROBE_DEFAULT_KILL_GRACE_MS
): Promise<boolean> {
  if (child.pid === undefined) return true;
  if (child.exitCode !== null || child.signalCode !== null) return true;
  const exit = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  child.kill("SIGTERM");
  if (await settledWithin(exit, graceMs)) return true;
  child.kill("SIGKILL");
  return settledWithin(exit, PROBE_DEFAULT_REAP_MS);
}

function settledWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
      timer.unref?.();
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

function decorate(err: unknown, label: string, redact: (text: string) => string): ProbeError {
  if (err instanceof ProbeError) return err;
  return new ProbeError("protocol_error", `${label}: ${redact(errorText(err))}`);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Shared bounded child-process lifecycle for catalog collectors (#236).
 *
 * Every stdio/ACP collector needs the same guarantees, and each one writing its
 * own timeout/cleanup path is how a probe ends up leaking a wrapper per refresh
 * or hanging a scheduled job forever. This is the ONE implementation.
 *
 * It is provider-neutral by construction: the caller supplies the executable,
 * argv, cwd and env, and does its own protocol work inside `run`. This module
 * knows no agent, no CLI, and no model name, and it never prompts — a catalog
 * probe must not spend model tokens.
 *
 * Guaranteed on EVERY exit path (success, spawn error, early exit, protocol
 * error, malformed output, timeout, cancellation):
 *
 * - registered close callbacks run (session/connection close) before teardown
 * - timers cleared and listeners removed
 * - SIGTERM, then a bounded SIGKILL fallback
 * - the child's exit is awaited, so a caller that resolves cannot leave a
 *   process still dying behind it
 * - stdout/stderr capture is bounded to a trailing window
 * - errors carry the child's own stderr tail and NEVER the environment
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/** Trailing bytes of stderr retained for diagnostics. */
export const PROBE_STDERR_CAPTURE_BYTES = 4_000;
/** Default overall probe budget. */
export const PROBE_DEFAULT_TIMEOUT_MS = 45_000;
/** How long a terminated child has to exit before SIGKILL. */
export const PROBE_DEFAULT_KILL_GRACE_MS = 2_000;
/** How long SIGKILL has to be reaped before we stop waiting. */
export const PROBE_DEFAULT_REAP_MS = 2_000;

export class ProbeTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeTimeoutError";
  }
}

export class ProbeCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeCancelledError";
  }
}

export interface ProbeHandle {
  stdin: Writable;
  stdout: Readable;
  /** Process id, or undefined if the spawn never produced one. */
  pid: number | undefined;
  /**
   * Register a close step (an ACP `session/close`, a connection dispose) to run
   * before the child is terminated. Runs exactly once, in reverse registration
   * order, on every exit path. A throwing/hanging callback cannot prevent
   * teardown — it is bounded and its failure is swallowed.
   */
  onClose(step: () => void | Promise<void>): void;
  /** Rejects when the child exits early; race protocol waits against it. */
  readonly exited: Promise<never>;
  /** Trailing stderr captured so far. */
  stderrTail(): string;
}

export interface BoundedProbeOptions<T> {
  executable: string;
  args?: ReadonlyArray<string>;
  cwd?: string;
  /**
   * Environment for the child. Supplied by the ADAPTER so a probe observes what
   * a real spawn would. Never logged, never attached to an error.
   */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  killGraceMs?: number;
  maxStderrBytes?: number;
  /** A label used in timeout/cancellation messages. Must not carry secrets. */
  label?: string;
  run: (handle: ProbeHandle) => Promise<T>;
}

/**
 * Run `run` against a freshly spawned child and tear everything down.
 *
 * The result of `run` is returned only after close steps have run and the child
 * has been reaped, so "the probe returned" always means "the process is gone".
 */
export async function runBoundedProbe<T>(options: BoundedProbeOptions<T>): Promise<T> {
  const label = options.label ?? options.executable;
  const timeoutMs = options.timeoutMs ?? PROBE_DEFAULT_TIMEOUT_MS;
  const maxStderrBytes = options.maxStderrBytes ?? PROBE_STDERR_CAPTURE_BYTES;

  if (options.signal?.aborted) {
    throw new ProbeCancelledError(`${label} probe cancelled before spawn`);
  }

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(options.executable, [...(options.args ?? [])], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    // Synchronous spawn failure: nothing to clean up, but the error must still
    // be shaped like every other failure from this helper.
    throw new Error(`${label} probe could not spawn: ${errorText(err)}`);
  }

  let stderr = "";
  const onStderr = (chunk: Buffer | string): void => {
    stderr = (stderr + String(chunk)).slice(-maxStderrBytes);
  };
  child.stderr.on("data", onStderr);

  const closeSteps: Array<() => void | Promise<void>> = [];
  let settled = false;
  let exitReject: ((err: Error) => void) | undefined;

  const onSpawnError = (err: Error): void => {
    if (settled) return;
    exitReject?.(new Error(`${label} probe process error: ${errorText(err)}`));
  };
  const onExit = (code: number | null, signalCode: NodeJS.Signals | null): void => {
    if (settled) return;
    exitReject?.(
      new Error(
        `${label} probe exited early (code=${code}, signal=${signalCode})` +
          (stderr.trim() ? `: ${stderr.trim()}` : "")
      )
    );
  };

  // Node reports a failed spawn (ENOENT, EACCES) ASYNCHRONOUSLY on the `error`
  // event, not by throwing. Without waiting for the `spawn` event first, a
  // `run` that returns without touching the child resolves before the failure
  // arrives — and a probe against a missing executable reports SUCCESS.
  const started = new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  started.catch(() => {});

  const exited = new Promise<never>((_resolve, reject) => {
    exitReject = reject;
  });
  // The early-exit promise is always raced against; mark it handled so an exit
  // that loses the race can never surface as an unhandled rejection.
  exited.catch(() => {});
  child.once("error", onSpawnError);
  child.once("exit", onExit);

  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;

  const handle: ProbeHandle = {
    stdin: child.stdin,
    stdout: child.stdout,
    pid: child.pid,
    onClose: (step) => { closeSteps.push(step); },
    exited,
    stderrTail: () => stderr,
  };

  try {
    const bounded = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new ProbeTimeoutError(`${label} probe timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
      timer.unref?.();
      if (options.signal) {
        onAbort = () => reject(new ProbeCancelledError(`${label} probe cancelled`));
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    bounded.catch(() => {});
    // `run` is only ever handed a child that actually started.
    await Promise.race([started, bounded]);
    const value = await Promise.race([options.run(handle), bounded, exited]);
    settled = true;
    return value;
  } catch (err) {
    settled = true;
    // Attach the child's own stderr, never the environment, so a failed refresh
    // is diagnosable from the log line alone without leaking credentials.
    throw decorate(err, label, stderr);
  } finally {
    settled = true;
    if (timer) clearTimeout(timer);
    if (options.signal && onAbort) options.signal.removeEventListener("abort", onAbort);
    child.removeListener("error", onSpawnError);
    child.removeListener("exit", onExit);
    child.stderr.removeListener("data", onStderr);
    // Close steps first: an ACP session should be closed politely before its
    // transport is torn out from under it. Bounded and failure-tolerant — a
    // wedged close must not keep the process alive.
    for (const step of closeSteps.reverse()) {
      await withDeadline(step, options.killGraceMs ?? PROBE_DEFAULT_KILL_GRACE_MS);
    }
    await terminate(child, options.killGraceMs ?? PROBE_DEFAULT_KILL_GRACE_MS);
  }
}

/** Run a close step, swallowing failure and bounding how long it may hang. */
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
 * SIGTERM, then SIGKILL if it has not exited, then await the reap. Resolves
 * once the child is gone (or the bounded wait elapses), never earlier.
 */
export async function terminate(
  child: ChildProcessWithoutNullStreams,
  graceMs: number = PROBE_DEFAULT_KILL_GRACE_MS
): Promise<void> {
  // A spawn that never produced a process has nothing to signal or await;
  // without this, every ENOENT would sit through the full grace + reap budget.
  if (child.pid === undefined) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  child.kill("SIGTERM");
  if (await settledWithin(exit, graceMs)) return;
  child.kill("SIGKILL");
  await settledWithin(exit, PROBE_DEFAULT_REAP_MS);
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

function decorate(err: unknown, label: string, stderr: string): Error {
  const detail = stderr.trim();
  const message = errorText(err);
  const full = detail && !message.includes(detail) ? `${message}: ${detail}` : message;
  if (err instanceof ProbeTimeoutError) return new ProbeTimeoutError(full);
  if (err instanceof ProbeCancelledError) return new ProbeCancelledError(full);
  return new Error(message.startsWith(label) ? full : `${label} probe failed: ${full}`);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

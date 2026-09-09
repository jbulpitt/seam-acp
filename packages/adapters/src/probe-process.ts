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
 *   registration order, and that holds for a step registered LATE as well: it
 *   is queued and drained by the phase loop, never executed on arrival
 * - the registration phase stays open until the provider run settles (bounded
 *   by `finalizeDeadlineMs`), then SEALS; a registration after the seal is
 *   rejected outright rather than run, so nothing acts after return
 * - `handle.signal` aborts, so the caller's own async work is cancelled too
 * - every listener and timer this module adds is removed
 * - SIGTERM, then a bounded SIGKILL, then the exit is AWAITED; failing to
 *   observe an exit is itself an error, not a silent success
 * - errors are structured codes with REDACTED detail: supplied env values and
 *   credential-shaped content never reach a log, a card, or a durable row
 *
 * ## What "bounded" does and does not mean
 *
 * The helper is bounded and it WAITS for cooperative close completion. Each
 * close step is given an AbortSignal and a bounded window; a cooperative step
 * observes the signal and stops, and the helper awaits it before returning.
 *
 * It CANNOT preempt arbitrary JavaScript that ignores cancellation. There is no
 * mechanism in the language to abort a running promise, so a deliberately
 * non-cooperative callback can still mutate state after its promise is
 * abandoned. That adversarial case is outside this contract: every close
 * implementation in this repository cooperates, and a provider adding one is
 * expected to do the same. What IS guaranteed is that the helper itself
 * schedules no work after return — nothing is detached, and a post-seal
 * registration is refused rather than run.
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
/**
 * Separate, bounded deadline for FINALIZATION: after cancellation, how long the
 * provider run has to settle so its close registrations are complete. This is
 * not the authority for "registration is done" — settlement of the run is. It
 * exists only so a run that refuses to settle cannot hang the helper forever.
 */
export const PROBE_DEFAULT_FINALIZE_DEADLINE_MS = 10_000;
/** How many times finalization re-drains newly registered close steps. */
const LATE_CLOSE_DRAIN_ROUNDS = 8;
/** Session is always closed before the connection that carries it. */
const CLOSE_PHASES = ["session", "connection"] as const;

export type ProbeErrorCode =
  | "spawn_failed"
  | "exited_early"
  | "output_overflow"
  | "timeout"
  | "cancelled"
  | "not_reaped"
  | "not_settled"
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

/**
 * A teardown step. It receives an AbortSignal that fires when its bounded
 * window elapses; a cooperative implementation stops there.
 *
 * The helper CANNOT preempt a promise that ignores the signal — nothing in
 * JavaScript can. See the contract note on {@link runBoundedProbe}.
 */
export type ProbeCloseStep = (signal: AbortSignal) => void | Promise<void>;

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
  onClose(step: ProbeCloseStep, phase?: ProbeClosePhase): void;
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
  /**
   * After the deadline or an abort, how long an already-running `run` gets to
   * observe the abort and finish registering its close steps before we
   * finalize. Bounded on purpose: waiting forever would defeat the deadline.
   */
  /**
   * Bounded ceiling on finalization, NOT the signal that registration is
   * complete — settlement of `run` is. A run that refuses to settle within it
   * yields `not_settled`, after the child has been terminated and reaped.
   */
  finalizeDeadlineMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  /** Label used in error detail. Must not carry secrets. */
  label?: string;
  /**
   * Test seam (same precedent as the adapters' `catalogProbe` injections).
   * Production leaves it unset and the helper spawns the real executable. It
   * exists so the un-reapable and listener-accounting paths — which a real OS
   * process cannot be made to exhibit, since SIGKILL is not catchable — are
   * provable through `runBoundedProbe` itself rather than only through
   * `terminate`.
   */
  spawnOverride?: () => ChildProcessWithoutNullStreams;
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

interface CloseStep { step: ProbeCloseStep; phase: ProbeClosePhase }

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
  const finalizeDeadlineMs = options.finalizeDeadlineMs ?? PROBE_DEFAULT_FINALIZE_DEADLINE_MS;
  const redact = (text: string): string => redactProbeText(text, options.env);

  if (options.signal?.aborted) {
    throw new ProbeError("cancelled", `${label} cancelled before spawn`);
  }

  let child: ChildProcessWithoutNullStreams;
  try {
    child = options.spawnOverride ? options.spawnOverride() : spawn(options.executable, [...(options.args ?? [])], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    throw new ProbeError("spawn_failed", `${label}: ${redact(errorText(err))}`);
  }

  const controller = new AbortController();
  const closeSteps: CloseStep[] = [];
  // Phase order is a property of the CONTRACT, not of registration order.
  let cleanupStarted = false;
  /** True once the helper will accept no further close registrations. */
  let registrationSealed = false;
  /** Registrations that arrived after the phase closed (provider bug). */
  let droppedRegistrations = 0;
  let succeeded = false;
  /** Set when the run refused to settle inside the finalization deadline. */
  let notSettled = false;
  /** Code of the error currently unwinding, so finalization can rank causes. */
  let thrownCode: ProbeErrorCode | undefined;
  /** Set once a post-spawn `error` is seen, which is NOT a spawn failure. */
  let postSpawnError: Error | undefined;
  /** Set when the child ended normally; not a failure, but it IS reaped. */
  let cleanExit = false;
  /** True once the OS has actually produced the process. */
  let spawned = child.pid !== undefined;
  /** The caller's own promise, so finalization can give it a bounded chance
   *  to observe the abort and finish registering its closes. */
  let runPromise: Promise<T> | undefined;
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

  /**
   * A child `error` means two very different things depending on WHEN it
   * arrives. Before the process exists it is a spawn failure (ENOENT, EACCES).
   * AFTER a pid exists the process is real and may still be running, so
   * classifying it `spawn_failed` both misdescribes it and skips the reaping
   * question entirely — the child could be left alive.
   */
  const onSpawnError = (err: Error): void => {
    if (spawned || child.pid !== undefined) {
      postSpawnError = err;
      fail(new ProbeError("protocol_error", `${label}: ${redact(errorText(err))}`));
      return;
    }
    fail(new ProbeError("spawn_failed", `${label}: ${redact(errorText(err))}`));
  };
  /**
   * Kept attached for the WHOLE lifecycle and removed last, so an `error`
   * emitted during teardown cannot surface as an uncaught exception in the
   * host process (or as an unhandled error in a test run).
   */
  const swallowLateError = (): void => {};
  child.on("error", swallowLateError);
  const onExit = (code: number | null, signalCode: NodeJS.Signals | null): void => {
    // A CLEAN exit (code 0, no signal) is ordinary teardown — a short-lived
    // wrapper ending after its work, or ending because we closed its transport.
    // Treating it as `exited_early` failed probes that had already succeeded,
    // purely on whether the exit event beat the run's resolution to the race.
    // Only an ABNORMAL exit is a failure worth unblocking racers for.
    if (code === 0 && signalCode === null) {
      cleanExit = true;
      return;
    }
    // Raw child stderr is NEVER attached; only its redacted tail.
    const tail = redact(stderrTail).trim();
    fail(new ProbeError(
      "exited_early",
      `${label} exited (code=${code}, signal=${signalCode})${tail ? `: ${tail}` : ""}`
    ));
  };

  const exited = new Promise<never>((_resolve, reject) => { exitReject = reject; });
  exited.catch(() => {});
  // Named so BOTH can be removed: these are mutually raced, so whichever does
  // not fire would otherwise stay attached for the lifetime of the child.
  let onStarted: (() => void) | undefined;
  let onStartError: ((err: Error) => void) | undefined;
  const started = new Promise<void>((resolve, reject) => {
    onStarted = () => { spawned = true; resolve(); };
    // Map to the CODED error here. Rejecting with Node's raw error would reach
    // `decorate` and be classified `protocol_error`, sending an operator to
    // debug a protocol when the executable is simply missing.
    onStartError = (err: Error) => {
      if (spawned || child.pid !== undefined) {
        postSpawnError = err;
        reject(new ProbeError("protocol_error", `${label}: ${redact(errorText(err))}`));
        return;
      }
      reject(new ProbeError("spawn_failed", `${label}: ${redact(errorText(err))}`));
    };
    child.once("spawn", onStarted);
    child.once("error", onStartError);
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
      // Registration barrier. Before finalization a step is queued normally.
      // AFTER cleanup has begun but BEFORE finalization — a connection that
      // finished constructing past the deadline — the step runs immediately AND
      // its promise is tracked, so finalization drains it. Previously this was
      // a detached `void`, so `runBoundedProbe` could resolve while a session
      // close was still pending: return did not mean cleanup had happened.
      // Explicit registration phases. While the phase is OPEN — including the
      // whole finalization window, which stays open until `run` settles — a
      // step is QUEUED with its declared phase and drained by the phase loop
      // like any other. It is never executed on arrival: doing that discarded
      // the phase and could run a connection close before a session close.
      //
      // Once the phase is SEALED the helper has already told its caller that
      // cleanup finished, so the step is rejected outright — not executed, not
      // detached — because anything it did would be a side effect after return.
      if (registrationSealed) {
        droppedRegistrations += 1;
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
    runPromise = options.run(handle);
    // Never leave the caller's promise unhandled: on the timeout/abort path we
    // stop awaiting it here, but finalization still observes it below.
    runPromise.catch(() => undefined);
    const value = await Promise.race([runPromise, bounded, exited]);
    succeeded = true;
    return value;
  } catch (err) {
    const decorated = decorate(err, label, redact);
    thrownCode = decorated.code;
    throw decorated;
  } finally {
    cleanupStarted = true;
    // SETTLEMENT of the run — not a fixed grace — is what says registration is
    // complete. Abort first so a cooperative `run` observes cancellation, then
    // wait for it to actually settle. The deadline below is only a ceiling so a
    // run that refuses to settle cannot hang the helper forever; when it is hit
    // we terminate/reap the child and report `not_settled` rather than
    // returning as though cleanup had completed.
    if (!controller.signal.aborted) controller.abort();
    if (runPromise) {
      const settled = await settledWithin(
        runPromise.then(() => undefined, () => undefined),
        finalizeDeadlineMs
      );
      if (!settled) notSettled = true;
    }
    if (timer) clearTimeout(timer);
    if (options.signal && onOuterAbort) options.signal.removeEventListener("abort", onOuterAbort);
    // Transport stays FULLY LIVE across the close drain — forwarding included.
    // Removing the stdout listener or ending the republished stream here would
    // make the session phase useless: a `session/close` written afterwards is
    // either never delivered or never answered, which is the exact thing
    // session-before-connection ordering exists to allow.
    // Drain in PHASE order, repeatedly: a close step may itself register another
    // one, and a step that arrived late still has to obey session-before-
    // connection. The registration phase stays OPEN across rounds so anything a
    // draining step registers is picked up by the next round rather than
    // escaping; it seals only once a full round adds nothing new.
    for (let round = 0; closeSteps.length > 0 && round < LATE_CLOSE_DRAIN_ROUNDS; round++) {
      const pending = closeSteps.splice(0, closeSteps.length);
      for (const phase of CLOSE_PHASES) {
        for (const entry of pending.filter((step) => step.phase === phase)) {
          await withDeadline(entry.step, killGraceMs);
        }
      }
    }
    // Nothing may register from here on.
    registrationSealed = true;
    // Transport down only once every session-phase close has had its turn.
    child.removeListener("error", onSpawnError);
    child.removeListener("exit", onExit);
    if (onStarted) child.removeListener("spawn", onStarted);
    if (onStartError) child.removeListener("error", onStartError);
    child.stdout.removeListener("data", onStdout);
    child.stdout.removeListener("end", onStdoutEnd);
    child.stderr.removeListener("data", onStderr);
    if (!stdout.destroyed) stdout.end();
    const reaped = cleanExit || (await terminate(child, killGraceMs));
    // The protective error listener is the LAST thing removed, so a stray
    // `error` emitted during termination cannot become an uncaught exception.
    child.removeListener("error", swallowLateError);
    if (droppedRegistrations > 0) {
      // Not fatal — the closes it wanted are moot once the child is reaped —
      // but it is a provider bug and must not be silent.
      // eslint-disable-next-line no-console
      logDroppedRegistrations(label, droppedRegistrations);
    }
    // A leaked process is the most actionable fact there is, so `not_reaped`
    // wins over any in-flight cause and is reported on every path, not only
    // after a successful run.
    if (!reaped) {
      throw new ProbeError(
        "not_reaped",
        `${label} child ${child.pid ?? "?"} did not exit after SIGKILL` +
          (postSpawnError ? `; after error: ${redact(postSpawnError.message)}` : "")
      );
    }
    // A run that ignored cancellation is the specific, actionable fact — more
    // useful than the deadline that merely triggered it — so it takes
    // precedence over the raced cause. (`succeeded` cannot be true here: a run
    // that returned a value has settled by definition, which is why gating on
    // it made this branch unreachable.)
    // Ranked, so a specific cause is never masked by a symptom of it. Only the
    // cancellation-triggered codes are replaced: if the probe already failed
    // concretely (overflow, early exit, protocol error) that IS the cause, and
    // the un-settled run is incidental to it.
    if (notSettled && (thrownCode === undefined || thrownCode === "timeout" || thrownCode === "cancelled")) {
      throw new ProbeError(
        "not_settled",
        `${label} run did not settle within ${finalizeDeadlineMs}ms of cancellation` +
          (thrownCode ? ` (after ${thrownCode})` : "")
      );
    }
  }
}

/**
 * Run one close step under a bounded window, handing it a signal so it can stop
 * itself. We stop AWAITING when the window elapses; a cooperative step will
 * already have stopped. A step that ignores the signal cannot be preempted —
 * see the contract note on {@link runBoundedProbe}.
 */
async function withDeadline(step: ProbeCloseStep, ms: number): Promise<void> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => step(controller.signal)).catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => { controller.abort(); resolve(); }, ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort();
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
  // ONLY `exit` counts as reaped. Resolving on `error` too meant a child that
  // errored without ever exiting reported success while still running, and the
  // complementary once-listener stayed attached forever.
  let onExit: (() => void) | undefined;
  const exit = new Promise<void>((resolve) => {
    onExit = () => resolve();
    child.once("exit", onExit);
  });
  try {
    child.kill("SIGTERM");
    if (await settledWithin(exit, graceMs)) return true;
    child.kill("SIGKILL");
    return await settledWithin(exit, PROBE_DEFAULT_REAP_MS);
  } finally {
    // Whether or not it fired, this listener is ours to remove.
    if (onExit) child.removeListener("exit", onExit);
  }
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

/** Surfaced rather than swallowed: a registration after the phase closed is a
 *  provider-side lifecycle bug, even though the step itself is now moot. */
function logDroppedRegistrations(label: string, count: number): void {
  process.emitWarning(
    `${label}: ${count} probe close registration(s) arrived after the lifecycle finalized and were dropped`,
    "SeamProbeLifecycleWarning"
  );
}

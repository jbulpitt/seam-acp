import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import {
  attachErrorClassification,
  classified,
  type AdapterErrorKind,
} from "./error-classification.js";
import {
  PROBE_STDERR_CAPTURE_BYTES,
  ProbeError,
  redactProbeText,
  terminateProcessGroup,
  type ProbeErrorCode,
} from "./probe-process.js";

interface AgyFailureEvidence {
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

/** Never retain raw CLI diagnostics: they may contain auth, prompts or paths. */
export function agyFailure(
  code: ProbeErrorCode,
  errorKind?: AdapterErrorKind,
  evidence: AgyFailureEvidence = {},
): ProbeError {
  const failure = new ProbeError(code, "native AGY lifecycle failed");
  if (errorKind) {
    // #481: retain only the closed enum learned before the diagnostic is
    // destroyed. Attaching `details` here would recreate the credential leak
    // this boundary exists to prevent; agent id + kind are sufficient for the
    // resolver, and every raw token/path/prompt still dies above this return.
    attachErrorClassification(failure, classified("agy", errorKind, {
      ...(evidence.exitCode !== undefined ? { exitCode: evidence.exitCode } : {}),
      ...(evidence.signal !== undefined ? { signal: evidence.signal } : {}),
    }));
  }
  return failure;
}

/** Abort a wait, not its underlying work; callers must own and close that work. */
export async function agyWait<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

/** Only use with a child launched in its own process group (detached:true). */
export async function reapAgyTree(child: ChildProcess): Promise<void> {
  // A failed kill must not permit a replacement turn beside the old process.
  // Native AGY can need more than 500 ms to flush and acknowledge SIGTERM.
  if (!await terminateProcessGroup(child, 1_000)) throw agyFailure("not_reaped");
}

/** One interactive turn; no finite-probe byte ceiling on streamed answers. */
export class AgyTurnLifecycle {
  readonly abort = new AbortController();
  userCancelled = false;
  streaming = false;
  proc?: ChildProcess;
  readonly temporaryFiles: string[] = [];
  readonly done: Promise<void>;
  private finish!: () => void;
  private timer: NodeJS.Timeout;
  private cleanup?: Promise<void>;
  private stderrBytes = 0;
  private stderrTail = "";
  private diagnosticValues: string[] = [];
  private stdoutBytes = 0;
  private structured = false;
  private captureStdout = true;
  private stdoutOverflow = false;
  private readonly stdout: Buffer[] = [];
  private exit!: Promise<void>;
  private onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  private resolveClose?: () => void;
  private pendingExit?: { code: number | null; signal: NodeJS.Signals | null };
  private onError = (): void => this.fail("spawn_failed");
  private onStderr = (chunk: Buffer): void => {
    // A noisy child must not exhaust host memory/IO before cancellation runs.
    this.stderrBytes += chunk.length;
    if (this.stderrBytes > 256_000) this.fail("output_overflow");
    // #491: the Daily Standup child emitted useful output, then exited and its
    // entire diagnostic was discarded. Retain only this bounded in-memory tail
    // until `close` drains stderr; classification keeps a closed enum and exit
    // facts, then cleanup destroys the text. Removing this restores the blind
    // generic `agent_exit` while every other adapter and AGY session still runs.
    this.stderrTail = (this.stderrTail + chunk.toString("utf8"))
      .slice(-PROBE_STDERR_CAPTURE_BYTES);
  };
  private onStdout = (chunk: Buffer): void => {
    if (!this.captureStdout) return;
    // Refuse only oversized buffered output, not a healthy streaming turn.
    // Pending fallback capture is bounded without imposing a streaming limit.
    this.stdoutBytes += chunk.length;
    if (this.stdoutBytes > 1_000_000) {
      this.stdoutOverflow = true;
      if (this.structured) this.fail("output_overflow");
      return;
    }
    this.stdout.push(chunk);
  };
  constructor(
    readonly sessionId: string,
    timeoutMs: number,
    private readonly classifyDiagnostic?: (redactedDiagnostic: string) => AdapterErrorKind,
  ) {
    this.done = new Promise(resolve => { this.finish = resolve; });
    // CLI --print-timeout is not an enforced host bound if the CLI wedges.
    this.timer = setTimeout(() => this.fail("timeout"), timeoutMs);
  }
  private abortWith(error: ProbeError): void {
    if (!this.abort.signal.aborted) this.abort.abort(error);
  }
  fail(code: ProbeErrorCode): void { if (!this.abort.signal.aborted) this.abort.abort(agyFailure(code)); }
  cancel(): void { this.userCancelled = true; this.fail("cancelled"); }
  private classifyExit(code: number | null, signal: NodeJS.Signals | null): ProbeError {
    // Classify only an already-redacted copy. Even if a future matcher throws,
    // this one nested turn still fails safely as `unclassified`; the adapter,
    // other sessions, and every other provider remain available.
    let safeDiagnostic = redactProbeText(this.stderrTail, process.env);
    for (const value of this.diagnosticValues) {
      safeDiagnostic = safeDiagnostic.split(value).join("[redacted]");
    }
    safeDiagnostic = safeDiagnostic.trim();
    let errorKind: AdapterErrorKind = "unclassified";
    try {
      if (safeDiagnostic) errorKind = this.classifyDiagnostic?.(safeDiagnostic) ?? "unclassified";
    } catch { /* The closed fallback is safer than surfacing classifier text. */ }
    return agyFailure("exited_early", errorKind, { exitCode: code, signal });
  }
  attach(
    proc: ChildProcess,
    structured: boolean,
    needsStdin: boolean,
    diagnosticValues: ReadonlyArray<string> = [],
  ): void {
    this.proc = proc;
    this.structured = structured;
    this.diagnosticValues = diagnosticValues
      .filter(value => value.length >= 4)
      .sort((a, b) => b.length - a.length);
    proc.on("error", this.onError);
    // Record at `exit`, but classify at `close`: Node only guarantees all
    // stderr bytes have drained at close, and the last line is often the cause.
    this.onExit = (code, signal) => {
      if (code !== 0 || signal !== null || !this.streaming) {
        this.pendingExit = { code, signal };
      }
    };
    proc.once("exit", this.onExit);
    // close, unlike exit, guarantees the final stdout bytes have been drained.
    this.exit = new Promise(resolve => { this.resolveClose = resolve; });
    proc.once("close", this.onClose);
    // Partial startup still enters cleanup, rather than leaking a real child.
    if (!proc.stdout || !proc.stderr || (needsStdin && !proc.stdin)) {
      this.fail("spawn_failed");
      this.abort.signal.throwIfAborted();
    }
    proc.stderr!.on("data", this.onStderr);
    proc.stdout!.on("data", this.onStdout);
    proc.stdin?.on("error", this.onError);
  }
  private onClose = (): void => {
    if (this.pendingExit) {
      this.abortWith(this.classifyExit(this.pendingExit.code, this.pendingExit.signal));
    }
    this.resolveClose?.();
  };
  async structuredOutput(): Promise<string> {
    await agyWait(this.exit, this.abort.signal);
    if (this.stdoutOverflow) throw agyFailure("output_overflow");
    return Buffer.concat(this.stdout).toString("utf8");
  }
  commitStream(): void {
    if (this.structured) return;
    this.captureStdout = false;
    this.stdout.length = 0;
  }
  close(): Promise<void> {
    return this.cleanup ??= (async () => {
      clearTimeout(this.timer);
      // The caller has finished persistence and closed the LS reader first.
      try { if (this.proc) await reapAgyTree(this.proc); }
      finally {
        this.proc?.stdin?.destroy();
        this.proc?.stdout?.destroy();
        this.proc?.stderr?.destroy();
        this.proc?.stdout?.removeListener("data", this.onStdout);
        this.proc?.stderr?.removeListener("data", this.onStderr);
        this.proc?.stdin?.removeListener("error", this.onError);
        this.proc?.removeListener("error", this.onError);
        if (this.onExit) this.proc?.removeListener("exit", this.onExit);
        this.proc?.removeListener("close", this.onClose);
        this.stdout.length = 0;
        this.stderrTail = "";
        this.diagnosticValues = [];
        await Promise.all(this.temporaryFiles.map(file => fs.unlink(file).catch(() => {})));
        this.finish();
      }
    })();
  }
}

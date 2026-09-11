import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { ProbeError, terminateProcessGroup, type ProbeErrorCode } from "./probe-process.js";

/** Never retain raw CLI diagnostics: they may contain auth, prompts or paths. */
export function agyFailure(code: ProbeErrorCode): ProbeError {
  return new ProbeError(code, "native AGY lifecycle failed");
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
  private stdoutBytes = 0;
  private structured = false;
  private readonly stdout: Buffer[] = [];
  private exit!: Promise<void>;
  private onExit?: (code: number | null) => void;
  private onError = (): void => this.fail("spawn_failed");
  private onStderr = (chunk: Buffer): void => {
    // A noisy child must not exhaust host memory/IO before cancellation runs.
    this.stderrBytes += chunk.length;
    if (this.stderrBytes > 256_000) this.fail("output_overflow");
  };
  private onStdout = (chunk: Buffer): void => {
    if (!this.structured) return;
    // Structured stdout is retained whole; refuse overflow BEFORE retaining.
    this.stdoutBytes += chunk.length;
    if (this.stdoutBytes > 1_000_000) { this.fail("output_overflow"); return; }
    this.stdout.push(chunk);
  };
  constructor(readonly sessionId: string, timeoutMs: number) {
    this.done = new Promise(resolve => { this.finish = resolve; });
    // CLI --print-timeout is not an enforced host bound if the CLI wedges.
    this.timer = setTimeout(() => this.fail("timeout"), timeoutMs);
  }
  fail(code: ProbeErrorCode): void { if (!this.abort.signal.aborted) this.abort.abort(agyFailure(code)); }
  cancel(): void { this.userCancelled = true; this.fail("cancelled"); }
  attach(proc: ChildProcess, structured: boolean, needsStdin: boolean): void {
    this.proc = proc;
    this.structured = structured;
    proc.on("error", this.onError);
    this.exit = new Promise(resolve => {
      // A clean CLI exit before LS discovery still cannot fulfill this turn.
      this.onExit = (code) => { if (code !== 0 || !this.streaming) this.fail("exited_early"); resolve(); };
      proc.once("exit", this.onExit);
    });
    // Partial startup still enters cleanup, rather than leaking a real child.
    if (!proc.stdout || !proc.stderr || (needsStdin && !proc.stdin)) {
      this.fail("spawn_failed");
      this.abort.signal.throwIfAborted();
    }
    proc.stderr!.on("data", this.onStderr);
    proc.stdout!.on("data", this.onStdout);
    proc.stdin?.on("error", this.onError);
  }
  async structuredOutput(): Promise<string> {
    await agyWait(this.exit, this.abort.signal);
    return Buffer.concat(this.stdout).toString("utf8");
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
        this.stdout.length = 0;
        await Promise.all(this.temporaryFiles.map(file => fs.unlink(file).catch(() => {})));
        this.finish();
      }
    })();
  }
}

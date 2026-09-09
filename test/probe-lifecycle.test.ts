/**
 * #236 — shared bounded probe lifecycle.
 *
 * The contract every stdio/ACP collector inherits, proved on EVERY exit path:
 * success, spawn error, early exit, protocol error, malformed output, timeout,
 * and cancellation. The helper is provider-neutral — nothing here names an
 * agent, a CLI, or a model.
 *
 * "The probe returned" must always mean "the process is gone", so each case
 * asserts the child was actually reaped rather than merely signalled.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ProbeCancelledError,
  ProbeTimeoutError,
  runBoundedProbe,
  PROBE_STDERR_CAPTURE_BYTES,
} from "@seam/adapters";

const CHILD = fileURLToPath(new URL("./fixtures/fake-probe-child.mjs", import.meta.url));

let dir: string;
let signalLog: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-probe-"));
  signalLog = path.join(dir, "signals.log");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const env = (mode: string, over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  FAKE_PROBE_MODE: mode,
  FAKE_PROBE_SIGNAL_LOG: signalLog,
  ...over,
});

/** True once the pid no longer exists. */
function gone(pid: number | undefined): boolean {
  if (pid === undefined) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

/** Wait for the fixture child's readiness line before acting on it. */
function ready(stdout: NodeJS.ReadableStream): Promise<void> {
  return new Promise((resolve) => {
    const onData = (chunk: Buffer | string): void => {
      if (String(chunk).includes("READY")) {
        stdout.removeListener("data", onData);
        resolve();
      }
    };
    stdout.on("data", onData);
  });
}

describe("#236 bounded probe lifecycle", () => {
  it("returns the caller's value and reaps the child", async () => {
    let pid: number | undefined;
    const closed: string[] = [];
    const value = await runBoundedProbe({
      executable: process.execPath,
      args: [CHILD],
      env: env("ready"),
      timeoutMs: 5_000,
      run: async (handle) => {
        pid = handle.pid;
        handle.onClose(() => { closed.push("session"); });
        handle.onClose(() => { closed.push("connection"); });
        return "collected";
      },
    });
    expect(value).toBe("collected");
    // Close steps run in reverse registration order — a connection is torn
    // down after the session that rides on it.
    expect(closed).toEqual(["connection", "session"]);
    await settle();
    expect(gone(pid)).toBe(true);
  });

  it("awaits the exit, so a returned probe never leaves a dying child", async () => {
    let pid: number | undefined;
    await runBoundedProbe({
      executable: process.execPath,
      args: [CHILD],
      env: env("ready"),
      timeoutMs: 5_000,
      run: async (handle) => { pid = handle.pid; return null; },
    });
    // No settle() here: the guarantee is that it is ALREADY gone on return.
    expect(gone(pid)).toBe(true);
  });

  it("terminates with SIGTERM first and falls back to SIGKILL", async () => {
    let pid: number | undefined;
    await runBoundedProbe({
      executable: process.execPath,
      args: [CHILD],
      env: env("ignore-sigterm"),
      timeoutMs: 5_000,
      killGraceMs: 150,
      run: async (handle) => {
        pid = handle.pid;
        // Only signal a child that has already installed its SIGTERM handler,
        // otherwise the default action kills it and proves nothing.
        await ready(handle.stdout);
        return null;
      },
    });
    // The child recorded SIGTERM and still refused to exit, so only the
    // SIGKILL fallback can account for it being gone.
    expect(fs.readFileSync(signalLog, "utf8")).toContain("SIGTERM");
    expect(gone(pid)).toBe(true);
  });

  it("surfaces a spawn error without leaking the environment", async () => {
    await expect(
      runBoundedProbe({
        executable: path.join(dir, "does-not-exist"),
        env: env("ready", { SUPER_SECRET_TOKEN: "s3cr3t-value" }),
        timeoutMs: 2_000,
        run: async () => "unreachable",
      })
    ).rejects.toThrow(/ENOENT|could not spawn|process error/);
    try {
      await runBoundedProbe({
        executable: path.join(dir, "does-not-exist"),
        env: env("ready", { SUPER_SECRET_TOKEN: "s3cr3t-value" }),
        timeoutMs: 2_000,
        run: async () => "unreachable",
      });
    } catch (err) {
      expect(String(err)).not.toContain("s3cr3t-value");
      expect(String(err)).not.toContain("SUPER_SECRET_TOKEN");
    }
  });

  it("reports an early exit with the child's own stderr", async () => {
    let pid: number | undefined;
    await expect(
      runBoundedProbe({
        executable: process.execPath,
        args: [CHILD],
        env: env("exit", { SUPER_SECRET_TOKEN: "s3cr3t-value" }),
        timeoutMs: 5_000,
        label: "outlier",
        run: async (handle) => {
          pid = handle.pid;
          // A real collector waits on protocol I/O; racing `exited` is how a
          // dead child becomes a diagnosable error instead of a hang.
          await Promise.race([new Promise(() => {}), handle.exited]);
          return "unreachable";
        },
      })
    ).rejects.toThrow(/refused to start/);
    await settle();
    expect(gone(pid)).toBe(true);
  });

  it("propagates a protocol/parse error and still tears everything down", async () => {
    let pid: number | undefined;
    let closed = false;
    await expect(
      runBoundedProbe({
        executable: process.execPath,
        args: [CHILD],
        env: env("garbage"),
        timeoutMs: 5_000,
        label: "outlier",
        run: async (handle) => {
          pid = handle.pid;
          handle.onClose(() => { closed = true; });
          throw new Error("malformed provider output");
        },
      })
    ).rejects.toThrow(/malformed provider output/);
    expect(closed).toBe(true);
    await settle();
    expect(gone(pid)).toBe(true);
  });

  it("times out, closes the session, and reaps the child", async () => {
    let pid: number | undefined;
    let closed = false;
    const started = Date.now();
    await expect(
      runBoundedProbe({
        executable: process.execPath,
        args: [CHILD],
        env: env("silent"),
        timeoutMs: 200,
        label: "outlier",
        run: async (handle) => {
          pid = handle.pid;
          handle.onClose(() => { closed = true; });
          return new Promise<string>(() => {});
        },
      })
    ).rejects.toThrow(ProbeTimeoutError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(closed).toBe(true);
    await settle();
    expect(gone(pid)).toBe(true);
  });

  it("cancels on an abort signal, before and during the run", async () => {
    const pre = new AbortController();
    pre.abort();
    await expect(
      runBoundedProbe({
        executable: process.execPath,
        args: [CHILD],
        env: env("ready"),
        signal: pre.signal,
        run: async () => "unreachable",
      })
    ).rejects.toThrow(ProbeCancelledError);

    const mid = new AbortController();
    let pid: number | undefined;
    let closed = false;
    const running = runBoundedProbe({
      executable: process.execPath,
      args: [CHILD],
      env: env("silent"),
      timeoutMs: 10_000,
      signal: mid.signal,
      run: async (handle) => {
        pid = handle.pid;
        handle.onClose(() => { closed = true; });
        return new Promise<string>(() => {});
      },
    });
    await settle();
    mid.abort();
    await expect(running).rejects.toThrow(ProbeCancelledError);
    expect(closed).toBe(true);
    await settle();
    expect(gone(pid)).toBe(true);
  });

  it("bounds captured stderr instead of buffering without limit", async () => {
    const noisy = path.join(dir, "noisy.mjs");
    fs.writeFileSync(
      noisy,
      `process.stderr.write("x".repeat(200000));\nsetInterval(() => {}, 1 << 30);\n`
    );
    let tail = "";
    await runBoundedProbe({
      executable: process.execPath,
      args: [noisy],
      timeoutMs: 10_000,
      run: async (handle) => {
        // Poll rather than sleep a fixed interval: under a loaded full-suite
        // run the child may not have flushed 200KB in any fixed window.
        const until = Date.now() + 8_000;
        while (Date.now() < until) {
          tail = handle.stderrTail();
          if (tail.length >= PROBE_STDERR_CAPTURE_BYTES) break;
          await settle();
        }
        return null;
      },
    });
    // 200KB written, at most the capture window retained.
    expect(tail.length).toBe(PROBE_STDERR_CAPTURE_BYTES);
  });

  it("does not let a wedged close step keep the process alive", async () => {
    let pid: number | undefined;
    await runBoundedProbe({
      executable: process.execPath,
      args: [CHILD],
      env: env("ready"),
      timeoutMs: 5_000,
      killGraceMs: 100,
      run: async (handle) => {
        pid = handle.pid;
        // A close that never settles, and one that throws. Neither may block
        // teardown; a collector that hangs here would leak a process per refresh.
        handle.onClose(() => new Promise<void>(() => {}));
        handle.onClose(() => { throw new Error("close failed"); });
        return null;
      },
    });
    expect(gone(pid)).toBe(true);
  });

  it("clears its timeout, so a fast probe cannot hold the event loop", async () => {
    // A leaked timer would keep this process alive well past the assertion;
    // an unref'd + cleared timer lets the run finish immediately.
    const started = Date.now();
    await runBoundedProbe({
      executable: process.execPath,
      args: [CHILD],
      env: env("ready"),
      timeoutMs: 30_000,
      run: async () => "fast",
    });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("never prompts: the caller alone drives the child's stdin", async () => {
    // The helper writes nothing to the child on its own — a catalog probe must
    // not spend model tokens. Proven by the child never receiving input.
    const echo = path.join(dir, "echo-stdin.mjs");
    const seen = path.join(dir, "stdin.log");
    fs.writeFileSync(
      echo,
      `import {appendFileSync} from "node:fs";\n` +
      `process.stdin.on("data", (d) => appendFileSync(${JSON.stringify(seen)}, String(d)));\n` +
      `setInterval(() => {}, 1 << 30);\n`
    );
    await runBoundedProbe({
      executable: process.execPath,
      args: [echo],
      timeoutMs: 5_000,
      run: async () => { await settle(); return null; },
    });
    expect(fs.existsSync(seen)).toBe(false);
  });
});

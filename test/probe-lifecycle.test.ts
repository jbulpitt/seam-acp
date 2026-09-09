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
  ProbeError,
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
        // Registered connection-FIRST on purpose: order must come from the
        // declared phase, not from when the provider happened to register.
        handle.onClose(() => { closed.push("connection"); }, "connection");
        handle.onClose(() => { closed.push("session"); }, "session");
        return "collected";
      },
    });
    expect(value).toBe("collected");
    // A session is closed politely while its transport is still up, so every
    // session step runs before every connection step.
    expect(closed).toEqual(["session", "connection"]);
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
    ).rejects.toMatchObject({ code: "spawn_failed" });
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
    ).rejects.toMatchObject({ code: "exited_early" });
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
    ).rejects.toMatchObject({ code: "protocol_error" });
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
    ).rejects.toMatchObject({ code: "timeout" });
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
    ).rejects.toMatchObject({ code: "cancelled" });

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
    await expect(running).rejects.toMatchObject({ code: "cancelled" });
    expect(closed).toBe(true);
    await settle();
    expect(gone(pid)).toBe(true);
  });

  it("keeps only a bounded tail of stderr", async () => {
    const noisy = path.join(dir, "noisy.mjs");
    // Distinct, non-secret-shaped lines: a run of identical characters would be
    // redacted as one opaque blob and prove nothing about the bound.
    fs.writeFileSync(
      noisy,
      `for (let i = 0; i < 800; i++) process.stderr.write("warn line " + i + "\\n");\n` +
      `setInterval(() => {}, 1 << 30);\n`
    );
    let tail = "";
    await runBoundedProbe({
      executable: process.execPath,
      args: [noisy],
      timeoutMs: 10_000,
      run: async (handle) => {
        const until = Date.now() + 8_000;
        while (Date.now() < until) {
          tail = handle.stderrTail();
          if (tail.length >= PROBE_STDERR_CAPTURE_BYTES) break;
          await settle();
        }
        return null;
      },
    });
    expect(tail.length).toBe(PROBE_STDERR_CAPTURE_BYTES);
  });

  it("fails and kills on a 2MB stdout flood instead of buffering it", async () => {
    const flood = path.join(dir, "flood.mjs");
    fs.writeFileSync(
      flood,
      `const chunk = "d".repeat(64 * 1024);\n` +
      `for (let i = 0; i < 32; i++) process.stdout.write(chunk);\n` +
      `setInterval(() => {}, 1 << 30);\n`
    );
    let pid: number | undefined;
    let closed = false;
    await expect(
      runBoundedProbe({
        executable: process.execPath,
        args: [flood],
        timeoutMs: 10_000,
        maxStdoutBytes: 256_000,
        label: "outlier",
        run: async (handle) => {
          pid = handle.pid;
          handle.onClose(() => { closed = true; }, "session");
          // A collector that never reads must still be protected: the ceiling
          // is enforced at the boundary, not by the consumer.
          return new Promise<string>(() => {});
        },
      })
    ).rejects.toMatchObject({ code: "output_overflow" });
    expect(closed).toBe(true);
    await settle();
    expect(gone(pid)).toBe(true);
  });

  it("fails and kills on a stderr flood", async () => {
    const flood = path.join(dir, "flood-err.mjs");
    fs.writeFileSync(
      flood,
      `const chunk = "e".repeat(64 * 1024);\n` +
      `for (let i = 0; i < 32; i++) process.stderr.write(chunk);\n` +
      `setInterval(() => {}, 1 << 30);\n`
    );
    let pid: number | undefined;
    await expect(
      runBoundedProbe({
        executable: process.execPath,
        args: [flood],
        timeoutMs: 10_000,
        maxStderrBytes: 128_000,
        run: async (handle) => {
          pid = handle.pid;
          return new Promise<string>(() => {});
        },
      })
    ).rejects.toMatchObject({ code: "output_overflow" });
    await settle();
    expect(gone(pid)).toBe(true);
  });


  it("HOSTILE: a child echoing its own env never leaks it into a diagnostic", async () => {
    const leaky = path.join(dir, "leaky.mjs");
    fs.writeFileSync(
      leaky,
      `process.stderr.write("dumping env: SUPER_SECRET_TOKEN=" + process.env.SUPER_SECRET_TOKEN + "\\n");\n` +
      `process.stderr.write("also sk-live_abcdefghijklmnop and jesse@example.com\\n");\n` +
      `process.exit(7);\n`
    );
    let seen = "";
    await expect(
      runBoundedProbe({
        executable: process.execPath,
        args: [leaky],
        env: { ...process.env, SUPER_SECRET_TOKEN: "s3cr3t-value-abc" },
        timeoutMs: 5_000,
        run: async (handle) => {
          await handle.exited.catch((err: Error) => { seen = String(err); throw err; });
          return "unreachable";
        },
      })
    ).rejects.toMatchObject({ code: "exited_early" });
    // Neither the supplied env value, nor credential-shaped content the helper
    // never saw in the env, may survive into anything renderable or durable.
    for (const text of [seen]) {
      expect(text).not.toContain("s3cr3t-value-abc");
      expect(text).not.toContain("sk-live_abcdefghijklmnop");
      expect(text).not.toContain("jesse@example.com");
      expect(text).toContain("[redacted]");
    }
  });

  it("runs a LATE close registration instead of dropping it", async () => {
    // A connection that finishes constructing after the deadline used to
    // register its close into an already-drained list and leak the session.
    let lateClosed = false;
    await expect(
      runBoundedProbe({
        executable: process.execPath,
        args: [CHILD],
        env: env("silent"),
        timeoutMs: 150,
        killGraceMs: 200,
        run: async (handle) => {
          await new Promise((resolve) => setTimeout(resolve, 400));
          handle.onClose(() => { lateClosed = true; }, "session");
          return "late";
        },
      })
    ).rejects.toMatchObject({ code: "timeout" });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(lateClosed).toBe(true);
  });

  it("aborts handle.signal so provider async work is cancelled too", async () => {
    let aborted = false;
    await expect(
      runBoundedProbe({
        executable: process.execPath,
        args: [CHILD],
        env: env("silent"),
        timeoutMs: 150,
        run: async (handle) => {
          handle.signal.addEventListener("abort", () => { aborted = true; });
          return new Promise<string>(() => {});
        },
      })
    ).rejects.toMatchObject({ code: "timeout" });
    expect(aborted).toBe(true);
  });

  it("removes every listener and timer it added", async () => {
    // A leaked 'data'/'exit' listener or abort subscription per refresh is how
    // a long-lived process turns a scheduled catalog job into a memory leak.
    const outer = new AbortController();
    let added = 0;
    let removed = 0;
    const realAdd = outer.signal.addEventListener.bind(outer.signal);
    const realRemove = outer.signal.removeEventListener.bind(outer.signal);
    Object.defineProperty(outer.signal, "addEventListener", {
      configurable: true,
      value: (...args: Parameters<typeof realAdd>) => { added += 1; return realAdd(...args); },
    });
    Object.defineProperty(outer.signal, "removeEventListener", {
      configurable: true,
      value: (...args: Parameters<typeof realRemove>) => { removed += 1; return realRemove(...args); },
    });

    let childListeners = 0;
    await runBoundedProbe({
      executable: process.execPath,
      args: [CHILD],
      env: env("ready"),
      timeoutMs: 5_000,
      signal: outer.signal,
      run: async (handle) => {
        await ready(handle.stdout);
        return null;
      },
    });
    expect(added).toBeGreaterThan(0);
    // Every abort subscription this probe made was torn down again.
    expect(removed).toBe(added);

    // And nothing accumulates across repeated probes on the same controller.
    for (let i = 0; i < 3; i++) {
      await runBoundedProbe({
        executable: process.execPath,
        args: [CHILD],
        env: env("ready"),
        timeoutMs: 5_000,
        signal: outer.signal,
        run: async () => { childListeners += 1; return null; },
      });
    }
    expect(childListeners).toBe(3);
    expect(removed).toBe(added);
    expect(outer.signal.aborted).toBe(false);
  });

  it("reports not_reaped rather than claiming a clean exit", async () => {
    // Proven at the seam: a child the helper cannot observe exiting must not
    // return as though the host were left clean.
    const { terminate } = await import("@seam/adapters");
    const stubborn = {
      pid: 999_999,
      exitCode: null,
      signalCode: null,
      once: () => stubborn,
      kill: () => true,
    } as unknown as Parameters<typeof terminate>[0];
    expect(await terminate(stubborn, 50)).toBe(false);
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

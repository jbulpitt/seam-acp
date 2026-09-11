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
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ProbeError,
  type ProbeHandle,
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


/** A controllable stand-in for a spawned child, for paths a real OS process
 *  cannot exhibit (an un-reapable child; exact listener accounting). */
interface FakeChild {
  child: ChildProcessWithoutNullStreams;
  exit: (code: number) => void;
}
function fakeChild(opts: { diesOnKill?: boolean } = {}): FakeChild {
  const emitter = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
  const mutable = emitter as unknown as Record<string, unknown>;
  mutable.pid = 4242;
  mutable.exitCode = null;
  mutable.signalCode = null;
  mutable.stdin = new PassThrough();
  mutable.stdout = new PassThrough();
  mutable.stderr = new PassThrough();
  // `diesOnKill` models a normal process: a signal ends it. Left off, the child
  // is un-reapable, which is how the not_reaped path is exercised.
  mutable.kill = () => {
    if (opts.diesOnKill) {
      queueMicrotask(() => {
        if (mutable.exitCode === null) {
          mutable.exitCode = 0;
          emitter.emit("exit", 0, "SIGTERM");
        }
      });
    }
    return true;
  };
  queueMicrotask(() => emitter.emit("spawn"));
  return {
    child: emitter,
    exit: (code: number) => {
      mutable.exitCode = code;
      emitter.emit("exit", code, null);
    },
  };
}


/** A sleep that stops when its close window elapses — the cooperative shape
 *  every close callback is expected to have. */
function cooperativeSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

describe("#236 bounded probe lifecycle", () => {
  it("reaps a partial startup with missing stdout before refusing it", async () => {
    const { child } = fakeChild({ diesOnKill: true });
    Object.assign(child, { stdout: null });
    await expect(runBoundedProbe({
      executable: "fixture", spawnOverride: () => child,
      run: async () => { throw new Error("must not enter protocol"); },
    })).rejects.toMatchObject({ code: "spawn_failed" });
    expect(child.exitCode).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
  });

  it("still escalates and observes exit after synchronous TERM failure", async () => {
    const { child, exit } = fakeChild();
    const signals: unknown[] = [];
    child.kill = (signal) => {
      signals.push(signal);
      if (signal === "SIGTERM") throw new Error("synthetic signal failure");
      queueMicrotask(() => exit(0));
      return true;
    };
    await expect(runBoundedProbe({
      executable: "fixture", spawnOverride: () => child, killGraceMs: 10,
      run: async () => "value",
    })).resolves.toBe("value");
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.exitCode).toBe(0);
  });

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
        finalizeDeadlineMs: 150,
        label: "outlier",
        run: async (handle) => {
          pid = handle.pid;
          handle.onClose(() => { closed = true; });
          // A real collector observes cancellation; ignoring it is its own
          // reported failure (not_settled), covered separately.
          return new Promise<string>((_resolve, reject) =>
            handle.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
          );
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
      finalizeDeadlineMs: 150,
      signal: mid.signal,
      run: async (handle) => {
        pid = handle.pid;
        handle.onClose(() => { closed = true; });
        return new Promise<string>((_resolve, reject) =>
          handle.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
        );
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
        finalizeDeadlineMs: 150,
        maxStdoutBytes: 256_000,
        label: "outlier",
        run: async (handle) => {
          pid = handle.pid;
          handle.onClose(() => { closed = true; }, "session");
          // A collector that never reads must still be protected: the ceiling
          // is enforced at the boundary, not by the consumer.
          return new Promise<string>((_resolve, reject) =>
            handle.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
          );
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
        finalizeDeadlineMs: 150,
        maxStderrBytes: 128_000,
        run: async (handle) => {
          pid = handle.pid;
          return new Promise<string>((_resolve, reject) =>
            handle.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
          );
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
        finalizeDeadlineMs: 150,
        run: async (handle) => {
          return new Promise<string>((_resolve, reject) =>
            handle.signal.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")); }, { once: true })
          );
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

  it("a LATE close is drained BEFORE runBoundedProbe settles, not after", async () => {
    // The previous head detached the late step with `void`, so the helper
    // resolved with registered:false/closed:false and only became true ~550ms
    // later. Return must MEAN cleanup happened.
    let registered = false;
    let closed = false;
    const outcome = await runBoundedProbe({
      executable: process.execPath,
      args: [CHILD],
      env: env("silent"),
      timeoutMs: 75,
      killGraceMs: 200,
      finalizeDeadlineMs: 2_000,
      run: async (handle) => {
        // Finishes construction well after the deadline, exactly as a slow ACP
        // connection would, then registers the session close it owns.
        await new Promise((resolve) => setTimeout(resolve, 400));
        registered = true;
        handle.onClose(async (signal) => {
          await cooperativeSleep(50, signal);
          closed = true;
        }, "session");
        return "late";
      },
    }).then(() => "resolved", (err: ProbeError) => err.code);
    expect(outcome).toBe("timeout");
    // Observed synchronously after settle — no extra waiting allowed.
    expect(registered).toBe(true);
    expect(closed).toBe(true);
  });

  it("a cooperative run that honours handle.signal finalizes promptly", async () => {
    let closed = false;
    const started = Date.now();
    await expect(
      runBoundedProbe({
        executable: process.execPath,
        args: [CHILD],
        env: env("silent"),
        timeoutMs: 75,
        finalizeDeadlineMs: 5_000,
        run: async (handle) => {
          await new Promise<void>((resolve) =>
            handle.signal.addEventListener("abort", () => resolve(), { once: true })
          );
          handle.onClose(() => { closed = true; }, "session");
          return "aborted-cleanly";
        },
      })
    ).rejects.toMatchObject({ code: "timeout" });
    expect(closed).toBe(true);
    // The bounded grace is a ceiling, not a floor: honouring the signal returns
    // immediately rather than burning the full finalization deadline.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("an error WITHOUT an exit is not_reaped, not a clean return", async () => {
    // SIGKILL cannot be caught by a real process, so the un-reapable path is
    // only reachable through the documented spawn seam.
    const fake = fakeChild();
    await expect(
      runBoundedProbe({
        executable: "irrelevant",
        spawnOverride: () => fake.child,
        timeoutMs: 5_000,
        killGraceMs: 50,
        run: async () => {
          // Emit `error` only — never `exit`. The previous terminate() treated
          // that as reaped and returned true while the child was still alive.
          setTimeout(() => fake.child.emit("error", new Error("boom")), 10);
          return "done";
        },
      })
    ).rejects.toMatchObject({ code: "not_reaped" });
    expect(fake.child.listenerCount("exit")).toBe(0);
    expect(fake.child.listenerCount("error")).toBe(0);
  });

  it("leaves EXACT zero listeners on the child on every path", async () => {
    const counts = (c: FakeChild): Record<string, number> => ({
      exit: c.child.listenerCount("exit"),
      error: c.child.listenerCount("error"),
      spawn: c.child.listenerCount("spawn"),
      stdoutData: c.child.stdout.listenerCount("data"),
      stdoutEnd: c.child.stdout.listenerCount("end"),
      stderrData: c.child.stderr.listenerCount("data"),
    });
    const zero = { exit: 0, error: 0, spawn: 0, stdoutData: 0, stdoutEnd: 0, stderrData: 0 };

    // success
    const ok = fakeChild();
    await runBoundedProbe({
      executable: "x", spawnOverride: () => ok.child, timeoutMs: 2_000, killGraceMs: 50,
      run: async () => { ok.exit(0); return "ok"; },
    });
    expect(counts(ok)).toEqual(zero);

    // early exit
    const early = fakeChild();
    await expect(runBoundedProbe({
      executable: "x", spawnOverride: () => early.child, timeoutMs: 2_000, killGraceMs: 50,
      run: async (handle) => { setTimeout(() => early.exit(3), 10); return handle.exited; },
    })).rejects.toMatchObject({ code: "exited_early" });
    expect(counts(early)).toEqual(zero);

    // timeout
    const slow = fakeChild();
    await expect(runBoundedProbe({
      executable: "x", spawnOverride: () => slow.child, timeoutMs: 60, killGraceMs: 50,
      finalizeDeadlineMs: 100,
      run: async (handle) => {
        setTimeout(() => slow.exit(0), 80);
        return new Promise<string>((_resolve, reject) =>
          handle.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
        );
      },
    })).rejects.toMatchObject({ code: "timeout" });
    expect(counts(slow)).toEqual(zero);

    // protocol error
    const bad = fakeChild();
    await expect(runBoundedProbe({
      executable: "x", spawnOverride: () => bad.child, timeoutMs: 2_000, killGraceMs: 50,
      run: async () => { bad.exit(0); throw new Error("bad frame"); },
    })).rejects.toMatchObject({ code: "protocol_error" });
    expect(counts(bad)).toEqual(zero);

    // output overflow
    const loud = fakeChild();
    await expect(runBoundedProbe({
      executable: "x", spawnOverride: () => loud.child, timeoutMs: 2_000, killGraceMs: 50,
      maxStdoutBytes: 16, finalizeDeadlineMs: 100,
      run: async (handle) => {
        setTimeout(() => { loud.child.stdout.emit("data", Buffer.alloc(64)); loud.exit(0); }, 10);
        return new Promise<string>((_resolve, reject) =>
          handle.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
        );
      },
    })).rejects.toMatchObject({ code: "output_overflow" });
    expect(counts(loud)).toEqual(zero);
  });


  it("registration LATER than any fixed grace still runs, proven at return", async () => {
    // The exact independently reproduced case: timeout 20ms, old close grace
    // 20ms, registration at 120ms. Under the old fixed-grace barrier the helper
    // returned after ~42ms with registered:false/closed:false. Settlement of the
    // run — not a fixed window — is now the authority.
    let registered = false;
    let closed = false;
    const outcome = await runBoundedProbe({
      executable: process.execPath,
      args: [CHILD],
      env: env("silent"),
      timeoutMs: 20,
      killGraceMs: 200,
      finalizeDeadlineMs: 5_000,
      run: async (handle) => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        registered = true;
        handle.onClose(async (signal) => {
          await cooperativeSleep(30, signal);
          closed = true;
        }, "session");
        return "late";
      },
    }).then(() => "resolved", (err: ProbeError) => err.code);
    expect(outcome).toBe("timeout");
    // Observed SYNCHRONOUSLY at return — no trailing wait permitted.
    expect(registered).toBe(true);
    expect(closed).toBe(true);
  });

  it("a never-settling run is bounded, reaped, and reported not_settled", async () => {
    // Reaps normally, so the ONLY fault is the run refusing to settle — a
    // leaked process would otherwise (correctly) outrank it.
    const stuck = fakeChild({ diesOnKill: true });
    let closed = false;
    const started = Date.now();
    const outcome = await runBoundedProbe({
      executable: "x",
      spawnOverride: () => stuck.child,
      // A short deadline triggers cancellation; the SEPARATE finalization
      // deadline then bounds how long the uncooperative run may stall teardown.
      timeoutMs: 60,
      killGraceMs: 30,
      finalizeDeadlineMs: 120,
      run: async (handle) => {
        handle.onClose(() => { closed = true; }, "session");
        // Deliberately ignores handle.signal and never settles.
        return new Promise<string>(() => {});
      },
    }).then(() => "resolved", (err: ProbeError) => err.code);
    // The run itself never failed, so the helper must name the real problem.
    expect(outcome).toBe("not_settled");
    expect(closed).toBe(true);
    expect(Date.now() - started).toBeLessThan(4_000);
    // Terminated and reaped BEFORE the failure was returned.
    expect(stuck.child.listenerCount("exit")).toBe(0);
    expect(stuck.child.listenerCount("error")).toBe(0);
  });

  it("a POST-spawn error without an exit is not_reaped, never spawn_failed", async () => {
    // A pid already exists, so the process is real and may still be running.
    // Classifying it spawn_failed both misdescribed it and skipped reaping.
    const unreapable = fakeChild();
    const outcome = await runBoundedProbe({
      executable: "irrelevant",
      spawnOverride: () => unreapable.child,
      timeoutMs: 5_000,
      killGraceMs: 40,
      finalizeDeadlineMs: 500,
      run: async (handle) => {
        // Emitted while the lifecycle is live; never followed by `exit`.
        setTimeout(() => unreapable.child.emit("error", new Error("post-spawn boom")), 10);
        return handle.exited;
      },
    }).then(() => "resolved", (err: ProbeError) => err.code);
    expect(outcome).toBe("not_reaped");
    expect(unreapable.child.listenerCount("exit")).toBe(0);
    expect(unreapable.child.listenerCount("error")).toBe(0);
  });

  it("a PRE-spawn error is still spawn_failed", async () => {
    await expect(
      runBoundedProbe({
        executable: path.join(dir, "definitely-not-here"),
        timeoutMs: 2_000,
        finalizeDeadlineMs: 500,
        run: async () => "unreachable",
      })
    ).rejects.toMatchObject({ code: "spawn_failed" });
  });

  it("an error emitted DURING teardown never escapes as an uncaught exception", async () => {
    // The protective listener is removed last, so a stray error while the child
    // is being terminated cannot surface as an unhandled error in the run.
    const noisy = fakeChild();
    await runBoundedProbe({
      executable: "x",
      spawnOverride: () => noisy.child,
      timeoutMs: 2_000,
      killGraceMs: 50,
      finalizeDeadlineMs: 500,
      run: async (handle) => {
        handle.onClose(() => {
          noisy.child.emit("error", new Error("teardown boom"));
          noisy.exit(0);
        }, "session");
        return "ok";
      },
    });
    expect(noisy.child.listenerCount("error")).toBe(0);
  });

  it("drops — never detaches — a registration after the phase closed", async () => {
    // Nothing may run after the helper has told its caller cleanup is done.
    const child = fakeChild();
    let escaped = false;
    let capture: ProbeHandle | undefined;
    await runBoundedProbe({
      executable: "x",
      spawnOverride: () => child.child,
      timeoutMs: 2_000,
      killGraceMs: 50,
      finalizeDeadlineMs: 500,
      run: async (handle) => { capture = handle; child.exit(0); return "ok"; },
    });
    capture!.onClose(() => { escaped = true; }, "session");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(escaped).toBe(false);
  });


  it("a LATE registration still obeys session-before-connection ordering", async () => {
    // Reproduction: register connection THEN session, both after the abort. The
    // old code ran each on arrival, producing
    // ["connection-start", "session", "connection-end"].
    const order: string[] = [];
    await expect(
      runBoundedProbe({
        executable: process.execPath,
        args: [CHILD],
        env: env("silent"),
        timeoutMs: 20,
        killGraceMs: 300,
        finalizeDeadlineMs: 3_000,
        run: async (handle) => {
          await new Promise<void>((resolve) =>
            handle.signal.addEventListener("abort", () => resolve(), { once: true })
          );
          await new Promise((resolve) => setTimeout(resolve, 20));
          handle.onClose(async (signal) => {
            order.push("connection-start");
            await cooperativeSleep(30, signal);
            order.push("connection-end");
          }, "connection");
          handle.onClose(() => { order.push("session"); }, "session");
          throw new Error("cancelled");
        },
      })
    ).rejects.toMatchObject({ code: "timeout" });
    expect(order).toEqual(["session", "connection-start", "connection-end"]);
  });

  it("a cooperative close observes its signal and finishes before return", async () => {
    // The helper hands each close step a signal and awaits it. A cooperative
    // step stops when the window elapses, so return means it is done.
    let sawSignal = false;
    let finished = false;
    const child = fakeChild({ diesOnKill: true });
    await runBoundedProbe({
      executable: "x",
      spawnOverride: () => child.child,
      timeoutMs: 2_000,
      killGraceMs: 40,
      finalizeDeadlineMs: 500,
      run: async (handle) => {
        handle.onClose(async (signal) => {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 5_000);
            signal.addEventListener("abort", () => {
              sawSignal = true;
              clearTimeout(timer);
              resolve();
            }, { once: true });
          });
          finished = true;
        }, "session");
        return "ok";
      },
    });
    // Asserted synchronously at return: the cooperative step completed.
    expect(sawSignal).toBe(true);
    expect(finished).toBe(true);
  });

  it("seals registration: a post-return registration is refused, not run", async () => {
    const child = fakeChild({ diesOnKill: true });
    let escaped = false;
    let capture: ProbeHandle | undefined;
    await runBoundedProbe({
      executable: "x",
      spawnOverride: () => child.child,
      timeoutMs: 2_000,
      killGraceMs: 40,
      finalizeDeadlineMs: 500,
      run: async (handle) => { capture = handle; return "ok"; },
    });
    capture!.onClose(() => { escaped = true; }, "session");
    capture!.onClose(() => { escaped = true; }, "connection");
    await new Promise((resolve) => setTimeout(resolve, 150));
    // Refused outright — not executed, not detached, no post-return side effect.
    expect(escaped).toBe(false);
  });

  it("every close registration in this repository is cooperative", async () => {
    // The helper cannot preempt a callback that ignores its signal, so the
    // guarantee is only as good as the callbacks. Every in-repo registration
    // must therefore either be synchronous (nothing to cancel) or observe the
    // signal it is handed.
    const roots = ["packages", "test"];
    const files: string[] = [];
    const walk = (base: string): void => {
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        const full = path.join(base, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "dist") continue;
          walk(full);
        } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
          files.push(full);
        }
      }
    };
    for (const root of roots) walk(path.join(process.cwd(), root));

    const offenders: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      if (!text.includes("onClose(")) continue;
      for (const match of text.matchAll(/onClose\(\s*(async\s*)?\(([^)]*)\)\s*=>/g)) {
        const isAsync = Boolean(match[1]);
        const takesSignal = (match[2] ?? "").trim().length > 0;
        // An async close that never looks at its signal cannot be stopped.
        if (isAsync && !takesSignal) {
          const body = text.slice(match.index ?? 0, (match.index ?? 0) + 400);
          // Deliberately-adversarial fixtures are exempt and say so.
          if (!body.includes("wedged") && !body.includes("never settles")) {
            offenders.push(`${path.relative(process.cwd(), file)}: ${match[0]}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
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
        // A deliberately WEDGED close that never settles, and one that throws.
        // Neither may block teardown. This is the adversarial case the contract
        // explicitly excludes from the cooperation guarantee.
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

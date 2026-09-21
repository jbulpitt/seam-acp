/**
 * #456 — bridge-spawned agents had piped stderr that nobody drained.
 *
 * `spawnAgent` hands back a child spawned `["pipe","pipe","pipe"]` and the
 * slot manager attached a handler only to `stdout`. A Node readable with no
 * consumer stays paused, so the 64 KiB kernel pipe buffer fills and the child
 * blocks on its next write to fd 2 — a live process that has stopped
 * producing output, which is indistinguishable from a hung agent at the
 * seam-acp layer.
 *
 * The first test does not assert about a ring or a frame. It spawns a real
 * child and demonstrates the stall, because that is the claim the whole story
 * rests on and it is cheap to prove rather than assume.
 */
import { describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  createStderrRing,
  attachStderrDrain,
  exitFramePayload,
} from "../packages/bridge/src/stderr-ring.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const exited = (child: ChildProcess) =>
  new Promise<number | null>((resolve) => child.once("exit", resolve));

/**
 * Writes well past the 64 KiB pipe buffer and then exits naturally.
 *
 * Not `process.exit()`: that discards Node's buffered async write and the
 * child dies at once, having delivered nothing. Measured against four writer
 * shapes, the three that run to completion normally — Node async, Node
 * `writeSync`, and a native `sh`/`dd` — all park until someone reads.
 */
const NOISY = 'process.stderr.write("x".repeat(400000));';

describe("#456 the stall is real, not theoretical", () => {
  it("blocks a child whose stderr is piped and never read", async () => {
    // Exactly how the bridge spawned agents: fd 2 piped, no consumer.
    const child = spawn(process.execPath, ["-e", NOISY], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let done = false;
    void exited(child).then(() => { done = true; });

    await sleep(1_500);
    // It cannot finish: the pipe is full and nobody is reading. This is the
    // hung-agent signature #443 would otherwise have to detect — a live
    // process that has simply stopped.
    expect(done).toBe(false);
    expect(child.exitCode).toBeNull();

    child.kill("SIGKILL");
  }, 20_000);

  it("releases that same child as soon as the drain is attached", async () => {
    const child = spawn(process.execPath, ["-e", NOISY], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    await sleep(1_000);
    expect(child.exitCode).toBeNull(); // stalled, as above

    // The fix, applied to an already-stalled child.
    const ring = createStderrRing();
    expect(attachStderrDrain(child, ring)).toBe(true);

    expect(await exited(child)).toBe(0);
    // And the bytes were not merely discarded to unblock it.
    expect(ring.stats().droppedBytes).toBeGreaterThan(0);
    expect(ring.tail()).toContain("x");
  }, 20_000);

  it("is a no-op on the copilot legacy path, which inherits fd 2", () => {
    // That path spawns ["pipe","pipe","inherit"], so `stderr` is null and it
    // can never fill. It must keep behaving exactly as it does today.
    expect(attachStderrDrain({ stderr: null }, createStderrRing())).toBe(false);
  });
});

describe("#456 the ring is bounded by bytes, not just lines", () => {
  it("keeps the most recent lines within the line cap", () => {
    const ring = createStderrRing({ maxLines: 3 });
    for (let i = 1; i <= 6; i += 1) ring.push(`line-${i}\n`);
    expect(ring.tail()).toContain("line-6");
    expect(ring.tail()).not.toContain("line-1");
    expect(ring.stats().lines).toBe(3);
  });

  it("bounds a single enormous line, which a line cap alone would not", () => {
    // One 10 MB line is one line. This is the case the story calls out, and
    // the local path's 100-entry ring does not cover it.
    const ring = createStderrRing({ maxBytes: 1_024, maxLines: 100 });
    ring.push("y".repeat(10 * 1024 * 1024) + "\n");
    expect(ring.stats().bytes).toBeLessThanOrEqual(1_024);
    expect(ring.stats().droppedBytes).toBeGreaterThan(10 * 1024 * 1024 - 1_024);
  });

  it("bounds an unterminated line too, so a newline-free stream cannot grow", () => {
    const ring = createStderrRing({ maxBytes: 512 });
    for (let i = 0; i < 50; i += 1) ring.push("z".repeat(1_000));
    expect(ring.stats().bytes).toBeLessThanOrEqual(512);
  });

  it("keeps the END of an oversized line, where the cause usually is", () => {
    const ring = createStderrRing({ maxBytes: 32 });
    ring.push("start-of-a-very-long-error-".repeat(10) + "THE-ACTUAL-CAUSE\n");
    expect(ring.tail()).toContain("THE-ACTUAL-CAUSE");
  });
});

describe("#456 truncation is stated, never implied", () => {
  it("says how much it dropped, so a partial trace is not read as a whole one", () => {
    const ring = createStderrRing({ maxLines: 2 });
    for (let i = 1; i <= 5; i += 1) ring.push(`line-${i}\n`);
    expect(ring.tail()).toMatch(/^\[stderr truncated: \d+ earlier bytes dropped\]\n/);
  });

  it("adds no marker when nothing was dropped", () => {
    const ring = createStderrRing();
    ring.push("only line\n");
    expect(ring.tail()).toBe("only line");
  });

  it("retains a line the agent never finished, since it still wrote those bytes", () => {
    const ring = createStderrRing();
    ring.push("complete\npartial-at-death");
    expect(ring.tail()).toBe("complete\npartial-at-death");
  });
});

describe("#456 the exit frame reports cause instead of leaving it inferred", () => {
  const ringWith = (text: string) => {
    const ring = createStderrRing();
    ring.push(text);
    return ring;
  };

  it("carries the tail when the agent died abnormally", () => {
    const payload = exitFramePayload(1, null, ringWith("fatal: auth required\n"));
    expect(payload).toMatchObject({ code: 1, stderrTail: "fatal: auth required" });
  });

  it("treats a signal death as abnormal", () => {
    expect(exitFramePayload(null, "SIGSEGV", ringWith("boom\n"))).toHaveProperty("stderrTail");
  });

  it("stays silent on a clean exit, so a healthy turn carries no payload", () => {
    const payload = exitFramePayload(0, null, ringWith("some startup chatter\n"));
    expect(payload).toEqual({ code: 0 });
  });

  it("matches the local path's definition of abnormal for code=null, signal=null", () => {
    // `agent-runtime.ts`: abnormal = (code !== 0 && code !== null) || signal != null.
    // Two definitions of "died badly" that disagree would have the local and
    // bridge paths report different causes for the same death.
    expect(exitFramePayload(null, null, ringWith("chatter\n"))).toEqual({ code: 1 });
  });

  it("omits the field entirely when there was no stderr, rather than sending empty", () => {
    // Absent means "nothing to report". An empty string would be a claim.
    expect(exitFramePayload(1, null, createStderrRing())).toEqual({ code: 1 });
    expect(exitFramePayload(1, null, undefined)).toEqual({ code: 1 });
  });
});

describe("#456 mixed-version: the wire must not change for anyone who is not asking", () => {
  it("emits exactly today's frame shape on a normal exit", () => {
    // An old seam-acp reads `code` and nothing else. A clean exit is the
    // common case and it must stay byte-identical to what shipped before.
    expect(exitFramePayload(0, null, undefined)).toEqual({ code: 0 });
  });

  it("adds only an extra field on an abnormal exit, never changing code", () => {
    const payload = exitFramePayload(137, "SIGKILL", ringWith2());
    expect(payload.code).toBe(137);
    // Old consumers destructure `code`; an unknown sibling field is ignored.
    expect(Object.keys(payload).sort()).toEqual(["code", "stderrTail"]);
  });

  function ringWith2() {
    const ring = createStderrRing();
    ring.push("killed\n");
    return ring;
  }
});

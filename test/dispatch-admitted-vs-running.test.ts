/**
 * #409 — "dispatch: running" was logged when the watcher SELECTED a dispatch,
 * before it entered the target's SerialQueue. A turn could announce itself as
 * running and then sit queued for minutes without another line.
 *
 * Measured on 2026-09-13: `294ba576` logged `running` at 12:28:00 and did not
 * start until 12:41:32 — thirteen and a half minutes — behind `44e0d03e`, which
 * held that thread's queue from 12:27:10.
 *
 * The framing that matters is that the DATABASE was right the whole time.
 * `turn_attempts` reported `state=pending`, `prompt_started=0`,
 * `acp_session_id=null` for the entire wait, which is accurate. The log was the
 * record that disagreed, and the apparent contradiction sent a diagnosis at the
 * database twice before the saturated queue was found.
 *
 * So the requirement under test is an agreement, not a wording preference:
 * `admitted` is emitted where `attempts.admit()` leaves the row **pending**, and
 * `running` is emitted at the last point before `onDispatch`, which is where
 * `attempts.claim()` flips it to **active**. One vocabulary, two records.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { DispatchWatcher } from "../packages/core/src/core/dispatch/watcher.js";
import { dispatchDirs, type DispatchSpec } from "../packages/core/src/core/dispatch/types.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

interface Line { msg: string; obj: Record<string, unknown> }

/** Captures info lines in order, which is what the journal reader sees. */
function recordingLogger(): { logger: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const push = (obj: unknown, msg?: string) =>
    lines.push({ msg: msg ?? "", obj: (obj ?? {}) as Record<string, unknown> });
  const logger = {
    child: () => logger,
    info: push, warn: push, error: push,
    debug: () => {}, trace: () => {}, fatal: () => {},
  } as unknown as Logger;
  return { logger, lines };
}

let dataDir: string;
let store: SessionStore;
let dirs: ReturnType<typeof dispatchDirs>;
const watchers = new Set<DispatchWatcher>();
/** Releases every turn a test is still holding. `drain()` waits for that
 *  `onDispatch`. An assertion that throws first used to leave the promise
 *  unresolved, and the hook sat until its 10s timeout. */
const releases: Array<() => void> = [];

function hold(): { promise: Promise<void>; release: () => void } {
  let release = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  let opened = false;
  const once = () => {
    if (opened) return;
    opened = true;
    release();
  };
  releases.push(once);
  return { promise, release: once };
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "seam-409-"));
  dirs = dispatchDirs(dataDir);
  store = new SessionStore(path.join(dataDir, "w.db"));
});

afterEach(async () => {
  for (const release of releases) release();
  releases.length = 0;
  for (const w of watchers) w.stop();
  await Promise.all([...watchers].map((w) => w.drain()));
  watchers.clear();
  store.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function dropSpec(spec: Partial<DispatchSpec> & { id: string }): Promise<void> {
  await mkdir(dirs.pending, { recursive: true });
  await writeFile(
    path.join(dirs.pending, `${spec.id}.json`),
    JSON.stringify({
      target: "thread-1", prompt: "do the thing", session: "live",
      createdUtc: new Date().toISOString(), ...spec,
    }),
    "utf8"
  );
}

const only = (lines: Line[], msg: string) => lines.filter((l) => l.msg === msg);

describe("#409 admitted and running are different moments", () => {
  it("does not call a queued turn running while another holds its target", async () => {
    // The reproduction. Two dispatches on ONE target: the first blocks until
    // released, the second can only be queued behind it. The wait is the
    // holder's own promise, not a clock.
    const held = hold();
    let holderEntered: () => void = () => {};
    const holderRunning = new Promise<void>((resolve) => { holderEntered = resolve; });
    const started: string[] = [];

    const { logger, lines } = recordingLogger();
    const watcher = new DispatchWatcher({
      attempts: store.turnAttempts, dataDir, logger,
      onDispatch: async (spec) => {
        started.push(spec.id);
        if (spec.id === "holder") {
          holderEntered();
          await held.promise;
        }
        return { output: spec.id, stopReason: "end_turn" };
      },
    });
    watchers.add(watcher);

    await dropSpec({ id: "holder" });
    await dropSpec({ id: "queued" });
    const run = watcher.start();
    await holderRunning;

    // Both were ADMITTED — selection happened for each. `admitted` is logged
    // before either turn enters the target queue, so it is already true once
    // the holder has reached onDispatch.
    expect(only(lines, "dispatch: admitted").map((l) => l.obj.id).sort())
      .toEqual(["holder", "queued"]);
    // Only the holder is RUNNING. This is the whole bug: before #409 the
    // queued turn had already claimed to be running here.
    expect(only(lines, "dispatch: running").map((l) => l.obj.id)).toEqual(["holder"]);
    expect(started).toEqual(["holder"]);

    // And the database agrees with the log rather than contradicting it.
    expect(store.turnAttempts.get("queued")?.state).toBe("pending");

    held.release();
    watcher.stop();
    await run;
    await watcher.drain();

    // Once the holder releases, the queued turn runs and says so.
    expect(only(lines, "dispatch: running").map((l) => l.obj.id).sort())
      .toEqual(["holder", "queued"]);
    expect(started.sort()).toEqual(["holder", "queued"]);
  });

  it("reports how long the queued turn waited, so the wait is one number", async () => {
    // The issue is about 13.5 minutes being invisible. `queuedMs` makes it
    // readable without diffing two timestamps across a busy journal. The
    // clock is injected: the number is the wait the test applied, not how
    // long the scheduler took to notice.
    const held = hold();
    let holderEntered: () => void = () => {};
    const holderRunning = new Promise<void>((resolve) => { holderEntered = resolve; });
    let now = 1_000_000;
    const heldFor = 13.5 * 60 * 1000;
    const { logger, lines } = recordingLogger();
    const watcher = new DispatchWatcher({
      attempts: store.turnAttempts, dataDir, logger,
      now: () => now,
      onDispatch: async (spec) => {
        if (spec.id === "holder") {
          holderEntered();
          await held.promise;
        }
        return { output: spec.id, stopReason: "end_turn" };
      },
    });
    watchers.add(watcher);

    await dropSpec({ id: "holder" });
    await dropSpec({ id: "queued" });
    const run = watcher.start();
    await holderRunning;
    now += heldFor;
    held.release();
    watcher.stop();
    await run;
    await watcher.drain();

    const queued = only(lines, "dispatch: running").find((l) => l.obj.id === "queued");
    const holder = only(lines, "dispatch: running").find((l) => l.obj.id === "holder");
    expect(queued).toBeDefined();
    expect(holder).toBeDefined();
    // Holder was admitted and started on the same clock reading. The queued
    // turn's wait is exactly the advance applied while the holder blocked it.
    expect(holder!.obj.queuedMs).toBe(0);
    expect(queued!.obj.queuedMs).toBe(heldFor);
    expect(only(lines, "dispatch: admitted").map((l) => l.obj.id)).toEqual(["holder", "queued"]);
    const runningAt = only(lines, "dispatch: running").map((l) => l.obj.id);
    expect(runningAt).toEqual(["holder", "queued"]);
  });

  it("emits running immediately before execution, not merely at some later point", async () => {
    // Ordering, not just presence: the line must precede the provider call for
    // the same id, or a reader still cannot trust it.
    // ONE interleaved timeline of log lines and the provider call. Comparing
    // the log lines only to each other would still pass if `running` were
    // emitted AFTER the turn finished, which is a different lie with the same
    // ordering.
    const timeline: string[] = [];
    const logger = {
      child: () => logger,
      info: (_o: unknown, msg?: string) => {
        if (msg === "dispatch: admitted" || msg === "dispatch: running") timeline.push(msg);
      },
      warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, fatal: () => {},
    } as unknown as Logger;

    const watcher = new DispatchWatcher({
      attempts: store.turnAttempts, dataDir, logger,
      onDispatch: async (spec) => {
        timeline.push(`onDispatch:${spec.id}`);
        return { output: "ok", stopReason: "end_turn" };
      },
    });
    watchers.add(watcher);
    await dropSpec({ id: "solo" });
    await watcher.start();
    watcher.stop();
    await watcher.drain();

    expect(timeline).toEqual([
      "dispatch: admitted",
      "dispatch: running",
      "onDispatch:solo",
    ]);
  });

  it("never claims a turn ran when it was blocked before execution", async () => {
    // A turn selected and then refused inside the queue must show `admitted`
    // and NO `running`. Absence is the signal, so it has to be real absence.
    const { logger, lines } = recordingLogger();
    store.turnAttempts.admit({ id: "blocked", target: "thread-1", prompt: "p", session: "live" });
    store.turnAttempts.completePending("blocked", {
      id: "blocked", target: "thread-1", status: "completed",
      output: "already done", finishedUtc: new Date().toISOString(),
    });
    const watcher = new DispatchWatcher({
      attempts: store.turnAttempts, dataDir, logger,
      onDispatch: async () => { throw new Error("must not execute"); },
    });
    watchers.add(watcher);
    await dropSpec({ id: "blocked" });
    await watcher.start();
    watcher.stop();
    await watcher.drain();

    expect(only(lines, "dispatch: running")).toHaveLength(0);
  });
});

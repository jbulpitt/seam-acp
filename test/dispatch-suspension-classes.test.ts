/**
 * #333 — most "resume failed" events were never failures.
 *
 * `DispatchSuspendedError` was thrown from 65 sites and only 5 carried a
 * reason, so 60 different conditions collapsed into one Discord notice reading
 * "stalled after restart" and one `stalled_reason` constant that described
 * WHERE execution stopped rather than why it refused. Reading the conditions,
 * three unrelated events shared the exception:
 *
 *   shutdown   — this process is going down; the next boot owns the work
 *   superseded — a newer generation/owner/fence owns the work right now
 *   defect     — nobody is going to finish it without an operator
 *
 * Only the third is worth waking somebody for. These tests pin the routing,
 * the reason plumbing, and the property that made the old behaviour
 * irreproducible: the outcome used to depend on racing `stop()`.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pino } from "pino";
import { DispatchWatcher } from "../packages/core/src/core/dispatch/watcher.js";
import {
  DispatchSuspendedError,
  type SuspensionClass,
} from "../packages/core/src/core/dispatch/attempt-store.js";
import { dispatchDirs, type DispatchSpec } from "../packages/core/src/core/dispatch/types.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const silent = pino({ level: "silent" }) as unknown as Logger;
const repo = path.resolve(import.meta.dirname, "..");

/**
 * Run one dispatch that refuses with `suspension`, optionally calling `stop()`
 * while the callback is parked. The park is what makes the race deterministic:
 * the refusal is delivered strictly after `stop()` when `stopDuringRun` is set,
 * and strictly before it when it is not.
 */
async function runRefusal(opts: {
  id: string;
  suspension: SuspensionClass;
  reason: string;
  stopDuringRun: boolean;
}): Promise<{ notices: Array<{ spec: DispatchSpec; err: DispatchSuspendedError }>; running: string[] }> {
  // Its own queue per run: `start()` recovers leftovers from `running/`, so a
  // shared directory would replay the previous case's retained artifact and
  // attribute its notice to this one.
  const runDir = await mkdtemp(path.join(tmpdir(), "seam-suspension-run-"));
  const runDirs = dispatchDirs(runDir);
  const notices: Array<{ spec: DispatchSpec; err: DispatchSuspendedError }> = [];
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });

  const watcher = new DispatchWatcher({
    dataDir: runDir,
    logger: silent,
    onRetained: async (spec, err) => { notices.push({ spec, err }); },
    onDispatch: async (spec) => {
      entered();
      await held;
      throw DispatchSuspendedError[opts.suspension](spec.id, opts.reason);
    },
  });

  await mkdir(runDirs.pending, { recursive: true });
  await writeFile(
    path.join(runDirs.pending, `${opts.id}.json`),
    JSON.stringify({
      id: opts.id,
      target: "thread-1",
      prompt: "do the thing",
      session: "live",
      createdUtc: new Date().toISOString(),
    }),
    "utf8"
  );
  await watcher.start({ waitForInitialDispatches: false });
  await started;
  if (opts.stopDuringRun) watcher.stop();
  release();
  await watcher.initialDispatchesSettled();
  if (!opts.stopDuringRun) watcher.stop();

  const running = await readdir(runDirs.running);
  await rm(runDir, { recursive: true, force: true });
  return { notices, running };
}

describe("#333 suspension classes", () => {
  it("raises no operator notice for a restart's shutdown and superseded refusals", async () => {
    // The restart shape from the incident: several dispatches in flight, some
    // handed to the next boot, some already owned by a newer generation. Before
    // this change every one of them produced "Dispatch <id> is stalled after
    // restart" and a durable quarantine.
    for (const [index, suspension] of (["shutdown", "superseded", "shutdown"] as const).entries()) {
      const { notices, running } = await runRefusal({
        id: `in-flight-${index}`,
        suspension,
        reason: `fixture ${suspension}`,
        stopDuringRun: false,
      });
      expect(notices).toEqual([]);
      // Retention still keeps the artifact claimed, so the next boot finds it.
      // Silence must not mean the work was dropped.
      expect(running).toEqual([`in-flight-${index}.json`]);
    }
  });

  it("names the cause of a defect refusal instead of a generic stall", async () => {
    const reason = "thread switched from codex to claude";
    const { notices, running } = await runRefusal({
      id: "broken",
      suspension: "defect",
      reason,
      stopDuringRun: false,
    });
    expect(notices).toHaveLength(1);
    expect(notices[0]?.err.reason).toBe(reason);
    expect(notices[0]?.err.suspension).toBe("defect");
    // The notice text is built from `err.reason` in observeRetainedDispatch;
    // what the watcher must guarantee is that the reason survives the hop at
    // all. It used to call onRetained(spec) and drop the error on the floor.
    expect(notices[0]?.err.reason).not.toMatch(/stalled after restart/);
    expect(running).toEqual(["broken.json"]);
  });

  it("treats a shutdown identically on both sides of stop()", async () => {
    // THE race. `stop()` closing intake used to decide whether the identical
    // shutdown handoff became a durable quarantine plus a Discord notice or a
    // clean hand-off, so the same event reported two different outcomes
    // depending on which side of a millisecond it landed.
    const before = await runRefusal({
      id: "shutdown-before-stop",
      suspension: "shutdown",
      reason: "restart cutoff reached",
      stopDuringRun: false,
    });
    const after = await runRefusal({
      id: "shutdown-after-stop",
      suspension: "shutdown",
      reason: "restart cutoff reached",
      stopDuringRun: true,
    });
    expect(before.notices).toEqual([]);
    expect(after.notices).toEqual([]);
    expect(before.running).toEqual(["shutdown-before-stop.json"]);
    expect(after.running).toEqual(["shutdown-after-stop.json"]);
  });

  it("reports a defect identically on both sides of stop()", async () => {
    // The other half of the same race, and the half that lost information:
    // with the old `this.ready &&` gate a genuine defect arriving after stop()
    // was silently swallowed and no quarantine was ever recorded for it.
    const before = await runRefusal({
      id: "defect-before-stop",
      suspension: "defect",
      reason: "no ACP session id was ever recorded",
      stopDuringRun: false,
    });
    const after = await runRefusal({
      id: "defect-after-stop",
      suspension: "defect",
      reason: "no ACP session id was ever recorded",
      stopDuringRun: true,
    });
    expect(before.notices).toHaveLength(1);
    expect(after.notices).toHaveLength(1);
    expect(after.notices[0]?.err.reason).toBe("no ACP session id was ever recorded");
  });

  it("keeps an inner refusal's class and reason when a store write is wrapped", async () => {
    // Thirteen sites wrapped a store write in `catch { throw new
    // DispatchSuspendedError(spec.id) }`, flattening a classified refusal into
    // a silent one. `from` is what stops the catch discarding it; deleting it
    // turns every wrapped superseded write back into an operator notice.
    const inner = DispatchSuspendedError.superseded("job", "generation 3 was replaced by generation 4");
    const passed = DispatchSuspendedError.from(inner, "job", "binding failed");
    expect(passed).toBe(inner);
    expect(passed.suspension).toBe("superseded");

    const foreign = DispatchSuspendedError.from(new Error("SQLITE_BUSY"), "job", "binding failed");
    expect(foreign.suspension).toBe("defect");
    expect(foreign.reason).toBe("binding failed: SQLITE_BUSY");
  });

  it("cannot construct a refusal without a reason", async () => {
    // The structural guarantee. The constructor is private, so the 60 silent
    // sites cannot come back as a compile-time-valid shape, and the runtime
    // check catches anything reaching it through an untyped path.
    expect(() => DispatchSuspendedError.defect("job", "   ")).toThrow(/non-empty reason/);
    expect(DispatchSuspendedError.shutdown("job", "going down").suspension).toBe("shutdown");
  });

  it("has no silent construction site left in the dispatch or orchestrator source", async () => {
    // Structural, not behavioural. `private constructor` is the real guard —
    // it makes a silent site a type error — so this asserts the guard itself
    // is still in place, plus that nobody has routed around it with a cast.
    // Written as two assertions because the second one is what a regression
    // actually looks like: `as any` compiles fine and greps differently.
    const store = readFileSync(
      path.join(repo, "packages/core/src/core/dispatch/attempt-store.ts"), "utf8");
    expect(store).toMatch(/private constructor\(\s*\n\s*readonly dispatchId: string,/);

    const offenders: string[] = [];
    for (const relative of [
      "packages/core/src/core/dispatch/attempt-store.ts",
      "packages/core/src/core/dispatch/watcher.ts",
      "packages/core/src/platforms/discord/orchestrator.ts",
    ]) {
      const text = readFileSync(path.join(repo, relative), "utf8");
      text.split("\n").forEach((line, index) => {
        // Any spelling: `new DispatchSuspendedError(`, `new (X as any)(`, or a
        // parenthesised/asserted form. The three factories are the only
        // legitimate constructions and they live inside the class itself.
        if (!/new\s*\(?\s*DispatchSuspendedError\b/.test(line)) return;
        if (/return new DispatchSuspendedError\(dispatchId, reason, "/.test(line)) return;
        offenders.push(`${relative}:${index + 1} ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("classifies every throw site in the dispatch path", async () => {
    // Counts the surface so a new site added without a class is visible. The
    // point is not the exact number; it is that every factory call names a
    // class and no call passes an empty reason.
    const counts: Record<string, number> = { shutdown: 0, superseded: 0, defect: 0, from: 0 };
    for (const relative of [
      "packages/core/src/core/dispatch/attempt-store.ts",
      "packages/core/src/platforms/discord/orchestrator.ts",
    ]) {
      const text = readFileSync(path.join(repo, relative), "utf8");
      for (const kind of Object.keys(counts)) {
        counts[kind]! += text.split(`DispatchSuspendedError.${kind}(`).length - 1;
      }
    }
    // Every class is represented: a taxonomy nothing uses is a taxonomy that
    // has silently collapsed back to one bucket.
    expect(counts.shutdown).toBeGreaterThan(0);
    expect(counts.superseded).toBeGreaterThan(0);
    expect(counts.defect).toBeGreaterThan(0);
    expect(counts.from).toBeGreaterThan(0);
  });
});

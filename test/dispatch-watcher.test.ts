import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pino } from "pino";
import { DispatchWatcher } from "../packages/core/src/core/dispatch/watcher.js";
import { dispatchDirs, type DispatchSpec } from "../packages/core/src/core/dispatch/types.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

let dataDir: string;
let dirs: ReturnType<typeof dispatchDirs>;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "seam-dispatch-test-"));
  dirs = dispatchDirs(dataDir);
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

/** Drop a pending spec, returning its id. */
async function dropSpec(spec: Partial<DispatchSpec> & { id: string }): Promise<string> {
  await mkdir(dirs.pending, { recursive: true });
  const body = {
    target: "thread-1",
    prompt: "do the thing",
    session: "live",
    createdUtc: new Date().toISOString(),
    ...spec,
  };
  await writeFile(path.join(dirs.pending, `${spec.id}.json`), JSON.stringify(body), "utf8");
  return spec.id;
}

async function readDone(id: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(dirs.done, `${id}.json`), "utf8"));
}

describe("DispatchWatcher", () => {
  it("moves a pending spec through running to done with the callback's output", async () => {
    const seen: DispatchSpec[] = [];
    const watcher = new DispatchWatcher({
      dataDir,
      logger: silent,
      onDispatch: async (spec) => {
        seen.push(spec);
        // The spec must be out of pending/ and claimed in running/ while the
        // callback is executing — that's what makes a crash recoverable.
        expect(await readdir(dirs.pending)).toEqual([]);
        expect(await readdir(dirs.running)).toEqual([`${spec.id}.json`]);
        return { output: "hello from the agent", stopReason: "end_turn" };
      },
    });

    await dropSpec({ id: "job-a", correlationId: "corr-7" });
    await watcher.start();
    watcher.stop();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.target).toBe("thread-1");
    expect(seen[0]!.prompt).toBe("do the thing");
    expect(seen[0]!.correlationId).toBe("corr-7");

    const result = await readDone("job-a");
    expect(result).toMatchObject({
      id: "job-a",
      status: "completed",
      output: "hello from the agent",
      stopReason: "end_turn",
      target: "thread-1",
      correlationId: "corr-7",
    });
    expect(typeof result.finishedUtc).toBe("string");

    // Queue drained.
    expect(await readdir(dirs.pending)).toEqual([]);
    expect(await readdir(dirs.running)).toEqual([]);
  });

  it("records status failed with the error when the callback rejects", async () => {
    const watcher = new DispatchWatcher({
      dataDir,
      logger: silent,
      onDispatch: async () => {
        throw new Error("agent exploded");
      },
    });

    await dropSpec({ id: "job-b" });
    await watcher.start();
    watcher.stop();

    const result = await readDone("job-b");
    expect(result).toMatchObject({
      id: "job-b",
      status: "failed",
      error: "agent exploded",
      target: "thread-1",
    });
    expect(result.output).toBeUndefined();
    expect(await readdir(dirs.running)).toEqual([]);
  });

  it("re-enqueues a spec a crash left in running/ (at-least-once)", async () => {
    // Simulate the crash: a claimed spec sitting in running/ with no result.
    await mkdir(dirs.running, { recursive: true });
    await mkdir(dirs.pending, { recursive: true });
    await writeFile(
      path.join(dirs.running, "job-c.json"),
      JSON.stringify({ target: "thread-9", prompt: "resume me", session: "isolated" }),
      "utf8"
    );

    const seen: string[] = [];
    const watcher = new DispatchWatcher({
      dataDir,
      logger: silent,
      onDispatch: async (spec) => {
        seen.push(spec.id);
        return { output: "recovered", stopReason: "end_turn" };
      },
    });

    await watcher.start();
    watcher.stop();

    expect(seen).toEqual(["job-c"]);
    expect(await readDone("job-c")).toMatchObject({
      id: "job-c",
      status: "completed",
      output: "recovered",
      target: "thread-9",
    });
  });

  it("drops a stale running spec that already has a result instead of re-running it", async () => {
    await mkdir(dirs.running, { recursive: true });
    await mkdir(dirs.done, { recursive: true });
    await writeFile(
      path.join(dirs.running, "job-d.json"),
      JSON.stringify({ target: "thread-1", prompt: "already ran" }),
      "utf8"
    );
    await writeFile(
      path.join(dirs.done, "job-d.json"),
      JSON.stringify({ id: "job-d", status: "completed", output: "first run", target: "thread-1" }),
      "utf8"
    );

    let calls = 0;
    const watcher = new DispatchWatcher({
      dataDir,
      logger: silent,
      onDispatch: async () => {
        calls++;
        return { output: "second run", stopReason: "end_turn" };
      },
    });

    await watcher.start();
    watcher.stop();

    expect(calls).toBe(0);
    expect(await readDone("job-d")).toMatchObject({ output: "first run" });
    expect(await readdir(dirs.running)).toEqual([]);
  });

  it("runs different targets concurrently but serializes the same target", async () => {
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const release = new Map<string, () => void>();
    const gate = (id: string) =>
      new Promise<void>((resolve) => release.set(id, resolve));

    const watcher = new DispatchWatcher({
      dataDir,
      logger: silent,
      onDispatch: async (spec) => {
        active++;
        maxActive = Math.max(maxActive, active);
        order.push(`start:${spec.id}`);
        await gate(spec.id);
        order.push(`end:${spec.id}`);
        active--;
        return { output: spec.id, stopReason: "end_turn" };
      },
    });

    // Two specs on thread-1 (must serialize) and one on thread-2 (must overlap).
    await dropSpec({ id: "a1", target: "thread-1" });
    await dropSpec({ id: "a2", target: "thread-1" });
    await dropSpec({ id: "b1", target: "thread-2" });

    await mkdir(dirs.running, { recursive: true });
    await mkdir(dirs.done, { recursive: true });
    const tick = watcher.start();

    // Let the claims land and the first callbacks enter.
    await vi_waitFor(() => release.size >= 2);
    // thread-1's second spec must NOT have started while the first is parked.
    expect(order.filter((o) => o.startsWith("start:")).sort()).toEqual(["start:a1", "start:b1"]);
    expect(maxActive).toBe(2);

    for (const r of [...release.values()]) r();
    await vi_waitFor(() => release.size >= 3);
    for (const r of [...release.values()]) r();

    await tick;
    watcher.stop();

    expect(order).toContain("end:a2");
    // Same target: a2 only starts after a1 finished.
    expect(order.indexOf("start:a2")).toBeGreaterThan(order.indexOf("end:a1"));
    for (const id of ["a1", "a2", "b1"]) {
      expect(await readDone(id)).toMatchObject({ id, status: "completed", output: id });
    }
  });

  it("serializes same-target specs in createdUtc arrival order, not id/readdir order", async () => {
    // Regression guard for the claim-race de-flake: two specs on the SAME target
    // claimed in one tick must reach the thread in on-disk ARRIVAL order. Here
    // the later id ("aaa") was created FIRST — sorting by id/readdir would run it
    // first; only sorting by createdUtc gives the correct ["zzz", "aaa"].
    const order: string[] = [];
    const watcher = new DispatchWatcher({
      dataDir,
      logger: silent,
      onDispatch: async (spec) => {
        order.push(spec.id);
        return { output: spec.id, stopReason: "end_turn" };
      },
    });

    await dropSpec({ id: "zzz", target: "t", createdUtc: "2026-01-01T00:00:00.000Z" });
    await dropSpec({ id: "aaa", target: "t", createdUtc: "2026-01-01T00:00:05.000Z" });

    await watcher.start();
    watcher.stop();

    expect(order).toEqual(["zzz", "aaa"]);
    expect(await readDone("zzz")).toMatchObject({ status: "completed" });
    expect(await readDone("aaa")).toMatchObject({ status: "completed" });
  });

  it("fails an unparseable spec instead of retrying it forever", async () => {
    await mkdir(dirs.pending, { recursive: true });
    await writeFile(path.join(dirs.pending, "job-e.json"), "{ not json", "utf8");

    let calls = 0;
    const watcher = new DispatchWatcher({
      dataDir,
      logger: silent,
      onDispatch: async () => {
        calls++;
        return { output: "", stopReason: "end_turn" };
      },
    });

    await watcher.start();
    await watcher.tick(); // a second pass must not find it again
    watcher.stop();

    expect(calls).toBe(0);
    const result = await readDone("job-e");
    expect(result.status).toBe("failed");
    expect(String(result.error)).toContain("malformed JSON");
    expect(await readdir(dirs.pending)).toEqual([]);
    expect(await readdir(dirs.running)).toEqual([]);
  });

  it("rejects a spec missing required fields", async () => {
    await mkdir(dirs.pending, { recursive: true });
    await writeFile(path.join(dirs.pending, "job-f.json"), JSON.stringify({ prompt: "hi" }), "utf8");

    const watcher = new DispatchWatcher({
      dataDir,
      logger: silent,
      onDispatch: async () => ({ output: "", stopReason: "end_turn" }),
    });
    await watcher.start();
    watcher.stop();

    const result = await readDone("job-f");
    expect(result.status).toBe("failed");
    expect(String(result.error)).toContain("target");
  });
});

/** Poll until `cond` holds or we give up — small helper so the concurrency test
 *  doesn't depend on arbitrary sleeps. */
async function vi_waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor: condition never became true");
}

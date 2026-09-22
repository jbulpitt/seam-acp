/**
 * #447: an accepted dispatch is a pending attempt row before the caller is
 * told the id. The file is a projection. Deleting `attempts.admit` from
 * `publishDispatch` makes the row assertions fail.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { publishDispatch } from "../packages/core/src/core/dispatch/publish.js";
import { DispatchWatcher } from "../packages/core/src/core/dispatch/watcher.js";
import { dispatchDirs, type DispatchSpec } from "../packages/core/src/core/dispatch/types.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

let dataDir: string;
let store: SessionStore;
const watchers = new Set<DispatchWatcher>();

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "seam-447-"));
  store = new SessionStore(path.join(dataDir, "seam.db"));
});

afterEach(async () => {
  for (const watcher of watchers) watcher.stop();
  await Promise.all([...watchers].map((watcher) => watcher.drain()));
  watchers.clear();
  store.close();
  await rm(dataDir, { recursive: true, force: true });
});

function spec(id: string, prompt = "do the work"): DispatchSpec {
  return {
    id,
    target: "thread-1",
    prompt,
    session: "live",
    kind: "handoff",
    correlationId: id,
    createdUtc: "2026-09-22T04:40:00.000Z",
  };
}

describe("publishDispatch", () => {
  it("leaves a pending row before the queue file is required", async () => {
    const blocker = path.join(dataDir, "not-a-directory");
    await writeFile(blocker, "x");
    await expect(publishDispatch(store.turnAttempts, blocker, spec("during-restart")))
      .resolves.toMatchObject({ projection: "admitted-only" });
    expect(store.turnAttempts.get("during-restart")).toMatchObject({
      state: "pending",
      generation: 0,
      promptStarted: false,
      source: "dispatch",
      spec: { prompt: "do the work", target: "thread-1" },
    });
    expect(store.turnAttempts.list("pending").map((row) => row.id)).toEqual(["during-restart"]);

    const onDispatch = vi.fn(async () => ({ output: "ran from the row", stopReason: "end_turn" }));
    const watcher = new DispatchWatcher({
      attempts: store.turnAttempts,
      dataDir,
      logger: silent,
      onDispatch,
    });
    watchers.add(watcher);
    await watcher.start();
    watcher.stop();
    expect(onDispatch).toHaveBeenCalledTimes(1);
    expect(onDispatch.mock.calls[0]?.[0]).toMatchObject({ id: "during-restart", prompt: "do the work" });
    expect(store.turnAttempts.get("during-restart")?.state).toBe("completed");
  });

  it("writes the file only after the row is visible, and a second publish does not fork it", async () => {
    const pendingFile = path.join(dispatchDirs(dataDir).pending, "visible.json");
    let fileExistedWhenAdmitted = true;
    const original = store.turnAttempts.admit.bind(store.turnAttempts);
    vi.spyOn(store.turnAttempts, "admit").mockImplementation((incoming) => {
      fileExistedWhenAdmitted = existsSync(pendingFile);
      return original(incoming);
    });
    await expect(publishDispatch(store.turnAttempts, dataDir, spec("visible")))
      .resolves.toEqual({ projection: "projected" });
    expect(fileExistedWhenAdmitted).toBe(false);
    await access(path.join(dispatchDirs(dataDir).pending, "visible.json"));

    await publishDispatch(store.turnAttempts, dataDir, spec("visible", "different prompt"));
    expect(store.turnAttempts.list("pending")).toHaveLength(1);
    expect(store.turnAttempts.get("visible")?.spec.prompt).toBe("do the work");
  });

  it("does not rewind an attempt that execution already owns", async () => {
    const owned = spec("owned");
    store.turnAttempts.claim(owned, "{\"agent\":\"codex\"}", "boot-1");
    await mkdir(dispatchDirs(dataDir).pending, { recursive: true });
    await publishDispatch(store.turnAttempts, dataDir, { ...owned, prompt: "replacement" });
    expect(store.turnAttempts.get("owned")).toMatchObject({
      state: "active",
      generation: 1,
      spec: { prompt: "do the work" },
    });
  });
});

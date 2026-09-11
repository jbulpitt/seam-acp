import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { DispatchWatcher } from "../packages/core/src/core/dispatch/watcher.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { dispatchArtifactState, dispatchDirs } from "../packages/core/src/core/dispatch/types.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

let dataDir: string;
let store: SessionStore;
const watchers: DispatchWatcher[] = [];
const logger = pino({ level: "silent" }) as unknown as Logger;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "seam-306-completion-"));
  store = new SessionStore(path.join(dataDir, "seam.db"));
});
afterEach(async () => {
  for (const watcher of watchers.splice(0)) { watcher.stop(); await watcher.drain(); }
  store.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("completion survives done artifact removal (#306)", () => {
  it("uses SQL completion for artifact inspection after pruning", async () => {
    store.recordDelegation({ id: "pruned-child", kind: "forward", status: "completed" });
    // Without this production helper's SQL path, chain/admission repair mistakes pruning for missing publication.
    expect(await dispatchArtifactState(dataDir, "pruned-child", (id) => store.isDispatchCompleted(id))).toBe("done");
    expect(await dispatchArtifactState(dataDir, "unknown", (id) => store.isDispatchCompleted(id))).toBeNull();
  });
  for (const resumeEnabled of [false, true]) {
    it(`drops completed queue leftovers without replay or replacement output (resume=${resumeEnabled})`, async () => {
      const dirs = dispatchDirs(dataDir);
      for (const sub of ["running", "pending"] as const) {
        await mkdir(dirs[sub], { recursive: true });
        store.recordDelegation({ id: sub, kind: "wake", status: "completed" });
        await writeFile(path.join(dirs[sub], `${sub}.json`), JSON.stringify({
          id: sub, target: "worker", session: "live", prompt: "must not replay",
        }));
      }
      const onDispatch = vi.fn(async () => ({ output: "duplicate", stopReason: "end_turn" }));
      const watcher = new DispatchWatcher({
        dataDir, logger, resumeEnabled, onDispatch,
        isCompleted: (id: string) => store.isDispatchCompleted(id),
      });
      watchers.push(watcher);
      await watcher.start();
      // Without SQL completion authority, a pruned result becomes a paid rerun or a replacement failure.
      expect(onDispatch).not.toHaveBeenCalled();
      expect(await readdir(dirs.running)).toEqual([]);
      expect(await readdir(dirs.pending)).toEqual([]);
      expect(await readdir(dirs.done)).toEqual([]);
      expect(await watcher.listStaleRunning()).toEqual([]);
    });
  }
});

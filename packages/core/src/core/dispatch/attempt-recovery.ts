import { mkdir, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { TurnAttemptStore } from "./attempt-store.js";
import { dispatchDirs } from "./types.js";

/** SQL completion wins before any external side effect. Repair its filesystem
 * projection before the existing DB-first report/chain reconciler and before
 * watcher intake. A failure is fatal to recovery, not permission to rerun. */
export async function projectAttemptCompletions(
  dataDir: string,
  attempts: TurnAttemptStore,
  needsProjection: (id: string) => boolean = () => true
): Promise<number> {
  const dirs = dispatchDirs(dataDir);
  await mkdir(dirs.done, { recursive: true });
  let n = 0;
  for (const a of [...attempts.list("completed"), ...attempts.list("cancelled")]) {
    if (!needsProjection(a.id)) continue;
    if (!a.outcome) throw new Error("completed attempt has no durable outcome");
    if (!a.id || a.id === "." || a.id === ".." || path.basename(a.id) !== a.id || /[\\\0]/.test(a.id)) {
      throw new Error("invalid durable dispatch id");
    }
    const final = path.join(dirs.done, `${a.id}.json`);
    const temp = `${final}.attempt.tmp`;
    await writeFile(temp, `${JSON.stringify(a.outcome)}\n`, "utf8");
    await rename(temp, final);
    await rm(path.join(dirs.running, `${a.id}.json`), { force: true });
    await rm(path.join(dirs.pending, `${a.id}.json`), { force: true });
    n++;
  }
  return n;
}

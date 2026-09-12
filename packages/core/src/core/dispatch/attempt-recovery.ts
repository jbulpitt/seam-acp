import { mkdir, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { TurnAttemptStore } from "./attempt-store.js";
import { dispatchDirs } from "./types.js";
import type { Logger } from "../../lib/logger.js";

/** SQL completion wins before any external side effect. Repair its filesystem
 * projection before the existing DB-first report/chain reconciler and before
 * watcher intake. A failed projection affects only its result artifact: SQL
 * still prevents replay, and unrelated recovery/admission remains available. */
export async function projectAttemptCompletions(
  dataDir: string,
  attempts: TurnAttemptStore,
  needsProjection: (id: string) => boolean = () => true,
  logger?: Pick<Logger, "error">
): Promise<number> {
  const dirs = dispatchDirs(dataDir);
  const report = (id: string, err: unknown): void => {
    if (logger) logger.error({ id, err }, "dispatch: result projection failed; SQL completion retained, other work continues");
    else console.error("dispatch: result projection failed; SQL completion retained", id, err);
  };
  let n = 0;
  for (const a of [...attempts.list("completed", report), ...attempts.list("cancelled", report)]) {
    try {
      if (a.source !== "dispatch") continue;
      if (!needsProjection(a.id)) continue;
      if (!a.outcome) throw new Error("completed attempt has no durable outcome");
      if (!a.id || a.id === "." || a.id === ".." || path.basename(a.id) !== a.id || /[\\\0]/.test(a.id)) {
        throw new Error("invalid durable dispatch id");
      }
      const final = path.join(dirs.done, `${a.id}.json`);
      const temp = `${final}.attempt.tmp`;
      await mkdir(dirs.done, { recursive: true });
      await writeFile(temp, `${JSON.stringify(a.outcome)}\n`, "utf8");
      await rename(temp, final);
      await rm(path.join(dirs.running, `${a.id}.json`), { force: true });
      await rm(path.join(dirs.pending, `${a.id}.json`), { force: true });
      n++;
    } catch (err) {
      report(a.id, err);
    }
  }
  return n;
}

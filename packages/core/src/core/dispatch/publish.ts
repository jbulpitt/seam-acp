/**
 * Admit a dispatch before anyone is told it was accepted (#447).
 *
 * The pending file and `turn_attempts` already exist. The watcher used to be
 * the first writer of the row, which is after `handoff` has returned the id.
 * A restart in that gap leaves a success with nothing to query. `admit` is
 * synchronous and commits before this function awaits the file, so a crash
 * during the write still leaves a pending row the next boot can run.
 * A failed file write does not undo the row and does not throw: throwing
 * would read as "not accepted", and a retry mints a second id.
 */
import type { TurnAttemptStore } from "./attempt-store.js";
import { enqueueDispatchSpec, type DispatchSpec } from "./types.js";

export type DispatchPublication =
  | { projection: "projected" }
  | { projection: "admitted-only"; error: unknown };

export async function publishDispatch(
  attempts: Pick<TurnAttemptStore, "admit"> | null | undefined,
  dataDir: string,
  spec: DispatchSpec,
  log?: { error: (obj: unknown, msg?: string) => void },
): Promise<DispatchPublication> {
  // A test double with no attempt ledger still has to land the file. Production
  // SessionStore always has the ledger; that is the path that admits first.
  if (!attempts) {
    await enqueueDispatchSpec(dataDir, spec);
    return { projection: "projected" };
  }
  attempts.admit(spec);
  try {
    await enqueueDispatchSpec(dataDir, spec);
    return { projection: "projected" };
  } catch (error) {
    log?.error({ err: error, dispatchId: spec.id }, "dispatch admitted; queue file was not written");
    return { projection: "admitted-only", error };
  }
}

import os from "node:os";

/**
 * Deprioritise the vitest MAIN process, not only its pool workers.
 *
 * `test/non-live-env.ts` runs inside each worker, so it cannot reach the
 * process that does collection, transformation and reporting — and transform
 * alone is tens of seconds of CPU on a full run.
 *
 * It matters more than it looks. seam-acp runs at `Nice=-5` and every agent
 * child inherits it, and test runs are launched BY agent turns. Today that
 * inheritance happens to be broken by npm re-parenting the runner to init,
 * which lands it back at 0 — so the ordering is currently correct by accident.
 * Launched any other way (a direct `vitest` binary, a different package
 * manager, an editor runner) the main process would inherit -5 and compete
 * with the agents it is supposed to yield to.
 *
 * Setting it explicitly makes the guarantee unconditional instead of lucky.
 */
export default function setup(): void {
  try {
    os.setPriority(0, 15);
  } catch {
    // Priority is an optimisation, never a test precondition.
  }
}

import { vi } from "vitest";
import * as recovery from "../../packages/core/src/core/recovery-directive.js";

const runBoundedRecovery = recovery.runBoundedRecovery;

/** Advance recovery only; hang-watch timers, wall time and ACP I/O stay real. */
export function fastProviderRetryClock(): void {
  vi.spyOn(recovery, "runBoundedRecovery").mockImplementation(opts => {
    let elapsed = 0;
    return runBoundedRecovery({ ...opts, now: () => Date.now() + elapsed,
      sleep: async ms => { elapsed += ms; } });
  });
}

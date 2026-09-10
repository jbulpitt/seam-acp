import { vi } from "vitest";
import * as owners from "../packages/core/src/core/dispatch/process-owner.js";

/** Explicit synthetic PID-reuse proof; preserves real durable registration and
 * runs the production liveness guard. No process is spawned or signalled. This
 * does not demonstrate provider session reload or supervisor stop ordering. */
export function simulateRetiredOwnerProcess(): void {
  const current = owners.processOwner();
  if (!current) throw new Error("synthetic ownership fixture requires readable process identity");
  vi.spyOn(owners, "processOwner").mockReturnValue({ ...current, start: "0" });
}

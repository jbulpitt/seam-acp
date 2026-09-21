import { describe, expect, it } from "vitest";
import { BootAcquisitionExhaustedError, DispatchAcquisitionPhase, isRetryableBootAcquisitionError } from "../packages/core/src/core/dispatch/acquisition-phase.js";

describe("#448 acquisition owner outcome", () => {
  it.each([
    Object.assign(new Error("load timed out"), { code: "session_load_timeout" }),
    Object.assign(new Error("bridge socket lost"), { bridgeUnreachable: true }),
  ])("exhaustion dominates its retained retryable cause: %s", async cause => {
    expect(isRetryableBootAcquisitionError(cause)).toBe(true);
    const exhausted = new BootAcquisitionExhaustedError(3, cause);
    expect(exhausted.cause).toBe(cause);
    expect(isRetryableBootAcquisitionError(exhausted)).toBe(false);
    const wrapped = new Error("outer wrapper", { cause: exhausted });
    expect(isRetryableBootAcquisitionError(wrapped)).toBe(false);
    await expect(new DispatchAcquisitionPhase("dispatch-id", "boot-recovery").acquire(async () => { throw exhausted; }))
      .rejects.toMatchObject({ suspension: "defect", reason: `provider acquisition failed during boot-recovery: boot recovery exhausted 3 pre-prompt acquisition attempts: ${cause.message}` });
  });

  it("an unspent transient acquisition remains retryable for the isolated watcher owner", async () => {
    await expect(new DispatchAcquisitionPhase("isolated-id", "boot-recovery").acquire(async () => { throw new Error("ACP connection closed"); }))
      .rejects.toMatchObject({ suspension: "retryable", reason: "provider acquisition failed during boot-recovery: ACP connection closed" });
  });

  it("an integrity refusal is not relabelled as budget exhaustion", async () => {
    await expect(new DispatchAcquisitionPhase("dispatch-id", "boot-recovery").acquire(async () => { throw new Error("Strict resume refused: thread session changed during acquisition"); }))
      .rejects.toMatchObject({ suspension: "defect", reason: "provider acquisition failed during boot-recovery: Strict resume refused: thread session changed during acquisition" });
  });
});

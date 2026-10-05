import { describe, expect, it } from "vitest";
import { BootAcquisitionExhaustedError, DispatchAcquisitionPhase, isRetryableBootAcquisitionError, bootRecoveryBackoff, bootErrorClassification } from "../packages/core/src/core/dispatch/acquisition-phase.js";
import { attachErrorClassification, providerRetryBackoff } from "@seam/adapters";

describe("#448 acquisition owner outcome", () => {
  it("a classified missing session cannot spend a load retry budget", () => {
    const gone = Object.assign(new Error("Internal error"), {
      data: { errorKind: "session_gone", agentId: "codex", details: "no rollout found for lost-session" },
    });
    expect(isRetryableBootAcquisitionError(gone)).toBe(false);
    expect(isRetryableBootAcquisitionError(new Error("outer wrapper", { cause: gone }))).toBe(false);
    expect(isRetryableBootAcquisitionError(new Error("Internal error"))).toBe(true);
  });
  it("keeps the adapter's provider cause through dispatch acquisition for its existing retry owner", async () => {
    const error = new Error("Overloaded");
    attachErrorClassification(error, { agentId: "claude", errorKind: "server_error" });
    const wrapped = await new DispatchAcquisitionPhase("provider", "boot-recovery").acquire(async () => { throw error; }).catch(e => e);
    expect(wrapped.cause).toBe(error);
    expect(bootErrorClassification(wrapped)).toMatchObject({ errorKind: "server_error" });
    expect(bootRecoveryBackoff(wrapped)).toEqual(providerRetryBackoff("server_error")!.map(delay => Math.max(30_000, delay)));
    expect(bootRecoveryBackoff(new Error("ACP connection closed"))).toEqual([30_000, 30_000]);
  });

  it.each(["quota_exhausted", "auth_required", "auth_expired", "model_not_found", "invalid_request"] as const)(
    "does not turn %s into boot-recovery retry loops", async kind => {
      const error = new Error(`provider refused: ${kind}`);
      attachErrorClassification(error, { agentId: "codex", errorKind: kind });
      expect(isRetryableBootAcquisitionError(new Error("wrapper", { cause: error }))).toBe(false);
      await expect(new DispatchAcquisitionPhase("provider", "boot-recovery").acquire(async () => { throw error; }))
        .rejects.toMatchObject({ suspension: "defect", reason: `provider acquisition failed during boot-recovery: ${error.message}` });
    });

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

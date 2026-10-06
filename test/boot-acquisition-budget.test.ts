import { describe, expect, it } from "vitest";
import { BootAcquisitionExhaustedError, DispatchAcquisitionPhase, isRetryableBootAcquisitionError, bootRecoveryBackoff, bootErrorClassification } from "../packages/core/src/core/dispatch/acquisition-phase.js";
import { attachErrorClassification, providerRetryBackoff } from "@seam/adapters";
import { RequestError } from "@agentclientprotocol/sdk";
import { classifyAndAttach, classifyCodexError } from "@seam/adapters";
import { negotiateReauth, ReauthParked } from "../packages/core/src/core/reauth-negotiation.js";

describe("#448 acquisition owner outcome", () => {
  it("gives the observed writer collision the long retry schedule and a plain parked cause", async () => {
    const error = new RequestError(-32603, "Internal error", {
      details: "thread 01a0e0f0-6fe1-7f70-9c3f-db1325e4a455 already has an active writer",
    });
    classifyAndAttach(error, classifyCodexError(error));
    const stderr = Object.assign(new Error(`${error.message}\nagent stderr (last lines):\n[bridge] adapter agy loaded`, { cause: error }), { data: error.data });
    expect(isRetryableBootAcquisitionError(stderr)).toBe(true);
    expect(bootRecoveryBackoff(stderr)).toEqual(providerRetryBackoff("overloaded")!.map(delay => Math.max(30_000, delay)));
    expect(bootRecoveryBackoff(stderr)).toHaveLength(5);
    const exhausted = new BootAcquisitionExhaustedError(6, stderr);
    await expect(new DispatchAcquisitionPhase("writer", "execution").acquire(async () => { throw exhausted; }))
      .rejects.toMatchObject({ suspension: "defect", reason: "Codex was still attached to this session from the previous turn" });
  });

  it("does not retry or replace Codex's exact production auth error with an acquisition defect", async () => {
    const error = new RequestError(-32000, "Authentication required", null);
    classifyAndAttach(error, classifyCodexError(error));
    expect(isRetryableBootAcquisitionError(error)).toBe(false);
    expect(isRetryableBootAcquisitionError(new Error("wrapper", { cause: error }))).toBe(false);
    const decision = negotiateReauth({ errorKind: "auth_required", message: error.message });
    if (decision.action !== "park") throw new Error("expected the existing reauth decision");
    const parked = new ReauthParked(decision, error);
    expect(isRetryableBootAcquisitionError(parked)).toBe(false);
    await expect(new DispatchAcquisitionPhase("codex-auth", "boot-recovery").acquire(async () => { throw parked; }))
      .rejects.toBe(parked);
    expect(parked.cause).toBe(error);
  });
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

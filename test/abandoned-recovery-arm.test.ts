import { afterEach, describe, expect, it, vi } from "vitest";
import { recoveryArmFixture } from "./helpers/recovery-arm.js";

afterEach(() => { vi.useRealTimers(); });

describe("pre-submit recovery arm ownership", () => {
  it("preserves the 15s lost-arm timeout and lets the next ordinary requests use the same session once", async () => {
    vi.useFakeTimers();
    const h = recoveryArmFixture({ fail: "timeout" });
    const first = h.runtime.prompt("synthetic first request", undefined, h.opts).catch(error => error);
    await vi.advanceTimersByTimeAsync(15_000);
    const error = await first;
    const busyAfterFailure = h.runtime.busy;
    const ownerAfterFailure = h.owner.snapshot(h.slot);
    const next = [];
    for (const text of ["synthetic next request", "synthetic third request"]) {
      next.push(await h.runtime.prompt(text, undefined, h.opts).catch(error => error));
    }
    expect(error).toBe(h.timeout);
    expect(error).toMatchObject({ code: "ETIMEDOUT", cause: h.timeout.cause });
    expect(next).toEqual([{ stopReason: "end_turn", cancelled: false }, { stopReason: "end_turn", cancelled: false }]);
    expect(ownerAfterFailure).toBeUndefined();
    expect(busyAfterFailure).toBe(false);
    expect(h.prompt.mock.calls.map(([params]) => params.prompt)).toEqual([
      [{ type: "text", text: "synthetic next request" }], [{ type: "text", text: "synthetic third request" }],
    ]);
    expect(h.prompt.mock.calls.every(([params]) => params.sessionId === h.sid)).toBe(true);
    expect(h.bind).toHaveBeenCalledTimes(2);
    expect(h.release).not.toHaveBeenCalled();
    expect(h.evidence.filter(e => e.kind === "submission-evidence")[1]).toMatchObject({
      evidence: { phase: "intent", outcome: "not_sent", acceptance: { reason: "rpc_never_invoked" } },
    });
  });

  it("cleans an invalid acknowledgement without invoking the prompt", async () => {
    const h = recoveryArmFixture({ fail: "invalid-ack" });
    await expect(h.runtime.prompt("synthetic request", undefined, h.opts))
      .rejects.toThrow("remote rung-1 recovery acknowledgement was invalid");
    expect(h.prompt).not.toHaveBeenCalled();
    expect(h.owner.snapshot(h.slot)).toBeUndefined();
    expect(h.runtime.busy).toBe(false);
  });

  it("keeps the first loaded-session replay boundary for the next request after an unsent arm", async () => {
    vi.useFakeTimers();
    const h = recoveryArmFixture({ fail: "timeout" });
    Object.assign(h.runtime, { justResumed: true, replayLoadedDuringLoad: false });
    const first = h.runtime.prompt("synthetic abandoned question", undefined, h.opts).catch(error => error);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await first).toBe(h.timeout);
    const nativePrompt = h.prompt.getMockImplementation()!;
    const feed = (sessionUpdate: string, text: string) => (h.runtime as unknown as {
      handleSessionUpdate(update: unknown): Promise<void>;
    }).handleSessionUpdate({ sessionUpdate, content: { type: "text", text } });
    h.prompt.mockImplementationOnce(async params => {
      await feed("user_message_chunk", "synthetic old question");
      await feed("agent_message_chunk", "synthetic old answer");
      await feed("user_message_chunk", "synthetic next question");
      await feed("agent_message_chunk", "synthetic live answer");
      return nativePrompt(params);
    });
    await h.runtime.prompt("synthetic next question", undefined, h.opts);
    expect(h.evidence.filter(event => event.kind === "agent-text").map(event => event.text))
      .toEqual(["synthetic live answer"]);
  });

  it("cleans the unsent arm when durable delegation fails, preserving its cause", async () => {
    const h = recoveryArmFixture();
    const failure = new Error("synthetic durable bind failure");
    h.bind.mockRejectedValueOnce(failure);
    await expect(h.runtime.prompt("synthetic request", undefined, h.opts)).rejects.toBe(failure);
    expect(h.prompt).not.toHaveBeenCalled();
    expect(h.owner.snapshot(h.slot)).toBeUndefined();
    expect(h.runtime.busy).toBe(false);
  });

  it.each(["armed", "executing"] as const)("does not disarm an existing different %s owner", async existingOwner => {
    const h = recoveryArmFixture({ existingOwner });
    const prior = h.owner.snapshot(h.slot);
    await expect(h.runtime.prompt("synthetic request", undefined, h.opts))
      .rejects.toThrow("rung-1 recovery already owns this slot submission");
    expect(h.owner.snapshot(h.slot)).toEqual(prior);
    expect(h.prompt).not.toHaveBeenCalled();
  });

  it.each(["partial", "prompt"] as const)("preserves observed %s input after an ambiguous arm answer", async observedInput => {
    vi.useFakeTimers();
    const h = recoveryArmFixture({ fail: "timeout", observedInput });
    const result = h.runtime.prompt("synthetic request", undefined, h.opts).catch(error => error);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toBe(h.timeout);
    expect(h.owner.snapshot(h.slot)).toMatchObject({ phase: observedInput === "partial" ? "armed" : "executing" });
    expect(h.prompt).not.toHaveBeenCalled();
    await expect(h.runtime.prompt("synthetic next request", undefined, h.opts))
      .rejects.toThrow("rung-1 recovery already owns this slot submission");
  });

  it("retains an unconfirmed arm when disarm is unavailable and preserves the original timeout", async () => {
    vi.useFakeTimers();
    const h = recoveryArmFixture({ fail: "timeout", disarmUnavailable: true });
    const result = h.runtime.prompt("synthetic request", undefined, h.opts).catch(error => error);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toBe(h.timeout);
    expect(h.owner.snapshot(h.slot)).toMatchObject({ phase: "armed" });
    expect(h.prompt).not.toHaveBeenCalled();
  });
});

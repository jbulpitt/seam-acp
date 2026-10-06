import { describe, expect, it, vi } from "vitest";
import { savedSessionHost, SAVED_SESSION } from "./helpers/saved-session-recovery.js";
import { DispatchAcquisitionPhase } from "../packages/core/src/core/dispatch/acquisition-phase.js";

async function previousTurn(h: Awaited<ReturnType<typeof savedSessionHost>>, completed = true, detached = true) {
  const router = h.makeRouter();
  const runtime = await router.getOrStartRuntime(h.record);
  const child = (runtime as any).child;
  const spec = { id: "previous", target: h.record.channelRef, prompt: "continue previous turn",
    kind: "handoff" as const, session: "live" as const, createdUtc: new Date().toISOString() };
  h.store.turnAttempts.registerOwner("previous-boot");
  const attempt = h.store.turnAttempts.claim(spec, "fixture-identity", "previous-boot");
  h.store.turnAttempts.bind(attempt, SAVED_SESSION);
  h.store.turnAttempts.startPrompt(attempt);
  await runtime.prompt(spec.prompt, undefined, {
    onRemoteRecovery: binding => {
      h.store.turnAttempts.recordRemoteRecovery(attempt, { ...binding, location: "fixture" });
    },
    onRemoteRecoveryReleased: () => {},
  });
  if (completed) h.store.turnAttempts.complete(attempt, { id: spec.id, target: spec.target,
    status: "completed", output: "resumed ok", stopReason: "end_turn", finishedUtc: new Date().toISOString() });
  if (detached) { child.detach(); runtime.releaseRecovery(); }
  return { attempt, slot: child.slot };
}

describe("session writer acquisition", () => {
  it("retires the living idle orphan, confirms its exit, then loads and sends the next dispatch once", async () => {
    const h = await savedSessionHost({ writerLock: true, recoverySleep: async () => { throw new Error("load should succeed without backoff"); } });
    try {
      const previous = await previousTurn(h);
      expect((await h.client.listSlots()).health.find(row => row.slot === previous.slot)?.alive).toBe(true);
      const router = h.makeRouter();
      const orch = h.makeOrchestrator(router);
      (orch as any).config.SEAM_DISPATCH_STATUS_PANEL = false;
      const loads: number[] = [];
      const start = router.getOrStartRuntime.bind(router);
      vi.spyOn(router, "getOrStartRuntime").mockImplementation(async (...args) => {
        loads.push(previous.slot);
        expect((await h.client.listSlots()).health.find(row => row.slot === previous.slot)?.alive).not.toBe(true);
        return start(...args);
      });
      await orch.dispatchInjectTurn({ id: "next", target: h.record.channelRef, prompt: "continue ORIGINAL-FIRST-SEND",
        kind: "handoff", session: "live", stream: false, reportBack: false, createdUtc: new Date().toISOString() });
      const requests = await h.requests();
      expect(loads).toHaveLength(1);
      expect(requests.filter(frame => frame.method === "session/load")).toHaveLength(2);
      expect(requests.filter(frame => frame.method === "session/new")).toEqual([]);
      expect(requests.filter(frame => frame.method === "session/prompt"
        && JSON.stringify(frame.params.prompt).includes("ORIGINAL-FIRST-SEND"))).toHaveLength(1);
      expect(h.store.turnAttempts.get("next")).toMatchObject({ state: "completed", promptStarted: true, acpSessionId: SAVED_SESSION });
      expect(h.commands.filter(frame => frame.type === "kill" && frame.slot === previous.slot)).toHaveLength(1);
    } finally { await h.close(); }
  }, 20_000);

  it.each(["active", "suspended", "bound"] as const)("never retires a current-turn-owned slot (%s)", async ownership => {
    const retry = vi.fn(async () => { throw new Error("backoff observed"); });
    const h = await savedSessionHost({ writerLock: true, recoverySleep: retry });
    try {
      const previous = await previousTurn(h, ownership === "bound", ownership !== "bound");
      if (ownership === "suspended") h.store.turnAttempts.suspend(previous.attempt.id, "previous-boot");
      const orch = h.makeOrchestrator(h.makeRouter());
      await expect((orch as any).acquireRecordedRuntime(h.record, "incoming", SAVED_SESSION)).rejects.toThrow("backoff observed");
      expect(retry).toHaveBeenCalledWith(30_000);
      expect(h.commands.filter(frame => frame.type === "kill" && frame.slot === previous.slot)).toEqual([]);
      expect((await h.client.listSlots()).health.find(row => row.slot === previous.slot)?.alive).toBe(true);
      expect((await h.requests()).filter(frame => frame.method === "session/prompt")).toHaveLength(1);
    } finally { await h.close(); }
  }, 20_000);

  it("does not stop an orphan that becomes owned during the last bridge read", async () => {
    const retry = vi.fn(async () => { throw new Error("backoff observed"); });
    const h = await savedSessionHost({ writerLock: true, recoverySleep: retry });
    try {
      const previous = await previousTurn(h);
      const list = h.mux.sendCmd.bind(h.mux);
      let reads = 0;
      vi.spyOn(h.mux, "sendCmd").mockImplementation(async (...args) => {
        const reply = await list(...args);
        if (args[0] === "listSlots" && ++reads === 2) {
          const owner = h.store.turnAttempts.claim({ id: "new-owner", target: h.record.channelRef,
            kind: "handoff", session: "live", prompt: "recorded turn" }, "fixture-identity", "previous-boot");
          h.store.turnAttempts.bind(owner, SAVED_SESSION);
          h.store.turnAttempts.recordRemoteRecovery(owner, h.store.turnAttempts.get(previous.attempt.id)!.remoteRecovery!);
        }
        return reply;
      });
      const router = h.makeRouter();
      const start = vi.spyOn(router, "getOrStartRuntime");
      await expect((h.makeOrchestrator(router) as any).acquireRecordedRuntime(h.record, "incoming", SAVED_SESSION))
        .rejects.toThrow("backoff observed");
      expect(start).not.toHaveBeenCalled();
      expect(retry).toHaveBeenCalledWith(30_000);
      expect(h.commands.filter(frame => frame.type === "kill" && frame.slot === previous.slot)).toEqual([]);
      expect((await h.client.listSlots()).health.find(row => row.slot === previous.slot)?.alive).toBe(true);
    } finally { await h.close(); }
  }, 20_000);

  it("retries a writer it cannot retire for the existing recovery window, then reports the cause once", async () => {
    const delays: number[] = [];
    let clock = Date.now();
    let now: ReturnType<typeof vi.spyOn> | undefined;
    const h = await savedSessionHost({ writerLock: true, recoverySleep: async ms => {
      delays.push(ms);
      clock += ms;
    } });
    try {
      const previous = await previousTurn(h, false);
      const router = h.makeRouter();
      const collision = await router.getOrStartRuntime(h.record).then(() => {
        throw new Error("expected the real writer collision");
      }, error => error);
      const load = vi.spyOn(router, "getOrStartRuntime").mockRejectedValue(collision);
      clock = Date.now();
      now = vi.spyOn(Date, "now").mockImplementation(() => clock);
      const orch = h.makeOrchestrator(router);
      await expect(new DispatchAcquisitionPhase("incoming", "execution").acquire(() =>
        (orch as any).acquireRecordedRuntime(h.record, "incoming", SAVED_SESSION)))
        .rejects.toMatchObject({ suspension: "defect", reason: "Codex was still attached to this session from the previous turn" });
      expect(delays).toEqual([30_000, 30_000, 120_000, 300_000, 419_999]);
      expect(load).toHaveBeenCalledTimes(6);
      expect((await h.requests()).filter(frame => frame.method === "session/load")).toHaveLength(2);
      expect((await h.requests()).filter(frame => frame.method === "session/prompt")).toHaveLength(1);
      expect(h.commands.filter(frame => frame.type === "kill" && frame.slot === previous.slot)).toEqual([]);
    } finally {
      now?.mockRestore();
      await h.close();
    }
  }, 20_000);
});

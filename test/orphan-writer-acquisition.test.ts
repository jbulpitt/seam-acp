import { describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
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
  it.each(["new session", "no bridge", "warm runtime", "no slot inventory"] as const)("does not inspect orphan slots for %s", async mode => {
    const h = await savedSessionHost();
    try {
      const router = h.makeRouter();
      const orch = h.makeOrchestrator(router);
      if (mode === "new session") h.record.acpSessionId = "";
      if (mode === "no bridge") (orch as any).bridgeHub = undefined;
      if (mode === "warm runtime") vi.spyOn(router, "hasRuntime").mockReturnValue(true);
      if (mode === "no slot inventory") (orch as any).bridgeHub = {};
      const runtime = {} as Awaited<ReturnType<typeof router.getOrStartRuntime>>;
      const start = vi.spyOn(router, "getOrStartRuntime").mockResolvedValue(runtime);
      const config = vi.spyOn(router, "describeConfig").mockImplementation(() => {
        throw new Error("orphan lookup should not read configuration here");
      });
      const inventory = vi.spyOn(h.mux, "sendCmd");
      await expect((orch as any).acquireRecordedRuntime(h.record, "incoming")).resolves.toBe(runtime);
      expect(start).toHaveBeenCalledExactlyOnceWith(h.record, undefined, expect.any(Function));
      expect(config).not.toHaveBeenCalled();
      expect(inventory).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });

  it("adopts the known idle writer and sends the next dispatch once without a second load", async () => {
    const h = await savedSessionHost({ writerLock: true, recoverySleep: async () => { throw new Error("load should succeed without backoff"); } });
    try {
      const previous = await previousTurn(h);
      const before = (await h.client.listSlots()).health.find(row => row.slot === previous.slot)!;
      const writer = await fs.readFile(path.join(h.root, "session.writer"), "utf8");
      expect(before.alive).toBe(true);
      const router = h.makeRouter();
      const orch = h.makeOrchestrator(router);
      (orch as any).config.SEAM_DISPATCH_STATUS_PANEL = false;
      const acquisitions: number[] = [];
      const start = router.getOrStartRuntime.bind(router);
      vi.spyOn(router, "getOrStartRuntime").mockImplementation(async (...args) => {
        acquisitions.push(previous.slot);
        expect((await h.client.listSlots()).health.find(row => row.slot === previous.slot))
          .toMatchObject({ alive: true, pid: before.pid });
        return start(...args);
      });
      await orch.dispatchInjectTurn({ id: "next", target: h.record.channelRef, prompt: "continue ORIGINAL-FIRST-SEND",
        kind: "handoff", session: "live", stream: false, reportBack: false, createdUtc: new Date().toISOString() });
      const requests = await h.requests();
      expect(acquisitions).toHaveLength(1);
      expect(router.getRuntime(h.record.id)?.getSlot()).toBe(previous.slot);
      expect(requests.filter(frame => frame.method === "session/load")).toHaveLength(1);
      expect(requests.filter(frame => frame.method === "session/new")).toEqual([]);
      expect(requests.filter(frame => frame.method === "session/prompt"
        && JSON.stringify(frame.params.prompt).includes("ORIGINAL-FIRST-SEND"))).toHaveLength(1);
      expect(h.store.turnAttempts.get("next")).toMatchObject({ state: "completed", promptStarted: true, acpSessionId: SAVED_SESSION });
      expect(new Set(requests.filter(frame => frame.method === "session/prompt").map(frame => frame.pid)).size).toBe(1);
      expect(h.commands.filter(frame => frame.type === "rpc" && frame.method === "spawn")).toHaveLength(1);
      expect(await fs.readFile(path.join(h.root, "session.writer"), "utf8")).toBe(writer);
      expect(h.commands.filter(frame => frame.type === "kill" && frame.slot === previous.slot)).toEqual([]);
    } finally { await h.close(); }
  }, 20_000);

  it.each(["active", "suspended", "bound"] as const)("never retires a current-turn-owned slot (%s)", async ownership => {
    const retry = vi.fn(async () => { throw new Error("backoff observed"); });
    const h = await savedSessionHost({ writerLock: true, recoverySleep: retry });
    try {
      const previous = await previousTurn(h, ownership === "bound", ownership !== "bound");
      const before = (await h.client.listSlots()).health.find(row => row.slot === previous.slot)!;
      if (ownership === "suspended") h.store.turnAttempts.suspend(previous.attempt.id, "previous-boot");
      const router = h.makeRouter();
      const orch = h.makeOrchestrator(router);
      if (ownership === "bound") {
        await expect(router.getOrStartRuntime(h.record)).rejects.toThrow(/already bound/);
        await expect((orch as any).acquireRecordedRuntime(h.record, "incoming", SAVED_SESSION)).rejects.toThrow("backoff observed");
        expect(retry).toHaveBeenCalledWith(30_000);
      } else {
        const runtime = await (orch as any).acquireRecordedRuntime(h.record, "incoming", SAVED_SESSION);
        expect(runtime.getSlot()).toBe(previous.slot);
        expect(runtime.getSessionInfo()?.sessionId).toBe(SAVED_SESSION);
        expect(retry).not.toHaveBeenCalled();
      }
      expect(h.commands.filter(frame => frame.type === "kill" && frame.slot === previous.slot)).toEqual([]);
      expect((await h.client.listSlots()).health.find(row => row.slot === previous.slot))
        .toMatchObject({ alive: true, pid: before.pid });
      expect((await h.requests()).filter(frame => frame.method === "session/prompt")).toHaveLength(1);
      expect((await h.requests()).filter(frame => frame.method === "session/load")).toHaveLength(1);
      expect(h.commands.filter(frame => frame.type === "rpc" && frame.method === "spawn")).toHaveLength(1);
    } finally { await h.close(); }
  }, 20_000);

  it("adopts the same writer when a turn becomes its owner during the bridge read", async () => {
    const retry = vi.fn(async () => { throw new Error("backoff observed"); });
    const h = await savedSessionHost({ writerLock: true, recoverySleep: retry });
    try {
      const previous = await previousTurn(h);
      const before = (await h.client.listSlots()).health.find(row => row.slot === previous.slot)!;
      const list = h.mux.sendCmd.bind(h.mux);
      let reads = 0;
      vi.spyOn(h.mux, "sendCmd").mockImplementation(async (...args) => {
        const reply = await list(...args);
        if (args[0] === "listSlots" && ++reads === 1) {
          const owner = h.store.turnAttempts.claim({ id: "new-owner", target: h.record.channelRef,
            kind: "handoff", session: "live", prompt: "recorded turn" }, "fixture-identity", "previous-boot");
          h.store.turnAttempts.bind(owner, SAVED_SESSION);
          h.store.turnAttempts.recordRemoteRecovery(owner, h.store.turnAttempts.get(previous.attempt.id)!.remoteRecovery!);
        }
        return reply;
      });
      const router = h.makeRouter();
      const start = vi.spyOn(router, "getOrStartRuntime");
      const runtime = await (h.makeOrchestrator(router) as any).acquireRecordedRuntime(h.record, "incoming", SAVED_SESSION);
      expect(runtime.getSlot()).toBe(previous.slot);
      expect(start).toHaveBeenCalledTimes(1);
      expect(h.store.turnAttempts.get("new-owner")?.remoteRecovery?.slot).toBe(previous.slot);
      expect(retry).not.toHaveBeenCalled();
      expect(h.commands.filter(frame => frame.type === "kill" && frame.slot === previous.slot)).toEqual([]);
      expect((await h.client.listSlots()).health.find(row => row.slot === previous.slot))
        .toMatchObject({ alive: true, pid: before.pid });
      expect((await h.requests()).filter(frame => frame.method === "session/load")).toHaveLength(1);
      expect(h.commands.filter(frame => frame.type === "rpc" && frame.method === "spawn")).toHaveLength(1);
    } finally { await h.close(); }
  }, 20_000);

  it("refuses a foreign thread's writer for the existing recovery window and never replaces it", async () => {
    const delays: number[] = [];
    let clock = Date.now();
    let now: ReturnType<typeof vi.spyOn> | undefined;
    const h = await savedSessionHost({ writerLock: true, recoverySleep: async ms => {
      delays.push(ms);
      clock += ms;
    } });
    try {
      const previous = await previousTurn(h, false);
      const before = (await h.client.listSlots()).health.find(row => row.slot === previous.slot)!;
      const writer = await fs.readFile(path.join(h.root, "session.writer"), "utf8");
      const incoming = { ...h.record, id: "discord:foreign-thread", channelRef: "foreign-thread" };
      h.store.upsert(incoming);
      const router = h.makeRouter([incoming.channelRef]);
      const collision = await router.getOrStartRuntime(incoming).then(() => {
        throw new Error("expected the real writer collision");
      }, error => error);
      const load = vi.spyOn(router, "getOrStartRuntime").mockRejectedValue(collision);
      clock = Date.now();
      now = vi.spyOn(Date, "now").mockImplementation(() => clock);
      const orch = h.makeOrchestrator(router);
      await expect(new DispatchAcquisitionPhase("incoming", "execution").acquire(() =>
        (orch as any).acquireRecordedRuntime(incoming, "incoming", SAVED_SESSION)))
        .rejects.toMatchObject({ suspension: "defect", reason: "Codex was still attached to this session from the previous turn" });
      expect(delays).toEqual([30_000, 30_000, 120_000, 300_000, 420_000]);
      expect(load).toHaveBeenCalledTimes(6);
      expect((await h.requests()).filter(frame => frame.method === "session/load")).toHaveLength(2);
      expect((await h.requests()).filter(frame => frame.method === "session/prompt")).toHaveLength(1);
      expect((await h.requests()).filter(frame => frame.method === "session/new")).toEqual([]);
      expect(h.commands.filter(frame => frame.type === "kill" && frame.slot === previous.slot)).toEqual([]);
      expect((await h.client.listSlots()).health.find(row => row.slot === previous.slot))
        .toMatchObject({ alive: true, pid: before.pid });
      expect(await fs.readFile(path.join(h.root, "session.writer"), "utf8")).toBe(writer);
      expect(h.store.get(h.record.id)?.acpSessionId).toBe(SAVED_SESSION);
      expect(router.getRuntime(incoming.id)).toBeUndefined();
    } finally {
      now?.mockRestore();
      await h.close();
    }
  }, 20_000);

  it("reaps a truly unowned writer only after the existing sweep grace", async () => {
    const h = await savedSessionHost({ writerLock: true });
    try {
      const previous = await previousTurn(h);
      h.store.removeMisfiledSession(h.record.id, { id: "remove-fixture-owner", tier: "session",
        scope: h.record.id, summary: "Fixture owner explicitly removed",
        beforeJson: JSON.stringify(h.record), afterJson: "null" });
      expect(h.store.get(h.record.id)).toBeNull();
      const router = h.makeRouter();
      const orch = h.makeOrchestrator(router);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      orch.sweepUnownedSlots("fixture");
      await vi.advanceTimersByTimeAsync(89_999);
      expect(h.commands.filter(frame => frame.type === "kill")).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      vi.useRealTimers();
      await vi.waitFor(async () => expect((await h.client.listSlots()).health.find(row => row.slot === previous.slot)?.alive)
        .not.toBe(true));
      expect(h.commands.filter(frame => frame.type === "kill" && frame.slot === previous.slot)).toHaveLength(1);
      expect(h.commands.filter(frame => frame.type === "rpc" && frame.method === "spawn")).toHaveLength(1);
      expect((await h.requests()).filter(frame => frame.method === "session/load")).toHaveLength(1);
      expect(router.hasRuntime(h.record.id)).toBe(false);
    } finally { vi.useRealTimers(); await h.close(); }
  }, 20_000);
});

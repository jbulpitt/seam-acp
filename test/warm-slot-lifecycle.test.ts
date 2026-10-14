import { afterAll, describe, expect, it, vi } from "vitest";
import { savedSessionHost, SAVED_SESSION } from "./helpers/saved-session-recovery.js";
import { prepareSessionExecutables } from "./helpers/saved-session-executables.js";

const executables = await prepareSessionExecutables();
afterAll(() => executables.close());
const drain = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve));
};

describe("warm-slot lifecycle", () => {
  it("shutdown detaches an idle slot instead of sending cancel or kill", async () => {
    const h = await savedSessionHost(executables);
    try {
      const router = h.makeRouter();
      const runtime = await router.getOrStartRuntime(h.record);
      await runtime.prompt("continue warm-up");
      const slot = runtime.getSlot()!;
      const before = (await h.client.listSlots()).health.find(row => row.slot === slot)!;
      expect(runtime.busy).toBe(false);
      await router.disposeAll();
      await drain();
      expect(h.commands.filter(frame => frame.type === "kill")).toEqual([]);
      expect((await h.requests()).filter(frame => frame.method === "session/cancel")).toEqual([]);
      expect((await h.client.listSlots()).health.find(row => row.slot === slot))
        .toMatchObject({ alive: true, pid: before.pid });
      expect(h.store.get(h.record.id)?.acpSessionId).toBe(SAVED_SESSION);
    } finally { await h.close(); }
  }, 15_000);

  it("shutdown detaches a busy prompt without recovery delegation (/context shape)", async () => {
    const h = await savedSessionHost(executables);
    try {
      const router = h.makeRouter();
      const runtime = await router.getOrStartRuntime(h.record);
      const prompt = runtime.prompt("long job").catch(() => undefined);
      await vi.waitFor(async () => expect((await h.requests()).some(row => row.method === "session/prompt")).toBe(true));
      const slot = runtime.getSlot()!;
      const before = (await h.client.listSlots()).health.find(row => row.slot === slot)!;
      expect(runtime.busy).toBe(true);
      expect(runtime.hasDelegatedTurnInFlight()).toBe(false);
      await router.disposeAll();
      await drain();
      expect(h.commands.filter(frame => frame.type === "kill")).toEqual([]);
      expect((await h.requests()).filter(frame => frame.method === "session/cancel")).toEqual([]);
      expect((await h.client.listSlots()).health.find(row => row.slot === slot))
        .toMatchObject({ alive: true, pid: before.pid });
      await prompt;
    } finally { await h.close(); }
  }, 15_000);

  it("reconnect sweep adopts a known session and the next turn uses the same writer", async () => {
    const h = await savedSessionHost({ ...executables, writerLock: true });
    try {
      const previous = h.makeRouter();
      const runtime = await previous.getOrStartRuntime(h.record);
      await runtime.prompt("continue warm-up");
      const slot = runtime.getSlot()!;
      const before = (await h.client.listSlots()).health.find(row => row.slot === slot)!;
      // Detach directly so RED isolates the reconnect bug, not shutdown's kill.
      await runtime.detach();
      const replacement = h.makeRouter();
      const orch = h.makeOrchestrator(replacement);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      orch.sweepUnownedSlots("fixture");
      await vi.advanceTimersByTimeAsync(90_000);
      vi.useRealTimers();
      await drain();
      await vi.waitFor(() => expect(replacement.hasRuntime(h.record.id)).toBe(true));
      expect(h.commands.filter(frame => frame.type === "kill")).toEqual([]);
      expect(replacement.getRuntime(h.record.id)?.getSlot()).toBe(slot);
      expect(replacement.getRuntime(h.record.id)?.busy).toBe(false);
      const result = await orch.injectTurn(h.store.get(h.record.id)!, "continue next turn", { session: "live" });
      expect(result.error).toBeUndefined();
      expect((await h.client.listSlots()).health.find(row => row.slot === slot))
        .toMatchObject({ alive: true, pid: before.pid });
      const requests = await h.requests();
      expect(requests.filter(row => row.method === "initialize")).toHaveLength(1);
      expect(requests.filter(row => row.method === "session/load")).toHaveLength(1);
      expect(requests.filter(row => row.method === "session/new")).toEqual([]);
      expect(new Set(requests.filter(row => row.method === "session/prompt").map(row => row.pid)).size).toBe(1);
      expect(requests.filter(row => row.method === "session/prompt").map(row => row.params.sessionId))
        .toEqual([SAVED_SESSION, SAVED_SESSION]);
    } finally { vi.useRealTimers(); await h.close(); }
  }, 20_000);

  it("the first turn after boot adopts an idle loaded session before any delegated prompt", async () => {
    const h = await savedSessionHost(executables);
    try {
      const previous = h.makeRouter();
      const runtime = await previous.getOrStartRuntime(h.record);
      const slot = runtime.getSlot()!;
      const before = (await h.client.listSlots()).health.find(row => row.slot === slot)!;
      await runtime.detach();
      await h.restartBridge();
      const router = h.makeRouter();
      const orch = h.makeOrchestrator(router);
      const result = await orch.injectTurn(h.record, "continue after boot", { session: "live" });
      expect(result.error).toBeUndefined();
      expect(router.getRuntime(h.record.id)?.getSlot()).toBe(slot);
      expect((await h.client.listSlots()).health.find(row => row.slot === slot))
        .toMatchObject({ alive: true, pid: before.pid });
      expect((await h.requests()).filter(row => row.method === "session/load")).toHaveLength(1);
      expect(h.commands.filter(frame => frame.type === "rpc" && frame.method === "spawn")).toHaveLength(1);
    } finally { await h.close(); }
  }, 20_000);

  it("waits for a retained non-delegated prompt before sending the successor", async () => {
    const h = await savedSessionHost(executables);
    try {
      const previous = h.makeRouter();
      previous.setAskUser(() => new Promise(() => {}));
      const runtime = await previous.getOrStartRuntime(h.record);
      const original = runtime.prompt("continue client reply").catch(() => undefined);
      const slot = runtime.getSlot()!;
      const permission = { requestId: "fixture-client-reply", sessionId: SAVED_SESSION, toolCallId: "fixture-call" };
      await vi.waitFor(async () => expect(await h.slots.permissionControl(slot, "permission_status", permission))
        .toMatchObject({ state: "pending" }));
      await previous.disposeAll();
      await original;
      await h.restartBridge();
      const router = h.makeRouter();
      router.setAskUser(() => new Promise(() => {}));
      const retained = await router.getOrStartRuntime(h.record);
      expect(retained.getSlot()).toBe(slot);
      expect(retained.busy).toBe(true);
      expect(await h.slots.permissionControl(slot, "permission_status", permission))
        .toMatchObject({ state: "pending" });
      const next = retained.prompt("continue successor");
      void next.catch(() => {});
      await drain();
      expect((await h.requests()).filter(row => row.method === "session/prompt")).toHaveLength(1);
      await h.slots.permissionControl(slot, "answer_permission", permission,
        { outcome: { outcome: "selected", optionId: "allow" } });
      await expect(next).resolves.toMatchObject({ stopReason: "end_turn" });
      expect((await h.requests()).filter(row => row.method === "session/prompt")).toHaveLength(2);
      expect((await h.requests()).filter(row => row.method === "session/load")).toHaveLength(1);
      expect(h.commands.filter(frame => frame.type === "kill")).toEqual([]);
    } finally { await h.close(); }
  }, 20_000);
});

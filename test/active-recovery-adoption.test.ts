import { afterAll, describe, expect, it, vi } from "vitest";
import { savedSessionHost, SAVED_SESSION } from "./helpers/saved-session-recovery.js";
import { prepareSessionExecutables } from "./helpers/saved-session-executables.js";
import { createRuntimeDispatchWatcher } from "../packages/core/src/core/dispatch/watcher.js";
import { DispatchSuspendedError } from "../packages/core/src/core/dispatch/attempt-store.js";

const executables = await prepareSessionExecutables();
afterAll(() => executables.close());
const drain = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve));
};

describe("same-controller recovery adoption", () => {
  it("releases the failed invocation's local owner instead of refusing the same slot on every reconciliation tick", async () => {
    const h = await savedSessionHost({ ...executables, connectionFailure: true });
    const router = h.makeRouter();
    const orch = h.makeOrchestrator(router);
    const warnings = vi.spyOn((orch as any).logger, "warn");
    const watcher = createRuntimeDispatchWatcher({ runtime: orch, attempts: h.store.turnAttempts,
      dataDir: h.root, logger: (orch as any).logger, pollMs: 1_000_000 });
    orch.setDispatchWatcher(watcher);
    try {
      await orch.loadPlugins();
      await watcher.start();
      const original = await router.getOrStartRuntime(h.record);
      const slot = original.getSlot()!;
      const detach = vi.spyOn(original, "detach");
      const failed = await orch.dispatchInjectTurn({ id: "failed-503", target: h.record.channelRef,
        prompt: "continue original task", session: "live", kind: "handoff", stream: false,
        createdUtc: new Date().toISOString() }).catch(error => error);
      expect(failed).toBeInstanceOf(DispatchSuspendedError);
      expect(h.store.get(h.record.id)?.acpSessionId).toBe(SAVED_SESSION);

      // Exercise the same reconciliation wakeup as the production one-second tick.
      for (let tick = 0; tick < 5; tick++) {
        await orch.reconcileRemoteRecoveries();
        await drain();
      }
      const refusals = warnings.mock.calls.filter(([, message]) =>
        message === "bridge recovery rebind unavailable; waiting without ending its work");
      expect(refusals.map(([fields]) => (fields as any).err.message)).toEqual([]);
      expect(detach).toHaveBeenCalledOnce();
      expect(h.commands.findIndex(cmd => cmd.action === "replayOutput" && cmd.payload.slot === slot)).toBeGreaterThan(-1);
      await vi.waitFor(() => expect(h.store.turnAttempts.get("failed-503")?.outcome?.status).toBe("completed"),
        { timeout: 10_000 });
      const requests = await h.requests();
      const prompts = requests.filter(request => request.method === "session/prompt");
      expect(prompts).toHaveLength(2);
      expect(prompts[1].params.prompt.map((part: any) => part.text ?? "").join("")).not.toContain("continue original task");
      expect(prompts.every(request => request.params.sessionId === SAVED_SESSION)).toBe(true);
      expect(requests.filter(request => request.method === "session/new")).toEqual([]);
      expect(requests.filter(request => request.method === "session/cancel")).toEqual([]);
      expect(h.commands.findIndex(cmd => cmd.type === "kill" && cmd.slot === slot)).toBeGreaterThan(
        h.commands.findIndex(cmd => cmd.action === "replayOutput" && cmd.payload.slot === slot));
      expect(h.notices.filter(notice => notice.text.includes("resumed ok"))).toHaveLength(1);
      await orch.reconcileRemoteRecoveries();
      await drain();
      expect((await h.requests()).filter(request => request.method === "session/prompt")).toHaveLength(2);
    } finally {
      watcher.stop();
      orch.suspendForRestart();
      await drain();
      await h.close();
      vi.restoreAllMocks();
    }
  }, 20_000);
});

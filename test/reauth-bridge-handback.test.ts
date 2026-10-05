import { describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { savedSessionHost, SAVED_SESSION } from "./helpers/saved-session-recovery.js";
import { createRuntimeDispatchWatcher } from "../packages/core/src/core/dispatch/watcher.js";
import { enqueueDispatchSpec } from "../packages/core/src/core/dispatch/types.js";
import { acceptReauthWait } from "../packages/core/src/core/reauth-negotiation.js";
import { makeChoiceCustomId } from "../packages/core/src/core/choice/types.js";
import type { ChoiceInteraction } from "../packages/core/src/platforms/chat-adapter.js";

async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

describe("terminal auth recovery handback", () => {
  it.each(["new", "retained-waiting", "retained-accepted"] as const)("continues once in the recorded session: %s", async mode => {
    const retained = mode !== "new";
    const h = await savedSessionHost({ authFailure: true, oldAuthDisarm: retained });
    const router = h.makeRouter();
    const orch = h.makeOrchestrator(router);
    Object.assign((orch as any).adapter, {
      sendChoiceCard: async (channel: unknown) => ({ channel, id: "auth-card" }),
      editChoiceCard: async () => {},
    });
    const sendCmd = h.mux.sendCmd.bind(h.mux);
    let oldBridge = retained;
    const commands = vi.spyOn(h.mux, "sendCmd").mockImplementation(async (action, payload, timeout) => {
      if (oldBridge && action === "disarmRung1Recovery") return { disarmed: false };
      return sendCmd(action, payload, timeout);
    });
    const adopt = vi.spyOn(h.mux, "adopt");
    const watcher = createRuntimeDispatchWatcher({ runtime: orch, attempts: h.store.turnAttempts,
      dataDir: h.root, logger: pino({ level: "silent" }), pollMs: 1_000_000 });
    orch.setDispatchWatcher(watcher);
    const requeue = vi.spyOn(watcher, "requeueStale");
    const id = "11111111-1111-4111-8111-111111111111";
    try {
      await watcher.start();
      await enqueueDispatchSpec(h.root, { id, target: h.record.channelRef, session: "live",
        location: "fixture", agentId: "codex", prompt: "ORIGINAL-DO-NOT-REPLAY",
        createdUtc: new Date().toISOString(), kind: "wake", reportBack: false }, h.store.turnAttempts);
      await watcher.tick();
      const parked = h.store.turnAttempts.get(id)!;
      expect(parked).toMatchObject({ state: "suspended", promptStarted: true, acpSessionId: SAVED_SESSION });
      expect(parked.stalledReason).toMatch(/^reauth-waiting:/);
      expect(Boolean(parked.remoteRecovery)).toBe(retained);
      const oldSlot = router.getRuntime(h.record.id)!.getSlot()!;
      const oldPid = (await h.client.listSlots()).health.find(row => row.slot === oldSlot)!.pid;
      if (retained) {
        expect(await h.slots.disarmRecovery(oldSlot, "another-submission")).toEqual({ disarmed: false });
        expect((await h.client.listSlots()).health.find(row => row.slot === oldSlot)?.pid).toBe(oldPid);
      }
      const card = h.store.listOpenChoiceCards("discord", h.record.channelRef)[0]!;
      expect(card.options[0]!.payload).toBe(`reauth-accept:${id}`);

      if (mode === "retained-accepted") expect(acceptReauthWait(h.store.turnAttempts, id)).not.toBeNull();
      oldBridge = false;
      await orch.reconcileRemoteRecoveries();
      expect(h.store.turnAttempts.get(id)?.remoteRecovery).toBeUndefined();
      expect(adopt).not.toHaveBeenCalled();
      if (retained) expect((await h.client.listSlots()).health.find(row => row.slot === oldSlot)?.alive).toBe(false);
      else expect((await h.client.listSlots()).health.find(row => row.slot === oldSlot)?.pid).toBe(oldPid);

      const replies: string[] = [];
      const click: ChoiceInteraction = { kind: "button", channel: { platform: "discord", id: h.record.channelRef },
        customId: makeChoiceCustomId(card.id, 0), messageId: "auth-card", userId: "fixture-user", userName: "Fixture",
        deferUpdate: async () => {}, replyEphemeral: async text => { replies.push(text); },
        followUpEphemeral: async text => { replies.push(text); }, showModal: async () => {} };
      if (mode !== "retained-accepted") {
        await watcher.tick();
        expect((await h.requests()).filter(row => row.method === "session/prompt")).toHaveLength(1);
        expect(h.store.turnAttempts.get(id)?.state).toBe("suspended");
        await (orch as any).handleChoiceCardInteraction(click);
        await (orch as any).handleChoiceCardInteraction(click);
        expect(replies.join("\n")).toContain("original prompt is not sent again");
      }
      await until(() => requeue.mock.results.length > 0, "accepted continuation admission");
      await requeue.mock.results[0]!.value;
      await watcher.tick();
      await until(() => h.store.turnAttempts.get(id)?.state === "completed", "continued turn completion");
      const completed = h.store.turnAttempts.get(id)!;
      expect(completed).toMatchObject({ generation: parked.generation + 1, promptStarted: true,
        acpSessionId: SAVED_SESSION, outcome: { status: "completed" } });
      const requests = await h.requests();
      const prompts = requests.filter(row => row.method === "session/prompt");
      expect(prompts).toHaveLength(2);
      expect(prompts.map(row => row.params.sessionId)).toEqual([SAVED_SESSION, SAVED_SESSION]);
      expect(JSON.stringify(prompts[0])).toContain("ORIGINAL-DO-NOT-REPLAY");
      expect(JSON.stringify(prompts[1])).not.toContain("ORIGINAL-DO-NOT-REPLAY");
      expect(prompts[1].params.prompt[0].text).toMatch(/^continue\n/);
      expect(requests.filter(row => row.method === "session/new")).toEqual([]);
      expect(requests.filter(row => row.method === "session/load")).toHaveLength(retained ? 2 : 1);
      expect(requeue).toHaveBeenCalledTimes(1);
      expect(commands.mock.calls.some(([action]) => action === "disarmRung1Recovery")).toBe(true);
    } finally {
      watcher.stop();
      commands.mockRestore();
      adopt.mockRestore();
      requeue.mockRestore();
      await h.close();
    }
  }, 30_000);

  it("does not retire an old child whose submission completed successfully", async () => {
    const h = await savedSessionHost({ oldAuthDisarm: true });
    try {
      const runtime = await h.makeRouter().getOrStartRuntime(h.record);
      const slot = runtime.getSlot()!;
      const pid = (await h.client.listSlots()).health.find(row => row.slot === slot)!.pid;
      await h.slots.armRecovery(slot, { submissionId: "completed-submission",
        acpSessionId: SAVED_SESSION, continuation: "continue" });
      await runtime.prompt("continue");
      expect(await h.slots.disarmRecovery(slot, "completed-submission")).toEqual({ disarmed: false });
      expect((await h.client.listSlots()).health.find(row => row.slot === slot)).toMatchObject({ alive: true, pid });
    } finally { await h.close(); }
  }, 20_000);
});

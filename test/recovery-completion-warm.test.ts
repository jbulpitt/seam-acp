import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { readSessiondProcessIdentity } from "../packages/bridge/src/sessiond-server.js";
import { executionIdentity } from "../packages/core/src/core/dispatch/execution-identity.js";
import { ElicitationManager } from "../packages/core/src/core/elicitation/manager.js";
import { elicitationCustomId } from "../packages/core/src/core/elicitation/types.js";
import type { ChannelRef, ComponentEvent, DeliveryNonceLookup, DeliveryNonceOptions, ElicitationCardPost, MessageRef } from "../packages/core/src/platforms/chat-adapter.js";
import { savedSessionHost, SAVED_SESSION } from "./helpers/saved-session-recovery.js";
import { prepareSessionExecutables } from "./helpers/saved-session-executables.js";

const executables = await prepareSessionExecutables();
afterAll(() => executables.close());

describe("recovered completion retains the known-session writer", () => {
  it.each(["answered", "operator cancelled"])("%s: adopts the original delegated form request", async mode => {
    const h = await savedSessionHost({ ...executables, writerLock: true });
    const cards: ElicitationCardPost[] = [];
    const edits: Array<{ ref: MessageRef; card: ElicitationCardPost }> = [];
    const receipts = new Map<string, { message: MessageRef; at: number }>();
    const adapter = {
      sendMessage: async (channel: ChannelRef, text: string, delivery?: DeliveryNonceOptions) => {
        const key = `${channel.id}:${delivery?.nonce}`;
        const prior = delivery?.nonce && receipts.get(key);
        if (prior && delivery?.enforceNonce) return prior.message;
        const message = { channel, id: `fixture-message-${h.notices.length}` };
        h.notices.push({ channel, text });
        if (delivery?.nonce) receipts.set(key, { message, at: Date.now() });
        return message;
      },
      findMessageByNonce: async (channel: ChannelRef, nonce: string, sinceMs: number): Promise<DeliveryNonceLookup> => {
        const receipt = receipts.get(`${channel.id}:${nonce}`);
        return receipt && receipt.at >= sinceMs ? { status: "found", message: receipt.message } : { status: "absent" };
      },
      sendElicitationCard: async (_channel: unknown, card: ElicitationCardPost) => {
        cards.push(card);
        return { channel: { platform: "discord", id: h.record.channelRef }, id: "original-form-card" };
      },
      editElicitationCard: async (ref: MessageRef, card: ElicitationCardPost) => { edits.push({ ref, card }); },
    };
    let old: ReturnType<typeof h.makeOrchestrator> | undefined;
    let next: ReturnType<typeof h.makeOrchestrator> | undefined;
    try {
      const oldRouter = h.makeRouter();
      old = h.makeOrchestrator(oldRouter, adapter);
      (old as any).currentAuthorIds.set(h.record.channelRef, "fixture-user");
      const runtime = await oldRouter.getOrStartRuntime(h.record);
      h.store.turnAttempts.registerOwner("outgoing-controller");
      const spec = { id: "recovered-form", target: h.record.channelRef, prompt: "continue form question",
        session: "live" as const, kind: "parked" as const, createdUtc: new Date().toISOString() };
      const identity = executionIdentity({ agent: "codex", location: "fixture", session: "live",
        model: "default", cwd: h.root, config: {} });
      const attempt = h.store.turnAttempts.claim(spec, identity, "outgoing-controller", "dispatch");
      h.store.turnAttempts.bind(attempt, SAVED_SESSION);
      h.store.turnAttempts.startPrompt(attempt);
      const original = runtime.prompt(spec.prompt, undefined, {
        onRemoteRecovery: binding => h.store.turnAttempts.recordRemoteRecovery(attempt, { ...binding, location: "fixture" }),
        onRemoteRecoveryReleased: () => {},
      }).catch(error => error);
      await vi.waitFor(() => expect(cards).toHaveLength(1), { timeout: 10_000 });
      const row = h.store.listOpenElicitations()[0]!;
      const slot = runtime.getSlot()!;
      const before = (await h.client.listSlots()).health.find(item => item.slot === slot)!;
      const agentPid = (await h.requests()).find(item => item.method === "initialize")!.pid;
      const holder = JSON.parse(fs.readFileSync(path.join(h.root, "slots.json"), "utf8")).slots
        .find((item: any) => item.slot === slot).identity;
      const identities = [holder, readSessiondProcessIdentity(before.pid!), readSessiondProcessIdentity(agentPid)];
      expect(identities.every(Boolean)).toBe(true);
      expect(h.store.turnAttempts.get(attempt.id)?.remoteRecovery).toMatchObject({ slot, acpSessionId: SAVED_SESSION });

      old.suspendForRestart();
      await oldRouter.disposeAll();
      await original;
      h.store.turnAttempts.suspendBoot("outgoing-controller");
      expect(h.commands.filter(frame => frame.type === "kill")).toEqual([]);
      expect(h.store.getElicitation(row.id)).toMatchObject({ status: "open", messageId: "original-form-card" });

      const router = h.makeRouter();
      next = h.makeOrchestrator(router, adapter);
      await next.recoverElicitations();
      const adoption = (next as any).adoptRemoteRecoveryOwned(h.store.turnAttempts.get(attempt.id)) as Promise<boolean>;
      await vi.waitFor(() => expect(router.getRuntime(h.record.id)?.getSlot()).toBe(slot), { timeout: 10_000 });
      const adopted = router.getRuntime(h.record.id)!;
      expect(cards).toHaveLength(1);
      for (const process of identities) expect(readSessiondProcessIdentity(process!.pid)).toEqual(process);

      if (mode === "operator cancelled") {
        h.store.turnAttempts.cancel(attempt.id);
        await expect(adoption).resolves.toBe(true);
        await vi.waitFor(async () => expect((await h.client.listSlots()).health.find(item => item.slot === slot)?.alive)
          .not.toBe(true), { timeout: 10_000 });
        expect(h.store.turnAttempts.get(attempt.id)?.state).toBe("cancelled");
        expect(h.commands.filter(frame => frame.type === "kill" && frame.slot === slot)).toHaveLength(1);
        return;
      }

      const click = { customId: elicitationCustomId("bool", row.id, "1"), messageId: "original-form-card",
        channel: { platform: "discord", id: h.record.channelRef }, userId: "fixture-user", userName: "Fixture",
        interactionId: "original-card-answer", kind: "button", deferUpdate: vi.fn(async () => {}),
        replyEphemeral: vi.fn(async () => {}), followUpEphemeral: vi.fn(async () => {}) } as unknown as ComponentEvent;
      const manager = (next as any).elicitations as ElicitationManager;
      await manager.handleComponent(click);
      await expect(adoption).resolves.toBe(true);
      expect(h.store.turnAttempts.get(attempt.id)).toMatchObject({ state: "completed", deliveryDone: true,
        outcome: { status: "completed", output: "resumed ok", stopReason: "end_turn" } });
      expect(h.store.getElicitation(row.id)).toMatchObject({ status: "accepted", messageId: "original-form-card", valuesJson: "{}" });
      expect(h.notices.filter(item => item.text.includes("resumed ok"))).toHaveLength(1);
      expect(edits.at(-1)).toMatchObject({ ref: { id: "original-form-card" }, card: { panel: { footer: "✅ Completed" } } });
      expect(edits.at(-1)!.card.buttons ?? []).toEqual([]);
      expect(h.commands.filter(frame => frame.type === "kill")).toEqual([]);
      expect(router.getRuntime(h.record.id)).toBe(adopted);
      expect(adopted.busy).toBe(false);
      for (const process of identities) expect(readSessiondProcessIdentity(process!.pid)).toEqual(process);

      await manager.handleComponent(click);
      const warm = await router.getOrStartRuntime(h.store.get(h.record.id)!);
      expect(warm).toBe(adopted);
      expect(warm.getSlot()).toBe(slot);
      await expect(warm.prompt("continue next turn")).resolves.toMatchObject({ stopReason: "end_turn" });
      const requests = await h.requests();
      expect(requests.filter(item => item.method === "elicitation/response"))
        .toEqual([expect.objectContaining({ pid: agentPid, params: { action: "accept", content: { proceed: true } } })]);
      expect(requests.filter(item => item.method === "session/prompt")).toHaveLength(2);
      expect(requests.filter(item => item.method === "session/prompt").map(item => item.params.sessionId))
        .toEqual([SAVED_SESSION, SAVED_SESSION]);
      expect(requests.filter(item => item.method === "session/load")).toHaveLength(1);
      expect(new Set(requests.map(item => item.pid))).toEqual(new Set([agentPid]));
      expect(h.commands.filter(frame => frame.type === "rpc" && frame.method === "spawn")).toHaveLength(1);
      expect(h.commands.filter(frame => frame.type === "kill")).toEqual([]);
      expect((await h.client.listSlots()).health.find(item => item.slot === slot)).toMatchObject({ alive: true, pid: before.pid });
      for (const process of identities) expect(readSessiondProcessIdentity(process!.pid)).toEqual(process);
    } finally {
      old?.suspendForRestart(); next?.suspendForRestart();
      (next as any)?.remoteAdoptionFinishers.get("recovered-form")?.();
      await h.close();
    }
  }, 25_000);
});

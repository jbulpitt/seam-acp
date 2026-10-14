import { afterAll, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import fs from "node:fs";
import path from "node:path";
import { readSessiondProcessIdentity } from "../packages/bridge/src/sessiond-server.js";
import { ElicitationManager } from "../packages/core/src/core/elicitation/manager.js";
import { elicitationCustomId } from "../packages/core/src/core/elicitation/types.js";
import { PendingPermissions } from "../packages/bridge/src/pending-permissions.js";
import type { ComponentEvent, ElicitationCardPost } from "../packages/core/src/platforms/chat-adapter.js";
import { savedSessionHost, SAVED_SESSION } from "./helpers/saved-session-recovery.js";
import { prepareSessionExecutables } from "./helpers/saved-session-executables.js";

const executables = await prepareSessionExecutables();
afterAll(() => executables.close());
const until = async (predicate: () => unknown) => vi.waitFor(() => expect(predicate()).toBeTruthy(), { timeout: 10_000 });

describe("ordinary elicitation lifecycle", () => {
  it("boot reconciles an unanswered form against its live owner without freezing or reposting the card", async () => {
    const h = await savedSessionHost(executables);
    const cards: ElicitationCardPost[] = [];
    const adapter = {
      sendElicitationCard: async (_channel: unknown, card: ElicitationCardPost) => {
        cards.push(card); return { channel: { platform: "discord", id: h.record.channelRef }, id: "same-form-card" };
      }, editElicitationCard: vi.fn(async () => {}),
    };
    const old = h.makeOrchestrator(h.makeRouter(), adapter);
    const next = h.makeOrchestrator(h.makeRouter(), adapter);
    try {
      (old as any).currentAuthorIds.set(h.record.channelRef, "fixture-user");
      const runtime = await (old as any).router.getOrStartRuntime(h.record);
      void runtime.prompt("continue form question").catch(() => {});
      await until(() => cards.length === 1);
      const row = h.store.listOpenElicitations()[0]!;
      await next.recoverElicitations();
      expect(h.store.getElicitation(row.id)).toMatchObject({ status: "open", messageId: "same-form-card", authorizedUserId: "fixture-user" });
      expect(cards).toHaveLength(1);
      expect(adapter.editElicitationCard).not.toHaveBeenCalled();
    } finally { old.suspendForRestart(); next.suspendForRestart(); await h.close(); }
  }, 20_000);

  it("keeps codex_async recovery and answer admission separate from ordinary request replay", async () => {
    const h = await savedSessionHost(executables);
    let sent = 0;
    const owner = vi.fn(async () => { throw new Error("async questions have no waiting ACP request"); });
    const admitted = vi.fn(async () => true);
    const options = { store: h.store, logger: pino({ level: "silent" }), currentUserId: () => "fixture-user",
      adapter: { sendElicitationCard: async () => { sent++; return { channel: { platform: "discord", id: h.record.channelRef }, id: "async-card" }; },
        editElicitationCard: async () => {} } as never,
      owner, onCodexAsyncAnswer: admitted };
    const old = new ElicitationManager(options as any);
    const next = new ElicitationManager(options as any);
    try {
      expect(await old.createCodexAsync(h.record, { itemId: "async-question", threadId: SAVED_SESSION, turnId: "turn",
        questions: [{ title: "Proceed?", options: ["Continue", "Wait"] }] })).toMatchObject({ ok: true });
      const row = h.store.listOpenElicitations()[0]!;
      await next.recoverOpen();
      expect(h.store.getElicitation(row.id)).toMatchObject({ source: "codex_async", status: "open", messageId: "async-card" });
      const click = { customId: elicitationCustomId("choice", row.id, "0"), messageId: "async-card",
        channel: { platform: "discord", id: h.record.channelRef }, userId: "fixture-user", userName: "Fixture",
        interactionId: "async-answer", kind: "button", replyEphemeral: vi.fn(async () => {}),
        deferUpdate: vi.fn(async () => {}), followUpEphemeral: vi.fn(async () => {}) } as unknown as ComponentEvent;
      await next.handleComponent(click);
      await next.handleComponent(click);
      expect(h.store.getElicitation(row.id)?.status).toBe("accepted");
      expect(admitted).toHaveBeenCalledTimes(1);
      expect(admitted.mock.calls[0]?.[0]).toMatchObject({ prompt: "Continue" });
      expect(owner).not.toHaveBeenCalled();
      expect(sent).toBe(1);
    } finally { old.detach?.(); next.detach?.(); await h.close(); }
  });

  it.each(["answered", "cancelled", "expired", "owner exited"])("%s: retains the original live request and card across controller detach", async mode => {
    const h = await savedSessionHost(executables);
    const cards: ElicitationCardPost[] = [];
    const edits: ElicitationCardPost[] = [];
    const adapter = {
      sendElicitationCard: async (_channel: unknown, card: ElicitationCardPost) => {
        cards.push(card); return { channel: { platform: "discord", id: h.record.channelRef }, id: "same-form-card" };
      },
      editElicitationCard: async (_ref: unknown, card: ElicitationCardPost) => { edits.push(card); },
    };
    let previous: ReturnType<typeof h.makeOrchestrator> | undefined;
    let next: ReturnType<typeof h.makeOrchestrator> | undefined;
    try {
      const oldRouter = h.makeRouter();
      previous = h.makeOrchestrator(oldRouter, adapter);
      (previous as any).currentAuthorIds.set(h.record.channelRef, "fixture-user");
      const runtime = await oldRouter.getOrStartRuntime(h.record);
      const original = runtime.prompt("continue form question").catch(error => error);
      await until(() => cards.length === 1);
      const row = h.store.listOpenElicitations()[0]!;
      const slot = runtime.getSlot()!;
      const before = (await h.client.listSlots()).health.find(item => item.slot === slot)!;
      const agentPid = (await h.requests()).find(item => item.method === "initialize")!.pid;
      const holder = JSON.parse(fs.readFileSync(path.join(h.root, "slots.json"), "utf8")).slots.find((item: any) => item.slot === slot).identity;
      const identities = [holder, readSessiondProcessIdentity(before.pid!), readSessiondProcessIdentity(agentPid)];
      expect(identities.every(Boolean)).toBe(true);
      expect(row).toMatchObject({ status: "open", messageId: "same-form-card", acpSessionId: SAVED_SESSION });
      previous.suspendForRestart();
      await oldRouter.disposeAll();
      await original;
      expect(h.store.getElicitation(row.id)?.status).toBe("open");
      expect(h.commands.filter(frame => frame.type === "kill")).toEqual([]);
      expect((await h.requests()).filter(frame => frame.method === "session/cancel")).toEqual([]);

      const newRouter = h.makeRouter();
      next = h.makeOrchestrator(newRouter, adapter);
      // Production boot has no transient author entry for this surviving request.
      await next.recoverElicitations();
      expect(h.store.getElicitation(row.id)?.status).toBe("open");
      await next.sweepUnownedSlots("fixture");
      await until(() => !!newRouter.getRuntime(h.record.id));
      expect(newRouter.getRuntime(h.record.id)?.getSlot()).toBe(slot);
      expect(cards).toHaveLength(1);
      expect(h.store.listOpenElicitations().map(item => item.id)).toEqual([row.id]);
      expect((await h.client.listSlots()).health.find(item => item.slot === slot))
        .toMatchObject({ alive: true, pid: before.pid });
      for (const identity of identities) expect(readSessiondProcessIdentity(identity!.pid)).toEqual(identity);

      const manager = (next as any).elicitations as ElicitationManager;
      const click = { customId: elicitationCustomId(mode === "cancelled" ? "cancel" : "bool", row.id, mode === "cancelled" ? undefined : "1"),
        messageId: "same-form-card", channel: { platform: "discord", id: h.record.channelRef }, userId: "fixture-user",
        userName: "Fixture", interactionId: "same-card-answer", kind: "button", deferUpdate: vi.fn(async () => {}),
        replyEphemeral: vi.fn(async () => {}), followUpEphemeral: vi.fn(async () => {}) } as unknown as ComponentEvent;
      if (mode === "owner exited") {
        await h.slots.kill(slot); // Only the native process this test started.
        await manager.recoverOpen();
        expect(h.store.getElicitation(row.id)).toMatchObject({ status: "interrupted", terminalDetail: expect.stringMatching(/agent process|owner.*(exited|gone)/i) });
      } else if (mode === "expired") {
        const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(row.expiresUtc) + 1);
        try { await manager.sweep(); } finally { clock.mockRestore(); }
        expect(h.store.getElicitation(row.id)).toMatchObject({ status: "expired", terminalDetail: "The request expired." });
      } else {
        await manager.handleComponent(click);
        await manager.handleComponent(click);
        expect(h.store.getElicitation(row.id)).toMatchObject({ status: mode === "answered" ? "accepted" : "cancelled",
          ...(mode === "cancelled" ? { terminalDetail: "Cancelled by the user." } : {}) });
      }
      if (mode !== "owner exited") {
        await vi.waitFor(async () => expect((await h.requests()).filter(item => item.method === "elicitation/response")).toHaveLength(1), { timeout: 10_000 });
        const answer = (await h.requests()).find(item => item.method === "elicitation/response")!;
        expect(answer).toMatchObject({ pid: agentPid, params: mode === "answered" ? { action: "accept", content: { proceed: true } } : { action: "cancel" } });
        await vi.waitFor(() => expect(newRouter.getRuntime(h.record.id)?.busy).toBe(false));
        await newRouter.getRuntime(h.record.id)!.prompt("continue after form");
        expect((await h.requests()).filter(item => item.method === "session/load")).toHaveLength(1);
        expect(h.commands.filter(frame => frame.type === "rpc" && frame.method === "spawn")).toHaveLength(1);
      }
      expect(cards).toHaveLength(1);
      expect(edits.at(-1)?.buttons).toEqual([]);
    } finally {
      previous?.suspendForRestart(); next?.suspendForRestart(); await h.close();
    }
  }, 25_000);

  it("retains and replays ordinary requests by ACP session and JSON-RPC id, but not after real ACP cancellation", () => {
    const written: string[] = [];
    const pending = new PendingPermissions(line => { written.push(line); return true; }, 42);
    const request = { mode: "form", sessionId: "acp", message: "Answer", requestedSchema: { type: "object", properties: {} } };
    const frame = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "elicitation/create", params: request });
    const identity = { requestId: 7, sessionId: "acp", method: "elicitation/create" as const };
    pending.observeOutput(frame);
    expect(pending.unanswered("acp").map(line => JSON.parse(line))).toEqual([JSON.parse(frame)]);
    expect(pending.status(identity as any)).toMatchObject({ state: "pending", pid: 42 });
    expect(pending.status({ ...identity, sessionId: "other" } as any)).toMatchObject({ state: "gone" });
    pending.answer(identity as any, { action: "accept" } as any);
    pending.answer(identity as any, { action: "accept" } as any);
    expect(written).toHaveLength(1);
    expect(pending.observeInput(JSON.stringify({ id: 7, result: { action: "accept" } }))).toBe(false);
    pending.observeOutput(frame);
    pending.observeOutput(JSON.stringify({ method: "$/cancel_request", params: { requestId: 7, reason: "Provider withdrew the question." } }));
    expect(pending.status(identity as any)).toMatchObject({ state: "gone", detail: expect.stringContaining("Provider withdrew the question.") });
    expect(pending.unanswered("acp")).toEqual([]);
  });
});

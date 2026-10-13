import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { pino } from "pino";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import { DEFAULT_REMOTE_RUNG1_POLICY, spawnRemoteSlot } from "../packages/core/src/core/remote-spawn.js";
import { scheduledOccurrenceKey } from "../packages/core/src/core/scheduled-prompts/occurrence-store.js";
import type { ScheduledPrompt } from "../packages/core/src/core/scheduled-prompts/types.js";
import type { ComponentEvent, ElicitationCardPost, IncomingMessage } from "../packages/core/src/platforms/chat-adapter.js";
import { savedSessionHost } from "./helpers/saved-session-recovery.js";
import { prepareSessionExecutables } from "./helpers/saved-session-executables.js";

const executables = await prepareSessionExecutables();
afterAll(() => executables.close());
afterEach(() => vi.restoreAllMocks());
const logger = pino({ level: "silent" });
const fixture = fileURLToPath(new URL("./fixtures/isolated-permission-agent.mjs", import.meta.url));

async function pendingSchedule(unbound = false) {
  const h = await savedSessionHost({ ...executables, agentFixture: fixture });
  const now = new Date().toISOString();
  h.store.upsert({ ...h.record, acpSessionId: unbound ? "" : h.record.acpSessionId,
    configJson: JSON.stringify({ permissionPolicy: "ask" }) },
  { source: "permission scope fixture", cause: "set the test thread binding" });
  const old = h.makeOrchestrator(h.makeRouter());
  const schedule: ScheduledPrompt = { id: "isolated-permission-schedule", platform: "discord", channelRef: h.record.channelRef,
    parentRef: null, name: "Independent permission", promptText: "read snapshots", cron: "0 * * * *", timezone: "UTC",
    model: null, cwd: null, targetChannel: null, outputType: "messages", sessionMode: "isolated",
    catchupSeconds: 0, enabled: true, legacyAttachmentCount: 0, createdBy: "fixture-user", createdUtc: now, updatedUtc: now,
    lastRunUtc: null, lastStatus: null, nextRunUtc: null, pinnedSessionId: null };
  h.store.upsertScheduled(schedule);
  const occurrence = h.store.scheduledOccurrences.prepare(scheduledOccurrenceKey(schedule.id), schedule,
    row => old.scheduleExecution(row))!;
  h.store.turnAttempts.registerOwner("prior-controller");
  const attempt = h.store.turnAttempts.claim({ id: occurrence.id, target: schedule.channelRef, prompt: schedule.promptText,
    session: "isolated", kind: "scheduled", createdUtc: now }, occurrence.execution.fingerprint, "prior-controller", "schedule");
  const original = new AgentRuntime({ profile: h.makeRouter().getProfile("codex", "fixture")!, logger,
    permissionPolicy: () => new Promise(() => {}), bridgeHealth: h.mux,
    spawnFn: () => spawnRemoteSlot(h.mux, { agentId: "codex", cwd: h.root, mcpServers: [],
      rung1Recovery: DEFAULT_REMOTE_RUNG1_POLICY }) });
  await original.start();
  const info = await original.newSession({ cwd: h.root });
  h.store.turnAttempts.bind(attempt, info.sessionId);
  h.store.turnAttempts.startPrompt(attempt);
  const prompt = original.prompt(schedule.promptText, undefined, {
    onRemoteRecovery: binding => h.store.turnAttempts.recordRemoteRecovery(attempt, { ...binding, location: "fixture" }),
    onRemoteRecoveryReleased: () => {}, recoveryScope: "ephemeral",
  }).catch(() => undefined);
  const slot = original.getSlot()!;
  await vi.waitFor(async () => expect(await h.slots.permissionControl(slot, "permission_status", {
    requestId: "isolated-permission", sessionId: info.sessionId, toolCallId: "isolated-tool",
  })).toMatchObject({ state: "pending" }), { timeout: 10_000 });
  await original.detach();
  await prompt;
  old.suspendForRestart();
  h.store.turnAttempts.suspendBoot("prior-controller");

  const router = h.makeRouter();
  const orch = h.makeOrchestrator(router);
  router.setAskUser((record, request, context) => orch.requestPermission(record, request, context.requestId));
  const sendCmd = h.mux.sendCmd.bind(h.mux);
  vi.spyOn(h.mux, "sendCmd").mockImplementation(async (action, payload: any, ...rest) => {
    if (action === "permissionStatus" || action === "answerPermission") {
      return h.slots.permissionControl(payload.slot, action === "permissionStatus" ? "permission_status" : "answer_permission",
        payload.permission, payload.response);
    }
    return sendCmd(action, payload, ...rest);
  });
  const posted: ElicitationCardPost[] = [];
  const edited = vi.fn(async () => {});
  Object.assign((orch as any).adapter, {
    sendElicitationCard: async (channel: unknown, card: ElicitationCardPost) => {
      posted.push(card); return { channel, id: `permission-card-${posted.length}` };
    }, editElicitationCard: edited,
  });
  let adopted!: AgentRuntime;
  const attach = AgentRuntime.prototype.attachRecovery;
  vi.spyOn(AgentRuntime.prototype, "attachRecovery").mockImplementation(function (...args) {
    adopted = this;
    return attach.apply(this, args);
  });
  const adoption = (orch as any).adoptRemoteRecoveryOwned(h.store.turnAttempts.get(attempt.id));
  await vi.waitFor(() => expect(posted).toHaveLength(1), { timeout: 10_000 });
  const card = h.store.actionCards.permissions()[0]!;
  const owner = (await h.client.listSlots()).health.find(row => row.slot === slot)!;
  const click = (): ComponentEvent => ({ customId: posted[0]!.buttons![0]!.customId!, messageId: card.messageId!,
    channel: card.channel, userId: "fixture-user", userName: "Operator", interactionId: "permission-answer", kind: "button",
    deferUpdate: vi.fn(async () => {}), replyEphemeral: vi.fn(async () => {}), followUpEphemeral: vi.fn(async () => {}),
  });
  return { h, router, orch, attempt, slot, card, owner, adopted, adoption, posted, edited, click,
    async close() { orch.suspendForRestart(); await h.close(); } };
}

describe("a live message supersedes only its own permission", () => {
  it.each([
    { name: "an idle live session", unbound: false, active: false },
    { name: "a thread with no live ACP binding", unbound: true, active: false },
    { name: "a running parallel live session", unbound: false, active: true },
  ])("keeps the scheduled card answerable alongside $name", async ({ unbound, active }) => {
    const f = await pendingSchedule(unbound);
    let live: AgentRuntime | undefined;
    try {
      if (active) {
        live = await f.router.getOrStartRuntime(f.h.store.get(f.h.record.id)!);
        void live.prompt("parallel live turn", undefined, {
          onRemoteRecovery: () => {}, onRemoteRecoveryReleased: () => {},
        }).catch(() => undefined);
        (f.orch as any).channelQueues.set(f.h.record.channelRef, Promise.resolve());
        vi.spyOn(f.router, "isBusy").mockReturnValue(true);
        vi.spyOn(f.router, "abortTurn").mockImplementation(async () => { await live!.cancel(); return "cancelled"; });
      }
      const incoming = vi.spyOn(f.orch as any, "handleIncomingMessageInner").mockResolvedValue(undefined);
      const message: IncomingMessage = { channel: f.card.channel, authorId: "fixture-user", authorIsBot: false,
        text: "An unrelated live request", raw: {}, messageId: "new-live-message" };
      await (f.orch as any).handleIncomingMessage(message);
      expect(incoming).toHaveBeenCalledOnce();
      expect(f.h.store.actionCards.getPermission(f.card.id)).toMatchObject({ status: "open", messageId: f.card.messageId });
      expect(f.edited).not.toHaveBeenCalled();
      expect((await f.h.requests()).filter(row => row.id === "isolated-permission" && row.result)).toHaveLength(0);
      expect((await f.h.client.listSlots()).health.find(row => row.slot === f.slot)).toMatchObject({ alive: true, pid: f.owner.pid });
      await (f.orch as any).actionCards.handlePermission(f.click());
      await vi.waitFor(() => expect(f.h.store.scheduledOccurrences.get(f.attempt.id)?.settled).toBe(true), { timeout: 10_000 });
      await f.adoption;
      await (f.orch as any).actionCards.handlePermission(f.click());
      const requests = await f.h.requests();
      expect(requests.filter(row => row.id === "isolated-permission" && row.result)).toEqual([
        expect.objectContaining({ result: { outcome: { outcome: "selected", optionId: "allow" } } }),
      ]);
      expect(requests.filter(row => row.method === "session/prompt" && row.params.sessionId === f.card.acpSessionId)).toHaveLength(1);
      expect(f.h.store.actionCards.getPermission(f.card.id)).toMatchObject({ status: "answered", messageId: f.card.messageId });
      expect(f.h.store.turnAttempts.get(f.attempt.id)).toMatchObject({ state: "completed", outcome: { output: "isolated finished once" } });
      expect(f.h.notices.filter(row => row.text.includes("isolated finished once"))).toHaveLength(1);
    } finally {
      await live?.detach();
      await f.close();
    }
  }, 25_000);

  it("still supersedes a live permission while leaving the scheduled permission open", async () => {
    const f = await pendingSchedule();
    let live: AgentRuntime | undefined;
    try {
      live = await f.router.getOrStartRuntime(f.h.store.get(f.h.record.id)!);
      const now = new Date().toISOString();
      f.h.store.turnAttempts.registerOwner("live-controller");
      const attempt = f.h.store.turnAttempts.claim({ id: "live-permission", target: f.h.record.channelRef,
        prompt: "live tool", session: "live", kind: "handoff", createdUtc: now }, "live-identity", "live-controller", "inbound");
      f.h.store.turnAttempts.bind(attempt, live.getSessionInfo()!.sessionId);
      f.h.store.turnAttempts.startPrompt(attempt);
      const prompt = live.prompt("live tool", undefined, {
        onRemoteRecovery: binding => f.h.store.turnAttempts.recordRemoteRecovery(attempt, { ...binding, location: "fixture" }),
        onRemoteRecoveryReleased: () => {},
      });
      await vi.waitFor(() => expect(f.h.store.actionCards.permissions().filter(row => row.status === "open")).toHaveLength(2),
        { timeout: 10_000 });
      const liveCard = f.h.store.actionCards.permissions().find(row => row.attemptId === attempt.id)!;
      vi.spyOn(f.orch as any, "handleIncomingMessageInner").mockResolvedValue(undefined);
      await (f.orch as any).handleIncomingMessage({ channel: f.card.channel, authorId: "fixture-user", authorIsBot: false,
        text: "Replace my live request", raw: {}, messageId: "replace-live-permission" });
      expect(f.h.store.actionCards.getPermission(liveCard.id)?.status).toBe("cancelled");
      expect(f.h.store.actionCards.getPermission(f.card.id)?.status).toBe("open");
      await prompt;
      await (f.orch as any).actionCards.handlePermission(f.click());
      await vi.waitFor(() => expect(f.h.store.scheduledOccurrences.get(f.attempt.id)?.settled).toBe(true), { timeout: 10_000 });
      const requests = await f.h.requests();
      expect(requests.filter(row => row.id === "isolated-permission" && row.result)).toEqual([
        expect.objectContaining({ result: { outcome: { outcome: "cancelled" } } }),
        expect.objectContaining({ result: { outcome: { outcome: "selected", optionId: "allow" } } }),
      ]);
    } finally { await live?.detach(); await f.close(); }
  }, 25_000);

  it("answers cancellation to the isolated runtime that was actually targeted", async () => {
    const f = await pendingSchedule();
    try {
      await f.adopted.cancel();
      await vi.waitFor(() => expect(f.h.store.actionCards.getPermission(f.card.id)?.status).toBe("cancelled"), { timeout: 10_000 });
      expect((await f.h.requests()).filter(row => row.id === "isolated-permission" && row.result)).toEqual([
        expect.objectContaining({ result: { outcome: { outcome: "cancelled" } } }),
      ]);
    } finally { await f.close(); }
  }, 25_000);
});

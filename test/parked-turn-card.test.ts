import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { DispatchWatcher } from "../packages/core/src/core/dispatch/watcher.js";
import { executionIdentity } from "../packages/core/src/core/dispatch/execution-identity.js";
import { parkedTurnAction, parkedTurnChoiceSpec } from "../packages/core/src/core/parked-turn-card.js";
import { makeChoiceCustomId } from "../packages/core/src/core/choice/types.js";
import { DiscordAdapter } from "../packages/core/src/platforms/discord/adapter.js";
import { SyntheticInteraction } from "../packages/core/src/platforms/discord/synthetic-interaction.js";

let dir: string;
let store: SessionStore;
const logger = pino({ level: "silent" });
const id = "d4a166f6-2222-3333-4444-555555555555";
const watchers: DispatchWatcher[] = [];

function controller() {
  const orch = Object.create(Orchestrator.prototype) as any;
  orch.store = store;
  orch.logger = logger;
  orch.config = { DATA_DIR: dir, REPOS_ROOT: dir, DISCORD_ALLOWED_USER_IDS: new Set(["user"]),
    channelPresets: new Map(), threadPresets: new Map() };
  orch.router = { ensureSessionRecord: ({ channelRef }: any) => ({ id: `discord:${channelRef}`, platform: "discord", channelRef, parentRef: "parent" }) };
  const watcher = new DispatchWatcher({ dataDir: dir, logger: logger as any, attempts: store.turnAttempts, onDispatch: async () => {} });
  watchers.push(watcher);
  orch.dispatchWatcher = watcher;
  orch.adapter = {
    sendMessage: vi.fn(async () => ({ id: "notice" })),
    sendChoiceCard: vi.fn(async () => ({ id: "notice" })),
    editChoiceCard: vi.fn(async () => {}),
    getThreadLiveState: async () => ({ locked: false, archived: false }),
  };
  return orch;
}

function click(choiceId: string, index: number) {
  return {
    customId: makeChoiceCustomId(choiceId, index), userId: "user", userName: "Ada",
    channel: { platform: "discord", id: "worker", parentId: "parent" }, messageId: "notice", kind: "button",
    replyEphemeral: vi.fn(async () => {}),
    followUpEphemeral: vi.fn(async () => {}), showModal: vi.fn(),
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-parked-card-"));
  store = new SessionStore(path.join(dir, "seam.db"));
  const spec = { id, target: "worker", kind: "handoff" as const, session: "live" as const,
    prompt: "ORIGINAL-BRIEF-DO-NOT-REPLAY", createdUtc: new Date().toISOString() };
  store.turnAttempts.registerOwner("boot");
  const attempt = store.turnAttempts.claim(spec, executionIdentity({ agent: "codex", location: "local", session: "live", model: "m", cwd: "/repo", config: {} }), "boot");
  store.turnAttempts.bind(attempt, "original-acp");
  store.turnAttempts.startPrompt(attempt);
  store.turnAttempts.markStalled(id, "connection unavailable");
});
afterEach(() => { for (const watcher of watchers.splice(0)) watcher.stop(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe("durable parked-turn notice actions", () => {
  it("claims and settles Cancel while the central ACK is pending, then replies privately", async () => {
    const orch = controller();
    orch.adapter.sendChoiceCard.mockResolvedValueOnce({ id: "notice", jumpUrl: "https://discord.com/channels/g/worker/notice" });
    const posted = await orch.postParkedTurnNotice("worker", store.turnAttempts.get(id), "connection unavailable");
    expect(posted).toMatchObject({ messageId: "notice", jumpUrl: "https://discord.com/channels/g/worker/notice" });
    const card = store.listOpenChoiceCards("discord", "worker")[0]!;
    const native = new SyntheticInteraction({ kind: "button", channelId: "worker", messageId: "notice",
      customId: makeChoiceCustomId(card.id, 1) }, {
      client: {} as never, channel: { id: "worker", parentId: "parent",
        send: vi.fn(async () => ({ id: "private-reply" })) } as never,
      user: { id: "user", username: "Ada" } as never, member: null, message: { id: "notice" } as never,
    });
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const defer = native.deferUpdate.bind(native);
    vi.spyOn(native, "deferUpdate").mockImplementation(async () => { await pending; return defer(); });
    const adapter = Object.assign(Object.create(DiscordAdapter.prototype), {
      logger, choiceAcknowledgement: "update", choiceHandler: (event: unknown) => orch.handleChoiceCardInteraction(event),
    });
    const dispatched = adapter.handleChoiceInteraction(native);
    try {
      await vi.waitFor(() => expect(store.turnAttempts.get(id)?.state).toBe("cancelled"));
      expect(store.getChoiceCard(card.id)?.clickCount).toBe(1);
      expect(native.transcript).toEqual([]);
    } finally {
      release();
      await dispatched;
    }
    expect(native.transcript.map(entry => entry.op)).toEqual(["deferUpdate", "followUp"]);
    expect(native.transcript.at(-1)?.ephemeral).toBe(true);
  });

  it("persists attempt-bound actions, then Cancel works after a controller/store replacement", async () => {
    const first = controller();
    await first.postParkedTurnNotice("worker", store.turnAttempts.get(id), "real cause: connection unavailable");
    const card = store.listOpenChoiceCards("discord", "worker")[0]!;
    expect(parkedTurnAction(card.options[1]!.payload)).toEqual({ action: "cancel", attemptId: id });
    store.close();
    store = new SessionStore(path.join(dir, "seam.db"));
    const recovered = controller();
    const interaction = click(card.id, 1);
    await recovered.handleChoiceCardInteraction(interaction);
    expect(store.turnAttempts.get(id)?.state).toBe("cancelled");
    expect(store.turnAttempts.get(id)?.spec.prompt).toBe("ORIGINAL-BRIEF-DO-NOT-REPLAY");
    expect(store.getChoiceCard(card.id)?.status).not.toBe("open");
    const secondClick = click(card.id, 1);
    await recovered.handleChoiceCardInteraction(secondClick);
    expect(secondClick.replyEphemeral).toHaveBeenCalledWith("This card is closed.");
  });

  it("Resume uses the existing suspended dispatcher and never enqueues a new original prompt", async () => {
    const orch = controller();
    const watcher = new DispatchWatcher({ dataDir: dir, logger: logger as any, attempts: store.turnAttempts, onDispatch: async () => {} });
    orch.dispatchWatcher = watcher;
    try {
      await orch.postParkedTurnNotice("worker", store.turnAttempts.get(id), "connection unavailable");
      const card = store.listOpenChoiceCards("discord", "worker")[0]!;
      const interaction = click(card.id, 0);
      await orch.handleChoiceCardInteraction(interaction);
      expect(interaction.followUpEphemeral).toHaveBeenCalledWith(expect.stringContaining("Continuation requested"));
      expect(store.turnAttempts.get(id)?.acpSessionId).toBe("original-acp");
      expect(store.turnAttempts.get(id)?.spec.prompt).toBe("ORIGINAL-BRIEF-DO-NOT-REPLAY");
      expect(store.turnAttempts.get(`${id}-resume`)).toBeNull();
    } finally { watcher.stop(); }
  });

  it("a refused Resume remains unclaimed so the operator can fix the cause or abandon", async () => {
    const orch = controller();
    orch.dispatchWatcher = { listStaleRunning: async () => [store.turnAttempts.get(id)!.spec] };
    await orch.postParkedTurnNotice("worker", store.turnAttempts.get(id), "locked target");
    const card = store.listOpenChoiceCards("discord", "worker")[0]!;
    orch.adapter.getThreadLiveState = async () => ({ locked: true, archived: false });
    const interaction = click(card.id, 0);
    await orch.handleChoiceCardInteraction(interaction);
    expect(interaction.followUpEphemeral).toHaveBeenCalledWith(expect.stringMatching(/Cannot resume/));
    expect(store.getChoiceCard(card.id)?.clickCount).toBe(0);
  });

  it.each([false, true])("notice, inventory and executor agree when promptStarted=%s", async promptStarted => {
    const orch = controller();
    const probeId = "0642639d-0244-48de-a26c-07d53bf339d1";
    const spec = { id: probeId, target: "worker", kind: "wake" as const, session: "live" as const,
      prompt: "RECORDED-PENDING-PROMPT" };
    const attempt = store.turnAttempts.claim(spec, executionIdentity({ agent: "codex", location: "local",
      session: "live", model: "m", cwd: "/repo", config: {} }), "boot");
    if (promptStarted) {
      store.turnAttempts.bind(attempt, "original-acp");
      store.turnAttempts.startPrompt(attempt);
    }
    store.turnAttempts.markStalled(probeId, "fixture load failure");
    const expected = ["resume", "cancel"];
    expect((await orch.collectInterruptedRows("worker")).find((row: any) => row.id === probeId).actions).toEqual(expected);
    await orch.postParkedTurnNotice("worker", store.turnAttempts.get(probeId), "fixture load failure");
    const card = store.listOpenChoiceCards("discord", "worker")[0]!;
    expect(card.options.map((option: any) => parkedTurnAction(option.payload)?.action)).toEqual(expected);
    const refusal = await orch.workflowActionRefusal("resume", probeId, "worker");
    expect(refusal).toBeNull();
    expect(card.body).not.toContain("Resume isn't available:");
  });

  it("internal actions remain separate from ordinary prompts and reauth acceptance", () => {
    const spec = parkedTurnChoiceSpec(id, "cause", { resume: "Resume", cancel: "Cancel" });
    expect(spec.options).toHaveLength(2);
    expect(parkedTurnAction("ordinary prompt")).toBeNull();
    expect(parkedTurnAction(`reauth-accept:${id}`)).toBeNull();
  });

  it("does not invent a replay refusal while the old watcher claim is being released", async () => {
    const orch = controller();
    const probeId = "7e7ac718-e7b4-444a-a67e-7721b52762d6";
    const spec = { id: probeId, target: "worker", kind: "wake" as const, session: "live" as const, prompt: "PENDING" };
    store.turnAttempts.claim(spec, executionIdentity({ agent: "codex", location: "local", session: "live",
      model: "m", cwd: "/repo", config: {} }), "boot");
    store.turnAttempts.markStalled(probeId, "fixture load failure");
    orch.dispatchWatcher = { listStaleRunning: async () => [] };
    await orch.postParkedTurnNotice("worker", store.turnAttempts.get(probeId), "fixture load failure");
    const card = store.listOpenChoiceCards("discord", "worker")[0]!;
    expect(card.options.map((option: any) => parkedTurnAction(option.payload)?.action)).toEqual(["resume", "cancel"]);
    expect(await orch.dispatchContinuationRefusal(spec)).toBeNull();
    expect(card.body).not.toContain("continuation cannot be distinguished from replaying");
  });

  it.each(["thread_voice", "compact"] as const)("keeps an accurate refusal for the untracked %s path", async kind => {
    const orch = controller();
    const spec = { id: `untracked-${kind}`, target: "worker", kind, session: "live" as const, prompt: "PENDING" };
    store.turnAttempts.admit(spec);
    store.turnAttempts.markStalled(spec.id, "fixture interruption");
    const reason = await orch.dispatchContinuationRefusal(spec);
    expect(reason).toContain(kind === "thread_voice" ? "this voice turn has no recorded execution" : "this compaction has no recorded execution");
    expect(reason).toContain("can't tell whether");
    expect(reason).not.toContain("replay");
    await orch.postParkedTurnNotice("worker", store.turnAttempts.get(spec.id), "fixture interruption");
    expect(store.listOpenChoiceCards("discord", "worker")).toEqual([]);
    expect(orch.adapter.sendChoiceCard).not.toHaveBeenCalled();
    expect(store.turnAttempts.get(spec.id)?.state).toBe("cancelled");
    expect(orch.adapter.sendMessage).toHaveBeenCalledWith(expect.anything(), expect.stringContaining(reason));
    expect(orch.adapter.sendMessage).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("The prompt was never sent"));
  });

  it("does not treat a legacy admission without an execution claim as first-send proof", async () => {
    const orch = controller();
    const spec = { id: "legacy-unclaimed", target: "worker", kind: "handoff" as const, session: "live" as const, prompt: "PENDING" };
    store.turnAttempts.admit(spec);
    store.turnAttempts.markStalled(spec.id, "fixture interruption");
    expect(await orch.dispatchContinuationRefusal(spec)).toBe("this legacy turn has no recorded execution, so Seam can't tell whether its prompt was sent");
    expect(await orch.dispatchContinuationRefusal({ ...spec, id: "no-row" })).toBe("this legacy turn has no recorded execution, so Seam can't tell whether its prompt was sent");
    store.recordDelegation({ id: "no-row", kind: "handoff", sourceRef: null, targetRef: "worker", worker: null,
      promptPreview: "PENDING", correlationId: null, status: "interrupted" });
    expect(await orch.resumeTurnManually("no-row")).toContain("this legacy turn has no recorded execution");
  });
  it("normalizes old Abandon card payloads to Cancel", () => {
    expect(parkedTurnAction(`parked-turn:abandon:${id}`)).toEqual({ action: "cancel", attemptId: id });
  });

  it("never invites Resume when the adapter cannot offer its button", async () => {
    const orch = controller();
    delete orch.adapter.sendChoiceCard;
    await orch.observeRetainedDispatch(store.turnAttempts.get(id)!.spec);
    expect(orch.adapter.sendMessage.mock.calls.map((call: any[]) => call[1]).join("\n")).not.toMatch(/Resume|workflows resume:/);
  });

  it("cancels an unavailable dispatch with one durable failure report-back and no card", async () => {
    const orch = controller();
    const spec = { id: "cancel-only-dispatch", target: "worker", returnTo: "requester", reportBack: true,
      kind: "handoff" as const, session: "live" as const, prompt: "UNSENT" };
    store.recordDelegation({ id: spec.id, kind: "handoff", sourceRef: "requester", targetRef: "worker",
      worker: null, promptPreview: "UNSENT", correlationId: null, status: "interrupted" });
    store.turnAttempts.admit(spec);
    await orch.observeRetainedDispatch(spec, { reason: "provider acquisition failed: missing conversation" });
    const report = store.getReportBackByCorrelation(spec.id)!;
    expect(report).toMatchObject({ kind: "report_back", targetRef: "requester" });
    const queued = store.turnAttempts.get(report.id)!;
    expect(queued.spec.prompt).toContain("provider acquisition failed: missing conversation");
    expect(queued.spec.prompt).toContain("The prompt was never sent");
    expect(store.turnAttempts.get(spec.id)).toMatchObject({ state: "cancelled", promptStarted: false });
    expect(orch.adapter.sendChoiceCard).not.toHaveBeenCalled();
    expect(orch.adapter.sendMessage).not.toHaveBeenCalled();
    await orch.observeRetainedDispatch(spec, { reason: "provider acquisition failed: missing conversation" });
    expect(store.listRecentDelegations(20).filter(row => row.kind === "report_back")).toHaveLength(1);
    expect(orch.adapter.sendMessage).not.toHaveBeenCalled();
  });

  it("cancels an already-notified dispatch when only Cancel remains available", async () => {
    const orch = controller();
    const spec = { id: "already-notified-deleted-target", target: "deleted-worker", returnTo: "requester", reportBack: true,
      kind: "handoff" as const, session: "live" as const, prompt: "UNSENT" };
    const reason = "target thread is deleted; continuation cannot currently be admitted";
    store.recordDelegation({ id: spec.id, kind: "handoff", sourceRef: "requester", targetRef: spec.target,
      worker: null, promptPreview: spec.prompt, correlationId: null, status: "interrupted" });
    store.turnAttempts.claim(spec, executionIdentity({ agent: "codex", location: "local" }), "boot");
    store.turnAttempts.markStalled(spec.id, reason);
    const posted = await orch.publishChoiceCard(orch.router.ensureSessionRecord({ channelRef: "requester" }), {
      title: "Parked turn", body: `Dispatch is parked: ${reason}. Use Resume to continue.`,
      options: [{ label: "Abandon", kind: "prompt", payload: `parked-turn:abandon:${spec.id}` }],
    });
    store.turnAttempts.markStallNoticeDelivered(spec.id);
    orch.adapter.getThreadLiveState = async () => undefined;
    orch.adapter.sendChoiceCard.mockClear();

    await orch.observeRetainedDispatch(spec, { reason });
    await orch.observeRetainedDispatch(spec, { reason });

    expect(store.turnAttempts.get(spec.id)).toMatchObject({ state: "cancelled", promptStarted: false });
    const report = store.getReportBackByCorrelation(spec.id)!;
    expect(report).toMatchObject({ kind: "report_back", targetRef: "requester" });
    expect(store.turnAttempts.get(report.id)!.spec.prompt).toContain(reason);
    expect(store.turnAttempts.get(report.id)!.spec.prompt).toContain("The prompt was never sent");
    expect(store.listRecentDelegations(20).filter(row => row.kind === "report_back")).toHaveLength(1);
    expect(store.getChoiceCard(posted.choiceId)?.status).toBe("cancelled");
    expect(orch.adapter.sendChoiceCard).not.toHaveBeenCalled();
    expect(orch.adapter.sendMessage).not.toHaveBeenCalled();
  });

  it("replaces an already-notified Abandon-only card once when Resume becomes available", async () => {
    const orch = controller();
    const spec = store.turnAttempts.get(id)!.spec;
    const posted = await orch.publishChoiceCard(orch.router.ensureSessionRecord({ channelRef: "worker" }), {
      title: "Parked turn", body: "Dispatch is parked: execution identity changed. Use Resume to continue.",
      options: [{ label: "Abandon", kind: "prompt", payload: `parked-turn:abandon:${id}` }],
    });
    store.turnAttempts.markStallNoticeDelivered(id);
    orch.adapter.sendChoiceCard.mockClear();

    await orch.observeRetainedDispatch(spec);
    const recovered = store.listOpenChoiceCards("discord", "worker");
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.id).not.toBe(posted.choiceId);
    expect(recovered[0]!.options.map(option => parkedTurnAction(option.payload)?.action)).toEqual(["resume", "cancel"]);
    expect(recovered[0]!.options.map(option => option.label)).toEqual([expect.stringMatching(/^Resume /), expect.stringMatching(/^Cancel /)]);
    expect(recovered[0]!.body).toContain("continue under the thread's current configuration, or Cancel");
    expect(store.getChoiceCard(posted.choiceId)?.status).toBe("cancelled");
    expect(orch.adapter.sendChoiceCard).toHaveBeenCalledTimes(1);
    expect(orch.adapter.editChoiceCard).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ disabled: true, hideButtons: true }));

    await orch.observeRetainedDispatch(spec);
    expect(orch.adapter.sendChoiceCard).toHaveBeenCalledTimes(1);
    expect(orch.adapter.editChoiceCard).toHaveBeenCalledTimes(1);
    expect(store.turnAttempts.get(id)?.state).toBe("suspended");
  });

  it.each(["cancel", "abandon", "workflow action"])("closes persisted notices when cancelled through %s", async route => {
    const orch = controller();
    await orch.postParkedTurnNotice("worker", store.turnAttempts.get(id), "connection unavailable");
    await orch.postParkedTurnNotice("requester", store.turnAttempts.get(id), "connection unavailable");
    const cards = store.listOpenChoiceCards("discord");
    expect(cards).toHaveLength(2);

    if (route === "workflow action") {
      expect(await orch.performWorkflowAction("cancel", id, "worker")).toContain("Cancelled dispatch");
    } else {
      const interaction = { channelId: "worker", user: { id: "user" }, deferred: true, replied: false,
        options: { getString: (name: string) => name === route ? id : null, getInteger: () => null },
        editReply: vi.fn(async () => {}) };
      await orch.cmdWorkflows(interaction);
      expect(interaction.editReply).toHaveBeenCalledWith({ content: expect.stringContaining("Cancelled dispatch") });
    }

    expect(store.turnAttempts.get(id)?.state).toBe("cancelled");
    expect(store.listOpenChoiceCards("discord")).toEqual([]);
    for (const card of cards) expect(store.getChoiceCard(card.id)?.status).toBe("cancelled");
    expect(orch.adapter.editChoiceCard).toHaveBeenCalledTimes(2);
    const staleClick = click(cards[0]!.id, 1);
    await orch.handleChoiceCardInteraction(staleClick);
    expect(staleClick.replyEphemeral).toHaveBeenCalledWith("This card is closed.");
    expect(orch.adapter.sendChoiceCard).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("cancels an unavailable user turn with one plain cause and no buttons (already notified: %s)", async alreadyNotified => {
    const orch = controller();
    const spec = { id: "inbound-orphan", target: "worker", kind: "parked" as const, session: "live" as const, prompt: "UNSENT" };
    store.turnAttempts.claim(spec, executionIdentity({ agent: "codex", location: "local" }), "boot", "inbound");
    store.turnAttempts.markStalled(spec.id, "the provider lost the conversation");
    if (alreadyNotified) store.turnAttempts.markStallNoticeDelivered(spec.id);
    await orch.notifyParkedTurn(store.turnAttempts.get(spec.id));
    await orch.notifyParkedTurn(store.turnAttempts.get(spec.id));
    expect(store.turnAttempts.get(spec.id)?.state).toBe("cancelled");
    expect(orch.adapter.sendChoiceCard).not.toHaveBeenCalled();
    expect(orch.adapter.sendMessage).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.stringContaining("the provider lost the conversation"));
    expect(orch.adapter.sendMessage.mock.calls[0][1]).toContain("The prompt was never sent");
    expect(orch.adapter.sendMessage.mock.calls[0][1]).not.toMatch(/Resume|workflows resume:/);
  });

});

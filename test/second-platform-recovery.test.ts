import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { writeLiveMarker } from "../packages/core/src/core/dispatch/turn-resume.js";
import type { ChannelRef, DeliveryNonceLookup, IncomingMessage } from "../packages/core/src/platforms/chat-adapter.js";
import type { DispatchSpec } from "../packages/core/src/core/dispatch/types.js";
import type { ScheduledPrompt } from "../packages/core/src/core/scheduled-prompts/types.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import { logger as journal } from "../packages/core/src/lib/logger.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const drain = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve));
};
const logger = pino({ level: "silent" }) as unknown as Logger;

// Same synthetic adapter boundary as second-platform-turn; storage and recovery are real.
function setup(platform: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "seam-second-recovery-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new SessionStore(path.join(dir, "test.db"));
  cleanups.push(() => store.close());
  const channel: ChannelRef = { platform, id: platform === "discord" ? "1300000000000000002" : "AAA.TTT", parentId: "parent" };
  const now = new Date().toISOString();
  const record = { id: `${platform}:${channel.id}`, platform, channelRef: channel.id, parentRef: channel.parentId!,
    agentId: "codex", acpSessionId: "saved-acp", repoPath: "/synthetic", configJson: "{}", createdUtc: now, updatedUtc: now };
  store.upsert(record);
  const router = new SessionRouter({ logger, store, profiles: [], modelCatalog: fixtureModelCatalog([]),
    defaultAgentId: "codex", defaultModel: "test", defaultCwd: "/synthetic" });
  vi.spyOn(router, "describeConfig").mockReturnValue({ agent: { value: "codex" }, model: { value: "test" },
    effort: { value: null }, cwd: { value: "/synthetic" }, location: { value: "local" }, fastMode: { value: false },
    role: { value: null }, disableThreadPrefix: { value: false } } as any);
  let onEvent: (event: any) => Promise<void> = async () => {};
  const runtime = {
    busy: false,
    onEvent(f: typeof onEvent) { onEvent = f; }, getSessionInfo: () => ({ sessionId: "saved-acp" }),
    getProcessId: () => undefined, getProviderIdentity: () => "synthetic",
    getFastModeOutcome: () => undefined, getPromptCapabilities: () => ({}),
    prompt: vi.fn(async (_text: string): Promise<{ stopReason: string; cancelled?: boolean }> => {
      await onEvent({ kind: "agent-text", text: "RECOVERED_REPLY" });
      return { stopReason: "end_turn" };
    }),
    cancel: vi.fn(async () => {}), idle: async () => {},
  };
  const start = vi.spyOn(router, "getOrStartRuntime").mockResolvedValue(runtime as any);
  const visible: string[] = [];
  const adapter = {
    platform,
    sendPanel: vi.fn(async (channel: ChannelRef) => ({ channel, id: "panel" })),
    editPanel: vi.fn(async (_ref: any, _panel: any) => {}),
    sendMessage: vi.fn(async (channel: ChannelRef, text: string, _delivery?: { nonce?: string }) => {
      visible.push(text); return { channel, id: `message-${visible.length}` };
    }),
    editMessage: vi.fn(async (_ref: any, _text: string) => {}),
    findMessageByNonce: vi.fn(async (_channel: ChannelRef): Promise<DeliveryNonceLookup> => ({ status: "absent" })),
    getThreadLiveState: vi.fn(async (_channel: ChannelRef) => ({ archived: false, locked: false })),
  };
  const config = { DATA_DIR: dir, REPOS_ROOT: "/synthetic", TURN_TIMEOUT_SECONDS: 60,
    SEAM_TURN_RESUME_ENABLED: true, DEFAULT_MODEL: "test", REPO_EMOJIS: new Map(),
    channelPresets: new Map(), threadPresets: new Map() };
  const orch = new Orchestrator({ logger, store, router, modelCatalog: fixtureModelCatalog([]),
    adapter: adapter as any, renderer: discordRenderer, config: config as any });
  cleanups.push(async () => { orch.suspendForRestart(); await drain(); });
  const run = async (msg: IncomingMessage) => {
    await (orch as any).handleIncomingMessage(msg);
    await (orch as any).queueOnChannel(channel.id, async () => {});
  };
  return { dir, store, router, channel, record, runtime, start, adapter, orch, run, visible };
}

function suspended(h: ReturnType<typeof setup>, source: "inbound" | "dispatch" = "inbound", remote = false) {
  const spec: DispatchSpec = { id: source === "inbound" ? "inbound-original" : "handoff-original",
    target: h.channel.id, prompt: "original work", session: "live", kind: "handoff", createdUtc: new Date().toISOString() };
  h.store.turnAttempts.registerOwner("previous-controller");
  const attempt = h.store.turnAttempts.claim(spec, "identity", "previous-controller", source);
  h.store.turnAttempts.bind(attempt, "saved-acp");
  h.store.turnAttempts.startPrompt(attempt);
  h.store.turnAttempts.bindStatusCard(attempt, { channelId: h.channel.id, messageId: "original-card" });
  if (source === "inbound") {
    h.store.admitInbound({ messageId: "original", platform: h.channel.platform, channelRef: h.channel.id,
      parentRef: h.channel.parentId, sessionRecordId: h.record.id, authorId: "user", text: "original work", createdUtc: spec.createdUtc });
    h.store.claimInbound("original", 1, spec.createdUtc);
  }
  if (remote) h.store.turnAttempts.recordRemoteRecovery(attempt, { version: 1, location: "local", slot: 6,
    submissionId: "submission", acpSessionId: "saved-acp", delegatedUtc: spec.createdUtc });
  h.store.turnAttempts.suspendBoot("previous-controller");
  return h.store.turnAttempts.get(spec.id)!;
}

function usedChannels(h: ReturnType<typeof setup>) {
  return [...h.adapter.sendMessage.mock.calls.map(call => call[0]),
    ...h.adapter.sendPanel.mock.calls.map(call => call[0]),
    ...h.adapter.editPanel.mock.calls.map(call => call[0].channel),
    ...h.adapter.getThreadLiveState.mock.calls.map(call => call[0]),
    ...h.adapter.findMessageByNonce.mock.calls.map(call => call[0])];
}

describe("restart recovery retains the chat platform", () => {
  it.each(["test", "discord"])("rebinds a stale %s dispatch to its qualified session id", async platform => {
    const h = setup(platform);
    const attempt = suspended(h, "dispatch");
    const markSessionBridge = vi.fn();
    h.orch.setBridgeHub({ markSessionBridge, isBridgeReady: () => true } as any);
    const requeueStale = vi.fn(async () => true);
    (h.orch as any).dispatchWatcher = { listStaleRunning: async () => [attempt.spec], requeueStale };

    await h.orch.recoverInterruptedTurns();

    expect(markSessionBridge).toHaveBeenCalledWith(h.record.id, "local");
    expect(requeueStale).toHaveBeenCalledOnce();
    expect(h.adapter.getThreadLiveState).toHaveBeenCalled();
    expect(usedChannels(h).every(channel => channel.platform === platform && channel.id === h.channel.id)).toBe(true);
    expect(h.start).not.toHaveBeenCalled();
  });

  it.each(["test", "discord"])("continues a legacy %s marker on its own platform", async platform => {
    const h = setup(platform);
    await writeLiveMarker(h.dir, { id: "legacy-live", kind: "live", channelRef: h.channel.id,
      parentRef: h.channel.parentId, sessionRecordId: h.record.id, acpSessionId: "saved-acp",
      startedUtc: new Date().toISOString() });
    h.orch.setBridgeHub({ markSessionBridge: vi.fn(), isBridgeReady: () => true } as any);

    await h.orch.recoverInterruptedTurns();

    expect(h.runtime.prompt).toHaveBeenCalledOnce();
    expect(h.runtime.prompt.mock.calls[0]?.[0]).toMatch(/^continue\n/);
    expect(usedChannels(h).length).toBeGreaterThan(0);
    expect(usedChannels(h).every(channel => channel.platform === platform && channel.id === h.channel.id)).toBe(true);
    if (platform !== "discord") expect(h.store.getByChannel("discord", h.channel.id)).toBeNull();
  });

  it.each(["test", "discord"])("adopts a surviving %s owner and delivers once without a new prompt", async platform => {
    const h = setup(platform);
    const attempt = suspended(h, "inbound", true);
    const child = Object.assign(new EventEmitter(), { detach: vi.fn(), kill: vi.fn() });
    const mux = { adopt: vi.fn(() => child), sendCmd: vi.fn(async () => ({ health: [{ slot: 6, alive: true, attached: true,
      recovery: { version: 1, owner: "bridge", submissionId: "submission", acpSessionId: "saved-acp",
        rung: 1, phase: "executing", retry: 0, budget: 3, remaining: 3, disposition: "none", updatedUtc: attempt.updatedUtc } }] })) };
    let onEvent: (event: any) => Promise<void> = async () => {};
    const recoveryRuntime = { onEvent(f: typeof onEvent) { onEvent = f; }, idle: async () => {}, watchInFlightHang: async () => {} };
    const adoptRuntime = vi.spyOn(h.router, "adoptRecoveryRuntime").mockReturnValue(recoveryRuntime as any);
    vi.spyOn(h.router, "releaseRecoveryRuntime").mockReturnValue(false);
    h.orch.setBridgeHub({ muxFor: () => mux, slotHealthFor: () => [], onBridgeReady: () => () => {} } as any);

    await h.orch.recoverInterruptedTurns();
    await drain();
    expect(mux.adopt).toHaveBeenCalledOnce();
    expect(adoptRuntime.mock.calls[0]?.[0]).toMatchObject({ id: h.record.id, platform });
    await onEvent({ kind: "notice", severity: "error", title: "provider retained cause" });
    child.emit("remoteRecoveryResult", { version: 1, submissionId: "submission", acpSessionId: "saved-acp",
      status: "completed", text: "ADOPTED_FINAL", stopReason: "end_turn", finishedUtc: new Date().toISOString() });
    await (h.orch as any).queueOnChannel(h.channel.id, async () => {});

    expect(h.store.turnAttempts.get(attempt.id)).toMatchObject({ state: "completed", generation: 1,
      acpSessionId: "saved-acp", deliveryDone: true });
    expect(h.visible.filter(text => text === "ADOPTED_FINAL")).toHaveLength(1);
    expect(h.visible).toContain("❗ provider retained cause");
    expect(usedChannels(h).every(channel => channel.platform === platform && channel.id === h.channel.id)).toBe(true);
    expect(h.start).not.toHaveBeenCalled();
  });

  it.each(["test", "discord"])("retries an adopted %s delivery by its existing receipt", async platform => {
    const h = setup(platform);
    const prior = suspended(h, "inbound", true);
    const result = { version: 1 as const, submissionId: "submission", acpSessionId: "saved-acp",
      status: "completed" as const, text: "RETAINED_FINAL", stopReason: "end_turn", finishedUtc: new Date().toISOString() };
    expect(h.store.turnAttempts.adoptRemoteResult(prior, result, { id: prior.id, target: h.channel.id,
      status: "completed", output: result.text, finishedUtc: result.finishedUtc })).toBe(true);
    const cause = new Error("transport accepted no message: temporarily unavailable");
    h.adapter.sendMessage.mockRejectedValueOnce(cause);
    const warn = vi.spyOn((h.orch as any).logger, "warn");

    await (h.orch as any).finishRemoteRecoveryCompletion(prior, h.store.turnAttempts.get(prior.id));

    const receipt = h.store.turnAttempts.get(prior.id)!;
    expect(receipt).toMatchObject({ deliveryDone: false, deliveryPayload: { kind: "message", text: "RETAINED_FINAL" } });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ err: cause }), "adopted remote result delivery deferred");
    // Advance only the existing retry deadline, without running unrelated timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 30_000);
    await h.orch.reconcileRemoteRecoveries();
    await h.orch.reconcileRemoteRecoveries();

    expect(h.store.turnAttempts.get(prior.id)).toMatchObject({ deliveryDone: true, deliveryNonce: receipt.deliveryNonce });
    expect(h.visible).toEqual(["RETAINED_FINAL"]);
    expect(usedChannels(h).every(channel => channel.platform === platform && channel.id === h.channel.id)).toBe(true);
    expect(h.start).not.toHaveBeenCalled();
  });

  it.each(["test", "discord"])("recovers scheduled %s output using the schedule's platform", async platform => {
    const h = setup(platform);
    const now = new Date().toISOString();
    const row: ScheduledPrompt = { id: "schedule", platform, channelRef: h.channel.id, parentRef: h.channel.parentId!,
      name: "Live recovery", promptText: "work", cron: "0 9 * * *", timezone: "UTC", model: null,
      cwd: null, targetChannel: null, outputType: "messages", sessionMode: "live", catchupSeconds: 0,
      enabled: false, legacyAttachmentCount: 0, createdBy: "user", createdUtc: now, updatedUtc: now,
      lastRunUtc: null, lastStatus: null, nextRunUtc: null, pinnedSessionId: null };
    h.store.upsertScheduled(row);
    h.store.scheduledOccurrences.reserve({ id: "wake-original", scheduledFor: null }, row,
      { agentId: "codex", location: "local", model: "test", effort: null, cwd: "/synthetic", fingerprint: "identity" });
    h.store.turnAttempts.registerOwner("previous-controller");
    const attempt = h.store.turnAttempts.claim({ id: "wake-original", target: h.channel.id, prompt: "work",
      session: "live", kind: "scheduled", createdUtc: now }, "identity", "previous-controller", "schedule");
    h.store.turnAttempts.bind(attempt, "saved-acp");
    h.store.turnAttempts.recordRemoteRecovery(attempt, { version: 1, location: "local", slot: 6,
      submissionId: "submission", acpSessionId: "saved-acp", delegatedUtc: now });
    h.store.turnAttempts.suspendBoot("previous-controller");
    const prior = h.store.turnAttempts.get(attempt.id)!;
    expect(h.store.turnAttempts.adoptRemoteResult(prior, { version: 1, submissionId: "submission",
      acpSessionId: "saved-acp", status: "completed", text: "SCHEDULED_FINAL", finishedUtc: now },
    { id: prior.id, target: h.channel.id, status: "completed", output: "SCHEDULED_FINAL", finishedUtc: now })).toBe(true);
    h.store.turnAttempts.prepareDelivery(prior.id, h.channel.id, { kind: "message", text: "SCHEDULED_FINAL" });

    await h.orch.reconcileRemoteRecoveries();

    expect(h.visible).toEqual(["SCHEDULED_FINAL"]);
    expect(h.store.scheduledOccurrences.get(prior.id)?.settled).toBe(true);
    expect(usedChannels(h).every(channel => channel.platform === platform && channel.id === h.channel.id)).toBe(true);
    expect(h.start).not.toHaveBeenCalled();
  });
});

describe("platform-neutral channel commands", () => {
  it.each(["test", "discord"])("cancels an in-flight %s turn after deleting its parked successor", async platform => {
    const h = setup(platform);
    let entered!: () => void;
    let finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    h.runtime.prompt.mockImplementation(async () => {
      h.runtime.busy = true; entered(); await gate; h.runtime.busy = false;
      return { stopReason: "cancelled", cancelled: true };
    });
    const abort = vi.spyOn(h.router, "abortTurn");
    h.runtime.cancel.mockImplementation(async () => {
      expect(h.store.getParkedByChannel(platform, h.channel.id)).toBeNull();
      expect(h.store.turnAttempts.get("inbound-live-message")?.state).toBe("cancelled");
      finish();
    });
    const running = h.run({ messageId: "live-message", channel: h.channel, authorId: "user",
      authorIsBot: false, text: "real turn pipeline with a synthetic provider" });
    await started;
    (h.router as any).runtimes.set(h.record.id, h.runtime);
    h.store.upsertParked({ id: "queued-successor", platform, channelRef: h.channel.id, parentRef: h.channel.parentId!,
      location: "local", kind: "user_queue", prompt: "must not run", authorId: "user", authorName: null,
      noticeMessageId: "queued-card", attachments: [], createdUtc: new Date().toISOString() });
    try {
      const result = await (h.orch as any).cancelChannel(h.channel);
      expect(result.outcome).toBe("cancelled");
      expect(abort).toHaveBeenCalledWith(h.record.id, { force: false });
      expect(h.runtime.cancel).toHaveBeenCalledOnce();
    } finally { finish(); await running; }
    expect(h.runtime.prompt).toHaveBeenCalledOnce();
    expect(h.store.get(h.record.id)?.acpSessionId).toBe("saved-acp");
    expect(usedChannels(h).every(channel => channel.platform === platform && channel.id === h.channel.id)).toBe(true);
  });

  it("returns the actual cancel-write cause through the neutral command", async () => {
    const h = setup("test");
    const cause = new Error("session/cancel transport write failed");
    vi.spyOn(h.router, "abortTurn").mockRejectedValue(cause);
    expect(await (h.orch as any).cancelChannel(h.channel)).toMatchObject({ error: cause });
  });

  it.each(["test", "discord"])("resets only the %s binding and leaves config for the next turn", async platform => {
    const h = setup(platform);
    h.store.upsert({ ...h.record, configJson: '{"role":"worker","permissionPolicy":"deny"}' });
    const invalidation = vi.spyOn(h.router, "invalidate");
    const info = vi.spyOn(journal, "info").mockImplementation(() => {});

    await (h.orch as any).resetChannel(h.channel);
    await (h.orch as any).resetChannel(h.channel);

    expect(invalidation).toHaveBeenCalledWith(h.record.id, { operatorIntent: "replace-session" });
    expect(h.store.get(h.record.id)).toMatchObject({ acpSessionId: "", configJson: '{"role":"worker","permissionPolicy":"deny"}' });
    expect(h.start).not.toHaveBeenCalled();
    const clears = info.mock.calls.filter(([, message]) => message === "cleared stored acp session id");
    expect(clears).toHaveLength(1);
    expect(clears[0]?.[0]).toMatchObject({ sessionId: h.record.id, previousAcpSessionId: "saved-acp",
      source: "Orchestrator.resetChannel", cause: "operator requested session reset" });
    if (platform !== "discord") expect(h.store.getByChannel("discord", h.channel.id)).toBeNull();
  });

  it("keeps Discord slash cancel/reset replies and reset audit source", async () => {
    const h = setup("discord");
    vi.spyOn(h.orch as any, "recordFromInteraction").mockImplementation(() => h.store.get(h.record.id));
    const interaction = () => ({ options: { getString: () => null, getBoolean: () => false },
      reply: vi.fn(async (_body: unknown) => {}), replied: false, deferred: false });
    const cancel = interaction();
    await (h.orch as any).cmdCancel(cancel);
    expect(cancel.reply).toHaveBeenCalledWith({ content: "No active turn.", flags: 64 });
    const info = vi.spyOn(journal, "info").mockImplementation(() => {});
    const reset = interaction();
    await (h.orch as any).cmdReset(reset);
    expect(reset.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: "Session reset. Your next message will start a fresh ACP session (history is gone, but config is kept).",
      flags: 64,
    }));
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ source: "Orchestrator.cmdReset",
      cause: "operator requested session reset" }), "cleared stored acp session id");
  });
});

describe("permission defaults by chat platform", () => {
  it.each(["ask", "deny", "always"] as const)("keeps Discord's %s default while Chat defaults to always", defaultMode => {
    const h = setup("test");
    const router = new SessionRouter({ logger, store: h.store, profiles: [], modelCatalog: fixtureModelCatalog([]),
      defaultAgentId: "codex", defaultModel: "test", defaultPermissionMode: defaultMode,
      defaultPermissionModes: new Map([["test", "always"], ["google-chat", "always"]]) } as any);
    const chat = router.ensureSessionRecord({ platform: "google-chat", channelRef: "BBB.TTT", cwd: "/synthetic" });
    const discord = router.ensureSessionRecord({ platform: "discord", channelRef: "1300000000000000002", cwd: "/synthetic" });

    expect(router.describeConfig(h.record).permission).toEqual({ value: "always", source: "default" });
    expect(router.describeConfig(chat).permission).toEqual({ value: "always", source: "default" });
    expect(router.describeConfig(discord).permission).toEqual({ value: defaultMode, source: "default" });
    expect(router.permissionOptions(chat).permissionMode!()).toBe("always");
    expect(router.permissionOptions(discord).permissionMode!()).toBe(defaultMode);
    expect(router.permissionOptions().permissionMode!()).toBe(defaultMode);
    const live = router.permissionOptions(chat).permissionMode!;
    h.store.upsert({ ...chat, configJson: '{"permissionPolicy":"deny","autoApprovePermissions":true}' });
    expect(live()).toBe("deny");
    expect(router.describeConfig(h.store.get(chat.id)!).permission).toEqual({ value: "deny", source: "session config" });
    h.store.upsert({ ...discord, configJson: '{"autoApprovePermissions":true}' });
    expect(router.permissionOptions(discord).permissionMode!()).toBe("always");
  });
});

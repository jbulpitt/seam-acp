import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { GoogleChatAdapter } from "../packages/core/src/platforms/google-chat/adapter.js";
import { multiplexChatAdapters } from "../packages/core/src/platforms/google-chat/multiplex.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import type { ScheduledPrompt } from "../packages/core/src/core/scheduled-prompts/types.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); vi.restoreAllMocks(); });
const chatChannel = { platform: "google-chat", id: "AAQA-test" };
function googleError(status: number) {
  const message = status === 403 ? "Permission denied to perform the requested action on the specified resource, or the resource doesn't exist." : "Requested entity was not found.";
  return Object.assign(new Error(message), { response: { status, data: { error: {
    code: status, status: status === 403 ? "PERMISSION_DENIED" : "NOT_FOUND", message,
  } } } });
}
function fixture(mode: "live" | "isolated" = "isolated", targetChannel: string | null = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gchat-scheduled-")); cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new SessionStore(path.join(dir, "seam.db")); cleanups.push(() => store.close());
  const profiles = [{ id: "codex", defaultModel: "test-model", staticModels: [{ modelId: "test-model" }], effort: { mechanism: "none", levels: [] } }] as any;
  const modelCatalog = fixtureModelCatalog(profiles), logger = pino({ level: "silent" });
  const router = new SessionRouter({ store, modelCatalog, profiles, logger: logger as any, defaultAgentId: "codex", defaultModel: "test-model", defaultCwd: dir });
  const record = router.ensureSessionRecord({ platform: "google-chat", channelRef: chatChannel.id, cwd: dir });
  store.upsert({ ...record, acpSessionId: "live-context" }, { source: "fixture", cause: "retained session Space" });
  const request = vi.fn(async (_scope: string, req: any): Promise<any> => ({ name: req.url.split("/v1/")[1], spaceType: "SPACE" }));
  const native = new GoogleChatAdapter({ api: { request }, logger, subscription: "test", allowedUserIds: new Set(), defaultCwd: dir });
  const writes = () => ({ sendPanel: vi.fn(async (channel: any, _panel?: any, _nonce?: any) => ({ channel, id: "card" })),
    sendMessage: vi.fn(async (channel: any, _text?: any, _nonce?: any) => ({ channel, id: "message" })),
    sendFile: vi.fn(async (channel: any) => ({ channel, id: "file" })),
    findMessageByNonce: vi.fn(async () => ({ status: "absent" as const })) });
  const chat = { platform: "google-chat", ...writes(), getThreadLiveState: vi.fn(native.getThreadLiveState.bind(native)) };
  const cause = Object.assign(new Error("Invalid Form Body channel_id: Value AAQA-test is not snowflake."), { code: 50035 });
  const discord = { platform: "discord", ...writes(), getThreadLiveState: vi.fn(async (ref: any) => {
    if (ref.id === "AAQA-test" || ref.id === "AAQA-output") throw cause;
    return { locked: false, archived: false };
  }) };
  const adapter = multiplexChatAdapters([discord, chat] as any, id => store.getByChannelRef(id)?.platform ?? "discord");
  const orch = new Orchestrator({ store, router, modelCatalog, logger: logger as any, adapter,
    renderer: discordRenderer, config: { DATA_DIR: dir, REPOS_ROOT: dir, TURN_TIMEOUT_SECONDS: 60,
      channelPresets: new Map(), threadPresets: new Map() } as any });
  const now = new Date().toISOString();
  const row: ScheduledPrompt = { id: "sch-chat-test", platform: "google-chat", channelRef: chatChannel.id, parentRef: null,
    name: "Chat cron", promptText: "Reply SCHEDULE_OK", cron: "55 5 * * *", timezone: "America/Chicago",
    sessionMode: mode, outputType: "card", targetChannel, model: null, cwd: null, enabled: true,
    catchupSeconds: 0, legacyAttachmentCount: 0, createdBy: "42", createdUtc: now, updatedUtc: now,
    lastRunUtc: null, lastStatus: null, nextRunUtc: null, pinnedSessionId: null };
  store.upsertScheduled(row);
  const isolated = vi.spyOn(orch as any, "runIsolatedScheduledJob").mockImplementation(async (...args: any[]) => {
    const { owned } = args[0];
    if (owned) store.turnAttempts.complete(owned.attempt, { id: owned.attempt.id, target: row.channelRef,
      status: "completed", output: "SCHEDULE_OK", finishedUtc: new Date().toISOString() });
    return { text: "SCHEDULE_OK" };
  });
  const live = vi.spyOn(orch as any, "handleIncomingMessageInner").mockImplementation(async (...args: any[]) => {
    await adapter.sendMessage(args[0].channel, "LIVE_SCHEDULE_OK");
  });
  return { store, router, record, row, native, request, chat, discord, orch, isolated, live };
}

describe("Google Chat scheduled fire uses its durable platform", () => {
  it("resolves execution from the Chat binding without creating a shadow Discord session", () => {
    const h = fixture(); h.orch.scheduleExecution(h.row);
    expect(h.store.get(`discord:${h.row.channelRef}`)).toBeNull();
    expect(h.store.get(h.record.id)?.acpSessionId).toBe("live-context");
  });
  it.each([null, "AAQA-output"])("fires isolated output to %s on Chat, with Chat liveness, announce and result cards", async output => {
    const h = fixture("isolated", output);
    const binding = vi.spyOn(h.router, "ensureSessionRecord");
    await h.orch.runScheduledPrompt(h.row.id);
    expect(h.store.getScheduled(h.row.id)?.lastStatus).toBe("ok");
    expect(h.discord.getThreadLiveState).not.toHaveBeenCalled();
    expect(h.discord.sendPanel).not.toHaveBeenCalled();
    expect(h.chat.getThreadLiveState).toHaveBeenCalledWith({ platform: "google-chat", id: output ?? chatChannel.id });
    expect(binding.mock.calls.every(([input]) => input.platform === "google-chat")).toBe(true);
    expect(h.chat.sendPanel.mock.calls.map(([ref]) => ref)).toEqual([
      { platform: "google-chat", id: output ?? chatChannel.id }, { platform: "google-chat", id: output ?? chatChannel.id }]);
    expect(h.chat.sendPanel.mock.calls[1]![1]).toMatchObject({ title: "⏰ Chat cron", description: "SCHEDULE_OK" });
    expect(h.isolated.mock.calls[0]![0]).toMatchObject({ record: { id: h.record.id }, channel: { platform: "google-chat", id: output ?? chatChannel.id } });
  });
  it("queues a live schedule as a Chat prompt and ignores isolated output overrides", async () => {
    const h = fixture("live", "AAQA-output");
    await (h.orch as any).runScheduledPromptInner(h.row);
    expect(h.store.getScheduled(h.row.id)?.lastStatus).toBe("ok");
    expect(h.live.mock.calls[0]![0]).toMatchObject({ channel: chatChannel, text: expect.stringContaining("Reply SCHEDULE_OK") });
    expect(h.chat.sendMessage).toHaveBeenCalledWith(chatChannel, "LIVE_SCHEDULE_OK");
    expect(h.isolated).not.toHaveBeenCalled(); expect(h.discord.getThreadLiveState).not.toHaveBeenCalled();
  });
  it("drops only a genuinely deleted Chat binding, not a permission error", async () => {
    const h = fixture(); h.request.mockRejectedValueOnce(googleError(404));
    await (h.orch as any).runScheduledPromptInner(h.row);
    expect(h.store.getScheduled(h.row.id)).toBeNull(); expect(h.isolated).not.toHaveBeenCalled();
  });
  it("keeps a Chat schedule on an ambiguous Google 403 and surfaces the real cause", async () => {
    const h = fixture(), cause = googleError(403), warn = vi.spyOn((h.orch as any).logger, "warn");
    h.request.mockRejectedValueOnce(cause);
    await (h.orch as any).runScheduledPromptInner(h.row);
    expect(h.store.getScheduled(h.row.id)?.lastStatus).toBe("skipped: target unreachable");
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ err: cause }), expect.any(String));
    expect(h.isolated).not.toHaveBeenCalled(); expect(h.store.getScheduled(h.row.id)).not.toBeNull();
  });
  it("a successful Space GET is reachable, not archived or deleted", async () => {
    const h = fixture();
    await expect(h.native.getThreadLiveState(chatChannel)).resolves.toEqual({ locked: false, archived: false });
    expect(h.request).toHaveBeenCalledWith("chat", { method: "GET", url: "https://chat.googleapis.com/v1/spaces/AAQA-test" });
  });
  it("preserves Discord scheduled target routing", async () => {
    const h = fixture(), row = { ...h.row, platform: "discord", channelRef: "123", parentRef: "12" };
    h.store.upsertScheduled(row);
    await (h.orch as any).runScheduledPromptInner(row);
    expect(h.discord.getThreadLiveState).toHaveBeenCalledWith({ platform: "discord", id: "123", parentId: "12" });
    expect(h.discord.sendPanel).toHaveBeenCalledTimes(2); expect(h.chat.sendPanel).not.toHaveBeenCalled();
  });
});

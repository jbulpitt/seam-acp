import { afterEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { GoogleChatAdapter } from "../packages/core/src/platforms/google-chat/adapter.js";
import { SpaceWriteQueue } from "../packages/core/src/platforms/google-chat/write-queue.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { testSessionRouter } from "./helpers/session-fixture.js";
import { executionIdentity } from "../packages/core/src/core/dispatch/execution-identity.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("node:timers/promises", () => ({
  setTimeout: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
}));

function capError() {
  const message = "Cannot create reply since it has reached the threading reply limit.";
  return Object.assign(new Error(message), { response: { status: 429, data: { error: {
    code: 429, status: "RESOURCE_EXHAUSTED", message,
    errors: [{ message, domain: "global", reason: "rateLimitExceeded" }],
  } } } });
}

const stores: SessionStore[] = [];
const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(spaceType = "SPACE") {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-12T02:00:00Z"));
  const store = new SessionStore(":memory:"); stores.push(store);
  const channel = { platform: "google-chat", id: "A.Full", parentId: "A" };
  const record = { id: "google-chat:A.Full", platform: "google-chat", channelRef: "A.Full", parentRef: "A",
    agentId: "codex", acpSessionId: "same-acp-session", repoPath: "/fixture", configJson: '{"model":"test-model"}',
    createdUtc: new Date().toISOString(), updatedUtc: new Date().toISOString() };
  store.upsert(record);
  const cause = capError();
  let capped = false, serial = 0;
  const request = vi.fn(async (_scope: string, r: any): Promise<any> => {
    if (r.method !== "POST") return {};
    if (!capped && r.data.thread?.name === "spaces/A/threads/Full") { capped = true; throw cause; }
    const thread = r.data.thread?.name ?? "spaces/A/threads/Next";
    return { name: `spaces/A/messages/${++serial}`, thread: { name: thread } };
  });
  const logger = pino({ level: "silent" });
  const adapter = new GoogleChatAdapter({ api: { request }, subscription: "fixture",
    allowedUserIds: new Set(["users/42"]), defaultCwd: "/fixture", logger, writeIntervalMs: 1000 });
  adapter.setCommandDeps({ store, mutation: { readThreadPresetEntry: () => undefined } } as any);
  const added = adapter.receiveEvent({ type: "ADDED_TO_SPACE", space: { name: "spaces/A", spaceType,
    spaceThreadingState: "THREADED_MESSAGES" } });
  return { store, channel, record, cause, request, adapter, logger, added };
}

describe("Google Chat threading reply limit", () => {
  it("rejects the permanent cap once with its real cause and lets the next space write proceed", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const logger = pino({ level: "silent" }), warn = vi.spyOn(logger, "warn");
    const queue = new SpaceWriteQueue({ logger, intervalMs: 1000 });
    const cause = capError(), run = vi.fn().mockRejectedValue(cause), next = vi.fn().mockResolvedValue("next");
    let rejected: unknown, completed: unknown;
    void queue.enqueue("spaces/A", run).catch(err => { rejected = err; });
    void queue.enqueue("spaces/A", next).then(value => { completed = value; });
    await vi.advanceTimersByTimeAsync(3000);
    expect(rejected).toBe(cause);
    expect(run).toHaveBeenCalledOnce(); expect(completed).toBe("next");
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ err: cause, space: "spaces/A" }),
      "Google Chat write rejected");
    expect(warn).not.toHaveBeenCalledWith(expect.anything(), "Google Chat write retry");
  });

  it.each(["status", "reason", "message"])("keeps ordinary rate limits retryable when the cap %s does not match", async field => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const cause = capError();
    if (field === "status") cause.response.data.error.status = "UNAVAILABLE";
    if (field === "reason") cause.response.data.error.errors[0]!.reason = "quotaExceeded";
    if (field === "message") cause.response.data.error.message = "Rate limit exceeded. Try again later.";
    const queue = new SpaceWriteQueue({ logger: pino({ level: "silent" }), intervalMs: 1000 });
    const run = vi.fn().mockRejectedValueOnce(cause).mockResolvedValue("retried");
    const job = queue.enqueue("spaces/A", run);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await job).toBe("retried"); expect(run).toHaveBeenCalledTimes(2);
  });

  it.each(["SPACE", "DIRECT_MESSAGE"])("continues a capped %s reply top-level and keeps the durable session and ACP binding", async type => {
    const h = fixture(type); await h.added;
    const warn = vi.spyOn(h.logger, "warn");
    const job = h.adapter.sendMessage(h.channel, "remaining answer", { nonce: "receipt-1", enforceNonce: true });
    const other = h.adapter.sendMessage({ platform: "google-chat", id: "A.Other", parentId: "A" }, "unrelated answer");
    await vi.advanceTimersByTimeAsync(4000);
    const ref = await job; await other;
    const posts = h.request.mock.calls.filter(call => call[1].method === "POST");
    expect(posts).toHaveLength(3);
    expect(posts[1]![1].data.thread).toBeUndefined();
    expect(posts[1]![1].params.messageReplyOption).toBeUndefined();
    expect(posts[1]![1].params.messageId).toBe(posts[0]![1].params.messageId);
    expect(posts[1]![1].data.text).toContain("Continued from the previous thread (reply limit reached)");
    expect(posts[1]![1].data.text).toContain("remaining answer");
    expect(ref.channel.id).toBe("A.Next");
    expect(h.store.getByChannel("google-chat", "A.Next")).toMatchObject({
      id: h.record.id, acpSessionId: "same-acp-session", configJson: h.record.configJson, repoPath: "/fixture" });
    expect(h.store.listSessionsUncapped().filter(row => row.channelRef === "A.Full")).toEqual([]);
    expect(h.store.countSessions()).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ err: h.cause }),
      "Google Chat thread reply limit reached; continuing conversation");
    const chunk = h.adapter.sendMessage(h.channel, "next chunk");
    await vi.advanceTimersByTimeAsync(1000);
    expect((await chunk).channel.id).toBe("A.Next");
    expect(h.request.mock.lastCall![1].data.thread.name).toBe("spaces/A/threads/Next");
  });

  it("routes already queued replies to the continuation, rather than creating competing threads", async () => {
    const h = fixture(); await h.added;
    const first = h.adapter.sendMessage({ ...h.channel }, "first");
    const second = h.adapter.sendMessage({ ...h.channel }, "second");
    await vi.advanceTimersByTimeAsync(4000); await Promise.all([first, second]);
    expect(h.request.mock.calls[1]![1].data.thread).toBeUndefined();
    expect(h.request.mock.calls[2]![1].data.thread?.name).toBe("spaces/A/threads/Next");
  });

  it("finds the rebound row by its new channel without creating a new runtime identity", async () => {
    const h = fixture(); await h.added;
    const job = h.adapter.sendMessage(h.channel, "answer");
    await vi.advanceTimersByTimeAsync(3000); await job;
    const previewSessionRecord = vi.fn();
    const found = SessionRouter.prototype.ensureSessionRecord.call({ store: h.store, previewSessionRecord } as any,
      { platform: "google-chat", channelRef: "A.Next", parentRef: "A", cwd: "/fixture" });
    expect(found.id).toBe(h.record.id); expect(found.acpSessionId).toBe(h.record.acpSessionId);
    expect(previewSessionRecord).not.toHaveBeenCalled();
  });

  it("does not let a stale runtime metadata snapshot restore the capped channel", async () => {
    const h = fixture(); await h.added;
    const job = h.adapter.sendMessage(h.channel, "answer");
    await vi.advanceTimersByTimeAsync(3000); await job;
    h.store.upsert({ ...h.record, updatedUtc: new Date().toISOString() });
    expect(h.store.get(h.record.id)).toMatchObject({ channelRef: "A.Next", acpSessionId: "same-acp-session" });
  });

  it("keeps the new thread on the same running turn FIFO, rather than starting concurrent ACP work", async () => {
    const h = fixture(); await h.added;
    const router = testSessionRouter({ getProfile: () => undefined });
    const orch = new Orchestrator({ store: h.store, router: router as any, adapter: h.adapter,
      renderer: discordRenderer, logger: h.logger as any, modelCatalog: fixtureModelCatalog([]),
      config: { DATA_DIR: "/fixture", REPOS_ROOT: "/fixture", TURN_TIMEOUT_SECONDS: 60,
        DISCORD_ALLOWED_USER_IDS: new Set(), channelPresets: new Map(), threadPresets: new Map() } as any });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const first = (orch as any).queueOnChannel("A.Full", () => held);
    let second: Promise<void> | undefined;
    try {
      await vi.advanceTimersByTimeAsync(0);
      const send = h.adapter.sendMessage(h.channel, "answer");
      await vi.advanceTimersByTimeAsync(3000); await send;
      const next = vi.fn(async () => {});
      second = (orch as any).queueOnChannel("A.Next", next);
      await vi.advanceTimersByTimeAsync(0);
      expect(orch.isChannelBusy("A.Next")).toBe(true);
      expect(next).not.toHaveBeenCalled();
    } finally { release(); await first; await second; }
  });

  it("keeps the original stream receipt identity while routing later chunks to the new thread", async () => {
    const h = fixture(); await h.added;
    const orch = new Orchestrator({ store: h.store, router: testSessionRouter({ getProfile: () => undefined }) as any,
      adapter: h.adapter, renderer: discordRenderer, logger: h.logger as any, modelCatalog: fixtureModelCatalog([]),
      config: { DATA_DIR: "/fixture", REPOS_ROOT: "/fixture", DISCORD_ALLOWED_USER_IDS: new Set(),
        channelPresets: new Map(), threadPresets: new Map() } as any });
    const spec = { id: "stream-cap", target: "A.Full", prompt: "answer", session: "live" as const };
    h.store.turnAttempts.admit(spec);
    const attempt = h.store.turnAttempts.claim(spec, "fixture", "fixture-boot");
    const first = (orch as any).sendStreamAttemptText(attempt, h.channel, "first chunk", 0);
    await vi.advanceTimersByTimeAsync(3000); await first;
    const second = (orch as any).sendStreamAttemptText(attempt, h.channel, "second chunk", 1)
      .then(() => undefined, (err: unknown) => err);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await second).toBeUndefined();
    expect(h.channel.id).toBe("A.Full");
    expect(h.store.turnAttempts.get(spec.id)).toMatchObject({ deliveryChannel: "A.Full",
      deliveryPayload: { kind: "messages", texts: ["first chunk", "second chunk"], stream: { delivered: 2 } } });
    expect(h.request.mock.lastCall![1].data.thread.name).toBe("spaces/A/threads/Next");
  });

  it("reuses the existing inbound ledger to route a prior continuation thread after another rollover", async () => {
    const h = fixture(); await h.added;
    const first = h.adapter.sendMessage(h.channel, "first answer");
    await vi.advanceTimersByTimeAsync(3000); await first;
    h.store.admitInbound({ messageId: "next-turn", platform: "google-chat", channelRef: "A.Next", parentRef: "A",
      sessionRecordId: h.record.id, authorId: "42", text: "follow up", createdUtc: new Date().toISOString() });
    let capped = false;
    h.request.mockImplementation(async (_scope: string, r: any) => {
      if (!capped && r.data.thread?.name === "spaces/A/threads/Next") { capped = true; throw capError(); }
      return { name: "spaces/A/messages/third", thread: { name: r.data.thread?.name ?? "spaces/A/threads/Third" } };
    });
    const nextChannel = { platform: "google-chat", id: "A.Next", parentId: "A" };
    const second = h.adapter.sendMessage({ ...nextChannel }, "second answer");
    await vi.advanceTimersByTimeAsync(3000); await second;
    const remainder = h.adapter.sendMessage({ ...nextChannel }, "remaining output");
    await vi.advanceTimersByTimeAsync(1000); await remainder;
    expect(h.request.mock.lastCall![1].data.thread.name).toBe("spaces/A/threads/Third");
    expect(h.store.getByChannel("google-chat", "A.Next")).toMatchObject({ id: h.record.id, channelRef: "A.Third" });
    expect(h.store.countSessions()).toBe(1);
  });

  it("can recover the same attempt's immutable status card after the Chat home has moved", async () => {
    const h = fixture(); await h.added;
    const moved = h.adapter.sendMessage(h.channel, "move home");
    await vi.advanceTimersByTimeAsync(3000); await moved;
    const description = { agent: { value: "codex" }, model: { value: "test-model" }, effort: { value: null },
      cwd: { value: "/fixture" }, location: { value: "local" }, fastMode: { value: false },
      role: { value: null }, disableThreadPrefix: { value: false } };
    const router = testSessionRouter({ getProfile: () => undefined, describeConfig: () => description,
      ensureSessionRecord: () => h.store.get(h.record.id)! });
    const dir = mkdtempSync(path.join(tmpdir(), "seam-cap-recovery-")); dirs.push(dir);
    const orch = new Orchestrator({ store: h.store, router: router as any, adapter: h.adapter,
      renderer: discordRenderer, logger: h.logger as any, modelCatalog: fixtureModelCatalog([]),
      config: { DATA_DIR: dir, REPOS_ROOT: "/fixture", REPO_EMOJIS: new Map(), DEFAULT_MODEL: "test-model",
        DISCORD_ALLOWED_USER_IDS: new Set(), channelPresets: new Map(), threadPresets: new Map() } as any });
    const spec = { id: "resume-card", target: "A.Full", prompt: "answer", session: "live" as const };
    const identity = executionIdentity({ agent: "codex", model: "test-model", location: "local", cwd: "/fixture",
      config: { model: "test-model" } });
    h.store.turnAttempts.admit(spec);
    const attempt = h.store.turnAttempts.claim(spec, identity, "fixture-boot");
    h.store.turnAttempts.bindStatusCard(attempt, { channelId: "A.Next", messageId: "spaces/A/messages/card" });
    const edit = vi.spyOn(h.adapter, "editPanel").mockRejectedValue(new Error("fixture unavailable card"));
    vi.spyOn(h.adapter, "sendPanel").mockRejectedValue(new Error("fixture status replacement reached"));
    await expect((orch as any).executeIncomingMessage({ channel: { platform: "google-chat", id: "A.Full", parentId: "A" },
      authorId: "42", authorIsBot: false, text: "answer" }, undefined, attempt))
      .rejects.toThrow("fixture status replacement reached");
    expect(edit).toHaveBeenCalledWith(expect.objectContaining({ id: "spaces/A/messages/card",
      channel: expect.objectContaining({ id: "A.Next" }) }), expect.anything());
  });
});

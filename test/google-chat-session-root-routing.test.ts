import { afterEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { GoogleChatAdapter } from "../packages/core/src/platforms/google-chat/adapter.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";

const stores: SessionStore[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); vi.restoreAllMocks(); });
const space = { name: "spaces/session-home", spaceType: "SPACE", spaceThreadingState: "THREADED_MESSAGES" };
const channel = { platform: "google-chat", id: "session-home" };

function fixture() {
  const store = new SessionStore(":memory:"); stores.push(store);
  const now = new Date().toISOString();
  const record = { id: "google-chat:original-record", platform: "google-chat", channelRef: channel.id,
    parentRef: null, agentId: "codex", acpSessionId: "same-acp", repoPath: "/projects", configJson: "{}",
    createdUtc: now, updatedUtc: now };
  store.upsert(record);
  const request = vi.fn(async (_scope: string, r: any): Promise<any> => ({ name: `${space.name}/messages/sent`,
    thread: r.data?.thread ?? { name: `${space.name}/threads/new-output` }, sender: { name: "users/seam", type: "BOT" } }));
  const lifecycle = { space: () => space, appUser: () => "users/seam", recordAppUser: vi.fn(),
    start: vi.fn(async () => {}), stop: vi.fn(async () => {}), handle: vi.fn(async () => {}) };
  const rootMessage = (name: string) => ({ name, createTime: "2026-10-12T18:00:00Z",
    sender: { name: "users/author", displayName: "Root Author", type: "HUMAN" },
    text: "Root report", attachment: [{ contentName: "report.csv" }] });
  const history = { getMessage: vi.fn(async (name: string) => rootMessage(name)),
    readRawPage: vi.fn(async () => ({ messages: [rootMessage("spaces/session-home/messages/topic.root")], nextPageToken: null })) };
  const logger = pino({ level: "silent" });
  const adapter = new GoogleChatAdapter({ api: { request }, logger,
    subscription: "projects/test/subscriptions/events", allowedUserIds: new Set(["users/42"]),
    defaultCwd: "/projects", spaceEvents: lifecycle, historyReader: history, writeIntervalMs: 0 });
  const incoming: any[] = [];
  adapter.onMessage(msg => { incoming.push(msg); msg.onAdmitted?.(); });
  const ensureSessionRecord = vi.fn((input: any) => store.getByChannel("google-chat", input.channelRef) ?? {
    ...record, id: `google-chat:${input.channelRef}`, channelRef: input.channelRef });
  adapter.setCommandDeps({ store, router: { ensureSessionRecord, bindRecordLocation: () => "local" },
    mutation: { readThreadPresetEntry: () => undefined, applyThreadOverlay: () => ({ ok: true }),
      restoreThreadPresetEntry: () => ({ ok: true }) }, runtimeTransition: {}, cancelChannel: vi.fn() } as any);
  const receive = (id: string, reply: boolean, source: "direct" | "workspace", thread = "topic") => adapter.receiveEvent({
    type: "MESSAGE", space, user: { name: "users/42", displayName: "Tester", type: "HUMAN" },
    message: { name: `${space.name}/messages/${id}`, text: `Prompt ${id}`,
      thread: { name: `${space.name}/threads/${thread}` }, threadReply: reply,
      quotedMessageMetadata: reply ? { name: `${space.name}/messages/${thread}.root` } : undefined },
  }, undefined, undefined, source);
  return { store, record, adapter, request, incoming, receive, ensureSessionRecord, history, logger };
}

describe("one Google Chat session root with native per-prompt delivery", () => {
  it.each(["direct", "workspace"] as const)("admits an unmentioned top-level %s prompt at the exact root", async source => {
    const h = fixture(); await h.receive("top", false, source);
    expect(h.incoming).toHaveLength(1);
    expect(h.incoming[0]).toMatchObject({ channel, deliveryChannel: channel, preemptive: false, text: "Prompt top" });
    expect(h.store.get(h.record.id)?.acpSessionId).toBe("same-acp");
    expect(h.ensureSessionRecord.mock.calls.every(([input]) => input.channelRef === channel.id)).toBe(true);
    expect(h.request).not.toHaveBeenCalled();
  });

  it("does not mistake an old alias for an exact session-root binding", async () => {
    const h = fixture();
    h.store.rebindChannel(h.record.id, "elsewhere", null);
    await h.receive("not-ours", false, "workspace");
    expect(h.incoming).toHaveLength(0);
    expect(h.store.get(h.record.id)?.channelRef).toBe("elsewhere");
  });

  it("adds root context before admitting a native-thread prompt, while preserving its own delivery target", async () => {
    const h = fixture(); await h.receive("reply", true, "workspace", "topic");
    expect(h.incoming).toHaveLength(1);
    expect(h.incoming[0]).toMatchObject({ channel, deliveryChannel: {
      platform: "google-chat", id: "session-home.topic", parentId: "session-home" }, preemptive: false });
    expect(h.incoming[0].text).toContain("[In thread under Root Author's message");
    expect(h.incoming[0].text).toContain("2026-10-12T18:00:00Z");
    expect(h.incoming[0].text).toContain("Root report");
    expect(h.incoming[0].text).toContain("report.csv");
    expect(h.incoming[0].text).toMatch(/\]\n\nPrompt reply$/);
    expect(h.history.readRawPage).toHaveBeenCalledExactlyOnceWith({ space: "spaces/session-home",
      thread: "spaces/session-home/threads/topic", order: "oldest", limit: 1 });
    expect(h.history.getMessage).not.toHaveBeenCalled();
  });

  it("admits the original prompt without a header when root history fails and logs the real cause", async () => {
    const h = fixture(), cause = Object.assign(new Error("Google root read: permission denied"), { response: { status: 403 } });
    h.history.readRawPage.mockRejectedValueOnce(cause);
    const warn = vi.spyOn(h.logger, "warn");
    await h.receive("reply", true, "workspace");
    expect(h.incoming[0]).toMatchObject({ channel, text: "Prompt reply" });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ err: cause }),
      "Google Chat thread context unavailable; admitting without header");
  });

  it("uses Seam's own root-message delivery record before any Google history call", async () => {
    const h = fixture(); await h.adapter.sendMessage(channel, "Own explanation");
    await h.receive("reply", true, "workspace", "new-output");
    expect(h.incoming[0].text).toContain("Own explanation");
    expect(h.history.getMessage).not.toHaveBeenCalled(); expect(h.history.readRawPage).not.toHaveBeenCalled();
  });

  it("keeps returned status-message references on their native thread, not the root", async () => {
    const h = fixture();
    const target = { platform: "google-chat", id: "session-home.topic", parentId: "session-home" };
    const ref = await h.adapter.sendMessage(target, "Working");
    expect(ref.channel).toEqual(target);
    expect(h.request).toHaveBeenCalledWith("chat", expect.objectContaining({ data: expect.objectContaining({
      thread: { name: "spaces/session-home/threads/topic" } }) }));
    expect(h.store.get(h.record.id)?.channelRef).toBe(channel.id);
  });

  it("does not convert a capped native delivery thread into a new session binding", async () => {
    const h = fixture();
    const cause = Object.assign(new Error("Cannot create reply since it has reached the threading reply limit."), {
      response: { status: 429, data: { error: { code: 429, status: "RESOURCE_EXHAUSTED",
        message: "Cannot create reply since it has reached the threading reply limit.",
        errors: [{ domain: "global", reason: "rateLimitExceeded" }] } } } });
    h.request.mockRejectedValueOnce(cause);
    await h.adapter.sendMessage({ platform: "google-chat", id: "session-home.full", parentId: "session-home" }, "Answer");
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(h.request.mock.calls[1]![1].data.thread).toBeUndefined();
    expect(h.request.mock.calls[1]![1].data.text).toContain("Continued from the previous thread");
    expect(h.store.get(h.record.id)).toMatchObject({ channelRef: "session-home", acpSessionId: "same-acp" });
    expect(h.store.getByChannel("google-chat", "session-home.new-output")).toBeNull();
  });
});

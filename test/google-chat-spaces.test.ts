import { afterEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { createHash } from "node:crypto";
import { GoogleChatAdapter } from "../packages/core/src/platforms/google-chat/adapter.js";
import { PubSubPullTransport } from "../packages/core/src/platforms/google-chat/transport.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";

const logger = pino({ level: "silent" });
const stores: SessionStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); vi.restoreAllMocks(); });
const mention = (startIndex = 0, length = 5, type = "BOT") => ({ type: "USER_MENTION", startIndex, length,
  userMention: { type: "MENTION", user: { name: type === "BOT" ? "users/app" : "users/55", type } } });
const event = (state = "THREADED_MESSAGES", thread = "A"): any => ({ type: "MESSAGE",
  space: { name: "spaces/team", spaceType: "SPACE", spaceThreadingState: state },
  user: { name: "users/42", type: "HUMAN", displayName: "Tester" },
  message: { name: `spaces/team/messages/${thread}`, text: "@Seam hello", annotations: [mention()],
    thread: { name: `spaces/team/threads/${thread}` } } });
const threaded = { platform: "google-chat", id: "team.A", parentId: "team" };
const flat = { platform: "google-chat", id: "team" };
const idFor = (raw: any) => `gchat_${createHash("sha256").update(raw.message.name).digest("base64url")}`;

function setup(allowedSpaceIds: string[] = ["spaces/team"]) {
  const request = vi.fn(async (scope: string, r: any): Promise<any> => scope === "pubsub" ? {} : {
    name: "spaces/team/messages/app-1", thread: r.data?.thread ?? { name: "spaces/team/threads/new" },
  });
  const adapter = new GoogleChatAdapter({ api: { request }, subscription: "projects/test/subscriptions/events",
    allowedUserIds: new Set(["users/42"]), allowedSpaceIds: new Set(allowedSpaceIds),
    defaultCwd: "/projects", logger, writeIntervalMs: 0 } as any);
  const messages: any[] = [];
  adapter.onMessage(msg => { messages.push(msg); msg.onAdmitted?.(); });
  const transport = new PubSubPullTransport({ api: { request }, subscription: "projects/test/subscriptions/events", logger,
    receive: (raw, signal, id) => adapter.receiveEvent(raw, signal, id) });
  const deliver = (raw: unknown, id = "publication") => transport.process({ ackId: `ack-${id}`,
    message: { messageId: id, data: Buffer.from(JSON.stringify(raw)).toString("base64") } });
  const store = new SessionStore(":memory:"); stores.push(store);
  const record = { id: "google-chat:team.A", platform: "google-chat", channelRef: "team.A", parentRef: "team",
    agentId: "codex", acpSessionId: "saved-session", configJson: "{}" };
  const ensureSessionRecord = vi.fn(() => record);
  const describeConfig = vi.fn(() => ({ agent: { value: "codex" }, model: { value: "reviewed-model" } }));
  const applyAgentChange = vi.fn(async (_channel, _record, _arg, _actor, respond) => { await respond("Agent switched."); });
  const applyModelChange = vi.fn(async (_channel, _record, _arg, _actor, respond) => { await respond("Model switched."); });
  const cancelChannel = vi.fn(async () => ({ parked: null, cancelled: { cancelled: false, starting: false },
    outcome: "idle", queue: { state: "idle", queued: 0 } }));
  adapter.setCommandDeps({ store, router: { ensureSessionRecord, describeConfig },
    runtimeTransition: { applyAgentChange, applyModelChange }, cancelChannel } as any);
  return { adapter, request, messages, deliver, store, record, ensureSessionRecord, applyAgentChange, applyModelChange, cancelChannel };
}

describe("Google Chat mention-only shared spaces", () => {
  it("strips annotation spans, preserves human mentions and prompt formatting, then ACKs after admission", async () => {
    const h = setup();
    const raw = event();
    raw.message.text = "@Seam ask @Pat about **this** @Seam";
    raw.message.annotations = [mention(30), mention(10, 4, "HUMAN"), { ...mention(), startIndex: undefined }];
    raw.message.attachment = [{ contentName: "note.txt", attachmentDataRef: { resourceName: "attachment-ref" } }];
    await h.deliver(raw);
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]).toMatchObject({ channel: threaded, text: "ask @Pat about **this**", authorId: "42",
      attachments: [{ filename: "note.txt", url: "attachment-ref" }] });
    expect(h.messages[0].raw.message.text).toBe(raw.message.text);
    expect(h.request.mock.calls).toEqual([["pubsub", expect.objectContaining({ data: { ackIds: ["ack-publication"] } })]]);
  });

  it("removes middle and repeated app mentions without deleting similarly named human mentions", async () => {
    const h = setup(); const raw = event();
    raw.message.text = "One @Seam two @Seam three @Seam";
    raw.message.annotations = [mention(26, 5, "HUMAN"), mention(4), mention(14)];
    await h.deliver(raw);
    expect(h.messages[0].text).toBe("One  two  three @Seam");
  });

  it.each(["THREADED_MESSAGES", "GROUPED_MESSAGES"])("uses a native %s thread/topic as the shared session", async state => {
    const h = setup(); const reply = event(state); reply.message.name += ".reply"; reply.message.threadReply = true;
    await h.deliver(event(state)); await h.deliver(reply, "reply"); await h.deliver(event(state, "B"), "other");
    expect(h.messages.map(msg => msg.channel)).toEqual([threaded, threaded,
      { platform: "google-chat", id: "team.B", parentId: "team" }]);
    await h.adapter.sendMessage(threaded, "answer");
    expect(h.request.mock.calls.at(-1)![1]).toMatchObject({ data: { thread: { name: "spaces/team/threads/A" } },
      params: { messageReplyOption: "REPLY_MESSAGE_OR_FAIL" } });
  });

  it.each([false, true])("maps UNTHREADED_MESSAGES to one space session (thread field present: %s)", async hasThread => {
    const h = setup(); const raw = event("UNTHREADED_MESSAGES");
    if (!hasThread) delete raw.message.thread;
    await h.deliver(raw);
    expect(h.messages[0].channel).toEqual(flat);
    const ref = await h.adapter.sendMessage(flat, "answer");
    expect(ref.channel).toEqual(flat);
    expect(h.request.mock.calls.at(-1)![1].data).not.toHaveProperty("thread");
    expect(h.request.mock.calls.at(-1)![1].params).not.toHaveProperty("messageReplyOption");
  });

  it("uses Event.thread when MESSAGE.thread is absent", async () => {
    const h = setup(); const raw = event(); raw.thread = raw.message.thread; delete raw.message.thread;
    await h.deliver(raw);
    expect(h.messages[0].channel).toEqual(threaded);
  });

  it("keeps cached flat-space mapping when later events supply only the space name", async () => {
    const h = setup(); await h.deliver(event("UNTHREADED_MESSAGES"));
    const raw = event("UNTHREADED_MESSAGES", "B"); raw.space = { name: "spaces/team" };
    await h.deliver(raw, "next");
    expect(h.messages.map(msg => msg.channel)).toEqual([flat, flat]);
  });

  it.each(["no annotation", "human mention", "link preview"])("does not admit an unaddressed space MESSAGE (%s)", async kind => {
    const h = setup(); const raw = event(); raw.message.annotations = kind === "human mention" ? [mention(0, 5, "HUMAN")] : [];
    if (kind === "link preview") raw.message.matchedUrl = { url: "https://example.com" };
    await h.deliver(raw);
    expect(h.messages).toHaveLength(0);
    expect(h.request.mock.calls).toEqual([["pubsub", expect.anything()]]);
  });

  it("applies the space list to prompts, commands and card clicks without changing the user list", async () => {
    const h = setup(["spaces/other"]); const command = event();
    command.message = { ...command.message, text: "/agent codex", argumentText: "/agent codex", slashCommand: { commandId: 3 } };
    const click = { ...event(), type: "CARD_CLICKED", action: { actionMethodName: "seam_choice",
      parameters: [{ key: "choiceId", value: "pick" }, { key: "optionIndex", value: "0" }] } };
    const choice = vi.fn(); h.adapter.onChoiceInteraction(choice, "update");
    await h.deliver(event()); await h.deliver(command, "cmd"); await h.deliver(click, "click");
    expect(h.messages).toHaveLength(0); expect(h.applyAgentChange).not.toHaveBeenCalled(); expect(choice).not.toHaveBeenCalled();
    expect(h.store.getInbound(idFor(command))).toBeNull();
    expect(h.request.mock.calls.map(([scope]) => scope)).toEqual(["pubsub", "pubsub", "pubsub"]);
    expect(h.adapter.isAllowedUser("google-chat", "42")).toBe(true);
    expect(h.adapter.isAllowedUser("google-chat", "99")).toBe(false);
  });

  it.each([{ ids: [] }, { ids: ["team"] }])("accepts unrestricted/bare-id space configuration $ids", async ({ ids }) => {
    const h = setup(ids); await h.deliver(event()); expect(h.messages[0].text).toBe("hello");
  });

  it("does not gate DMs with the shared-space allowlist or require a DM mention", async () => {
    const h = setup(["other"]); const raw = event(); raw.space.spaceType = "DIRECT_MESSAGE";
    raw.message.annotations = []; raw.message.text = "hello without mention";
    await h.deliver(raw);
    expect(h.messages[0]).toMatchObject({ channel: threaded, text: "hello without mention" });
  });

  it("still refuses non-allowlisted users and bot senders in an allowed shared space", async () => {
    const h = setup(); const denied = event(); denied.user.name = "users/99";
    const bot = event(); bot.user.type = "BOT";
    await h.deliver(denied); await h.deliver(bot, "bot"); expect(h.messages).toHaveLength(0);
  });

  it("keeps durable admission before ACK for a mentioned Space turn", async () => {
    const h = setup(); let admit!: () => void;
    h.adapter.onMessage(msg => new Promise<void>(resolve => {
      admit = () => { msg.onAdmitted?.(); resolve(); };
    }));
    const processing = h.deliver(event());
    await vi.waitFor(() => expect(admit).toBeTypeOf("function"));
    expect(h.request).not.toHaveBeenCalled(); admit(); await processing;
    expect(h.request.mock.calls.at(-1)![0]).toBe("pubsub");
  });

  it.each([[2, "/cancel"], [3, "/agent codex"], [4, "/model reviewed-model"]])
    ("runs slash command %s without a mention in the correct shared thread", async (id, text) => {
      const h = setup(); const raw = event(); raw.message.annotations = [];
      raw.message.text = text; raw.message.argumentText = text; raw.message.slashCommand = { commandId: id };
      raw.message.threadReply = true;
      await h.deliver(raw);
      const effect = id === 2 ? h.cancelChannel : id === 3 ? h.applyAgentChange : h.applyModelChange;
      expect(effect.mock.calls[0]![0]).toEqual(threaded);
      expect(h.messages).toHaveLength(0);
      expect(h.request.mock.calls[0]![1].data).toMatchObject({ privateMessageViewer: { name: "users/42" },
        thread: { name: "spaces/team/threads/A" } });
      expect(h.request.mock.calls.at(-1)![0]).toBe("pubsub");
    });

  it("explains /new in an unthreaded Space without creating a phantom session or repeating the response", async () => {
    const h = setup(); const raw = event("UNTHREADED_MESSAGES"); delete raw.message.thread;
    raw.message.text = "/new separate"; raw.message.argumentText = "/new separate"; raw.message.slashCommand = { commandId: 1 };
    await h.deliver(raw); await h.deliver(raw, "redelivery");
    expect(h.ensureSessionRecord).not.toHaveBeenCalled();
    const writes = h.request.mock.calls.filter(([scope]) => scope === "chat");
    expect(writes).toHaveLength(1);
    expect(writes[0]![1].data.text).toMatch(/does not support threads.*one shared session/i);
    expect(writes[0]![1].data).not.toHaveProperty("thread");
    expect(writes[0]![1].data.privateMessageViewer).toEqual({ name: "users/42" });
    expect(h.store.getInbound(idFor(raw))).toMatchObject({ channelRef: "team", state: "completed" });
  });

  it("routes flat-space choice clicks through the same session and ACKs only after the handler commits", async () => {
    const h = setup(); const raw = event("UNTHREADED_MESSAGES"); delete raw.message.thread;
    raw.type = "CARD_CLICKED"; raw.action = { actionMethodName: "seam_choice", parameters: [
      { key: "choiceId", value: "pick" }, { key: "optionIndex", value: "0" }] };
    const choice = vi.fn(); h.adapter.onChoiceInteraction(choice, "update");
    await h.deliver(raw);
    expect(choice).toHaveBeenCalledWith(expect.objectContaining({ channel: flat, userId: "42" }));
    expect(h.request.mock.calls.at(-1)![0]).toBe("pubsub");
  });
});

describe("Google Chat Space membership lifecycle", () => {
  it("awaits the add hook before ACK and never turns membership into a prompt", async () => {
    const h = setup(); let commit!: () => void;
    const lifecycle = vi.fn(() => new Promise<void>(resolve => { commit = resolve; }));
    (h.adapter as any).onSpaceLifecycle?.(lifecycle);
    const raw = { type: "ADDED_TO_SPACE", space: event().space };
    const processing = h.deliver(raw);
    await Promise.resolve(); await Promise.resolve();
    expect(lifecycle).toHaveBeenCalledWith(raw); expect(h.request).not.toHaveBeenCalled();
    commit(); await processing;
    expect(h.messages).toHaveLength(0); expect(h.request.mock.calls.at(-1)![0]).toBe("pubsub");
  });

  it("handles removal even for an unlisted actor or space, with no reply or cancellation", async () => {
    const h = setup(["other"]); const lifecycle = vi.fn(); (h.adapter as any).onSpaceLifecycle?.(lifecycle);
    const raw = { type: "REMOVED_FROM_SPACE", space: event().space, user: { name: "users/99" } };
    await h.deliver(raw);
    expect(lifecycle).toHaveBeenCalledWith(raw); expect(h.cancelChannel).not.toHaveBeenCalled();
    expect(h.messages).toHaveLength(0); expect(h.request.mock.calls.map(([scope]) => scope)).toEqual(["pubsub"]);
  });

  it("does not register an unlisted Space on ADDED_TO_SPACE", async () => {
    const h = setup(["other"]); const lifecycle = vi.fn(); (h.adapter as any).onSpaceLifecycle?.(lifecycle);
    await h.deliver({ type: "ADDED_TO_SPACE", space: event().space });
    expect(lifecycle).not.toHaveBeenCalled(); expect(h.messages).toHaveLength(0);
  });

  it("keeps a failed lifecycle hook unacknowledged with the original cause", async () => {
    const h = setup(); const cause = new Error("subscription persistence failed");
    (h.adapter as any).onSpaceLifecycle?.(async () => { throw cause; });
    await expect(h.deliver({ type: "ADDED_TO_SPACE", space: event().space })).rejects.toBe(cause);
    expect(h.request).not.toHaveBeenCalled();
  });
});

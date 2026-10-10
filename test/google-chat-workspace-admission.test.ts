import { afterEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { GoogleChatAdapter } from "../packages/core/src/platforms/google-chat/adapter.js";
import { PubSubPullTransport } from "../packages/core/src/platforms/google-chat/transport.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { GOOGLE_CHAT_MESSAGE_CREATED, GOOGLE_CHAT_MESSAGE_BATCH_CREATED } from "../packages/core/src/platforms/google-chat/space-subscriptions.js";

const stores: SessionStore[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); vi.restoreAllMocks(); });
const space = { name: "spaces/team", spaceType: "SPACE", spaceThreadingState: "THREADED_MESSAGES" };
const mention = { type: "USER_MENTION", startIndex: 0, length: 5,
  userMention: { type: "MENTION", user: { name: "users/seam", type: "BOT" } } };
const message = (id = "one", extra = {}) => ({ name: `spaces/team/messages/${id}`, text: "unmentioned reply",
  sender: { name: "users/42", type: "HUMAN" }, space, thread: { name: "spaces/team/threads/session" }, ...extra });

function setup(state = "THREADED_MESSAGES", allowed = ["spaces/team"]) {
  const logs: any[] = [];
  const logger = pino({ level: "debug" }, { write: line => logs.push(JSON.parse(line)) });
  const request = vi.fn(async (_scope: string, _r: any): Promise<any> => ({}));
  const store = new SessionStore(":memory:"); stores.push(store);
  const lifecycle = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    handle: vi.fn(async () => {}), space: () => ({ ...space, spaceThreadingState: state }),
    appUser: () => "users/seam", recordAppUser: vi.fn() };
  const adapter = new GoogleChatAdapter({ api: { request }, subscription: "projects/test/subscriptions/events",
    allowedUserIds: new Set(["users/42"]), allowedSpaceIds: new Set(allowed), logger, defaultCwd: "/projects",
    spaceEvents: lifecycle, hasSession: (channel: any) => ["team.session", "team"].includes(channel.id),
    writeIntervalMs: 0 } as any);
  const incoming: any[] = [], runs: string[] = [];
  adapter.onMessage(msg => {
    incoming.push(msg);
    if (store.admitInbound({ ...msg, messageId: msg.messageId!, platform: "google-chat", channelRef: msg.channel.id, parentRef: msg.channel.parentId,
      sessionRecordId: `google-chat:${msg.channel.id}`, createdUtc: new Date().toISOString() })) runs.push(msg.messageId!);
    msg.onAdmitted?.();
  });
  const cancelChannel = vi.fn(async () => ({ outcome: "idle", queue: { state: "idle", queued: 0 },
    cancelled: { cancelled: false, starting: false }, parked: null }));
  adapter.setCommandDeps({ store, cancelChannel,
    router: { ensureSessionRecord: vi.fn(input => ({ id: `google-chat:${input.channelRef}`, ...input })),
      bindRecordLocation: vi.fn(() => "local") },
    mutation: { readThreadPresetEntry: vi.fn(), applyThreadOverlay: vi.fn(() => ({ ok: true })) },
    runtimeTransition: {} } as any);
  const transport = new PubSubPullTransport({ api: { request }, subscription: "projects/test/subscriptions/events", logger,
    receive: (event: unknown, signal?: AbortSignal, id?: string) => adapter.receiveEvent(event, signal, id),
    receiveWorkspaceMessage: (parsed: any, signal?: AbortSignal) => (adapter as any).receiveWorkspaceMessage(parsed, signal) } as any);
  const workspace = (payload: unknown, type = GOOGLE_CHAT_MESSAGE_CREATED, id = "delivery") => transport.process({
    ackId: `ack-${id}`, message: { messageId: id, attributes: { "ce-type": type, "ce-id": `event-${id}` },
      data: Buffer.from(JSON.stringify(payload)).toString("base64") } } as any);
  const direct = (m: any) => adapter.receiveEvent({ type: "MESSAGE", space, message: m, user: m.sender });
  return { adapter, transport, request, workspace, direct, store, incoming, runs, logs, lifecycle, cancelChannel };
}

describe("Workspace Events use the Google Chat durable admission path", () => {
  it("admits an unmentioned reply to an existing session and ACKs after its durable record", async () => {
    const h = setup(); await h.workspace({ message: message() });
    expect(h.runs).toHaveLength(1);
    expect(h.store.getInbound(h.runs[0]!)).toMatchObject({ channelRef: "team.session", text: "unmentioned reply" });
    expect(h.request).toHaveBeenLastCalledWith("pubsub", expect.objectContaining({ data: { ackIds: ["ack-delivery"] } }));
  });

  it("does not ACK while admission is pending", async () => {
    const h = setup(); let admit!: () => void;
    h.adapter.onMessage(msg => new Promise<void>(resolve => { admit = () => { msg.onAdmitted?.(); resolve(); }; }));
    const pending = h.workspace({ message: message() });
    await vi.waitFor(() => expect(admit).toBeTypeOf("function"));
    expect(h.request).not.toHaveBeenCalled(); admit(); await pending;
  });

  it("uses one ledger id for direct mention plus two CloudEvent deliveries", async () => {
    const h = setup(), m = message("mention", { text: "@Seam hello", annotations: [mention] });
    await h.direct(m); await h.workspace({ message: m }); await h.workspace({ message: m }, undefined, "redelivery");
    expect(h.incoming).toHaveLength(3);
    expect(new Set(h.incoming.map(msg => msg.messageId)).size).toBe(1);
    expect(h.runs).toHaveLength(1); expect(h.incoming.map(msg => msg.text)).toEqual(["hello", "hello", "hello"]);
  });

  it("uses the adapter's UNTHREADED channel mapping even when the resource has a thread", async () => {
    const h = setup("UNTHREADED_MESSAGES"); await h.workspace({ message: message("flat", { space: { name: "spaces/team" } }) });
    expect(h.incoming[0]?.channel).toEqual({ platform: "google-chat", id: "team" });
  });

  it("unpacks batches through the same path", async () => {
    const h = setup(); await h.workspace({ messages: [{ message: message("one") }, { message: message("two") }] },
      GOOGLE_CHAT_MESSAGE_BATCH_CREATED);
    expect(h.runs).toHaveLength(2); expect(h.request).toHaveBeenCalledOnce();
  });

  it.each(["own reply", "unlisted user", "unlisted space", "unrelated thread", "other app mention"])("skips %s", async kind => {
    const h = setup(undefined, kind === "unlisted space" ? ["other"] : undefined);
    const m = message();
    if (kind === "own reply") m.sender = { name: "users/seam", type: "BOT" };
    if (kind === "unlisted user") m.sender.name = "users/99";
    if (kind === "unrelated thread" || kind === "other app mention") m.thread.name = "spaces/team/threads/unrelated";
    if (kind === "other app mention") Object.assign(m, { text: "@Other hello", annotations: [
      { ...mention, userMention: { ...mention.userMention, user: { name: "users/other-app", type: "BOT" } } }] });
    await h.workspace({ message: m }); expect(h.runs).toHaveLength(0);
    expect(h.request).toHaveBeenCalledOnce();
  });

  it("never runs a duplicated slash command as a prompt", async () => {
    const h = setup(); const m = message("command", { text: "/cancel", threadReply: true,
      annotations: [{ type: "SLASH_COMMAND", slashCommand: { commandId: "2", type: "INVOKE" } }] });
    h.request.mockResolvedValue({ name: "spaces/team/messages/answer", thread: m.thread });
    await h.direct(m); await h.workspace({ message: m });
    expect(h.cancelChannel).toHaveBeenCalledOnce(); expect(h.incoming).toHaveLength(0);
  });

  it("does not execute another app's slash command or turn an unsupported command into a prompt", async () => {
    const h = setup();
    await h.workspace({ message: message("foreign", { text: "/cancel", annotations: [
      { type: "SLASH_COMMAND", slashCommand: { commandId: "2", type: "INVOKE", bot: { name: "users/other" } } }] }) });
    await h.workspace({ message: message("unknown", { text: "/unknown", slashCommand: { commandId: "900" } }) }, undefined, "unknown");
    expect(h.cancelChannel).not.toHaveBeenCalled(); expect(h.incoming).toHaveLength(0);
  });

  it("learns canonical app identity from its own app-auth message response, without a membership request", async () => {
    const h = setup(); h.request.mockResolvedValue({ name: "spaces/team/messages/our-reply", sender: { name: "users/seam", type: "BOT" } });
    await h.adapter.sendMessage({ platform: "google-chat", id: "team.session", parentId: "team" }, "hello");
    expect(h.lifecycle.recordAppUser).toHaveBeenCalledWith("spaces/team", "users/seam");
    expect(h.request.mock.calls.some(([, request]) => request.url.includes("members/app"))).toBe(false);
  });

  it("admits concurrent direct/Workspace copies under one durable key", async () => {
    const h = setup(), m = message("concurrent", { text: "@Seam hello", annotations: [mention] });
    await Promise.all([h.direct(m), h.workspace({ message: m })]);
    expect(h.incoming).toHaveLength(2); expect(h.runs).toHaveLength(1);
  });

  it("strips only Seam's annotation, preserving another bot's mention", async () => {
    const h = setup();
    await h.workspace({ message: message("mentions", { text: "@Seam ask @Other", annotations: [mention,
      { ...mention, startIndex: 10, length: 6, userMention: { ...mention.userMention, user: { name: "users/other", type: "BOT" } } }] }) });
    expect(h.incoming[0]?.text).toBe("ask @Other");
  });

  it("starts a session for a native Seam mention but not an unmentioned new thread", async () => {
    const h = setup();
    const m = message("new", { text: "@Seam start", annotations: [mention], thread: { name: "spaces/team/threads/new" } });
    await h.workspace({ message: m }); expect(h.incoming[0]?.channel.id).toBe("team.new");
    await h.workspace({ message: message("new-unmentioned", { thread: { name: "spaces/team/threads/other" } }) }, undefined, "other");
    expect(h.runs).toHaveLength(1);
  });

  it("hydrates a name-only reference using the approved app scope, never an empty turn", async () => {
    const h = setup(); h.request.mockImplementation(async () => message("reference"));
    await h.workspace({ message: { name: "spaces/team/messages/reference" } });
    expect(h.request).toHaveBeenNthCalledWith(1, "messages", expect.objectContaining({ method: "GET",
      url: "https://chat.googleapis.com/v1/spaces/team/messages/reference" }));
    expect(h.incoming[0]?.text).toBe("unmentioned reply");
  });

  it("logs a hydration rejection with the original Google cause and skips, without fabricating a turn", async () => {
    const h = setup(), cause = Object.assign(new Error("Google: message was deleted"), { code: 404 });
    h.request.mockImplementation(async (_scope, r) => { if (r.url.includes("chat.googleapis.com")) throw cause; return {}; });
    await h.workspace({ message: { name: "spaces/team/messages/gone" } });
    expect(h.incoming).toHaveLength(0);
    expect(h.logs.some(entry => entry.err?.message === cause.message)).toBe(true);
  });

  it("skips still-incomplete hydration, never fabricating empty text from a reference", async () => {
    const h = setup(); h.request.mockResolvedValue({ name: "spaces/team/messages/incomplete", sender: { name: "users/42" } });
    await h.workspace({ message: { name: "spaces/team/messages/incomplete" } });
    expect(h.incoming).toHaveLength(0);
    expect(h.logs.some(entry => entry.err?.message.includes("still lacks sender or content"))).toBe(true);
  });

  it("preserves a pre-admission failure and leaves the Workspace publication unacknowledged", async () => {
    const h = setup(), cause = new Error("SQLITE_BUSY: durable admission unavailable");
    h.adapter.onMessage(() => { throw cause; });
    await expect(h.workspace({ message: message() })).rejects.toBe(cause);
    expect(h.request).not.toHaveBeenCalled();
  });
});

describe("Adapter wires its Space subscription lifecycle", () => {
  it("starts pulling before reconciliation and stops its renewal worker", async () => {
    const h = setup();
    h.request.mockImplementation(async (_scope, r) => new Promise((_, reject) =>
      r.signal.addEventListener("abort", () => reject(r.signal.reason), { once: true })));
    await h.adapter.start(); await h.adapter.stop();
    expect(h.lifecycle.start).toHaveBeenCalledOnce(); expect(h.lifecycle.stop).toHaveBeenCalledOnce();
    expect(h.request.mock.invocationCallOrder[0]).toBeLessThan(h.lifecycle.start.mock.invocationCallOrder[0]!);
  });

  it("creates on add and deletes on removal without user authorization blocking cleanup", async () => {
    const h = setup();
    await h.adapter.receiveEvent({ type: "ADDED_TO_SPACE", space });
    await h.adapter.receiveEvent({ type: "REMOVED_FROM_SPACE", space, user: { name: "users/99" } });
    expect(h.lifecycle.handle).toHaveBeenNthCalledWith(1, { type: "ADDED_TO_SPACE", space });
    expect(h.lifecycle.handle).toHaveBeenNthCalledWith(2, expect.objectContaining({ type: "REMOVED_FROM_SPACE", space }));
  });

  it("does not subscribe to denied spaces or DMs", async () => {
    const h = setup(undefined, ["other"]);
    await h.adapter.receiveEvent({ type: "ADDED_TO_SPACE", space });
    await h.adapter.receiveEvent({ type: "ADDED_TO_SPACE", space: { ...space, spaceType: "DIRECT_MESSAGE" } });
    expect(h.lifecycle.handle).not.toHaveBeenCalled();
  });
});

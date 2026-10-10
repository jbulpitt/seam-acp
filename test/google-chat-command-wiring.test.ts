import { afterEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { GoogleChatAdapter } from "../packages/core/src/platforms/google-chat/adapter.js";
import { PubSubPullTransport } from "../packages/core/src/platforms/google-chat/transport.js";

const channel = { platform: "google-chat", id: "dm.thread", parentId: "dm" };
const logger = pino({ level: "silent" });
const stores: SessionStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); vi.restoreAllMocks(); });
const event = (id: number, text: string) => ({ type: "MESSAGE", space: { name: "spaces/dm" },
  user: { name: "users/42", displayName: "Tester" },
  message: { name: `spaces/dm/messages/command-${id}`, argumentText: text, text, slashCommand: { commandId: id },
    thread: { name: "spaces/dm/threads/thread" } } });

function setup() {
  const store = new SessionStore(":memory:"); stores.push(store);
  const request = vi.fn(async (_scope: string, r: any): Promise<any> => ({ name: "spaces/dm/messages/app",
    thread: r.data?.thread ?? { name: "spaces/dm/threads/new" } }));
  const adapter = new GoogleChatAdapter({ api: { request }, subscription: "projects/test/subscriptions/events",
    allowedUserIds: new Set(["users/42"]), defaultCwd: "/projects", logger, writeIntervalMs: 0 });
  const normal = vi.fn((message: any) => message.onAdmitted());
  adapter.onMessage(normal);
  const record = { id: "google-chat:dm.thread", platform: "google-chat", channelRef: "dm.thread", parentRef: "dm",
    agentId: "claude", acpSessionId: "saved-session", configJson: "{}" };
  const ensureSessionRecord = vi.fn(() => record);
  const describeConfig = vi.fn(() => ({ agent: { value: "claude" }, model: { value: "claude-reviewed" } }));
  const applyAgentChange = vi.fn(async (_ch, _record, _arg, _actor, respond) => {
    await respond("Switched agent, native outcome"); return { ok: true, message: "native" };
  });
  const applyModelChange = vi.fn(async (_ch, _record, _arg, _actor, respond) => {
    await respond("Switched model, native outcome"); return { ok: true, message: "native" };
  });
  const cancelChannel = vi.fn(async () => ({ parked: null, cancelled: { cancelled: true, starting: false },
    outcome: "idle", queue: { state: "idle", queued: 0 } }));
  (adapter as any).setCommandDeps?.({ store, router: { ensureSessionRecord, describeConfig },
    runtimeTransition: { applyAgentChange, applyModelChange }, cancelChannel });
  const transport = new PubSubPullTransport({ api: { request }, subscription: "projects/test/subscriptions/events", logger,
    receive: (...args: any[]) => (adapter.receiveEvent as any)(...args) });
  const deliver = (raw: unknown) => transport.process({ ackId: "ack-command", message: { messageId: "pubsub-command",
    data: Buffer.from(JSON.stringify(raw)).toString("base64") } });
  return { adapter, request, normal, record, ensureSessionRecord, describeConfig, applyAgentChange, applyModelChange, cancelChannel, deliver };
}

describe("merged Google Chat commands wired before ordinary turn admission", () => {
  it.each([[3, "agent", "claude"], [4, "model", "claude-reviewed"]])
    ("replies with usage for bare /%s with null argumentText, preserving the saved session", async (id, command, current) => {
      const h = setup();
      const before = structuredClone(h.record);
      const raw = event(Number(id), `/${command}`);
      await h.deliver({ ...raw, message: { ...raw.message, argumentText: null } });
      expect(h.applyAgentChange).not.toHaveBeenCalled();
      expect(h.applyModelChange).not.toHaveBeenCalled();
      expect(h.normal).not.toHaveBeenCalled();
      expect(h.record).toEqual(before);
      expect(h.request.mock.calls[0]![1].data.text).toBe(`Usage: /${command} <id> — current: ${current}`);
      expect(h.request.mock.calls.at(-1)).toEqual(["pubsub", expect.objectContaining({
        data: { ackIds: ["ack-command"] },
      })]);
    });

  it.each([[2, "/cancel"], [3, "/agent codex"], [4, "/model native-model"]])
    ("keeps command %s replies private to the caller in the command's top-level thread", async (id, text) => {
      const h = setup();
      const raw = event(Number(id), String(text));
      const thread = "spaces/dm/threads/ZjAsuOGhiCo";
      raw.message.name = "spaces/dm/messages/ZjAsuOGhiCo.ZjAsuOGhiCo";
      raw.message.thread.name = thread;
      await h.deliver(raw);
      expect(h.request.mock.calls[0]).toEqual(["chat", expect.objectContaining({
        params: expect.objectContaining({ messageReplyOption: "REPLY_MESSAGE_OR_FAIL" }),
        data: expect.objectContaining({ thread: { name: thread }, privateMessageViewer: { name: "users/42" } }),
      })]);
      expect(h.normal).not.toHaveBeenCalled();
      expect(h.request.mock.calls.at(-1)![0]).toBe("pubsub");
    });

  it("ACKs a reply's permanent NOT_FOUND after execution, logging the real cause instead of retrying the effect", async () => {
    const h = setup();
    const cause = Object.assign(new Error("NOT_FOUND: requested command thread was not found"),
      { response: { status: 404 } });
    const error = vi.spyOn(logger, "error");
    h.request.mockImplementation(async (_scope, r) => {
      if (r.params?.messageReplyOption === "REPLY_MESSAGE_OR_FAIL") throw cause;
      return { name: "spaces/dm/messages/doT0sHl7beg.doT0sHl7beg", thread: { name: "spaces/dm/threads/doT0sHl7beg" } };
    });
    await h.deliver(event(2, "/cancel"));
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ err: cause }),
      "Google Chat command reply rejected after execution; acknowledging event");
    expect(h.request.mock.calls.map(([scope]) => scope)).toEqual(["chat", "pubsub"]);
    expect(h.normal).not.toHaveBeenCalled();
  });

  it("keeps every split command reply private and in the invocation thread before ACK", async () => {
    const h = setup();
    h.applyModelChange.mockImplementation(async (_ch, _record, _arg, _actor, respond) => {
      const message = "Native model response. ".repeat(2000);
      await respond(message); return { ok: true, message };
    });
    await h.deliver(event(4, "/model native-model"));
    const writes = h.request.mock.calls.filter(([scope]) => scope === "chat");
    expect(writes.length).toBeGreaterThan(1);
    for (const [, req] of writes) expect(req).toMatchObject({
      params: { messageReplyOption: "REPLY_MESSAGE_OR_FAIL" },
      data: { thread: { name: "spaces/dm/threads/thread" }, privateMessageViewer: { name: "users/42" } },
    });
    expect(h.request.mock.calls.at(-1)![0]).toBe("pubsub");
  });

  it("cancels the calling thread directly, without turning /cancel into a newer prompt", async () => {
    const h = setup();
    await h.deliver(event(2, "/cancel"));
    expect(h.cancelChannel).toHaveBeenCalledExactlyOnceWith(channel);
    expect(h.normal).not.toHaveBeenCalled();
    expect(h.request.mock.calls[0]![1].data.text).toContain("Turn cancelled");
    expect(h.request.mock.calls.at(-1)![0]).toBe("pubsub");
  });

  it.each([[3, "/agent codex@remote", "codex@remote"], [4, "/model native-unlisted-id", "native-unlisted-id"]])
    ("passes command %s through the merged action map and RuntimeTransition unchanged", async (id, text, args) => {
      const h = setup();
      await h.deliver(event(Number(id), String(text)));
      const selected = id === 3 ? h.applyAgentChange : h.applyModelChange;
      expect(selected).toHaveBeenCalledExactlyOnceWith(channel, expect.objectContaining({ id: "google-chat:dm.thread" }),
        args, { id: "42", name: "Tester" }, expect.any(Function));
      expect(h.ensureSessionRecord).toHaveBeenCalledExactlyOnceWith({ platform: "google-chat", channelRef: "dm.thread",
        parentRef: "dm", cwd: "/projects" });
      expect(h.normal).not.toHaveBeenCalled();
      expect(h.request.mock.calls[0]![1].data.thread.name).toBe("spaces/dm/threads/thread");
      expect(h.request.mock.calls.at(-1)![0]).toBe("pubsub");
    });

  it("creates a new top-level thread for /new and binds only that returned sibling", async () => {
    const h = setup();
    await h.deliver(event(1, "/new Another task"));
    expect(h.normal).not.toHaveBeenCalled();
    expect(h.request.mock.calls[0]![1].data.text).toBe("Another task");
    expect(h.request.mock.calls[0]![1].data.thread).toBeUndefined();
    expect(h.ensureSessionRecord).toHaveBeenCalledExactlyOnceWith({ platform: "google-chat", channelRef: "dm.new",
      parentRef: "dm", cwd: "/projects" });
  });

  it("routes APP_COMMAND through the same canonical channel action", async () => {
    const h = setup();
    await h.deliver({ type: "APP_COMMAND", space: { name: "spaces/dm" }, thread: { name: "spaces/dm/threads/thread" },
      user: { name: "users/42", displayName: "Tester" },
      appCommandMetadata: { appCommandId: 2, appCommandType: "SLASH_COMMAND" } });
    expect(h.cancelChannel).toHaveBeenCalledExactlyOnceWith(channel);
    expect(h.normal).not.toHaveBeenCalled();
  });

  it("does not ACK while a command is still committing its real core operation", async () => {
    const h = setup();
    let commit!: () => void;
    h.applyModelChange.mockImplementation(async (_ch, _record, _arg, _actor, respond) => {
      await new Promise<void>(resolve => { commit = resolve; });
      await respond("Committed"); return { ok: true, message: "Committed" };
    });
    const processing = h.deliver(event(4, "/model native-model"));
    await vi.waitFor(() => expect(h.applyModelChange).toHaveBeenCalledOnce());
    expect(h.request).not.toHaveBeenCalled();
    commit(); await processing;
    expect(h.request.mock.calls.map(call => call[0])).toEqual(["chat", "pubsub"]);
  });

  it("reports a real cancel error, never a false cancellation success", async () => {
    const h = setup();
    h.cancelChannel.mockResolvedValueOnce({ parked: null, cancelled: { cancelled: false, starting: false },
      error: new Error("ECONNRESET while signalling the native runtime") } as any);
    await h.deliver(event(2, "/cancel"));
    expect(h.request.mock.calls[0]![1].data.text).toContain("ECONNRESET while signalling the native runtime");
    expect(h.request.mock.calls[0]![1].data.text).not.toContain("Turn cancelled");
  });

  it("preserves a thrown transition error for Pub/Sub redelivery without admitting a prompt", async () => {
    const h = setup();
    const cause = new Error("native session config write failed");
    h.applyModelChange.mockRejectedValueOnce(cause);
    await expect(h.deliver(event(4, "/model native-model"))).rejects.toBe(cause);
    expect(h.request).not.toHaveBeenCalled();
    expect(h.normal).not.toHaveBeenCalled();
  });

  it("leaves ordinary DM messages on the existing durable admission path", async () => {
    const h = setup();
    const raw: any = event(4, "hello"); delete raw.message.slashCommand;
    await h.deliver(raw);
    expect(h.normal).toHaveBeenCalledOnce();
    expect(h.applyModelChange).not.toHaveBeenCalled();
    expect(h.cancelChannel).not.toHaveBeenCalled();
  });
});

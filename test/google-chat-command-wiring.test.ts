import { describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { GoogleChatAdapter } from "../packages/core/src/platforms/google-chat/adapter.js";
import { PubSubPullTransport } from "../packages/core/src/platforms/google-chat/transport.js";

const channel = { platform: "google-chat", id: "dm.thread", parentId: "dm" };
const logger = pino({ level: "silent" });
const event = (id: number, text: string) => ({ type: "MESSAGE", space: { name: "spaces/dm" },
  user: { name: "users/42", displayName: "Tester" },
  message: { name: `spaces/dm/messages/command-${id}`, argumentText: text, text, slashCommand: { commandId: id },
    thread: { name: "spaces/dm/threads/thread" } } });

function setup() {
  const request = vi.fn(async (_scope: string, r: any): Promise<any> => ({ name: "spaces/dm/messages/app",
    thread: r.data?.thread ?? { name: "spaces/dm/threads/new" } }));
  const adapter = new GoogleChatAdapter({ api: { request }, subscription: "projects/test/subscriptions/events",
    allowedUserIds: new Set(["users/42"]), defaultCwd: "/projects", logger, writeIntervalMs: 0 });
  const normal = vi.fn((message: any) => message.onAdmitted());
  adapter.onMessage(normal);
  const record = { id: "google-chat:dm.thread", platform: "google-chat", channelRef: "dm.thread", parentRef: "dm" };
  const ensureSessionRecord = vi.fn(() => record);
  const applyAgentChange = vi.fn(async (_ch, _record, _arg, _actor, respond) => {
    await respond("Switched agent, native outcome"); return { ok: true, message: "native" };
  });
  const applyModelChange = vi.fn(async (_ch, _record, _arg, _actor, respond) => {
    await respond("Switched model, native outcome"); return { ok: true, message: "native" };
  });
  const cancelChannel = vi.fn(async () => ({ parked: null, cancelled: { cancelled: true, starting: false },
    outcome: "idle", queue: { state: "idle", queued: 0 } }));
  (adapter as any).setCommandDeps?.({ router: { ensureSessionRecord },
    runtimeTransition: { applyAgentChange, applyModelChange }, cancelChannel });
  const transport = new PubSubPullTransport({ api: { request }, subscription: "projects/test/subscriptions/events", logger,
    receive: (...args: any[]) => (adapter.receiveEvent as any)(...args) });
  const deliver = (raw: unknown) => transport.process({ ackId: "ack-command", message: { messageId: "pubsub-command",
    data: Buffer.from(JSON.stringify(raw)).toString("base64") } });
  return { adapter, request, normal, ensureSessionRecord, applyAgentChange, applyModelChange, cancelChannel, deliver };
}

describe("merged Google Chat commands wired before ordinary turn admission", () => {
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

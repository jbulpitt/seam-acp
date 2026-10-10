import { describe, expect, it, vi } from "vitest";
import { pino } from "pino";

const logger = pino({ level: "silent" });
const channel = { platform: "google-chat", id: "DM_1.Thread_1", parentId: "DM_1" };
const event = (reply = false) => ({ type: "MESSAGE", space: { name: "spaces/DM_1", spaceType: "DIRECT_MESSAGE",
  spaceThreadingState: "THREADED_MESSAGES" }, user: { name: "users/42", displayName: "Tester", type: "HUMAN" },
  message: { name: `spaces/DM_1/messages/${reply ? "Reply_2" : "Thread_1"}`, text: "hello", threadReply: reply,
    thread: { name: "spaces/DM_1/threads/Thread_1" }, attachment: [{ contentName: "note.txt", contentType: "text/plain",
      attachmentDataRef: { resourceName: "spaces/DM_1/messages/Thread_1/attachments/note" } }] } });

async function setup() {
  const { GoogleChatAdapter } = await import("../packages/core/src/platforms/google-chat/adapter.js");
  const request = vi.fn(async (_scope: string, r: any): Promise<any> => r.responseType === "arraybuffer"
    ? Buffer.from("attached text") : { name: "spaces/DM_1/messages/app-1", thread: { name: "spaces/DM_1/threads/Thread_1" } });
  const adapter = new GoogleChatAdapter({ api: { request }, subscription: "projects/test/subscriptions/events",
    allowedUserIds: new Set(["users/42"]), defaultCwd: "/projects", logger, writeIntervalMs: 0 });
  return { adapter, request };
}

describe("Google Chat DM adapter", () => {
  it("maps a top-level DM and its reply to the same safe session ref, and a new top-level to a new session", async () => {
    const { adapter } = await setup();
    const messages: any[] = [];
    adapter.onMessage(msg => { messages.push(msg); msg.onAdmitted?.(); });
    await adapter.receiveEvent(event());
    await adapter.receiveEvent(event(true));
    const other = event();
    other.message.name = "spaces/DM_1/messages/Another";
    other.message.thread.name = "spaces/DM_1/threads/Another";
    await adapter.receiveEvent(other);
    expect(messages.map(m => m.channel)).toEqual([channel, channel,
      { platform: "google-chat", id: "DM_1.Another", parentId: "DM_1" }]);
    expect(messages[0]).toMatchObject({ authorId: "42", authorName: "Tester", authorIsBot: false, cwd: "/projects" });
    expect(messages[0].messageId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(messages[0].messageId).not.toBe(messages[1].messageId);
    expect(messages[0].raw.message.thread.name).toBe("spaces/DM_1/threads/Thread_1");
    expect(messages[0].attachments[0].url).toBe("spaces/DM_1/messages/Thread_1/attachments/note");
  });

  it("does not admit other users or app messages, and accepts bare ids for choice authorization", async () => {
    const { adapter } = await setup();
    const handle = vi.fn();
    adapter.onMessage(handle);
    const denied = event(); denied.user.name = "users/99";
    const bot = event(); bot.user.type = "BOT";
    await adapter.receiveEvent(denied); await adapter.receiveEvent(bot);
    expect(handle).not.toHaveBeenCalled();
    expect(adapter.isAllowedUser("google-chat", "42")).toBe(true);
    expect(adapter.isAllowedUser("discord", "42")).toBe(false);
    expect(adapter.isAllowedUser("google-chat", "99")).toBe(false);
  });

  it("acks admission without waiting for turn completion, never merely because a handler returned", async () => {
    const { adapter } = await setup();
    let incoming: any;
    let finish!: () => void;
    const turn = new Promise<void>(resolve => { finish = resolve; });
    adapter.onMessage(msg => { incoming = msg; return turn; });
    const admitted = adapter.receiveEvent(event());
    await vi.waitFor(() => expect(incoming).toBeDefined());
    let settled = false;
    void admitted.then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    incoming.onAdmitted();
    await admitted;
    expect(settled).toBe(true);
    finish(); await turn;

    adapter.onMessage(() => {});
    await expect(adapter.receiveEvent(event(true))).rejects.toThrow("without durable admission");
  });

  it("sends and edits app messages in the original thread, with stable delivery nonces", async () => {
    const { adapter, request } = await setup();
    const ref = await adapter.sendMessage(channel, "hello", { nonce: "Nonce_UPPER/123", enforceNonce: true });
    expect(request.mock.calls[0]).toEqual(["chat", expect.objectContaining({ method: "POST",
      url: "https://chat.googleapis.com/v1/spaces/DM_1/messages",
      params: expect.objectContaining({ messageReplyOption: "REPLY_MESSAGE_OR_FAIL",
        messageId: expect.stringMatching(/^client-[a-z0-9-]{1,56}$/) }),
      data: expect.objectContaining({ text: "hello", thread: { name: "spaces/DM_1/threads/Thread_1" } }) })]);
    await adapter.editMessage(ref, "done");
    expect(request.mock.calls[1]).toEqual(["chat", expect.objectContaining({ method: "PATCH",
      url: "https://chat.googleapis.com/v1/spaces/DM_1/messages/app-1", params: { updateMask: "text" },
      data: expect.objectContaining({ text: "done" }) })]);
  });

  it("creates a new top-level session thread and sends text files as text, not app-auth uploads", async () => {
    const { adapter, request } = await setup();
    request.mockResolvedValueOnce({ name: "spaces/DM_1/messages/new", thread: { name: "spaces/DM_1/threads/New" } });
    expect(await adapter.createThread({ platform: "google-chat", id: "DM_1" }, "new session"))
      .toEqual({ platform: "google-chat", id: "DM_1.New", parentId: "DM_1" });
    expect(request.mock.calls[0]![1].data.thread).toBeUndefined();
    await adapter.sendFile(channel, { data: Buffer.from("file body"), filename: "note.txt", mimeType: "text/plain" });
    expect(request.mock.calls[1]![1].data.text).toContain("file body");
    expect(request.mock.calls[1]![1].url).not.toContain("upload");
  });

  it("downloads an inbound attachment through media.download using app authentication", async () => {
    const { adapter, request } = await setup();
    const bytes = await adapter.downloadAttachment({ url: "spaces/DM_1/messages/M/attachments/A",
      filename: "note.txt", contentType: "text/plain", size: 0 });
    expect(bytes.toString()).toBe("attached text");
    expect(request).toHaveBeenCalledWith("chat", expect.objectContaining({ method: "GET",
      url: "https://chat.googleapis.com/v1/media/spaces/DM_1/messages/M/attachments/A",
      params: { alt: "media" }, responseType: "arraybuffer" }));
  });

  it("treats a duplicate nonce as the same posted message, with a space-qualified lookup", async () => {
    const { adapter, request } = await setup();
    request.mockRejectedValueOnce(Object.assign(new Error("already exists"), { response: { status: 409 } }));
    const ref = await adapter.sendMessage(channel, "terminal", { nonce: "stable-delivery", enforceNonce: true });
    expect(ref.id).toBe("spaces/DM_1/messages/app-1");
    const createdId = request.mock.calls[0]![1].params.messageId;
    expect(request.mock.calls[1]![1]).toMatchObject({ method: "GET",
      url: `https://chat.googleapis.com/v1/spaces/DM_1/messages/${createdId}` });
    // Resolving a 409 is not an authorized history lookup for an uncertain receipt.
    expect(await adapter.findMessageByNonce(channel, "stable-delivery")).toMatchObject({
      status: "indeterminate", reason: expect.stringContaining("chat.app.messages.readonly"),
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("reports nonce lookup unsupported without configured history access and makes no Google call", async () => {
    const { adapter, request } = await setup();
    request.mockRejectedValue(Object.assign(new Error("Permission denied to perform the requested action"),
      { response: { status: 403 } }));

    for (let retry = 0; retry < 2; retry++) {
      const result = await adapter.findMessageByNonce(channel, "uncertain-delivery");
      expect(result).toEqual({ status: "indeterminate",
        reason: expect.stringMatching(/unsupported.*configured.*admin-approved.*chat\.app\.messages\.readonly/) });
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("logs a reply fallback instead of silently claiming the original thread", async () => {
    const { adapter, request } = await setup();
    request.mockResolvedValueOnce({ name: "spaces/DM_1/messages/fallback", thread: { name: "spaces/DM_1/threads/Fallback" } });
    const warn = vi.spyOn(logger, "warn");
    try {
      expect((await adapter.sendMessage(channel, "hello")).channel.id).toBe("DM_1.Fallback");
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ expected: "spaces/DM_1/threads/Thread_1",
        actual: "spaces/DM_1/threads/Fallback" }), "Google Chat reply fell back to a different thread");
    } finally { warn.mockRestore(); }
  });
});

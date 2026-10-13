import { afterEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoogleChatAdapter } from "../packages/core/src/platforms/google-chat/adapter.js";
import { GoogleChatHistoryReader } from "../packages/core/src/core/messages/google-chat-history.js";
import { projectDiscordConversation } from "../packages/core/src/core/reconstruction/project.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { parseGoogleChatWorkspaceMessages } from "../packages/core/src/platforms/google-chat/workspace-message-event.js";
import { GoogleChatSpaceEvents } from "../packages/core/src/platforms/google-chat/space-events.js";

const user = "users/poster", bot = "users/app", space = "spaces/test", thread = `${space}/threads/native`;
const channel = { platform: "google-chat", id: "test" };
const image = { data: Buffer.from([137, 80, 78, 71, 0, 255]), filename: "result.png", mimeType: "image/png", caption: "Result" };
const stores: SessionStore[] = [], dirs: string[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true })); vi.restoreAllMocks(); });

function fixture(path = ":memory:") {
  const store = new SessionStore(path); stores.push(store);
  const now = new Date().toISOString();
  store.upsert({ id: "google-chat:test", platform: "google-chat", channelRef: "test", parentRef: null,
    agentId: "codex", acpSessionId: "same-acp", repoPath: "/fixture", configJson: "{}", createdUtc: now, updatedUtc: now });
  const logger = pino({ level: "silent" });
  const cause = new Error("fixture");
  const drive = { upload: vi.fn(async () => "https://drive.google.com/file/d/original/view") };
  const history = new Map<string, any>();
  let ordinal = 0;
  const request = vi.fn(async (scope: string, r: any): Promise<any> => {
    if (r.method === "GET" && r.url.endsWith("/members/poster")) return { state: "JOINED", member: { name: user } };
    if (r.method === "GET" && !r.url.includes("/messages/")) return { name: space, spaceType: "SPACE" };
    if (r.url.includes("/attachments:upload")) return { attachmentDataRef: { resourceName: "uploaded" } };
    if (r.method === "GET") return history.get(r.url.split("/v1/")[1]);
    const message = { name: `${space}/messages/system-${++ordinal}`, text: r.data?.text, createTime: now,
      clientAssignedMessageId: r.params?.messageId, thread: r.data?.thread ?? { name: `${space}/threads/root-${ordinal}` },
      sender: { name: scope === "media" ? user : bot, type: scope === "media" ? "HUMAN" : "BOT" },
      attachment: r.data?.attachment?.map(() => ({ contentName: image.filename })) };
    history.set(message.name, message);
    if (message.clientAssignedMessageId) history.set(`${space}/messages/${message.clientAssignedMessageId}`, message);
    return message;
  });
  const reader = new GoogleChatHistoryReader({ credentialsFile: "unused",
    isOwnMessage: (m: any) => (store.googleChatSpaces as any).isOwnMessage(m) } as any,
    { request: async (r: any) => ({ data: r.url.includes("/messages?")
      ? { messages: [...history.values()].filter((v, i, a) => a.indexOf(v) === i) } : history.get(r.url.split("/v1/")[1]) }) });
  const make = (native = true) => {
    const adapter = new GoogleChatAdapter({ api: { request }, subscription: "unused", allowedUserIds: new Set([user]),
      defaultCwd: "/fixture", logger, writeIntervalMs: 0, driveUploader: drive, historyReader: reader,
      ...(native ? { mediaUser: user, nativeImages: true } : {}) } as any);
    adapter.setCommandDeps({ store, mutation: {}, deliveryForChannel: () => ({ channel }) } as any);
    return adapter;
  };
  return { store, logger, cause, drive, request, reader, history, make, adapter: make() };
}

async function echo(adapter: GoogleChatAdapter, message: any, source: "direct" | "workspace") {
  if (source === "direct") await adapter.receiveEvent({ type: "MESSAGE", space: { name: space, spaceType: "SPACE" }, user: message.sender, message });
  else await adapter.receiveWorkspaceMessage(parseGoogleChatWorkspaceMessages({
    attributes: { "ce-type": "google.workspace.chat.message.v1.created" },
    data: Buffer.from(JSON.stringify({ message })).toString("base64"),
  })[0]!);
}

describe("Google Chat native images", () => {
  it("uploads bytes and filename using user auth, then posts the native attachment with a durable client identity", async () => {
    const h = fixture();
    const ref = await h.adapter.sendFile(channel, image, { nonce: "image-turn" });
    expect(h.drive.upload).not.toHaveBeenCalled();
    const upload = h.request.mock.calls.find(([, r]) => r.url.includes("/attachments:upload"));
    expect(upload?.[0]).toBe("media");
    expect(upload?.[1]).toMatchObject({ method: "POST", params: { uploadType: "multipart" }, headers: { "Content-Type": expect.stringContaining("multipart/related") } });
    expect(Buffer.isBuffer(upload?.[1].data)).toBe(true);
    expect(upload?.[1].data.includes(image.data)).toBe(true);
    expect(upload?.[1].data.toString()).toContain(JSON.stringify({ filename: image.filename }));
    const create = h.request.mock.calls.find(([scope, r]) => scope === "media" && r.url.endsWith("/messages"));
    expect(create?.[1]).toMatchObject({ params: { messageId: expect.stringMatching(/^client-seam-[a-f0-9]+$/) },
      data: { text: "Result", attachment: [{ attachmentDataRef: { resourceName: "uploaded" } }] } });
    expect(create?.[1].params.messageId.length).toBeLessThanOrEqual(63);
    expect((h.store.googleChatSpaces as any).isOwnMessage({ name: ref.id })).toBe(true);
    expect(h.adapter.getBotUserId()).not.toBe(user);
  });

  it.each(["direct", "workspace"] as const)("drops the %s echo before create resolves and after restarting, but admits Jesse's own prompt", async source => {
    const dir = mkdtempSync(join(tmpdir(), "chat-images-")); dirs.push(dir);
    const h = fixture(join(dir, "seam.db"));
    const handler = vi.fn((m: any) => m.onAdmitted()); h.adapter.onMessage(handler);
    const original = h.request.getMockImplementation()!;
    let own: any;
    h.request.mockImplementation(async (scope, r) => {
      if (scope === "media" && r.url.endsWith("/messages")) {
        const alias = `${space}/messages/${r.params.messageId}`;
        const reopened = new SessionStore(join(dir, "seam.db"));
        try { expect((reopened.googleChatSpaces as any).isOwnMessage({ name: alias })).toBe(true); } finally { reopened.close(); }
        own = { name: alias, text: "Result", sender: { name: user, type: "HUMAN" }, attachment: [{ contentName: "result.png" }], thread: { name: thread } };
        await echo(h.adapter, { ...own, name: `${space}/messages/system-race`, clientAssignedMessageId: r.params.messageId }, source);
      }
      return original(scope, r);
    });
    const ref = await h.adapter.sendFile(channel, image, { nonce: "echo-test" });
    expect(handler).not.toHaveBeenCalled();
    const restarted = h.make(); restarted.onMessage(handler);
    await echo(restarted, { ...own, name: ref.id }, source);
    await echo(restarted, { ...own, name: `${space}/messages/human`, text: "My own prompt", attachment: [] }, source);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0].text).toBe("My own prompt");
  });

  it("classifies recorded user-auth images as Seam output in history and reconstruction, not the user's other messages", async () => {
    const h = fixture();
    await h.adapter.sendFile(channel, image, { nonce: "history-test" });
    h.history.set(`${space}/messages/human`, { name: `${space}/messages/human`, createTime: new Date().toISOString(), text: "Human prompt",
      sender: { name: user, type: "HUMAN" } });
    const page = await h.adapter.fetchMessagePage(channel.id, { limit: 5 });
    expect(page.messages.find(m => m.attachmentNames.length)?.authorType).toBe("bot");
    const projected = projectDiscordConversation(page.messages, { seamBotId: bot });
    expect(projected.find(m => m.text.includes("result.png"))?.role).toBe("assistant");
    expect(projected.find(m => m.text === "Human prompt")?.role).toBe("user");
    expect((await h.reader.readPage({ space, limit: 5 })).messages.find(m => m.attachmentNames.length)?.authorType).toBe("bot");
  });

  it("finds a native image receipt by the sender's media client id after restart", async () => {
    const h = fixture();
    const ref = await h.adapter.sendFile(channel, image, { nonce: "receipt-test" });
    const get = vi.spyOn(h.reader, "getMessage");
    const found = await h.make().findMessageByNonce(channel, "receipt-test", 0);
    expect(found).toMatchObject({ status: "found", message: { id: ref.id } });
    expect(get).toHaveBeenCalledWith(expect.stringContaining("/messages/client-seam-"));
  });

  it("preserves an image identity recorded while subscription registration is awaiting Google", async () => {
    const h = fixture();
    let release!: () => void, started!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const startup = new Promise<void>(resolve => { started = resolve; });
    const subscription: any = { name: "subscriptions/test", expireTime: new Date(Date.now() + 3_600_000).toISOString() };
    const events = new GoogleChatSpaceEvents({ api: { request: h.request }, store: h.store.googleChatSpaces,
      logger: h.logger, pubsubTopic: "projects/test/topics/events", subscriptions: {
        list: async () => [], create: async () => { started(); await held; return subscription; },
        renew: async () => subscription, delete: async () => {},
      } as any });
    const registered = events.register({ name: space, spaceType: "SPACE" });
    await startup;
    const name = `${space}/messages/client-seam-test`;
    h.store.googleChatSpaces.put({ ...h.store.googleChatSpaces.get(space)!, ownMessages: { [name]: true } } as any);
    release();
    try {
      await registered;
      expect((h.store.googleChatSpaces.get(space) as any)?.ownMessages?.[name]).toBe(true);
    } finally { await events.stop(); }
  });

  it("reuses a native create after a crash without requiring user-auth read permissions", async () => {
    const h = fixture(), original = h.request.getMockImplementation()!;
    const ref = await h.adapter.sendFile(channel, image, { nonce: "duplicate-image" });
    h.request.mockImplementation(async (scope, r) => {
      if (scope === "media" && r.url.endsWith("/messages")) throw Object.assign(new Error("Already exists"), { response: { status: 409 } });
      return original(scope, r);
    });
    const duplicate = await h.make().sendFile(channel, image, { nonce: "duplicate-image" });
    expect(duplicate.id).toBe(ref.id);
    expect(h.request).toHaveBeenCalledWith("messages", expect.objectContaining({ method: "GET", url: expect.stringContaining("/messages/client-seam-") }));
    expect(h.request.mock.calls.some(([scope, r]) => scope === "media" && r.method === "GET")).toBe(false);
  });

  it.each(["png", "jpeg", "gif", "webp"])("infers %s image MIME when the attachment fence supplies octet-stream", async extension => {
    const h = fixture();
    await h.adapter.sendFile(channel, { ...image, filename: `image.${extension}`, mimeType: "application/octet-stream" });
    const upload = h.request.mock.calls.find(([, r]) => r.url.includes("/attachments:upload"));
    expect(upload?.[1].data.toString()).toContain(`Content-Type: image/${extension}`);
    expect(h.drive.upload).not.toHaveBeenCalled();
  });

  it("does not let an app write bypass an in-flight native upload's per-space lane", async () => {
    const h = fixture(), original = h.request.getMockImplementation()!;
    let release!: () => void, started!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const startup = new Promise<void>(resolve => { started = resolve; });
    h.request.mockImplementation(async (scope, r) => {
      if (r.url.includes("/attachments:upload")) { started(); await held; }
      return original(scope, r);
    });
    const result = h.adapter.sendFile(channel, image);
    // On the old implementation Drive delivery finishes without starting an upload.
    const outcome = await Promise.race([startup.then(() => "upload"), result.then(() => "drive")]);
    expect(outcome).toBe("upload");
    const other = h.adapter.sendMessage(channel, "Queued app write");
    await Promise.resolve();
    expect(h.request.mock.calls.some(([, r]) => r.url.endsWith("/messages"))).toBe(false);
    release();
    await Promise.all([result, other]);
    expect(h.request.mock.calls.filter(([, r]) => r.url.endsWith("/messages"))).toHaveLength(2);
  });

  it("keeps Drive delivery in a DM and for an upload user who is not a Space member", async () => {
    for (const membership of ["DM", "absent", "INVITED"]) {
      const h = fixture();
      const original = h.request.getMockImplementation()!;
      h.request.mockImplementation(async (scope, r) => {
        if (r.method === "GET" && r.url.endsWith("/spaces/test") && membership === "DM") return { spaceType: "DIRECT_MESSAGE" };
        if (r.url.endsWith("/members/poster")) {
          if (membership === "absent") throw Object.assign(new Error("Member not found"), { response: { status: 404 } });
          return { state: "INVITED" };
        }
        return original(scope, r);
      });
      await h.adapter.sendFile(channel, image);
      expect(h.drive.upload).toHaveBeenCalledOnce();
      expect(h.request.mock.calls.some(([scope]) => scope === "media")).toBe(false);
    }
  });

  it("leaves non-images and unconfigured native images on the existing Drive path", async () => {
    const h = fixture();
    await h.adapter.sendFile(channel, { ...image, filename: "notes.pdf", mimeType: "application/pdf" });
    await h.make(false).sendFile(channel, image);
    expect(h.drive.upload).toHaveBeenCalledTimes(2);
    expect(h.request.mock.calls.some(([scope]) => scope === "media")).toBe(false);
  });

  it.each(["membership", "upload", "create"])("surfaces a configured native %s failure with its real cause instead of silently using Drive", async step => {
    const h = fixture(), original = h.request.getMockImplementation()!;
    const cause = Object.assign(new Error(`Google ${step} permission denied`), { response: { status: 403 } });
    const logged = vi.spyOn(h.logger, "error");
    h.request.mockImplementation(async (scope, r) => {
      if ((step === "membership" && r.url.includes("/members/")) || (step === "upload" && r.url.includes("/attachments:upload"))
        || (step === "create" && scope === "media" && r.url.endsWith("/messages"))) throw cause;
      return original(scope, r);
    });
    await expect(h.adapter.sendFile(channel, image)).rejects.toBe(cause);
    expect(h.drive.upload).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ err: cause }), expect.any(String));
  });

  it("continues a capped image reply at the Space root and lets other writes proceed in the same lane", async () => {
    const h = fixture(), original = h.request.getMockImplementation()!;
    let target = { platform: "google-chat", id: "test.native", parentId: "test" };
    const continued = vi.fn((next: any) => { target = next; });
    h.adapter.setCommandDeps({ store: h.store, mutation: {}, deliveryForChannel: () => ({ channel: target, continued }) } as any);
    const cap = Object.assign(new Error("Cannot create reply since it has reached the threading reply limit."), { response: { status: 429,
      data: { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Cannot create reply since it has reached the threading reply limit.",
        errors: [{ domain: "global", reason: "rateLimitExceeded" }] } } } });
    h.request.mockImplementation(async (scope, r) => {
      if (scope === "media" && r.data?.thread) throw cap;
      return original(scope, r);
    });
    const result = h.adapter.sendFile(channel, image, { nonce: "capped-image" });
    const other = h.adapter.sendMessage(channel, "Other queued write");
    await Promise.all([result, other]);
    expect(continued).toHaveBeenCalledWith(channel);
    const posts = h.request.mock.calls.filter(([scope, r]) => scope === "media" && r.url.endsWith("/messages"));
    expect(posts).toHaveLength(2);
    expect(posts[0]?.[1]).toMatchObject({ data: { thread: { name: thread } }, params: { messageReplyOption: "REPLY_MESSAGE_OR_FAIL" } });
    expect(posts[1]?.[1].data.thread).toBeUndefined();
    expect(posts[1]?.[1].data.text).toContain("Continued from the previous thread (reply limit reached)");
    expect(posts[0]?.[1].params.messageId).toBe(posts[1]?.[1].params.messageId);
    expect(h.store.get("google-chat:test")?.acpSessionId).toBe("same-acp");
  });
});

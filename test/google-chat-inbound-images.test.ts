import { describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { GoogleChatAdapter } from "../packages/core/src/platforms/google-chat/adapter.js";
import { parseGoogleChatWorkspaceMessages } from "../packages/core/src/platforms/google-chat/workspace-message-event.js";
import { installLegacyChatFixture } from "./helpers/google-chat-legacy-fixture.js";

const logger = pino({ level: "silent" }), space = "spaces/ROOM", bot = "users/app", sender = "users/42";
const opaque = "ClxzcGFjZXMvUk9PTS9tZXNzYWdlcy9NLk0vYXR0YWNobWVudHMvQQ==";
const bytes = Buffer.from([137, 80, 78, 71, 0, 255]);
const cause = (message = "Permission denied to perform the requested action on the specified resource, or the resource doesn't exist.", status = 403) =>
  Object.assign(new Error(message), { response: { status, data: { error: { code: status, message,
    status: status === 404 ? "NOT_FOUND" : "PERMISSION_DENIED", errors: [{ domain: "global", reason: status === 404 ? "notFound" : "forbidden" }] } } } });

function fixture(options: { mediaUser?: string | null; state?: string } = {}) {
  const request = vi.fn(async (_scope: string, r: any): Promise<any> => r.url.includes("/members/")
    ? { state: options.state ?? "JOINED" } : bytes);
  const drive = { upload: vi.fn(), download: vi.fn(async () => bytes) };
  const adapter = new GoogleChatAdapter({ api: { request }, subscription: "unused", allowedUserIds: new Set([sender]),
    defaultCwd: "/projects", logger, writeIntervalMs: 0, driveUploader: drive,
    ...(options.mediaUser === null ? {} : { mediaUser: options.mediaUser ?? "users/media", nativeImages: true }),
    spaceEvents: { start: async () => {}, stop: async () => {}, handle: async () => {},
      space: name => ({ name, spaceType: "SPACE" }), appUser: () => bot, recordAppUser: () => {} } });
  const store = installLegacyChatFixture(adapter, ["ROOM", "DM.thread"]);
  const incoming: any[] = [];
  adapter.onMessage(message => {
    const record = store.getByChannel(message.channel.platform, message.channel.id)!;
    store.admitInbound({ messageId: message.messageId, platform: message.channel.platform, channelRef: message.channel.id,
      sessionRecordId: record.id, authorId: message.authorId, text: message.text, attachments: message.attachments,
      createdUtc: new Date().toISOString(), preemptive: false });
    incoming.push(message); message.onAdmitted?.();
  });
  return { adapter, store, request, drive, incoming };
}

async function receive(h: ReturnType<typeof fixture>, options: { source?: "direct" | "workspace"; dm?: boolean; mentioned?: string; drive?: boolean } = {}) {
  const message: any = { name: `${options.dm ? "spaces/DM" : space}/messages/M.M`, text: "Describe this screenshot",
    sender: { name: sender, type: "HUMAN" }, thread: { name: `${options.dm ? "spaces/DM" : space}/threads/thread` },
    annotations: options.mentioned ? [{ type: "USER_MENTION", startIndex: 0, length: 4,
      userMention: { type: "MENTION", user: { name: options.mentioned, type: "BOT" } } }] : [],
    attachment: [{ name: `${space}/messages/M.M/attachments/A`, contentName: "screenshot.png", contentType: "image/png",
      source: options.drive ? "DRIVE_FILE" : "UPLOADED_CONTENT",
      ...(options.drive ? { driveDataRef: { driveFileId: "drive-original" } } : { attachmentDataRef: { resourceName: opaque } }) }] };
  if (options.source === "workspace") await h.adapter.receiveWorkspaceMessage(parseGoogleChatWorkspaceMessages({
    attributes: { "ce-type": "google.workspace.chat.message.v1.created" }, data: Buffer.from(JSON.stringify({ message })).toString("base64") })[0]!);
  else await h.adapter.receiveEvent({ type: "MESSAGE", user: message.sender,
    space: { name: options.dm ? "spaces/DM" : space, spaceType: options.dm ? "DIRECT_MESSAGE" : "SPACE" }, message });
  return h.incoming.at(-1);
}

describe("Google Chat inbound image auth", () => {
  it.each(["direct", "workspace"] as const)("persists the %s upload context and downloads an unmentioned image as the JOINED media user", async source => {
    const h = fixture(), message = await receive(h, { source });
    const saved = h.store.getInbound(message.messageId)!.attachments[0]!;
    expect(saved).toMatchObject({ url: opaque, platform: "google-chat", googleChat: { space, source: "UPLOADED_CONTENT", appAuth: false } });
    await expect(h.adapter.downloadAttachment(saved)).resolves.toEqual(bytes);
    expect(h.request.mock.calls).toEqual([
      ["memberships", expect.objectContaining({ method: "GET", url: "https://chat.googleapis.com/v1/spaces/ROOM/members/media" })],
      ["media", expect.objectContaining({ method: "GET", url: `https://chat.googleapis.com/v1/media/${opaque}`, params: { alt: "media" }, responseType: "arraybuffer" })],
    ]);
  });

  it.each(["direct", "workspace"] as const)("keeps %s app-mentioned uploads on chat.bot without looking up media-user membership", async source => {
    const h = fixture(), message = await receive(h, { source, mentioned: bot });
    await expect(h.adapter.downloadAttachment(message.attachments[0])).resolves.toEqual(bytes);
    expect(h.request).toHaveBeenCalledExactlyOnceWith("chat", expect.objectContaining({ url: `https://chat.googleapis.com/v1/media/${opaque}` }));
  });

  it("does not confuse another app's mention with access for Seam", async () => {
    const h = fixture(), message = await receive(h, { source: "workspace", mentioned: "users/another-app" });
    await h.adapter.downloadAttachment(message.attachments[0]);
    expect(h.request.mock.calls.at(-1)?.[0]).toBe("media");
  });

  it("keeps the app DM download on chat.bot even when a media user is configured", async () => {
    const h = fixture(), message = await receive(h, { dm: true });
    await h.adapter.downloadAttachment(message.attachments[0]);
    expect(h.request).toHaveBeenCalledExactlyOnceWith("chat", expect.objectContaining({ url: `https://chat.googleapis.com/v1/media/${opaque}` }));
  });

  it.each(["INVITED", "NOT_A_MEMBER"])("does not use the user token for a %s membership", async state => {
    const h = fixture({ state }), message = await receive(h);
    const denied = cause(); h.request.mockImplementation(async (scope, r) => {
      if (r.url.includes("/members/")) return { state };
      if (scope === "chat") throw denied;
      return bytes;
    });
    await expect(h.adapter.downloadAttachment(message.attachments[0])).rejects.toBe(denied);
    expect(h.request.mock.calls.some(([scope]) => scope === "media")).toBe(false);
    expect(h.request.mock.calls[0]?.[0]).toBe("memberships");
  });

  it("uses app auth, not the user token, when membership is absent (Google404)", async () => {
    const h = fixture(), message = await receive(h);
    const missing = cause("Requested entity was not found.", 404), denied = cause();
    h.request.mockImplementation(async (_scope, r) => { throw r.url.includes("/members/") ? missing : denied; });
    await expect(h.adapter.downloadAttachment(message.attachments[0])).rejects.toBe(denied);
    expect(h.request.mock.calls.map(([scope]) => scope)).toEqual(["memberships", "chat"]);
  });

  it("passes a membership403 through without authorizing a user download", async () => {
    const h = fixture(), message = await receive(h), denied = cause("Membership read denied by Google");
    h.request.mockRejectedValueOnce(denied);
    await expect(h.adapter.downloadAttachment(message.attachments[0])).rejects.toBe(denied);
    expect(h.request).toHaveBeenCalledExactlyOnceWith("memberships", expect.anything());
  });

  it("checks current membership again rather than caching download authority", async () => {
    const h = fixture(), message = await receive(h), attachment = message.attachments[0];
    await h.adapter.downloadAttachment(attachment);
    h.request.mockClear(); const denied = cause();
    h.request.mockImplementation(async (_scope, r) => { if (r.url.includes("/members/")) return { state: "INVITED" }; throw denied; });
    await expect(h.adapter.downloadAttachment(attachment)).rejects.toBe(denied);
    expect(h.request.mock.calls.map(([scope]) => scope)).toEqual(["memberships", "chat"]);
  });

  it("preserves the app path when the media user is not configured", async () => {
    const h = fixture({ mediaUser: null }), message = await receive(h);
    await h.adapter.downloadAttachment(message.attachments[0]);
    expect(h.request).toHaveBeenCalledExactlyOnceWith("chat", expect.anything());
  });

  it("does not hide a user download failure with a known-failing app-auth retry", async () => {
    const h = fixture(), message = await receive(h), denied = cause("User does not have access to this attachment");
    h.request.mockImplementation(async (scope, r) => { if (r.url.includes("/members/")) return { state: "JOINED" }; if (scope === "media") throw denied; return bytes; });
    await expect(h.adapter.downloadAttachment(message.attachments[0])).rejects.toBe(denied);
    expect(h.request.mock.calls.map(([scope]) => scope)).toEqual(["memberships", "media"]);
  });

  it("addresses an email-configured media membership with the existing encoded resource alias", async () => {
    const h = fixture({ mediaUser: "jesse@example.com" }), message = await receive(h);
    await h.adapter.downloadAttachment(message.attachments[0]);
    expect(h.request.mock.calls[0]).toEqual(["memberships", expect.objectContaining({ url: "https://chat.googleapis.com/v1/spaces/ROOM/members/jesse%40example.com" })]);
  });

  it.each(["direct", "workspace"] as const)("retains %s DRIVE_FILE references through admission and uses Drive, never media auth", async source => {
    const h = fixture(), message = await receive(h, { source, drive: true });
    const saved = h.store.getInbound(message.messageId)!.attachments[0]!;
    expect(saved).toMatchObject({ googleChat: { space, source: "DRIVE_FILE", driveFileId: "drive-original" } });
    await expect(h.adapter.downloadAttachment(saved)).resolves.toEqual(bytes);
    expect(h.drive.download).toHaveBeenCalledExactlyOnceWith("drive-original");
    expect(h.request).not.toHaveBeenCalled();
  });

  it("passes the real Drive failure through without falling into media.download", async () => {
    const h = fixture(), message = await receive(h, { drive: true }), denied = cause("Drive file access denied");
    h.drive.download.mockRejectedValueOnce(denied);
    await expect(h.adapter.downloadAttachment(message.attachments[0])).rejects.toBe(denied);
    expect(h.request).not.toHaveBeenCalled();
  });
});

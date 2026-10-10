import { afterEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { GoogleChatAdapter } from "../packages/core/src/platforms/google-chat/adapter.js";
import { multiplexChatAdapters } from "../packages/core/src/platforms/google-chat/multiplex.js";
import { GoogleDriveUploader } from "../packages/core/src/core/files/google-drive-upload.js";
import { loadConfig } from "../packages/core/src/config.js";
import type { ChatAdapter, ChoiceCardPost } from "../packages/core/src/platforms/chat-adapter.js";
import type { StructuredPanel } from "../packages/core/src/core/types.js";

const channel = { platform: "google-chat", id: "dm.thread", parentId: "dm" };
const panel: StructuredPanel = { color: 0, title: "Working", description: "## Result\n**Ready** [guide](https://example.com)",
  fields: [{ name: "Model", value: "`model-id`" }], footer: "*Running*" };
const choice: ChoiceCardPost = { panel, choiceId: "pick", options: [{ label: "Continue", kind: "prompt" }] };

function setup(driveUploader?: Pick<GoogleDriveUploader, "upload">, interval = 0) {
  let sequence = 0;
  const request = vi.fn(async (_scope: string, r: any): Promise<any> => ({
    name: r.method === "PATCH" ? r.url.split("/v1/")[1] : `spaces/dm/messages/app-${++sequence}`,
    thread: r.data?.thread ?? { name: "spaces/dm/threads/thread" },
  }));
  const adapter = new GoogleChatAdapter({ api: { request }, subscription: "projects/test/subscriptions/events",
    allowedUserIds: new Set(["users/42"]), defaultCwd: "/projects", logger: pino({ level: "silent" }),
    writeIntervalMs: interval, driveUploader } as any) as ChatAdapter & GoogleChatAdapter;
  return { adapter, request };
}

afterEach(() => vi.useRealTimers());

describe("Google Chat merged surface wiring", () => {
  it("formats outbound text and edits with the formatter's Chat syntax", async () => {
    const { adapter, request } = setup();
    const ref = await adapter.sendMessage(channel, "## Hello\n**Ready** [guide](https://example.com)");
    expect(request.mock.calls[0]![1].data).toMatchObject({ text: "*Hello*\n*Ready* <https://example.com|guide>",
      markupSyntax: "MARKUP_SYNTAX_CHAT", thread: { name: "spaces/dm/threads/thread" } });
    await adapter.editMessage(ref, "~~old~~ **done**");
    expect(request.mock.calls[1]![1].data).toMatchObject({ text: "~old~ *done*", markupSyntax: "MARKUP_SYNTAX_CHAT" });
  });

  it("splits UTF-8 output including thread overhead, without loss and with distinct stable part nonces", async () => {
    const { adapter, request } = setup();
    const text = "🌍".repeat(10_000);
    await adapter.sendMessage(channel, text, { nonce: "large-answer", enforceNonce: true });
    const first = request.mock.calls.map(call => call[1]);
    expect(first.length).toBeGreaterThan(1);
    expect(first.map(r => r.data.text).join("")).toBe(text);
    for (const r of first) {
      expect(Buffer.byteLength(JSON.stringify(r.data))).toBeLessThanOrEqual(32_000);
      expect(r.data.thread.name).toBe("spaces/dm/threads/thread");
    }
    expect(new Set(first.map(r => r.params.messageId)).size).toBe(first.length);
    await adapter.sendMessage(channel, text, { nonce: "large-answer", enforceNonce: true });
    expect(request.mock.calls.slice(first.length).map(call => call[1].params.messageId))
      .toEqual(first.map(r => r.params.messageId));
  });

  it("sends and replaces real status panels as formatted cardsV2", async () => {
    const { adapter, request } = setup();
    const ref = await adapter.sendPanel!(channel, panel, { nonce: "status", enforceNonce: true });
    const post = request.mock.calls[0]![1];
    expect(post.params.messageId).toMatch(/^client-/);
    expect(post.data.thread.name).toBe("spaces/dm/threads/thread");
    expect(post.data.cardsV2[0].card.sections[0].widgets).toEqual([
      { textParagraph: { text: '<b>Result</b><br><b>Ready</b> <a href="https://example.com">guide</a>' } },
      { decoratedText: { topLabel: "Model", text: "<code>model-id</code>", wrapText: true } },
      { textParagraph: { text: "<i>Running</i>" } },
    ]);
    await adapter.editPanel!(ref, { ...panel, title: "Done", description: "**Finished**" });
    expect(request.mock.calls[1]![1]).toMatchObject({ method: "PATCH", url: `https://chat.googleapis.com/v1/${ref.id}`,
      params: { updateMask: "cardsV2" }, data: { cardsV2: [{ card: { header: { title: "Done" } } }] } });
    expect(JSON.stringify(request.mock.calls[1]![1].data)).toContain("<b>Finished</b>");
  });

  it("wires layouts, choice closure and sign-in openLink/cancel cards", async () => {
    const { adapter, request } = setup();
    const layout = { blocks: [{ kind: "text" as const, content: "**Details**" }] };
    const layoutRef = await adapter.sendLayout!(channel, layout);
    await adapter.editLayout!(layoutRef, { blocks: [{ kind: "text", content: "**Updated**" }] });
    const choiceRef = await adapter.sendChoiceCard!(channel, choice);
    await adapter.editChoiceCard!(choiceRef, { ...choice, hideButtons: true });
    const signIn = { panel, buttons: [{ label: "Open secure page", style: "link" as const, url: "https://example.com/auth" },
      { label: "Cancel", customId: "elicitation:cancel:auth" }] };
    const authRef = await adapter.sendElicitationCard!(channel, signIn);
    await adapter.editElicitationCard!(authRef, { panel: { ...panel, title: "Cancelled" } });
    const payloads = request.mock.calls.map(call => call[1].data);
    expect(JSON.stringify(payloads[0])).toContain("<b>Details</b>");
    expect(JSON.stringify(payloads[1])).toContain("<b>Updated</b>");
    expect(JSON.stringify(payloads[2])).toContain("seam_choice");
    expect(JSON.stringify(payloads[3])).not.toContain("buttonList");
    expect(JSON.stringify(payloads[4])).toContain('"openLink":{"url":"https://example.com/auth"}');
    expect(JSON.stringify(payloads[4])).toContain("elicitation:cancel:auth");
    expect(JSON.stringify(payloads[5])).toContain("Cancelled");
    expect(request.mock.calls.filter(call => call[1].method === "PATCH").every(call =>
      call[1].params.updateMask === "cardsV2")).toBe(true);
  });

  it("shares the write budget across text, card creates and coalesced card edits", async () => {
    vi.useFakeTimers();
    const { adapter, request } = setup(undefined, 1000);
    const started: number[] = [];
    request.mockImplementation(async (_scope, r) => {
      started.push(Date.now());
      return { name: "spaces/dm/messages/card", thread: r.data?.thread ?? { name: "spaces/dm/threads/thread" } };
    });
    const ref = await adapter.sendMessage(channel, "first");
    const create = adapter.sendPanel!(channel, panel);
    const old = adapter.editPanel!(ref, { ...panel, title: "Old" });
    const latest = adapter.editPanel!(ref, { ...panel, title: "Latest" });
    const sibling = adapter.sendChoiceCard!({ ...channel, id: "dm.sibling" }, choice);
    await vi.advanceTimersByTimeAsync(3000);
    await Promise.all([create, old, latest, sibling]);
    expect(started.map(at => at - started[0]!)).toEqual([0, 1000, 2000, 3000]);
    expect(request.mock.calls[2]![1].data.cardsV2[0].card.header.title).toBe("Latest");
    expect(request.mock.calls.filter(call => call[1].method === "PATCH")).toHaveLength(1);
  });

  it("keeps Discord rich rendering untouched through the multiplexer", async () => {
    const { adapter, request } = setup();
    const dc = { platform: "discord", id: "123" };
    const sendPanel = vi.fn(async () => ({ channel: dc, id: "discord-card" }));
    const discord: ChatAdapter = { platform: "discord", start: async () => {}, stop: async () => {},
      onMessage: () => {}, sendMessage: vi.fn(), editMessage: vi.fn(), sendPanel };
    const mux = multiplexChatAdapters([discord, adapter]);
    await mux.sendPanel!(dc, panel);
    expect(sendPanel).toHaveBeenCalledExactlyOnceWith(dc, panel);
    expect(request).not.toHaveBeenCalled();
    await mux.sendPanel!(channel, panel);
    expect(request.mock.calls[0]![1].data.cardsV2).toHaveLength(1);
    expect(sendPanel).toHaveBeenCalledOnce();
  });

  it("uploads through the merged Shared Drive uploader before posting its link in the original thread", async () => {
    const drive = vi.fn(async (r: any): Promise<any> => r.method === "POST"
      ? { data: undefined, headers: new Headers({ location: "https://upload.example/session" }) }
      : { data: { id: "file1", webViewLink: "https://drive.google.com/file/d/file1/view" }, headers: new Headers() });
    const uploader = new GoogleDriveUploader({ credentialsFile: "/fake/key", folderId: "shared-folder",
      sharing: { kind: "members-only" } }, { request: drive });
    const { adapter, request } = setup(uploader);
    const data = Buffer.from("pdf bytes");
    await adapter.sendFile!(channel, { data, filename: "report.pdf", mimeType: "application/pdf", caption: "**Report**" },
      { nonce: "attachment", enforceNonce: true });
    expect(drive.mock.calls[0]![0]).toMatchObject({ data: { parents: ["shared-folder"], name: "report.pdf" } });
    expect(drive.mock.calls[0]![0].url).toContain("supportsAllDrives=true");
    expect(drive.mock.calls[1]![0].data).toBe(data);
    expect(drive).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]![1].data).toMatchObject({ text: "*Report*\n\n<https://drive.google.com/file/d/file1/view|report.pdf>",
      thread: { name: "spaces/dm/threads/thread" } });
    expect(request.mock.calls[0]![1].params.messageId).toMatch(/^client-/);
  });

  it("preserves the real upload failure without posting a pretend upload or changing settings", async () => {
    const cause = Object.assign(new Error("Drive folder access denied"), { response: { status: 403 } });
    const upload = vi.fn(async () => { throw cause; });
    const { adapter, request } = setup({ upload });
    await expect(adapter.sendFile!(channel, { data: Buffer.from("body"), filename: "note.txt", mimeType: "text/plain" }))
      .rejects.toBe(cause);
    expect(upload).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
  });

  it("retains text/binary fallbacks when Drive is not configured", async () => {
    const { adapter, request } = setup();
    await adapter.sendFile!(channel, { data: Buffer.from("hello"), filename: "note.txt", mimeType: "text/plain" });
    await adapter.sendFile!(channel, { data: Buffer.from([1, 2]), filename: "file.pdf", mimeType: "application/pdf" });
    expect(request.mock.calls[0]![1].data.text).toContain("hello");
    expect(request.mock.calls[1]![1].data.text).toContain("2 bytes");
    expect(request.mock.calls.every(call => call[1].url.startsWith("https://chat.googleapis.com/"))).toBe(true);
  });

  it("loads the existing uploader's destination and policy explicitly without ambient settings", () => {
    const config = loadConfig({ env: { DISCORD_BOT_TOKEN: "fake", DISCORD_ALLOWED_USER_IDS: "42", REPOS_ROOT: "/projects",
      GOOGLE_CHAT_DRIVE_FOLDER_ID: "shared-folder", GOOGLE_CHAT_DRIVE_SHARING_POLICY: "domain-readable",
      GOOGLE_CHAT_DRIVE_DOMAIN: "example.com" } }) as any;
    expect(config.GOOGLE_CHAT_DRIVE_FOLDER_ID).toBe("shared-folder");
    expect(config.GOOGLE_CHAT_DRIVE_SHARING_POLICY).toBe("domain-readable");
    expect(config.GOOGLE_CHAT_DRIVE_DOMAIN).toBe("example.com");
  });
});

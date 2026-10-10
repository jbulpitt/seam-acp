import { describe, expect, it, vi } from "vitest";
import type { StructuredPanel } from "../packages/core/src/core/types.js";

function adapter(platform: string) {
  let handle: any;
  return { platform, start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    sendMessage: vi.fn(async (channel: any, _text: string) => ({ channel, id: platform })),
    editMessage: vi.fn(async (_ref: any, _text: string) => {}), onMessage: vi.fn((f: any) => { handle = f; }),
    emit: async (msg: any) => handle(msg) };
}

describe("multi-adapter routing", () => {
  it("starts both platforms, fans in messages, and routes writes by ChannelRef.platform", async () => {
    const { multiplexChatAdapters } = await import("../packages/core/src/platforms/google-chat/multiplex.js");
    const discord = adapter("discord"), chat = adapter("google-chat");
    const mux = multiplexChatAdapters([discord, chat]);
    const handle = vi.fn(); mux.onMessage(handle);
    await mux.start();
    const dc = { platform: "discord", id: "123" }, gc = { platform: "google-chat", id: "AAA.TTT" };
    await discord.emit({ channel: dc }); await chat.emit({ channel: gc });
    expect(handle.mock.calls.map(c => c[0].channel)).toEqual([dc, gc]);
    await mux.sendMessage(dc, "discord unchanged");
    const ref = await mux.sendMessage(gc, "chat"); await mux.editMessage(ref, "chat edit");
    expect(discord.sendMessage).toHaveBeenCalledWith(dc, "discord unchanged");
    expect(discord.editMessage).not.toHaveBeenCalled();
    expect(chat.editMessage).toHaveBeenCalledWith(ref, "chat edit");
    await mux.stop(); expect(discord.stop).toHaveBeenCalledOnce(); expect(chat.stop).toHaveBeenCalledOnce();
  });

  it("uses the text panel fallback only on a platform without rich panels", async () => {
    const { multiplexChatAdapters } = await import("../packages/core/src/platforms/google-chat/multiplex.js");
    const discord = Object.assign(adapter("discord"), { sendPanel: vi.fn(async (channel: any) => ({ channel, id: "panel" })) });
    const chat = adapter("google-chat");
    const mux = multiplexChatAdapters([discord, chat]);
    const panel: StructuredPanel = { color: 0x5865f2, title: "Working", description: "doing work", fields: [] };
    await mux.sendPanel!({ platform: "discord", id: "123" }, panel);
    await mux.sendPanel!({ platform: "google-chat", id: "AAA.TTT" }, panel);
    expect(discord.sendPanel).toHaveBeenCalledOnce(); expect(discord.sendMessage).not.toHaveBeenCalled();
    expect(chat.sendMessage.mock.calls[0]![1]).toContain("Working");
  });

  it("looks up delivery nonces only on the ref's platform, including lookup failures", async () => {
    const { multiplexChatAdapters } = await import("../packages/core/src/platforms/google-chat/multiplex.js");
    const discord = Object.assign(adapter("discord"), { findMessageByNonce: vi.fn(async () => ({ status: "absent" })) });
    const cause = new Error("Permission denied or Google Chat resource does not exist");
    const chat = Object.assign(adapter("google-chat"), { findMessageByNonce: vi.fn(async () => {
      throw cause;
    }) });
    const mux = multiplexChatAdapters([discord, chat]);
    const gc = { platform: "google-chat", id: "AAA.TTT" }, dc = { platform: "discord", id: "123" };

    await expect(mux.findMessageByNonce!(gc, "chat-nonce", 1234)).rejects.toBe(cause);
    expect(chat.findMessageByNonce).toHaveBeenCalledExactlyOnceWith(gc, "chat-nonce", 1234);
    expect(discord.findMessageByNonce).not.toHaveBeenCalled();
    await expect(mux.findMessageByNonce!(dc, "discord-nonce", 5678)).resolves.toEqual({ status: "absent" });
    expect(discord.findMessageByNonce).toHaveBeenCalledExactlyOnceWith(dc, "discord-nonce", 5678);
    expect(chat.findMessageByNonce).toHaveBeenCalledOnce();
  });

  it("routes media to its owning platform without treating Discord CDN URLs as Google resources", async () => {
    const { multiplexChatAdapters } = await import("../packages/core/src/platforms/google-chat/multiplex.js");
    const discord = adapter("discord");
    const chat = Object.assign(adapter("google-chat"), { downloadAttachment: vi.fn(async () => Buffer.from("chat media")) });
    const mux = multiplexChatAdapters([discord, chat]);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("discord media"));
    try {
      const dc = { url: "https://cdn.discordapp.com/file", filename: "note.txt", contentType: "text/plain", size: 1 };
      const gc = { ...dc, url: "spaces/A/messages/M/attachments/F", platform: "google-chat" };
      expect((await mux.downloadAttachment!(dc)).toString()).toBe("discord media");
      expect((await mux.downloadAttachment!(gc)).toString()).toBe("chat media");
      expect(fetch).toHaveBeenCalledExactlyOnceWith(dc.url);
      expect(chat.downloadAttachment).toHaveBeenCalledExactlyOnceWith(gc);
    } finally { fetch.mockRestore(); }
  });
});

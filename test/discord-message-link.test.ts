import { describe, expect, it, vi } from "vitest";
import { discordMessageLink } from "../packages/core/src/platforms/discord/message-link.js";
import { DiscordAdapter } from "../packages/core/src/platforms/discord/adapter.js";

describe("Discord message links", () => {
  it("uses the containing thread, not its parent channel", () => {
    expect(discordMessageLink("guild", "thread", "message")).toEqual({
      jumpUrl: "https://discord.com/channels/guild/thread/message",
    });
  });

  it("reports an unknown guild instead of guessing a DM link", () => {
    expect(discordMessageLink(null, "thread", "message")).toEqual({
      jumpLinkUnavailableReason: "The Discord guild is unavailable.",
    });
  });

  it("does not link a card that has not been posted", () => {
    expect(discordMessageLink("guild", "thread", null)).toEqual({
      jumpLinkUnavailableReason: "No Discord message has been posted.",
    });
  });

  it.each(["sendMessage", "sendChoiceCard", "sendPanel", "sendLayout", "sendElicitationCard"])(
    "%s returns the actual guild and message link", async method => {
      const channel = { platform: "discord", id: "thread", parentId: "parent" };
      const adapter = Object.create(DiscordAdapter.prototype) as any;
      const send = vi.fn(async () => ({ id: "message" }));
      adapter.fetchSendableChannel = vi.fn(async () => ({ guildId: "guild", send }));
      const card = { panel: { title: "Card", color: 0x123456, fields: [] }, choiceId: "choice", options: [] };
      const input = method === "sendMessage" ? "hello"
        : method === "sendPanel" ? card.panel
          : method === "sendLayout" ? { blocks: [{ kind: "text", content: "hello" }] }
            : method === "sendElicitationCard" ? { panel: card.panel } : card;
      const result = await adapter[method](channel, input);
      expect(result).toEqual({ channel, id: "message", jumpUrl: "https://discord.com/channels/guild/thread/message" });
      expect(adapter.fetchSendableChannel).toHaveBeenCalledWith("thread");
    }
  );

  it("resolves a persisted card's actual channel and retains lookup errors", async () => {
    const adapter = Object.create(DiscordAdapter.prototype) as any;
    adapter.fetchSendableChannel = vi.fn(async () => ({ guildId: "other-guild" }));
    expect(await adapter.getMessageLink({ platform: "discord", id: "other-thread" }, "message")).toEqual({
      jumpUrl: "https://discord.com/channels/other-guild/other-thread/message",
    });
    adapter.fetchSendableChannel.mockRejectedValueOnce(new Error("Unknown Channel"));
    expect(await adapter.getMessageLink({ platform: "discord", id: "deleted-thread" }, "message")).toEqual({
      jumpLinkUnavailableReason: "Unknown Channel",
    });
    adapter.fetchSendableChannel.mockClear();
    expect(await adapter.getMessageLink({ platform: "discord", id: "thread" }, null)).toHaveProperty("jumpLinkUnavailableReason");
    expect(adapter.fetchSendableChannel).not.toHaveBeenCalled();
  });
});

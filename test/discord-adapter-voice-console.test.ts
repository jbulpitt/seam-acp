import { ChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
  DiscordAdapter,
  isSendableDiscordChannelType,
} from "../packages/core/src/platforms/discord/adapter.js";

describe("Discord Voice Console adapter boundary", () => {
  it("accepts a guild voice channel as a built-in chat destination", () => {
    expect(isSendableDiscordChannelType(ChannelType.GuildVoice)).toBe(true);
    expect(isSendableDiscordChannelType(ChannelType.GuildText)).toBe(true);
    expect(isSendableDiscordChannelType(ChannelType.PublicThread)).toBe(true);
    expect(isSendableDiscordChannelType(ChannelType.GuildCategory)).toBe(false);
  });

  it("edits an already-deferred slash reply when the command handler throws", async () => {
    const logger = {
      child: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    };
    logger.child.mockReturnValue(logger);
    const adapter = new DiscordAdapter({
      config: {
        DISCORD_ALLOWED_USER_IDS: new Set(["owner"]),
      } as any,
      logger: logger as any,
      slashHandler: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const interaction = {
      user: { id: "owner" },
      deferred: true,
      replied: false,
      editReply: vi.fn(async () => undefined),
      reply: vi.fn(async () => undefined),
    };

    await (adapter as any).handleSlash(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "That command failed unexpectedly. Please retry; if it repeats, check the bot logs.",
    });
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "slash handler crashed"
    );
  });
});

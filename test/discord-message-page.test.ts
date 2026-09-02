import { MessageType } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { DiscordAdapter } from "../packages/core/src/platforms/discord/adapter.js";

describe("DiscordAdapter.fetchMessagePage", () => {
  it("forwards cursor options and normalizes human, bot, embed, component, and attachment data", async () => {
    const logger = { child: vi.fn(), warn: vi.fn(), error: vi.fn() };
    logger.child.mockReturnValue(logger);
    const adapter = new DiscordAdapter({
      config: {
        DISCORD_ALLOWED_USER_IDS: new Set(["human"]),
        DISCORD_USER_NAMES: new Map(),
      } as any,
      logger: logger as any,
    });
    const fetch = vi.fn(async () => new Map([
      ["m2", {
        id: "m2",
        type: MessageType.Default,
        createdTimestamp: 2_000,
        author: { id: "bot", bot: true, username: "seam", globalName: "Seam" },
        member: null,
        content: "",
        attachments: { map: (fn: (attachment: { name: string }) => string) => [{ name: "log.txt" }].map(fn) },
        embeds: [{
          author: { name: "Agent" },
          title: "Working",
          description: "status details",
          fields: [{ name: "Model", value: "test" }],
          footer: { text: "1s" },
        }],
        components: [{}],
      }],
      ["m1", {
        id: "m1",
        type: MessageType.Reply,
        createdTimestamp: 1_000,
        author: { id: "human", bot: false, username: "jesse", globalName: "Jesse" },
        member: { displayName: "Jesse B" },
        content: "hello",
        attachments: { map: () => [] },
        embeds: [],
        components: [],
      }],
    ]));
    (adapter as any).fetchSendableChannel = vi.fn(async () => ({
      isThread: () => true,
      messages: { fetch },
    }));

    const rows = await adapter.fetchMessagePage("thread-1", { around: "hit", limit: 75 });

    expect(fetch).toHaveBeenCalledWith({ around: "hit", limit: 75 });
    expect(rows).toEqual([
      expect.objectContaining({
        messageId: "m2",
        authorType: "bot",
        authorId: "bot",
        authorName: "Seam",
        content: expect.stringContaining("status details"),
        attachmentNames: ["log.txt"],
        hasEmbeds: true,
        hasComponents: true,
      }),
      expect.objectContaining({
        messageId: "m1",
        authorType: "human",
        authorId: "human",
        authorName: "Jesse B",
        content: "hello",
        hasEmbeds: false,
        hasComponents: false,
      }),
    ]);
  });
});

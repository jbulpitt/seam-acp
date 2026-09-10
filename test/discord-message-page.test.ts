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

    const page = await adapter.fetchMessagePage("thread-1", { around: "hit", limit: 75 });

    expect(fetch).toHaveBeenCalledWith({ around: "hit", limit: 75 });
    // Raw-page facts travel with the eligible rows (#278). Here nothing was
    // filtered, so the counts agree and the oldest raw row is m1.
    expect(page.rawCount).toBe(2);
    expect(page.oldestRawId).toBe("m1");
    expect(page.oldestRawTimestampMs).toBe(1_000);
    expect(page.messages).toEqual([
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

  it("reports raw cursor facts for rows it filters out (#278)", async () => {
    const logger = { child: vi.fn(), warn: vi.fn(), error: vi.fn() };
    logger.child.mockReturnValue(logger);
    const adapter = new DiscordAdapter({
      config: {
        DISCORD_ALLOWED_USER_IDS: new Set(["human"]),
        DISCORD_USER_NAMES: new Map(),
      } as any,
      logger: logger as any,
    });
    const row = (id: string, type: MessageType, createdTimestamp: number) => [id, {
      id,
      type,
      createdTimestamp,
      author: { id: "human", bot: false, username: "jesse", globalName: "Jesse" },
      member: { displayName: "Jesse" },
      content: `content ${id}`,
      attachments: { map: () => [] },
      embeds: [],
      components: [],
    }] as const;
    const fetch = vi.fn(async () => new Map([
      row("m3", MessageType.Default, 3_000),
      row("m2", MessageType.Reply, 2_000),
      // The OLDEST raw row is a system post. Pagination must still be able to
      // continue from it, so it has to survive as cursor metadata even though
      // it is (correctly) withheld from callers.
      row("m1", MessageType.ChannelPinnedMessage, 1_000),
    ] as any));
    (adapter as any).fetchSendableChannel = vi.fn(async () => ({
      isThread: () => true,
      messages: { fetch },
    }));

    const page = await adapter.fetchMessagePage("thread-1", { limit: 100 });

    expect(page.messages.map((message) => message.messageId)).toEqual(["m3", "m2"]);
    expect(page.rawCount).toBe(3);
    expect(page.oldestRawId).toBe("m1");
    expect(page.oldestRawTimestampMs).toBe(1_000);
  });

  it("forces the platform lookup when checking whether a thread still exists", async () => {
    const logger = { child: vi.fn(), warn: vi.fn(), error: vi.fn() };
    logger.child.mockReturnValue(logger);
    const adapter = new DiscordAdapter({
      config: {
        DISCORD_ALLOWED_USER_IDS: new Set(["human"]),
        DISCORD_USER_NAMES: new Map(),
      } as any,
      logger: logger as any,
    });
    const fetch = vi.fn(async () => null);
    (adapter as any).client.channels.fetch = fetch;

    await expect(
      adapter.getThreadLiveState({ platform: "discord", id: "deleted-thread" })
    ).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith("deleted-thread", { force: true });
  });
});

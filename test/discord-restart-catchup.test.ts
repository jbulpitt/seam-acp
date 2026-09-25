import { SnowflakeUtil } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { DiscordAdapter } from "../packages/core/src/platforms/discord/adapter.js";

const id = (ms: number) => SnowflakeUtil.generate({ timestamp: ms }).toString();

describe("DiscordAdapter.catchUpMessagesAfter (#653)", () => {
  it("fetches only threads with newer messages and replays them oldest first", async () => {
    const logger = { child: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    logger.child.mockReturnValue(logger);
    const adapter = new DiscordAdapter({
      config: { DISCORD_ALLOWED_USER_IDS: new Set(["human"]), DISCORD_USER_NAMES: new Map() } as any,
      logger: logger as any,
    });
    const since = Date.parse("2026-09-25T15:21:49Z");
    const early = id(since + 2_000);
    const late = id(since + 9_000);
    const quietFetch = vi.fn();
    const busyFetch = vi.fn(async () => new Map([
      [late, { id: late }],
      [early, { id: early }],
    ]));
    const threads = new Map([
      ["quiet", { lastMessageId: id(since - 60_000), messages: { fetch: quietFetch } }],
      ["busy", { lastMessageId: late, messages: { fetch: busyFetch } }],
    ]);
    (adapter as any).client = {
      guilds: { cache: new Map([["g", { channels: { fetchActiveThreads: async () => ({ threads }) } }]]) },
    };
    const handled: string[] = [];
    (adapter as any).handleMessage = vi.fn(async (msg: { id: string }) => { handled.push(msg.id); });

    const after = id(since);
    const found = await adapter.catchUpMessagesAfter(after);

    expect(found).toBe(2);
    expect(quietFetch).not.toHaveBeenCalled();
    expect(busyFetch).toHaveBeenCalledWith({ after, limit: 100 });
    expect(handled).toEqual([early, late]);
  });
});

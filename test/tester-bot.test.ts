import { describe, expect, it, vi } from "vitest";
import { TesterBot } from "../packages/core/src/core/tester-bot.js";
import { DiscordAdapter } from "../packages/core/src/platforms/discord/adapter.js";

function fakeDiscord(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.replace("https://discord.com/api/v10", "").split("?")[0]}`;
    calls.push(key);
    if (!(key in routes)) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

describe("TesterBot (test deployments driven as a person)", () => {
  it("starts a thread in an allowlisted channel and posts there", async () => {
    const { fetchFn, calls } = fakeDiscord({
      "POST /channels/10/threads": { id: "11" },
      "POST /channels/11/messages": { id: "12" },
    });
    const bot = new TesterBot("t", new Set(["10"]), fetchFn);
    await expect(bot.post({ channel: "10", text: "hi", threadName: "case 1" })).resolves.toEqual({ threadId: "11", messageId: "12" });
    expect(calls).toEqual(["POST /channels/10/threads", "POST /channels/11/messages"]);
  });

  it("posts into a thread whose parent is allowlisted", async () => {
    const { fetchFn } = fakeDiscord({
      "GET /channels/11": { parent_id: "10" },
      "POST /channels/11/messages": { id: "13" },
    });
    const bot = new TesterBot("t", new Set(["10"]), fetchFn);
    await expect(bot.post({ channel: "11", text: "again" })).resolves.toEqual({ threadId: "11", messageId: "13" });
  });

  it("refuses any channel outside the allowlist before posting", async () => {
    const { fetchFn, calls } = fakeDiscord({ "GET /channels/99": { parent_id: "98" } });
    const bot = new TesterBot("t", new Set(["10"]), fetchFn);
    await expect(bot.post({ channel: "99", text: "x" })).rejects.toThrow(/not in SEAM_TEST_BOT_CHANNEL_IDS/);
    expect(calls).toEqual(["GET /channels/99"]);
  });

  it("reads messages oldest first with card text", async () => {
    const { fetchFn } = fakeDiscord({
      "GET /channels/10/messages": [
        { id: "3", author: { username: "seam", bot: true }, content: "", embeds: [{ title: "Done" }], timestamp: "t3" },
        { id: "2", author: { username: "tester", bot: true }, content: "hi", timestamp: "t2" },
      ],
    });
    const bot = new TesterBot("t", new Set(["10"]), fetchFn);
    const read = await bot.read({ channel: "10" });
    expect(read.map((m) => m.id)).toEqual(["2", "3"]);
    expect(read[1]!.embeds).toEqual(["Done"]);
  });
});

describe("DISCORD_ALLOWED_BOT_IDS", () => {
  function adapter(allowedBots: string[]) {
    const logger = { child: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    logger.child.mockReturnValue(logger);
    const a = new DiscordAdapter({
      config: {
        DISCORD_ALLOWED_USER_IDS: new Set(["human", "tester"]),
        DISCORD_ALLOWED_BOT_IDS: new Set(allowedBots),
        DISCORD_USER_NAMES: new Map(),
      } as any,
      logger: logger as any,
    });
    (a as any).botUserId = "self";
    return a as unknown as { isPersonAuthor(author: { id: string; bot?: boolean }): boolean };
  }

  it("treats a listed bot as a person, other bots and itself as bots", () => {
    const a = adapter(["tester", "self"]);
    expect(a.isPersonAuthor({ id: "human", bot: false })).toBe(true);
    expect(a.isPersonAuthor({ id: "tester", bot: true })).toBe(true);
    expect(a.isPersonAuthor({ id: "other", bot: true })).toBe(false);
    expect(a.isPersonAuthor({ id: "self", bot: true })).toBe(false);
  });
});

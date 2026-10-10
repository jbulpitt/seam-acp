import { SnowflakeUtil } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { DiscordAdapter } from "../packages/core/src/platforms/discord/adapter.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { multiplexChatAdapters } from "../packages/core/src/platforms/google-chat/multiplex.js";
import type { ChatAdapter } from "../packages/core/src/platforms/chat-adapter.js";

const id = (ms: number) => SnowflakeUtil.generate({ timestamp: ms }).toString();
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function restartHarness() {
  const dir = mkdtempSync(path.join(tmpdir(), "seam-platform-catchup-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new SessionStore(path.join(dir, "test.db"));
  cleanups.push(() => store.close());
  const logger = { child: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  logger.child.mockReturnValue(logger);
  const discord = new DiscordAdapter({ logger: logger as any,
    config: { DISCORD_ALLOWED_USER_IDS: new Set(["human"]), DISCORD_USER_NAMES: new Map() } as any });
  const since = Date.parse("2026-10-10T21:00:00Z");
  const after = id(since), older = id(since - 1_000), missed = id(since + 1_000);
  const busyFetch = vi.fn(async () => new Map([[missed, { id: missed, author: { id: "human", bot: false } }]]));
  const threads = new Map([["discord-thread", { lastMessageId: missed, messages: { fetch: busyFetch } }]]);
  const fetchActiveThreads = vi.fn(async () => ({ threads }));
  (discord as any).client = { guilds: { cache: new Map([["guild", { channels: { fetchActiveThreads } }]]) } };
  const handled: string[] = [];
  (discord as any).handleMessage = vi.fn(async (message: { id: string }) => { handled.push(message.id); });
  const chat = { platform: "google-chat", start: vi.fn(), stop: vi.fn(), onMessage: vi.fn(),
    sendMessage: vi.fn(), editMessage: vi.fn() } as ChatAdapter;
  const adapter = multiplexChatAdapters([discord, chat]);
  const admit = (platform: string, messageId: string, createdUtc = new Date(since).toISOString()) => {
    const channelRef = platform === "discord" ? "discord-thread" : "AAA.TTT";
    store.admitInbound({ platform, messageId, channelRef, sessionRecordId: `${platform}:${channelRef}`,
      authorId: "human", text: "already admitted", createdUtc });
  };
  const run = () => Orchestrator.prototype.catchUpAfterRestart.call({ store, adapter, logger } as unknown as Orchestrator);
  return { store, adapter, chat, after, older, missed, since, admit, run, busyFetch, handled, fetchActiveThreads };
}

describe("restart catch-up platform ownership", () => {
  it("replays Discord downtime messages after the newest Discord admission, not a newer Chat hash", async () => {
    const h = restartHarness();
    h.admit("discord", h.after);
    // An older Discord delivery may be admitted later; the snowflake still owns the cutoff.
    h.admit("discord", h.older, new Date(h.since + 2_000).toISOString());
    h.admit("google-chat", "gchat_xPmG7_abcdefghijklmnopqrstuvwxyz0123456789", new Date(h.since + 3_000).toISOString());
    const rows = h.store.listInboundNonterminal();

    await expect(h.run()).resolves.toBeUndefined();

    expect(h.busyFetch).toHaveBeenCalledExactlyOnceWith({ after: h.after, limit: 100 });
    expect(h.handled).toEqual([h.missed]);
    expect(h.store.listInboundNonterminal()).toEqual(rows);
  });

  it("does not let a higher numeric ID on another platform silently skip Discord downtime messages", async () => {
    const h = restartHarness();
    h.admit("discord", h.after);
    h.admit("google-chat", id(h.since + 10_000));

    await h.run();

    expect(h.busyFetch).toHaveBeenCalledExactlyOnceWith({ after: h.after, limit: 100 });
    expect(h.handled).toEqual([h.missed]);
  });

  it("does not invent a Discord cutoff when only Chat has been admitted", async () => {
    const h = restartHarness();
    h.admit("google-chat", "gchat_xPmG7_abcdefghijklmnopqrstuvwxyz0123456789");

    await expect(h.run()).resolves.toBeUndefined();

    expect(h.fetchActiveThreads).not.toHaveBeenCalled();
    expect(h.busyFetch).not.toHaveBeenCalled();
    expect(h.handled).toEqual([]);
  });

  it("leaves Chat catch-up to Pub/Sub redelivery without attempting history polling", async () => {
    const h = restartHarness();
    h.admit("discord", h.after);
    h.admit("google-chat", "gchat_xPmG7_abcdefghijklmnopqrstuvwxyz0123456789");
    const adapter = multiplexChatAdapters([h.chat, h.adapter]);

    await expect(Orchestrator.prototype.catchUpAfterRestart.call({ store: h.store, adapter,
      logger: { info: vi.fn() } } as unknown as Orchestrator)).resolves.toBeUndefined();

    expect(h.fetchActiveThreads).not.toHaveBeenCalled();
  });

  it("preserves the underlying Discord catch-up error for the boot caller", async () => {
    const h = restartHarness();
    h.admit("discord", h.after);
    const cause = new Error("Discord unavailable while listing active threads");
    h.fetchActiveThreads.mockRejectedValueOnce(cause);

    await expect(h.run()).rejects.toBe(cause);
  });
});

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
      [late, { id: late, author: { id: "human", bot: false } }],
      [id(since + 5_000), { id: "seam-reply", author: { id: "bot", bot: true } }],
      [early, { id: early, author: { id: "human", bot: false } }],
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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChannelType, Collection, MessageFlags, MessageType } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordAdapter } from "../packages/core/src/platforms/discord/adapter.js";
import { ServerStatusCard } from "../packages/core/src/core/server-status-card.js";
import { ServiceStatusCard, SERVICE_STATUS_BUMP_AFTER_MS } from "../packages/core/src/core/service-status-card.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { ServerStatusSnapshot } from "../packages/core/src/core/server-status.js";

const THREAD = "1540213090480558120";
const BOT = "seam-bot";
const NOW = 2_000_000_000_000;
const dirs: string[] = [];
const cards: Array<{ stop(): void }> = [];
afterEach(() => {
  for (const card of cards.splice(0)) card.stop();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function discordError(message: string, code: number) {
  return Object.assign(new Error(message), { code });
}

// Only Discord I/O is mocked; cards, adapter methods and rendered payloads are real.
function discordIO() {
  const warn = vi.fn();
  const logger = { child: () => logger, warn, info: vi.fn() } as unknown as Logger;
  const messages = new Map<string, ReturnType<typeof add>>();
  let nextSent = 0;
  const sends = vi.fn(async (payload: Record<string, unknown>) => {
    const msg = add(`sent-${++nextSent}`, BOT, NOW, false);
    if (payload.embeds) msg.embeds = payload.embeds as unknown[];
    return msg;
  });
  const fetchPins = vi.fn(async (options: { before?: number; limit?: number } = {}) => {
    const pins = [...messages.values()].filter(msg => msg.pinned)
      .sort((a, b) => b.pinnedTimestamp - a.pinnedTimestamp)
      .filter(msg => options.before === undefined || msg.pinnedTimestamp < options.before);
    const items = pins.slice(0, pageSize).map(message => ({ message, pinnedTimestamp: message.pinnedTimestamp }));
    return { items, hasMore: pins.length > items.length };
  });
  let pageSize = 50;
  const fetch = vi.fn(async (request: string | { limit: number }) => {
    if (typeof request !== "string") return new Collection();
    const msg = messages.get(request);
    if (!msg) throw discordError("Unknown Message", 10008);
    return msg;
  });
  const edit = vi.fn(async (id: string, payload: Record<string, unknown>) => {
    const msg = await fetch(id);
    return msg.edit(payload);
  });
  const channel = { id: THREAD, guildId: "guild", type: ChannelType.GuildText,
    send: sends, messages: { fetch, fetchPins, edit } };
  const adapter = Object.create(DiscordAdapter.prototype) as DiscordAdapter;
  Object.assign(adapter, { client: { user: { id: BOT }, channels: { fetch: vi.fn(async () => channel) } }, logger, statusEditSequence: 0 });

  function add(id: string, author = BOT, createdTimestamp = NOW, pinned = true) {
    const msg = {
      id, author: { id: author }, createdTimestamp, pinned, pinnedTimestamp: createdTimestamp,
      type: MessageType.Default, embeds: [] as unknown[],
      edit: vi.fn(async (payload: Record<string, unknown>) => {
        if (payload.flags === MessageFlags.IsComponentsV2 && msg.embeds.length > 0 && payload.embeds === undefined) {
          throw discordError("Cannot use embeds with IS_COMPONENTS_V2", 50035);
        }
        if (payload.embeds) msg.embeds = payload.embeds as unknown[];
        return { id, channelId: THREAD, embeds: msg.embeds };
      }),
      pin: vi.fn(async () => { msg.pinned = true; }),
      delete: vi.fn(async () => { messages.delete(id); }),
    };
    messages.set(id, msg);
    return msg;
  }
  return { adapter, messages, add, sends, fetchPins, fetch, warn, setPageSize: (n: number) => { pageSize = n; } };
}

type CardKind = "server" | "service";
type Format = "layout" | "panel";

function fixture(kind: CardKind, format: Format, io = discordIO()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pinned-status-")); dirs.push(dir);
  const stateFile = path.join(dir, `${kind}-status-card.json`);
  let now = NOW;
  if (format === "panel") Object.assign(io.adapter, { sendLayout: undefined, editLayout: undefined });
  const snap: ServerStatusSnapshot = { nowUtc: NOW, startedUtc: NOW - 60_000, pid: 1, nodeVersion: "test",
    memoryRssBytes: 0, memoryHeapUsedBytes: 0, activeTurns: 0, liveRuntimes: 0, sessions: 0,
    pendingWakes: 0, pendingWatches: 0, scheduledJobs: 0, restartPending: false, bridges: [] };
  const makeCard = () => {
    const card = kind === "server"
      ? new ServerStatusCard({ logger: { child: () => ({ warn: io.warn, info: vi.fn() }) } as unknown as Logger,
        adapter: io.adapter, threadId: THREAD, dataDir: dir, collect: () => snap })
      : new ServiceStatusCard({ logger: { child: () => ({ warn: io.warn, info: vi.fn() }) } as unknown as Logger,
        adapter: io.adapter, threadId: THREAD, stateFile, sources: [], collect: () => [], now: () => now });
    cards.push(card);
    return card;
  };
  const save = (messageId: string, extra = {}) => fs.writeFileSync(stateFile,
    JSON.stringify({ threadId: THREAD, messageId, lastBumpAt: now, ...extra }));
  return { ...io, stateFile, makeCard, save, setNow: (n: number) => { now = n; },
    saved: () => JSON.parse(fs.readFileSync(stateFile, "utf8")) as { messageId: string; lastBumpAt?: number } };
}

for (const kind of ["server", "service"] as const) {
  for (const format of ["layout", "panel"] as const) {
    describe(`${kind} pinned card / ${format}`, () => {
      it("keeps the saved card and removes only other own pins across restart", async () => {
        const f = fixture(kind, format);
        const saved = f.add("saved", BOT, NOW - 3_000);
        const old = f.add("old", BOT, NOW - 4_000);
        const newer = f.add("newer", BOT, NOW - 2_000);
        const user = f.add("human", "owner", NOW - 1_000);
        const otherBot = f.add("other-bot", "another-bot");
        const unpinned = f.add("unpinned", BOT, NOW, false);
        f.save(saved.id);
        const card = f.makeCard(); await card.start(); card.stop();
        const restarted = f.makeCard(); await restarted.start(); await restarted.tick();
        expect(f.sends).not.toHaveBeenCalled();
        expect(saved.edit).toHaveBeenCalledTimes(3);
        expect(old.delete).toHaveBeenCalledTimes(1);
        expect(newer.delete).toHaveBeenCalledTimes(1);
        for (const msg of [user, otherBot, unpinned]) expect(msg.delete).not.toHaveBeenCalled();
        expect([...f.messages.keys()].sort()).toEqual(["human", "other-bot", "saved", "unpinned"]);
        expect(f.saved().messageId).toBe(saved.id);
      });

      for (const state of ["missing", "invalid", "wrong-thread"] as const) {
        it(`adopts the newest own pin with ${state} state instead of posting`, async () => {
          const f = fixture(kind, format);
          const older = f.add("older", BOT, NOW - 2_000);
          const newest = f.add("newest", BOT, NOW - 1_000);
          older.pinnedTimestamp = NOW + 1_000;
          f.add("human", "owner", NOW + 2_000);
          if (state === "invalid") fs.writeFileSync(f.stateFile, "not JSON");
          if (state === "wrong-thread") f.save("somewhere-else", { threadId: "other-thread" });
          const card = f.makeCard(); await card.start(); await card.tick();
          expect(f.sends).not.toHaveBeenCalled();
          expect(newest.edit).toHaveBeenCalledTimes(2);
          expect(older.delete).toHaveBeenCalledTimes(1);
          expect(f.saved().messageId).toBe(newest.id);
          expect(f.messages.has("human")).toBe(true);
        });
      }

      it("adopts an existing pin when the saved message is gone", async () => {
        const f = fixture(kind, format);
        const existing = f.add("existing"); f.save("gone");
        await f.makeCard().start();
        expect(existing.edit).toHaveBeenCalledTimes(1);
        expect(f.sends).not.toHaveBeenCalled();
        expect(f.saved().messageId).toBe(existing.id);
      });

      for (const cause of [discordError("Rate limited", 429), discordError("Discord unavailable", 500), new Error("socket reset")]) {
        it(`retains the same card after ${cause.message} and retries its edit`, async () => {
          const f = fixture(kind, format);
          const existing = f.add("existing"); f.save(existing.id);
          existing.edit.mockRejectedValueOnce(cause);
          const card = f.makeCard(); await card.start();
          expect(f.sends).not.toHaveBeenCalled();
          expect(existing.delete).not.toHaveBeenCalled();
          expect(f.saved().messageId).toBe(existing.id);
          expect(f.warn).toHaveBeenCalledWith(expect.objectContaining({ err: cause }), expect.any(String));
          await card.tick();
          expect(existing.edit).toHaveBeenCalledTimes(2);
          expect(f.sends).not.toHaveBeenCalled();
        });
      }

      it("replaces an actually deleted message exactly once", async () => {
        const f = fixture(kind, format);
        f.save("gone");
        const card = f.makeCard(); await card.start(); await card.tick(); card.stop();
        await f.makeCard().start();
        expect(f.sends).toHaveBeenCalledTimes(1);
        expect(f.saved().messageId).toBe("sent-1");
        expect(f.messages.get("sent-1")?.edit).toHaveBeenCalledTimes(2);
      });

      it("replaces once when the message disappears between lookup and edit", async () => {
        const f = fixture(kind, format); const existing = f.add("existing"); f.save(existing.id);
        existing.edit.mockImplementationOnce(async () => {
          f.messages.delete(existing.id);
          throw discordError("Unknown Message", 10008);
        });
        const card = f.makeCard(); await card.start(); await card.tick();
        expect(f.sends).toHaveBeenCalledTimes(1);
        expect(f.saved().messageId).toBe("sent-1");
        expect(f.messages.get("sent-1")?.edit).toHaveBeenCalledTimes(1);
      });

      it("retries a failed stale-pin deletion after restart without new durable state", async () => {
        const f = fixture(kind, format);
        const current = f.add("current", BOT, NOW - 1_000);
        const stale = f.add("stale", BOT, NOW - 2_000); f.save(current.id);
        const cause = discordError("Discord delete unavailable", 500);
        stale.delete.mockRejectedValueOnce(cause);
        const card = f.makeCard(); await card.start(); card.stop();
        expect(stale.delete).toHaveBeenCalledTimes(1);
        expect(f.messages.has(stale.id)).toBe(true);
        expect(current.edit).toHaveBeenCalledTimes(1);
        expect(f.warn).toHaveBeenCalledWith(expect.objectContaining({ err: cause, messageId: stale.id }), expect.any(String));
        const restarted = f.makeCard(); await restarted.start(); await restarted.tick();
        expect(stale.delete).toHaveBeenCalledTimes(2);
        expect(f.messages.has(stale.id)).toBe(false);
        expect(f.sends).not.toHaveBeenCalled();
        expect(f.saved().messageId).toBe(current.id);
        expect(f.saved()).not.toHaveProperty("pendingDelete");
      });

      it("does not post blindly when pinned-message lookup fails", async () => {
        const f = fixture(kind, format); const existing = f.add("existing");
        const cause = discordError("Discord pin lookup unavailable", 500);
        f.fetchPins.mockRejectedValueOnce(cause);
        const card = f.makeCard(); await card.start();
        expect(f.sends).not.toHaveBeenCalled();
        expect(f.warn).toHaveBeenCalledWith(expect.objectContaining({ err: cause }), expect.any(String));
        await card.tick();
        expect(existing.edit).toHaveBeenCalledTimes(1);
        expect(f.sends).not.toHaveBeenCalled();
      });

      it("finds the saved pin beyond the first Discord pin page", async () => {
        const f = fixture(kind, format); f.setPageSize(2);
        const current = f.add("current", BOT, NOW - 4_000); f.save(current.id);
        f.add("older", BOT, NOW - 3_000);
        f.add("newer", BOT, NOW - 2_000);
        f.add("human", "owner", NOW - 1_000);
        await f.makeCard().start();
        expect(f.fetchPins).toHaveBeenCalledWith(expect.objectContaining({ before: NOW - 2_000 }));
        expect(f.messages.has(current.id)).toBe(true);
        expect(f.messages.has("human")).toBe(true);
        expect(current.edit).toHaveBeenCalledTimes(1);
        expect(f.sends).not.toHaveBeenCalled();
      });
    });
  }

  it(`${kind} migrates an embed to V2 on the same message`, async () => {
    const f = fixture(kind, "layout");
    const existing = f.add("embed"); existing.embeds = [{ title: "old status" }]; f.save(existing.id);
    await f.makeCard().start();
    expect(f.sends).not.toHaveBeenCalled();
    expect(existing.delete).not.toHaveBeenCalled();
    expect(existing.edit).toHaveBeenCalledWith(expect.objectContaining({ content: "", embeds: [], flags: MessageFlags.IsComponentsV2 }));
    expect(f.saved().messageId).toBe(existing.id);
  });
}

it("keeps the service card's twenty-hour silent bump cadence", async () => {
  const f = fixture("service", "layout"); const existing = f.add("existing"); f.save(existing.id);
  const card = f.makeCard(); await card.start();
  f.setNow(NOW + SERVICE_STATUS_BUMP_AFTER_MS); await card.tick();
  expect(f.sends).not.toHaveBeenCalled();
  f.setNow(NOW + SERVICE_STATUS_BUMP_AFTER_MS + 1); await card.tick();
  expect(f.sends).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ content: "\u200B", flags: MessageFlags.SuppressNotifications }));
  expect(f.messages.has("sent-1")).toBe(false);
  await card.tick();
  expect(f.sends).toHaveBeenCalledTimes(1);
  expect(f.saved().messageId).toBe(existing.id);
});

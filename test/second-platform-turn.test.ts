/**
 * A second chat platform drives a real Orchestrator turn. The adapter, router
 * and runtime are synthetic; admission, the channel queue, the status card,
 * attachment handling and terminal delivery are production code.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { testSessionRouter } from "./helpers/session-fixture.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { inboundAttemptId } from "../packages/core/src/core/dispatch/attempt-store.js";
import type { DeliveryNonceLookup, IncomingMessage, MessageAttachment } from "../packages/core/src/platforms/chat-adapter.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { makeChoiceCustomId, type ChoiceCard } from "../packages/core/src/core/choice/types.js";
import { readdirSync, readFileSync, existsSync } from "node:fs";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const f of cleanups.splice(0).reverse()) f(); vi.restoreAllMocks(); });

function setup(platform: string, downloads?: Map<string, Buffer>) {
  const dir = mkdtempSync(path.join(tmpdir(), "seam-second-platform-"));
  cleanups.push(() => rmSync(dir, { force: true, recursive: true }));
  const store = new SessionStore(path.join(dir, "test.db"));
  cleanups.push(() => store.close());
  let onEvent: (event: any) => Promise<void> = async () => {};
  const runtime = {
    onEvent(f: typeof onEvent) { onEvent = f; }, getSessionInfo: () => ({ sessionId: "acp-1" }),
    getProcessId: () => undefined, getProviderIdentity: () => "synthetic",
    getFastModeOutcome: () => undefined, getPromptCapabilities: () => ({ image: true }),
    prompt: vi.fn(async (_text: string, _attachments?: MessageAttachment[]) => {
      await onEvent({ kind: "agent-text", text: "SECOND_PLATFORM_REPLY" });
      return { stopReason: "end_turn" };
    }),
    idle: async () => {}, cancel: async () => {},
  };
  const router = testSessionRouter({ listProfiles: () => [],
    describeConfig: () => ({ agent: { value: "codex" }, model: { value: "test" },
      effort: { value: null }, cwd: { value: "/synthetic" }, location: { value: "local" }, fastMode: { value: false },
      role: { value: null }, disableThreadPrefix: { value: false } }),
    ensureSessionRecord: (input: { platform: string; channelRef: string; parentRef?: string }) => {
      const existing = store.getByChannel(input.platform, input.channelRef);
      if (existing) return existing;
      const now = new Date().toISOString();
      const record = { id: `${input.platform}:${input.channelRef}`, platform: input.platform,
        channelRef: input.channelRef, parentRef: input.parentRef ?? null, agentId: "codex",
        acpSessionId: "acp-1", repoPath: "/synthetic", configJson: "{}", createdUtc: now, updatedUtc: now };
      store.upsert(record);
      return record;
    },
    getProfile: () => undefined,
    getOrStartRuntime: vi.fn(async () => runtime),
  });
  const adapter = {
    platform,
    sendPanel: vi.fn(async (channel: any) => ({ channel, id: "panel" })),
    editPanel: vi.fn(async (_ref: any, _panel?: unknown) => {}),
    sendMessage: vi.fn(async (channel: any, _text: string, _delivery?: { nonce?: string }) => ({ channel, id: "message" })),
    editMessage: vi.fn(async (_ref: any, _text?: string) => {}),
    findMessageByNonce: vi.fn(async (): Promise<DeliveryNonceLookup> => ({ status: "absent" })),
    sendChoiceCard: vi.fn(async (channel: any, _card: unknown) => ({ channel, id: "card" })),
    editChoiceCard: vi.fn(async (_ref: any, _card: unknown) => {}),
    isAllowedUser: vi.fn((p: string, userId: string) => p === "test" && userId === "42"),
    ...(downloads ? {
      downloadAttachment: vi.fn(async (a: MessageAttachment) => {
        const bytes = downloads.get(a.url);
        if (!bytes) throw new Error(`no fixture for ${a.url}`);
        return bytes;
      }),
    } : {}),
  };
  const config = { DATA_DIR: dir, REPOS_ROOT: "/synthetic", TURN_TIMEOUT_SECONDS: 60,
    DISCORD_ALLOWED_USER_IDS: new Set(["1300000000000000004"]),
    DEFAULT_MODEL: "test", REPO_EMOJIS: new Map(), channelPresets: new Map(), threadPresets: new Map() };
  const orch = new Orchestrator({ logger: pino({ level: "silent" }) as any,
    modelCatalog: fixtureModelCatalog([]), store, router: router as any,
    adapter: adapter as any, renderer: discordRenderer as any, config: config as any });
  const run = async (msg: IncomingMessage) => {
    await (orch as any).handleIncomingMessage(msg);
    // The turn holds its channel until delivery settles.
    await (orch as any).queueOnChannel(msg.channel.id, async () => {});
  };
  return { store, adapter, runtime, run, orch, dir };
}


function sessionRow(platform: string, channelRef: string, parentRef: string) {
  const now = new Date().toISOString();
  return { id: `${platform}:${channelRef}`, platform, channelRef, parentRef, agentId: "codex",
    acpSessionId: "acp-1", repoPath: "/synthetic", configJson: "{}", createdUtc: now, updatedUtc: now };
}

function card(platform: string, channelRef: string, parentRef: string): ChoiceCard {
  return { id: `card-${platform}`, platform, channelRef, parentRef, messageId: "card-msg", title: "Ship?", body: null,
    maxClicks: 1, targetUserId: null, defaultTarget: { type: "live" },
    options: [{ label: "Approve", kind: "prompt", payload: "Approved." }],
    clickCount: 0, status: "open", lastClickerId: null, lastClickerName: null, lastOptionIndex: null,
    createdBy: `${platform}:${channelRef}`, createdUtc: new Date().toISOString() } as ChoiceCard;
}

function click(platform: string, channelId: string, cardId: string, userId: string) {
  const ephemeral: string[] = [];
  return Object.assign({ customId: makeChoiceCustomId(cardId, 0), userId, userName: "Tester",
    channel: { platform, id: channelId }, messageId: "card-msg", kind: "button" as const,
    replyEphemeral: async (t: string) => { ephemeral.push(t); },
    followUpEphemeral: async (t: string) => { ephemeral.push(t); },
    showModal: async () => {} }, { ephemeral });
}

function pendingTargets(dir: string): string[] {
  const pending = path.join(dir, "dispatch", "pending");
  if (!existsSync(pending)) return [];
  return readdirSync(pending).filter(f => f.endsWith(".json"))
    .map(f => JSON.parse(readFileSync(path.join(pending, f), "utf8")).target);
}

function channelsUsed(adapter: ReturnType<typeof setup>["adapter"]) {
  return [
    ...adapter.sendPanel.mock.calls.map(call => call[0]),
    ...adapter.sendMessage.mock.calls.map(call => call[0]),
    ...adapter.editPanel.mock.calls.map(call => (call[0] as any).channel),
    ...adapter.editMessage.mock.calls.map(call => (call[0] as any).channel),
  ];
}

describe("a second chat platform runs a normal turn", () => {
  it("admits, answers and delivers on its own platform with adapter-read attachments", async () => {
    const attachmentUrl = "spaces/AAA/messages/BBB/attachments/CCC";
    const h = setup("test", new Map([[attachmentUrl, Buffer.from("hello from chat")]]));
    const msg: IncomingMessage = {
      messageId: "BBB_ccc-1",
      channel: { platform: "test", id: "AAA.TTT", parentId: "AAA" },
      authorId: "1234567890", authorName: "Tester", authorIsBot: false,
      text: "summarize the note",
      attachments: [{ url: attachmentUrl, filename: "note.txt", contentType: "text/plain", size: 15 }],
      raw: { synthetic: true },
    };

    await h.run(msg);

    expect(h.store.turnAttempts.get(inboundAttemptId("BBB_ccc-1"))).toMatchObject({ state: "completed" });
    expect(h.store.getByChannel("test", "AAA.TTT")).toMatchObject({ id: "test:AAA.TTT", parentRef: "AAA" });
    const used = channelsUsed(h.adapter);
    expect(used.length).toBeGreaterThan(0);
    expect(used.every(channel => channel.platform === "test" && channel.id === "AAA.TTT")).toBe(true);
    expect(h.adapter.sendMessage.mock.calls.map(call => call[1]).join("\n")).toContain("SECOND_PLATFORM_REPLY");

    expect(h.adapter.downloadAttachment).toHaveBeenCalledTimes(1);
    const sent = h.runtime.prompt.mock.calls[0]![1] as MessageAttachment[];
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`data:text/plain;base64,${Buffer.from("hello from chat").toString("base64")}`);
    // The admission keeps the platform reference, never the bytes.
    expect(JSON.stringify(h.store.getInbound("BBB_ccc-1"))).not.toContain("base64");
  });

  it("reports an attachment the adapter cannot read with its real cause instead of passing it on", async () => {
    const readable = "spaces/AAA/messages/BBB/attachments/OK";
    const h = setup("test", new Map([[readable, Buffer.from("fine")]]));
    const msg: IncomingMessage = {
      messageId: "BBB_ccc-2",
      channel: { platform: "test", id: "AAA.TTT", parentId: "AAA" },
      authorId: "1234567890", authorName: "Tester", authorIsBot: false,
      text: "read these",
      attachments: [
        { url: readable, filename: "fine.txt", contentType: "text/plain", size: 4 },
        { url: "spaces/AAA/messages/BBB/attachments/GONE", filename: "gone.txt", contentType: "text/plain", size: 4 },
        { url: "spaces/AAA/messages/BBB/attachments/HUGE", filename: "huge.bin", contentType: null, size: 200 * 1024 * 1024 },
      ],
      raw: { synthetic: true },
    };

    await h.run(msg);

    const sent = h.runtime.prompt.mock.calls[0]![1] as MessageAttachment[];
    expect(sent.map(a => a.filename)).toEqual(["fine.txt"]);
    expect(sent[0]!.url.startsWith("data:text/plain;base64,")).toBe(true);
    const notice = h.adapter.sendMessage.mock.calls.map(call => call[1]).find(text => text.includes("not sent to the agent"));
    expect(notice).toBeDefined();
    expect(notice).toContain("`gone.txt` — download failed: no fixture for spaces/AAA/messages/BBB/attachments/GONE");
    expect(notice).toContain("`huge.bin` — too large to download");
    expect(h.adapter.downloadAttachment).toHaveBeenCalledTimes(2);
  });

  it("leaves a Discord turn's ids, refs and attachment URLs unchanged", async () => {
    const h = setup("discord");
    const url = "https://cdn.discordapp.com/attachments/1/2/note.txt";
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("hello"));
    const msg: IncomingMessage = {
      messageId: "1300000000000000001",
      channel: { platform: "discord", id: "1300000000000000002", parentId: "1300000000000000003" },
      authorId: "1300000000000000004", authorName: "Tester", authorIsBot: false,
      text: "summarize the note",
      attachments: [{ url, filename: "note.txt", contentType: "text/plain", size: 5 }],
      raw: { synthetic: true },
    };

    await h.run(msg);

    expect(h.store.turnAttempts.get(inboundAttemptId("1300000000000000001"))).toMatchObject({ state: "completed" });
    expect(channelsUsed(h.adapter).every(channel => channel.platform === "discord"
      && channel.id === "1300000000000000002")).toBe(true);
    const sent = h.runtime.prompt.mock.calls[0]![1] as MessageAttachment[];
    expect(sent[0]!.url).toBe(url);
    fetch.mockRestore();
  });

  it("delivers a live dispatch into a second-platform thread on that platform", async () => {
    const h = setup("test");
    const now = new Date().toISOString();
    h.store.upsert({ id: "test:AAA.UUU", platform: "test", channelRef: "AAA.UUU", parentRef: "AAA",
      agentId: "codex", acpSessionId: "acp-1", repoPath: "/synthetic", configJson: "{}", createdUtc: now, updatedUtc: now });

    await h.orch.dispatchInjectTurn({ id: "second-platform-dispatch", target: "AAA.UUU", prompt: "do work",
      session: "live", kind: "handoff", stream: false, reportBack: false, createdUtc: now });

    expect(h.runtime.prompt).toHaveBeenCalledTimes(1);
    const used = channelsUsed(h.adapter);
    expect(used.length).toBeGreaterThan(0);
    expect(used.every(channel => channel.platform === "test" && channel.id === "AAA.UUU")).toBe(true);
    expect(h.store.getByChannel("discord", "AAA.UUU")).toBeNull();
  });

  it("accepts a choice click from an allowed second-platform user and keeps the card on its platform", async () => {
    const h = setup("test");
    h.store.upsert(sessionRow("test", "AAA.TTT", "AAA"));
    h.store.insertChoiceCard(card("test", "AAA.TTT", "AAA"));
    const evt = click("test", "AAA.TTT", "card-test", "42");

    await (h.orch as any).handleChoiceCardInteraction(evt);

    expect(evt.ephemeral.join("\n")).not.toContain("not available to you");
    expect(h.store.getChoiceCard("card-test")).toMatchObject({ clickCount: 1 });
    expect(h.adapter.editChoiceCard.mock.calls.every(call => (call[0] as any).channel.platform === "test")).toBe(true);
    expect(h.adapter.editChoiceCard).toHaveBeenCalled();
    expect(pendingTargets(h.dir)).toEqual(["AAA.TTT"]);
  });

  it("refuses a second-platform user the adapter does not allow, and Discord keeps its own allowlist", async () => {
    const h = setup("test");
    h.store.upsert(sessionRow("test", "AAA.TTT", "AAA"));
    h.store.insertChoiceCard(card("test", "AAA.TTT", "AAA"));
    const outsider = click("test", "AAA.TTT", "card-test", "99");
    await (h.orch as any).handleChoiceCardInteraction(outsider);
    expect(outsider.ephemeral.join("\n")).toContain("not available to you");
    expect(h.store.getChoiceCard("card-test")).toMatchObject({ clickCount: 0 });

    h.store.upsert(sessionRow("discord", "1300000000000000002", "1300000000000000003"));
    h.store.insertChoiceCard(card("discord", "1300000000000000002", "1300000000000000003"));
    const stranger = click("discord", "1300000000000000002", "card-discord", "42");
    await (h.orch as any).handleChoiceCardInteraction(stranger);
    expect(stranger.ephemeral.join("\n")).toContain("not available to you");
    expect(h.store.getChoiceCard("card-discord")).toMatchObject({ clickCount: 0 });
    const discordUser = click("discord", "1300000000000000002", "card-discord", "1300000000000000004");
    await (h.orch as any).handleChoiceCardInteraction(discordUser);
    expect(discordUser.ephemeral.join("\n")).not.toContain("not available to you");
    expect(h.store.getChoiceCard("card-discord")).toMatchObject({ clickCount: 1 });
  });

  it("posts the sign-in notice and card on the session's own platform", async () => {
    const h = setup("test");
    h.store.upsert(sessionRow("test", "AAA.TTT", "AAA"));

    await (h.orch as any).postReauthCard("AAA.TTT", "inbound-x", { errorKind: "auth_required" }, "Authentication required");

    expect(h.adapter.sendMessage.mock.calls.map(call => call[0].platform)).toEqual(["test"]);
    expect(h.adapter.sendChoiceCard).toHaveBeenCalledTimes(1);
    expect((h.adapter.sendChoiceCard.mock.calls[0]![0] as any).platform).toBe("test");
    expect(h.store.getByChannel("discord", "AAA.TTT")).toBeNull();
  });

  it("still refuses a message id that is unsafe as a file name", async () => {
    const h = setup("test");
    await expect(h.run({ messageId: "spaces/AAA/messages/BBB", channel: { platform: "test", id: "AAA.TTT" },
      authorId: "1", authorIsBot: false, text: "x", raw: {} })).rejects.toThrow(/invalid test message id/);
  });
});

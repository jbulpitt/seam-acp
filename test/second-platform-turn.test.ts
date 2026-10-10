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
  it("retains an uncertain Chat receipt without replay or API calls until history lookup is configured", async () => {
    const { GoogleChatAdapter } = await import("../packages/core/src/platforms/google-chat/adapter.js");
    const { multiplexChatAdapters } = await import("../packages/core/src/platforms/google-chat/multiplex.js");
    const h = setup("google-chat");
    const channel = { platform: "google-chat", id: "AAA.TTT", parentId: "AAA" };
    const request = vi.fn(async () => {
      throw Object.assign(new Error("Permission denied to perform the requested action"), { response: { status: 403 } });
    });
    const chat = new GoogleChatAdapter({ api: { request }, subscription: "projects/test/subscriptions/events",
      allowedUserIds: new Set(["users/42"]), defaultCwd: "/synthetic", logger: (h.orch as any).logger,
      writeIntervalMs: 0 });
    const lookup = vi.spyOn(chat, "findMessageByNonce");
    const send = vi.spyOn(chat, "sendMessage");
    const discordLookup = vi.fn(async () => ({ status: "absent" }));
    (h.orch as any).adapter = multiplexChatAdapters([
      { ...h.adapter, platform: "discord", findMessageByNonce: discordLookup } as any, chat,
    ]);
    const spec = { id: "chat-history-pending", target: channel.id, prompt: "already completed", session: "live" as const };
    h.store.turnAttempts.admit(spec);
    const attempt = h.store.turnAttempts.claim(spec, "fixture", "fixture-boot");
    h.store.turnAttempts.complete(attempt, { id: spec.id, target: channel.id, status: "completed",
      output: "retained answer", finishedUtc: new Date().toISOString() });
    h.store.turnAttempts.prepareDelivery(spec.id, channel.id, { kind: "message", text: "retained answer" });
    const receipt = h.store.turnAttempts.get(spec.id)!;

    await expect((h.orch as any).recoverRecordedDelivery(receipt, channel)).resolves.toBe("uncertain");
    const retained = h.store.turnAttempts.get(spec.id)!;
    expect(retained).toMatchObject({ state: "completed", deliveryDone: false,
      deliveryAbandonedReason: null, deliveryNonce: receipt.deliveryNonce, deliveryPayload: receipt.deliveryPayload,
      deliveryUncertainReason: expect.stringContaining("chat.app.messages.readonly"), outcome: receipt.outcome });
    await expect((h.orch as any).recoverRecordedDelivery(retained, channel)).resolves.toBe("uncertain");
    expect(lookup).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
    expect(discordLookup).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(h.runtime.prompt).not.toHaveBeenCalled();
    expect(h.store.turnAttempts.isDeliveryProven(spec.id)).toBe(false);
  });

  it("defers a failed Chat nonce lookup with its real cause, never attributing it to Discord", async () => {
    const { multiplexChatAdapters } = await import("../packages/core/src/platforms/google-chat/multiplex.js");
    const h = setup("google-chat");
    const channel = { platform: "google-chat", id: "AAA.TTT", parentId: "AAA" };
    const cause = Object.assign(new Error("Permission denied or the Google Chat resource does not exist"),
      { response: { status: 403 } });
    h.adapter.findMessageByNonce.mockRejectedValueOnce(cause);
    const discordLookup = vi.fn(async () => ({ status: "absent" }));
    const mux = multiplexChatAdapters([
      { ...h.adapter, platform: "discord", findMessageByNonce: discordLookup } as any,
      h.adapter as any,
    ]);
    (h.orch as any).adapter = mux;
    const warn = vi.spyOn((h.orch as any).logger, "warn");
    const spec = { id: "chat-nonce-recovery", target: channel.id, prompt: "already completed", session: "live" as const };
    h.store.turnAttempts.admit(spec);
    const attempt = h.store.turnAttempts.claim(spec, "fixture", "fixture-boot");
    h.store.turnAttempts.complete(attempt, { id: spec.id, target: channel.id, status: "completed",
      output: "retained answer", finishedUtc: new Date().toISOString() });
    h.store.turnAttempts.prepareDelivery(spec.id, channel.id, { kind: "message", text: "retained answer" });
    const receipt = h.store.turnAttempts.get(spec.id)!;

    await expect((h.orch as any).recoverRecordedDelivery(receipt, channel)).resolves.toBe("deferred");

    expect(h.adapter.findMessageByNonce).toHaveBeenCalledExactlyOnceWith(channel, receipt.deliveryNonce,
      Date.parse(receipt.deliveryStartedUtc!) - 5 * 60_000);
    expect(discordLookup).not.toHaveBeenCalled();
    expect(h.adapter.sendMessage).not.toHaveBeenCalled();
    expect(h.store.turnAttempts.get(spec.id)).toEqual(receipt);
    expect(h.runtime.prompt).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledExactlyOnceWith({ err: cause, id: spec.id, platform: "google-chat" },
      "platform nonce lookup deferred");
  });

  it("replays a captured Space answer once after a fully proved missing nonce, without running the provider", async () => {
    const { GoogleChatAdapter } = await import("../packages/core/src/platforms/google-chat/adapter.js");
    const { GoogleChatHistoryReader } = await import("../packages/core/src/core/messages/google-chat-history.js");
    const h = setup("google-chat");
    const channel = { platform: "google-chat", id: "AAA.TTT", parentId: "AAA" };
    const message = "Permission denied to perform the requested action on the specified resource, or the resource doesn't exist.";
    const cause = Object.assign(new Error(message), { response: { status: 403, data: { error: {
      code: 403, status: "PERMISSION_DENIED", message, errors: [{ message, domain: "global", reason: "forbidden" }],
    } } } });
    const historyRequest = vi.fn(async (options: any) => {
      if (!new URL(options.url).pathname.endsWith("/messages")) throw cause;
      return { data: { messages: [] } };
    });
    const request = vi.fn(async (_scope: string, options: any) => ({ name: "spaces/AAA/messages/TTT.answer",
      text: options.data.text, thread: options.data.thread }));
    const chat = new GoogleChatAdapter({ api: { request },
      historyReader: new GoogleChatHistoryReader({ credentialsFile: "/test/key.json" }, { request: historyRequest }),
      subscription: "projects/test/subscriptions/events", allowedUserIds: new Set(["users/42"]),
      defaultCwd: "/synthetic", logger: (h.orch as any).logger, writeIntervalMs: 0 });
    await chat.receiveEvent({ type: "ADDED_TO_SPACE", space: { name: "spaces/AAA", spaceType: "SPACE" } });
    (h.orch as any).adapter = chat;
    const spec = { id: "chat-missing-nonce-recovery", target: channel.id, prompt: "already completed", session: "live" as const };
    h.store.turnAttempts.admit(spec);
    const attempt = h.store.turnAttempts.claim(spec, "fixture", "fixture-boot");
    h.store.turnAttempts.complete(attempt, { id: spec.id, target: channel.id, status: "completed",
      output: "retained answer", finishedUtc: new Date().toISOString() });
    h.store.turnAttempts.prepareDelivery(spec.id, channel.id, { kind: "message", text: "retained answer" });
    const receipt = h.store.turnAttempts.get(spec.id)!;
    const warn = vi.spyOn((h.orch as any).logger, "warn");
    await expect((h.orch as any).recoverRecordedDelivery(receipt, channel)).resolves.toBe("delivered");
    expect(h.store.turnAttempts.get(spec.id)).toMatchObject({ state: "completed", deliveryDone: true,
      deliveryAbandonedReason: null, deliveryUncertainReason: null });
    expect(historyRequest).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]).toMatchObject(["chat", { method: "POST", data: { text: "retained answer" } }]);
    expect(warn).not.toHaveBeenCalled();
    expect(h.runtime.prompt).not.toHaveBeenCalled();
  });

  it("signals committed admission before a long turn finishes, including a duplicate receipt", async () => {
    const h = setup("test");
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    h.runtime.prompt.mockImplementationOnce(async () => { await held; return { stopReason: "end_turn" }; });
    const onAdmitted = vi.fn(() => expect(h.store.getInbound("chat_message_1")).not.toBeNull());
    const msg = { messageId: "chat_message_1", channel: { platform: "test", id: "AAA.TTT", parentId: "AAA" },
      authorId: "42", authorIsBot: false, text: "wait", raw: {}, onAdmitted };
    const turn = h.run(msg);
    try {
      await vi.waitFor(() => expect(onAdmitted).toHaveBeenCalledOnce());
      expect(h.store.getInbound("chat_message_1")).not.toBeNull();
    } finally { finish(); await turn; }
    await h.run(msg);
    expect(onAdmitted).toHaveBeenCalledTimes(2);
    expect(h.runtime.prompt).toHaveBeenCalledOnce();
  });

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
    // With Chat enabled the multiplexer has a downloader, but CDN handling stays Discord's.
    const download = vi.fn(async () => Buffer.from("must not eagerly download Discord media"));
    Object.assign(h.adapter, { downloadAttachment: download });
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

    expect(download).not.toHaveBeenCalled();

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

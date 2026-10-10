import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { GoogleChatAdapter } from "../packages/core/src/platforms/google-chat/adapter.js";
import { PubSubPullTransport } from "../packages/core/src/platforms/google-chat/transport.js";
import type { ChatAdapter } from "../packages/core/src/platforms/chat-adapter.js";
import { renderGoogleChatChoiceCard } from "../packages/core/src/platforms/google-chat/card-renderer.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { testSessionRouter } from "./helpers/session-fixture.js";

const channel = { platform: "google-chat", id: "dm.thread", parentId: "dm" };
const logger = pino({ level: "silent" });
const cleanups: (() => void)[] = [];
afterEach(() => { for (const clean of cleanups.splice(0).reverse()) clean(); });
const click = (operation = "option") => ({ type: "CARD_CLICKED", user: { name: "users/42", displayName: "Tester" },
  message: { name: "spaces/dm/messages/card", thread: { name: "spaces/dm/threads/thread" } },
  action: { actionMethodName: "seam_choice", parameters: [{ key: "choiceId", value: "pick" },
    { key: "optionIndex", value: "0" }, { key: "operation", value: operation }, { key: "inputName", value: "choiceInput_0" }] } });

function setup() {
  const request = vi.fn(async (_scope: string, r: any): Promise<any> => ({ name: "spaces/dm/messages/reply",
    thread: r.data?.thread ?? { name: "spaces/dm/threads/thread" } }));
  const adapter = new GoogleChatAdapter({ api: { request }, subscription: "projects/test/subscriptions/events",
    allowedUserIds: new Set(["users/42"]), defaultCwd: "/projects", logger, writeIntervalMs: 0 }) as ChatAdapter & GoogleChatAdapter;
  const transport = new PubSubPullTransport({ api: { request }, subscription: "projects/test/subscriptions/events", logger,
    receive: (...args: any[]) => (adapter.receiveEvent as any)(...args) });
  const deliver = (event: unknown, id = "pubsub-click-1") => transport.process({ ackId: `ack-${id}`,
    message: { messageId: id, data: Buffer.from(JSON.stringify(event)).toString("base64") } });
  return { adapter, request, deliver };
}

describe("Google Chat clicks through the adapter and Pub/Sub", () => {
  it("claims a real durable core choice once, dispatches to the Chat session and freezes the clicked card", async () => {
    const { adapter, request, deliver } = setup();
    const dir = mkdtempSync(path.join(tmpdir(), "gchat-click-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = new SessionStore(path.join(dir, "test.db"));
    cleanups.push(() => store.close());
    const now = new Date().toISOString();
    const record = { id: "google-chat:dm.thread", platform: "google-chat", channelRef: channel.id, parentRef: "dm",
      agentId: "codex", acpSessionId: "acp-1", repoPath: dir, configJson: "{}", createdUtc: now, updatedUtc: now };
    store.upsert(record);
    store.insertChoiceCard({ id: "pick", platform: "google-chat", channelRef: channel.id, parentRef: "dm",
      messageId: "spaces/dm/messages/card", title: "Continue?", body: null, maxClicks: 1, targetUserId: "42",
      defaultTarget: { type: "live" }, options: [{ label: "Continue", kind: "prompt", payload: "Exact chosen prompt" }],
      clickCount: 0, status: "open", lastClickerId: null, lastClickerName: null, lastOptionIndex: null,
      createdBy: record.id, createdUtc: now });
    const router = testSessionRouter({ listProfiles: () => [],
      describeConfig: () => ({ agent: { value: "codex" }, model: { value: "test" }, effort: { value: null },
        cwd: { value: dir }, location: { value: "local" }, role: { value: null }, fastMode: { value: false },
        disableThreadPrefix: { value: false } }), getProfile: () => undefined });
    const orch = new Orchestrator({ logger, modelCatalog: fixtureModelCatalog([]), store, router: router as any,
      adapter, renderer: discordRenderer, config: { DATA_DIR: dir, REPOS_ROOT: dir, DEFAULT_MODEL: "test",
        DISCORD_ALLOWED_USER_IDS: new Set(), REPO_EMOJIS: new Map(), channelPresets: new Map(), threadPresets: new Map() } as any });
    adapter.onChoiceInteraction!(evt => (orch as any).handleChoiceCardInteraction(evt), "update");
    await deliver(click());
    expect(store.getChoiceCard("pick")).toMatchObject({ clickCount: 1, lastClickerId: "42" });
    const pending = path.join(dir, "dispatch", "pending");
    const dispatches = () => readdirSync(pending).filter(file => file.endsWith(".json"))
      .map(file => JSON.parse(readFileSync(path.join(pending, file), "utf8")));
    expect(dispatches()).toHaveLength(1);
    expect(dispatches()[0]).toMatchObject({ target: channel.id, session: "live" });
    expect(dispatches()[0].prompt).toContain("Exact chosen prompt");
    const patch = request.mock.calls.find(call => call[1].method === "PATCH")![1];
    expect(patch.url).toBe("https://chat.googleapis.com/v1/spaces/dm/messages/card");
    expect(JSON.stringify(patch.data)).not.toContain("buttonList");
    await deliver(click(), "a-second-click");
    expect(store.getChoiceCard("pick")).toMatchObject({ clickCount: 1 });
    expect(dispatches()).toHaveLength(1);
    expect(request.mock.calls.some(call => call[1].data?.text === "This card is closed.")).toBe(true);
  });

  it("routes a choice to its real thread and bare actor identity, ACKing only after the handler commits and refreshes", async () => {
    const { adapter, request, deliver } = setup();
    let commit!: () => void;
    const durable = new Promise<void>(resolve => { commit = resolve; });
    const acknowledge = vi.fn(() => "update" as const);
    const handle = vi.fn(async (evt: any) => {
      await durable;
      await adapter.editChoiceCard!({ channel: evt.channel, id: evt.messageId }, {
        choiceId: "pick", panel: { color: 0, title: "Selected Continue", fields: [] }, options: [], hideButtons: true,
      });
    });
    adapter.onChoiceInteraction!(handle, acknowledge);
    const processing = deliver(click());
    await vi.waitFor(() => expect(handle).toHaveBeenCalledOnce());
    expect(request).not.toHaveBeenCalled();
    expect(handle.mock.calls[0]![0]).toMatchObject({ customId: "choice:pick:0", userId: "42", userName: "Tester",
      channel, messageId: "spaces/dm/messages/card", kind: "button" });
    expect(acknowledge).toHaveBeenCalledWith(expect.objectContaining({ customId: "choice:pick:0", kind: "button" }));
    commit(); await processing;
    expect(request.mock.calls.map(call => [call[0], call[1].method])).toEqual([["chat", "PATCH"], ["pubsub", "POST"]]);
    expect(request.mock.calls[0]![1].params).toEqual({ updateMask: "cardsV2" });
    expect(request.mock.calls[1]![1].data).toEqual({ ackIds: ["ack-pubsub-click-1"] });
  });

  it("uses the Pub/Sub delivery id for sign-in Cancel component idempotency and accepts Event.thread", async () => {
    const { adapter, deliver } = setup();
    const handle = vi.fn();
    adapter.onComponent!(handle, "update");
    const event: any = click();
    delete event.message.thread;
    event.thread = { name: "spaces/dm/threads/thread" };
    event.action = { actionMethodName: "seam_component", parameters: [{ key: "customId", value: "elicitation:cancel:auth" }] };
    await deliver(event, "stable-pubsub-id");
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ interactionId: "stable-pubsub-id",
      customId: "elicitation:cancel:auth", userId: "42", channel, kind: "button" }));
  });

  it("round-trips inline custom input without opening a dialog", async () => {
    const { adapter, deliver } = setup();
    const handle = vi.fn();
    adapter.onChoiceInteraction!(handle, "update");
    const card = renderGoogleChatChoiceCard({ panel: { color: 0, fields: [] }, choiceId: "pick",
      options: [{ label: "Your response", kind: "custom" }] });
    const widgets = card.cardsV2[0]!.card.sections[0]!.widgets;
    const button: any = widgets.find(widget => "buttonList" in widget);
    const action = button.buttonList.buttons[0].onClick.action;
    const event = { ...click(), action: { actionMethodName: action.function, parameters: action.parameters },
      common: { formInputs: { choiceInput_0: { stringInputs: { value: ["Exact **input**"] } } } } };
    await deliver(event);
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ kind: "modal", customId: "choice:pick:m:0",
      fields: { payload: "Exact **input**" } }));
  });

  it("keeps a real handler failure unacknowledged and passes the underlying cause", async () => {
    const { adapter, request, deliver } = setup();
    const cause = new Error("choice claim SQL failed");
    adapter.onChoiceInteraction!(async () => { throw cause; }, "update");
    await expect(deliver(click())).rejects.toBe(cause);
    expect(request).not.toHaveBeenCalled();
  });

  it("does not route a denied actor or unrelated action into core", async () => {
    const { adapter, deliver } = setup();
    const handle = vi.fn();
    adapter.onChoiceInteraction!(handle, "update");
    const denied = click(); denied.user.name = "users/99";
    const unrelated = click(); unrelated.action.actionMethodName = "not_seam";
    await deliver(denied); await deliver(unrelated, "other-id");
    expect(handle).not.toHaveBeenCalled();
  });

  it("sends closed-choice and sign-in replies privately in the original thread through the write queue", async () => {
    const { adapter, request, deliver } = setup();
    adapter.onChoiceInteraction!(async evt => { await evt.replyEphemeral("**This card is closed.**"); }, "ephemeral");
    await deliver(click());
    expect(request.mock.calls[0]).toEqual(["chat", expect.objectContaining({ method: "POST", data: expect.objectContaining({
      text: "*This card is closed.*", privateMessageViewer: { name: "users/42" }, thread: { name: "spaces/dm/threads/thread" },
    }) })]);
    expect(request.mock.calls.at(-1)![0]).toBe("pubsub");
  });
});

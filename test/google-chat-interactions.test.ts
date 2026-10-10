import { describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { GoogleChatAdapter } from "../packages/core/src/platforms/google-chat/adapter.js";
import { PubSubPullTransport } from "../packages/core/src/platforms/google-chat/transport.js";
import type { ChatAdapter } from "../packages/core/src/platforms/chat-adapter.js";
import { renderGoogleChatChoiceCard } from "../packages/core/src/platforms/google-chat/card-renderer.js";

const channel = { platform: "google-chat", id: "dm.thread", parentId: "dm" };
const logger = pino({ level: "silent" });
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

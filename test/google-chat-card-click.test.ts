import { describe, expect, it } from "vitest";
import { parseGoogleChatCardClick, type GoogleChatCardClickEvent } from "../packages/core/src/platforms/google-chat/card-click.js";
import { renderGoogleChatChoiceCard, renderGoogleChatElicitationCard, type GoogleChatCardAction } from "../packages/core/src/platforms/google-chat/card-renderer.js";

const context = { channel: { platform: "google-chat", id: "dm.thread", parentId: "dm" }, interactionId: "pubsub-delivery-id" };
const event: GoogleChatCardClickEvent = {
  type: "CARD_CLICKED", user: { name: "users/person", displayName: "A Person" },
  message: { name: "spaces/dm/messages/card" },
  action: { actionMethodName: "seam_choice", parameters: [
    { key: "choiceId", value: "pick" }, { key: "optionIndex", value: "1" },
  ] },
};

function clicked(action: GoogleChatCardAction): GoogleChatCardClickEvent {
  return { ...event, action: { actionMethodName: action.function, parameters: action.parameters } };
}

describe("Google Chat non-add-on CARD_CLICKED parser", () => {
  it("reads action.parameters, preserving card/user identity and the caller's canonical channel", () => {
    expect(parseGoogleChatCardClick(event, context)).toEqual({ type: "choice", interaction: {
      customId: "choice:pick:1", userId: "users/person", userName: "A Person", channel: context.channel,
      messageId: "spaces/dm/messages/card", kind: "button",
    } });
  });

  it("also reads the Event.common parameters map, not the add-on commonEventObject", () => {
    expect(parseGoogleChatCardClick({ ...event, action: undefined,
      common: { invokedFunction: "seam_choice", parameters: { choiceId: "common", optionIndex: "0" } },
    }, context)).toMatchObject({ type: "choice", interaction: { customId: "choice:common:0" } });
  });

  it("gives the non-add-on action its own parameters when both representations are present", () => {
    expect(parseGoogleChatCardClick({ ...event, common: {
      invokedFunction: "seam_component", parameters: { choiceId: "other", optionIndex: "9" },
    } }, context)).toMatchObject({ type: "choice", interaction: { customId: "choice:pick:1" } });
  });

  it("round-trips prompt buttons with their original option indices", () => {
    const widgets = renderGoogleChatChoiceCard({ panel: { color: 0, fields: [] }, choiceId: "roundtrip", options: [
      { label: "A", kind: "prompt" }, { label: "B", kind: "prompt" },
    ] }).cardsV2[0]!.card.sections[0]!.widgets;
    const widget = widgets[0]!;
    if (!("buttonList" in widget)) throw new Error("Expected buttons");
    for (const [index, button] of widget.buttonList.buttons.entries()) {
      if (!("action" in button.onClick)) throw new Error("Expected action");
      expect(parseGoogleChatCardClick(clicked(button.onClick.action), context))
        .toMatchObject({ type: "choice", interaction: { customId: `choice:roundtrip:${index}`, kind: "button" } });
    }
  });

  it("round-trips custom form submissions into neutral fields.payload without a dialog", () => {
    const widgets = renderGoogleChatChoiceCard({ panel: { color: 0, fields: [] }, choiceId: "custom", options: [
      { label: "Other", kind: "custom" },
    ] }).cardsV2[0]!.card.sections[0]!.widgets;
    const widget = widgets[1]!;
    if (!("buttonList" in widget) || !("action" in widget.buttonList.buttons[0]!.onClick)) throw new Error("Expected action");
    const action = widget.buttonList.buttons[0]!.onClick;
    if (!("action" in action)) throw new Error("Expected action");
    const input = { ...clicked(action.action), common: { formInputs: {
      choiceInput_0: { stringInputs: { value: ["Original *brief*\nwith _code_"] } },
    } } };
    expect(parseGoogleChatCardClick(input, context)).toMatchObject({ type: "choice", interaction: {
      customId: "choice:custom:m:0", kind: "modal", fields: { payload: "Original *brief*\nwith _code_" },
    } });
    const before = JSON.stringify(input);
    parseGoogleChatCardClick(input, context);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("round-trips multi-select change and confirmation separately, preserving empty selections", () => {
    const widgets = renderGoogleChatChoiceCard({ panel: { color: 0, fields: [] }, choiceId: "multi", select: { min: 1, max: 2 },
      options: [{ label: "A", kind: "prompt" }, { label: "B", kind: "prompt" }],
    }).cardsV2[0]!.card.sections[0]!.widgets;
    const select = widgets[0]!;
    const confirm = widgets[1]!;
    if (!("selectionInput" in select) || !("buttonList" in confirm)) throw new Error("Expected multi-select controls");
    const change = clicked(select.selectionInput.onChangeAction);
    expect(parseGoogleChatCardClick({ ...change, common: { formInputs: {
      choiceSelection: { stringInputs: { value: ["1", "0"] } },
    } } }, context)).toMatchObject({ type: "choice", interaction: { customId: "choice:multi:s", kind: "select", values: ["1", "0"] } });
    expect(parseGoogleChatCardClick(change, context)).toMatchObject({ type: "choice", interaction: { values: [] } });
    const onClick = confirm.buttonList.buttons[0]!.onClick;
    if (!("action" in onClick)) throw new Error("Expected confirmation action");
    expect(parseGoogleChatCardClick(clicked(onClick.action), context))
      .toMatchObject({ type: "choice", interaction: { customId: "choice:multi:c", kind: "button" } });
  });

  it("round-trips sign-in Cancel to component data, using the Pub/Sub id for idempotency", () => {
    const widget = renderGoogleChatElicitationCard({ panel: { color: 0, fields: [] },
      buttons: [{ label: "Cancel", customId: "elicitation:cancel:row-id" }],
    }, "sign-in").cardsV2[0]!.card.sections[0]!.widgets[0]!;
    if (!("buttonList" in widget)) throw new Error("Expected buttons");
    const onClick = widget.buttonList.buttons[0]!.onClick;
    if (!("action" in onClick)) throw new Error("Expected action");
    const result = parseGoogleChatCardClick(clicked(onClick.action), context);
    expect(result).toEqual({ type: "component", interaction: {
      interactionId: "pubsub-delivery-id", customId: "elicitation:cancel:row-id", userId: "users/person",
      userName: "A Person", channel: context.channel, messageId: "spaces/dm/messages/card", kind: "button",
    } });
    expect(result?.interaction).not.toHaveProperty("replyEphemeral");
    expect(result?.interaction).not.toHaveProperty("showModal");
  });

  it("extracts only the addressed enum input, without leaking unrelated form fields", () => {
    expect(parseGoogleChatCardClick({ ...event, action: { actionMethodName: "seam_component", parameters: [
      { key: "customId", value: "elicitation:pick:row" }, { key: "operation", value: "select" }, { key: "inputName", value: "enum" },
    ] }, common: { formInputs: { enum: { stringInputs: { value: ["keep"] } }, unrelated: { stringInputs: { value: ["secret"] } } } } }, context))
      .toMatchObject({ type: "component", interaction: { kind: "select", values: ["keep"] } });
  });

  it("does not handle unrelated actions, MESSAGE events or an add-on payload", () => {
    expect(parseGoogleChatCardClick({ ...event, type: "MESSAGE" }, context)).toBeNull();
    expect(parseGoogleChatCardClick({ ...event, action: { actionMethodName: "someone_else" } }, context)).toBeNull();
    expect(parseGoogleChatCardClick({ type: "CARD_CLICKED" }, context)).toBeNull();
  });

  it("reports missing identity and routing fields instead of fabricating an interaction", () => {
    expect(() => parseGoogleChatCardClick({ ...event, user: undefined }, context)).toThrow("Missing CARD_CLICKED user.name");
    expect(() => parseGoogleChatCardClick({ ...event, message: undefined }, context)).toThrow("Missing CARD_CLICKED message.name");
    expect(() => parseGoogleChatCardClick({ ...event, action: { actionMethodName: "seam_choice" } }, context)).toThrow("Missing seam_choice choiceId");
    expect(parseGoogleChatCardClick({ ...event, user: { name: "users/person" } }, context))
      .toMatchObject({ interaction: { userName: "users/person" } });
  });

  it.each(["no-index", "-1", "1.5", "1junk"])("does not turn invalid index %s into another option", (optionIndex) => {
    expect(() => parseGoogleChatCardClick({ ...event, action: { actionMethodName: "seam_choice", parameters: [
      { key: "choiceId", value: "pick" }, { key: "optionIndex", value: optionIndex },
    ] } }, context)).toThrow(`Invalid seam_choice optionIndex: ${optionIndex}`);
  });
});

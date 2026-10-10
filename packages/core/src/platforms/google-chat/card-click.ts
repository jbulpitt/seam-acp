import { makeChoiceConfirmId, makeChoiceCustomId, makeChoiceModalId, makeChoiceSelectId } from "../../core/choice/types.js";
import type { ChannelRef, ChoiceInteraction, ComponentEvent } from "../chat-adapter.js";
import { GOOGLE_CHAT_CHOICE_ACTION, GOOGLE_CHAT_COMPONENT_ACTION } from "./card-renderer.js";

/** The flat non-add-on Event carried by Pub/Sub, not chat.buttonClickedPayload. */
export interface GoogleChatCardClickEvent {
  type: string;
  user?: { name?: string; displayName?: string };
  message?: { name?: string };
  action?: { actionMethodName?: string; parameters?: Array<{ key: string; value: string }> };
  common?: {
    invokedFunction?: string;
    parameters?: Record<string, string>;
    formInputs?: Record<string, { stringInputs?: { value?: string[] } }>;
  };
}

type InteractionFields = "customId" | "userId" | "userName" | "channel" | "messageId" | "kind" | "values" | "fields";
export type GoogleChatChoiceInteractionData = Pick<ChoiceInteraction, InteractionFields>;
export type GoogleChatComponentEventData = Pick<ComponentEvent, InteractionFields | "interactionId">;
export type GoogleChatCardInteraction =
  | { type: "choice"; interaction: GoogleChatChoiceInteractionData }
  | { type: "component"; interaction: GoogleChatComponentEventData };

export interface GoogleChatCardClickContext {
  /** The adapter owns space/thread -> canonical channel mapping. */
  channel: ChannelRef;
  /** Pub/Sub delivery message id; Event itself has no unique click id. */
  interactionId: string;
}

/** Extracts data only; reply/modal capabilities and authorization belong to the adapter/core. */
export function parseGoogleChatCardClick(
  event: GoogleChatCardClickEvent,
  context: GoogleChatCardClickContext,
): GoogleChatCardInteraction | null {
  if (event.type !== "CARD_CLICKED") return null;
  const functionName = event.action?.actionMethodName ?? event.common?.invokedFunction;
  if (functionName !== GOOGLE_CHAT_CHOICE_ACTION && functionName !== GOOGLE_CHAT_COMPONENT_ACTION) return null;
  const parameters = { ...event.common?.parameters, ...Object.fromEntries(
    event.action?.parameters?.map(({ key, value }) => [key, value]) ?? [],
  ) };
  const common = {
    userId: required(event.user?.name, "CARD_CLICKED user.name"),
    userName: event.user?.displayName ?? required(event.user?.name, "CARD_CLICKED user.name"),
    messageId: required(event.message?.name, "CARD_CLICKED message.name"),
    channel: { ...context.channel },
  };
  const inputName = parameters.inputName;
  const values = inputName ? [...(event.common?.formInputs?.[inputName]?.stringInputs?.value ?? [])] : [];
  if (functionName === GOOGLE_CHAT_COMPONENT_ACTION) return {
    type: "component",
    interaction: {
      ...common, interactionId: context.interactionId,
      customId: required(parameters.customId, "seam_component customId"),
      kind: parameters.operation === "select" ? "select" : "button",
      ...(parameters.operation === "select" ? { values } : {}),
    },
  };
  const choiceId = required(parameters.choiceId, "seam_choice choiceId");
  if (parameters.operation === "select") return {
    type: "choice", interaction: { ...common, customId: makeChoiceSelectId(choiceId), kind: "select", values },
  };
  if (parameters.operation === "confirm") return {
    type: "choice", interaction: { ...common, customId: makeChoiceConfirmId(choiceId), kind: "button" },
  };
  const indexText = required(parameters.optionIndex, "seam_choice optionIndex");
  const index = Number(indexText);
  if (!Number.isInteger(index) || index < 0) throw new TypeError(`Invalid seam_choice optionIndex: ${indexText}`);
  return {
    type: "choice", interaction: {
      ...common,
      customId: parameters.operation === "custom" ? makeChoiceModalId(choiceId, index) : makeChoiceCustomId(choiceId, index),
      kind: parameters.operation === "custom" ? "modal" : "button",
      ...(parameters.operation === "custom" ? { fields: { payload: values[0] ?? "" } } : {}),
    },
  };
}

function required(value: string | undefined, field: string): string {
  if (value === undefined || value === "") throw new TypeError(`Missing ${field}`);
  return value;
}

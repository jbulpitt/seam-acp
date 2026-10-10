import type { PanelButton, StructuredLayout, StructuredPanel } from "../../core/types.js";
import type { ChoiceCardPost, ElicitationCardPost } from "../chat-adapter.js";
import { formatGoogleChatCardText } from "./card-text.js";

export const GOOGLE_CHAT_CARD_MAX_WIDGETS = 100;
export const GOOGLE_CHAT_SELECTION_MAX_ITEMS = 100;
export const GOOGLE_CHAT_CHOICE_ACTION = "seam_choice";
export const GOOGLE_CHAT_COMPONENT_ACTION = "seam_component";

export interface GoogleChatCardAction {
  function: string;
  parameters: Array<{ key: string; value: string }>;
}

export interface GoogleChatCardButton {
  text: string;
  type: "FILLED" | "OUTLINED";
  disabled?: boolean;
  onClick: { action: GoogleChatCardAction } | { openLink: { url: string } };
}

export type GoogleChatCardWidget =
  | { textParagraph: { text: string } }
  | { decoratedText: { topLabel: string; text: string; wrapText: true } }
  | { image: { imageUrl: string; altText: string } }
  | { divider: Record<string, never> }
  | { buttonList: { buttons: GoogleChatCardButton[] } }
  | { textInput: { name: string; label: string; type: "MULTIPLE_LINE" } }
  | { selectionInput: {
      name: string;
      label: string;
      type: "CHECK_BOX" | "DROPDOWN";
      items: Array<{ text: string; value: string; selected?: boolean }>;
      onChangeAction: GoogleChatCardAction;
    } };

export interface GoogleChatCardsMessage {
  cardsV2: Array<{
    cardId: string;
    card: {
      header?: { title: string; subtitle?: string; imageUrl?: string };
      sections: Array<{ widgets: GoogleChatCardWidget[] }>;
    };
  }>;
}

export function renderGoogleChatPanel(panel: StructuredPanel, cardId: string): GoogleChatCardsMessage {
  return panelMessage(panel, cardId, actionRows(panel.actions));
}

export function renderGoogleChatLayout(layout: StructuredLayout, cardId: string): GoogleChatCardsMessage {
  const widgets: GoogleChatCardWidget[] = layout.blocks.flatMap((block) => {
    if (block.kind === "text") return [paragraph(block.content)];
    return block.divider === false ? [] : [{ divider: {} }];
  });
  return message(cardId, [...widgets, ...actionRows(layout.actions)]);
}

export function renderGoogleChatChoiceCard(card: ChoiceCardPost): GoogleChatCardsMessage {
  const controls: GoogleChatCardWidget[] = [];
  if (!card.hideButtons) {
    if (card.select) {
      if (!card.disabled) {
        controls.push({ selectionInput: {
          name: "choiceSelection",
          label: `Choose ${card.select.min}–${card.select.max} options`,
          type: "CHECK_BOX",
          items: card.options.map((option, index) => ({
            text: option.label, value: String(index), selected: card.pendingSelection?.includes(index) ?? false,
          })),
          onChangeAction: action(GOOGLE_CHAT_CHOICE_ACTION, {
            choiceId: card.choiceId, operation: "select", inputName: "choiceSelection",
          }),
        } });
      }
      controls.push(buttonList([button("Confirm", action(GOOGLE_CHAT_CHOICE_ACTION, {
        choiceId: card.choiceId, operation: "confirm",
      }), card.disabled, "primary")]));
    } else {
      const options = card.options.map((option, index) => {
        const inputName = `choiceInput_${index}`;
        if (option.kind === "custom" && !card.disabled) {
          controls.push({ textInput: { name: inputName, label: option.label, type: "MULTIPLE_LINE" } });
        }
        return button(option.label, action(GOOGLE_CHAT_CHOICE_ACTION, {
          choiceId: card.choiceId, optionIndex: String(index),
          ...(option.kind === "custom" ? { operation: "custom", inputName } : {}),
        }), card.disabled, option.kind === "custom" ? "primary" : "secondary");
      });
      if (options.length) controls.push(buttonList(options));
    }
  }
  return panelMessage(card.panel, card.choiceId, controls);
}

export function renderGoogleChatElicitationCard(card: ElicitationCardPost, cardId: string): GoogleChatCardsMessage {
  const controls: GoogleChatCardWidget[] = [];
  if (card.select && !card.select.disabled) {
    controls.push({ selectionInput: {
      name: "elicitationSelection", label: card.select.placeholder,
      type: card.select.max > 1 ? "CHECK_BOX" : "DROPDOWN",
      items: card.select.options.map((option) => ({
        text: option.description ? `${option.label} — ${option.description}` : option.label,
        value: option.value,
      })),
      onChangeAction: action(GOOGLE_CHAT_COMPONENT_ACTION, {
        customId: card.select.customId, operation: "select", inputName: "elicitationSelection",
      }),
    } });
  }
  const buttons = card.buttons?.map((item): GoogleChatCardButton => {
    if (item.style === "link") {
      if (item.url === undefined) throw new TypeError(`Link button "${item.label}" has no URL`);
      return { text: item.label, type: "OUTLINED", onClick: { openLink: { url: item.url } }, disabled: item.disabled };
    }
    if (item.customId === undefined) throw new TypeError(`Button "${item.label}" has no customId`);
    return button(item.label, action(GOOGLE_CHAT_COMPONENT_ACTION, { customId: item.customId }), item.disabled, item.style);
  });
  if (buttons?.length) controls.push(buttonList(buttons));
  return panelMessage(card.panel, cardId, controls);
}

/** Measures the message as JSON; transport adds any text/thread fields afterward. */
export function googleChatCardsPayloadBytes(payload: GoogleChatCardsMessage): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

function panelMessage(panel: StructuredPanel, cardId: string, controls: GoogleChatCardWidget[]): GoogleChatCardsMessage {
  const widgets: GoogleChatCardWidget[] = [];
  if (panel.description) widgets.push(paragraph(panel.description));
  for (const field of panel.fields) widgets.push({ decoratedText: {
    topLabel: field.name, text: formatGoogleChatCardText(field.value), wrapText: true,
  } });
  if (panel.imageUrl) widgets.push({ image: { imageUrl: panel.imageUrl, altText: panel.title ?? panel.author ?? "" } });
  if (panel.footer) widgets.push(paragraph(panel.footer));
  const output = message(cardId, [...widgets, ...controls]);
  const title = panel.title || panel.author;
  if (title) output.cardsV2[0]!.card.header = {
    title,
    ...(panel.title && panel.author ? { subtitle: panel.author } : {}),
    ...(panel.authorIconURL ? { imageUrl: panel.authorIconURL } : {}),
  };
  return output;
}

function message(cardId: string, widgets: GoogleChatCardWidget[]): GoogleChatCardsMessage {
  return { cardsV2: [{ cardId, card: { sections: widgets.length ? [{ widgets }] : [] } }] };
}

function paragraph(markdown: string): GoogleChatCardWidget {
  return { textParagraph: { text: formatGoogleChatCardText(markdown) } };
}

function actionRows(rows?: PanelButton[][]): GoogleChatCardWidget[] {
  return rows?.filter((row) => row.length).map((row) => buttonList(row.map((item) => button(
    item.emoji ? `${item.emoji} ${item.label}` : item.label,
    action(GOOGLE_CHAT_COMPONENT_ACTION, { customId: item.customId }), item.disabled, item.style,
  )))) ?? [];
}

function buttonList(buttons: GoogleChatCardButton[]): GoogleChatCardWidget {
  return { buttonList: { buttons } };
}

function button(text: string, callback: GoogleChatCardAction, disabled?: boolean, style?: string): GoogleChatCardButton {
  return { text, type: style === "primary" ? "FILLED" : "OUTLINED", disabled, onClick: { action: callback } };
}

function action(functionName: string, parameters: Record<string, string>): GoogleChatCardAction {
  return { function: functionName, parameters: Object.entries(parameters).map(([key, value]) => ({ key, value })) };
}

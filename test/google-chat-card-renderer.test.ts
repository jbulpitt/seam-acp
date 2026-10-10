import { describe, expect, it } from "vitest";
import type { StructuredPanel } from "../packages/core/src/core/types.js";
import {
  GOOGLE_CHAT_CARD_MAX_WIDGETS, GOOGLE_CHAT_SELECTION_MAX_ITEMS,
  googleChatCardsPayloadBytes, renderGoogleChatChoiceCard, renderGoogleChatElicitationCard,
  renderGoogleChatLayout, renderGoogleChatPanel,
} from "../packages/core/src/platforms/google-chat/card-renderer.js";
import { formatGoogleChatCardText } from "../packages/core/src/platforms/google-chat/card-text.js";

const panel: StructuredPanel = { color: 0x57f287, title: "Done", fields: [] };

describe("Google Chat card text", () => {
  it("reuses the agent-output heading/list normalization, then emits card HTML", () => {
    const text = "## Result\n- Read **the [guide](https://example.com/docs)** and use `seam config tts`.\n> *Warning*\n~~old~~";
    expect(formatGoogleChatCardText(text)).toBe('<b>Result</b><br>- Read <b>the <a href="https://example.com/docs">guide</a></b> and use <code>seam config tts</code>.<br>&gt; <i>Warning</i><br><s>old</s>');
  });

  it("preserves code contents, HTML-escaping only their representation", () => {
    const text = '**Outside** `a_b * c <d> & "e"`\n```ts\nconst a = "*_";\r\n\t// **bold** <@123> ||secret||\n```';
    expect(formatGoogleChatCardText(text)).toBe('<b>Outside</b> <code>a_b * c &lt;d&gt; &amp; &quot;e&quot;</code><br><pre><code>const a = &quot;*_&quot;;\r\n\t// **bold** &lt;@123&gt; ||secret||</code></pre>');
  });

  it.each([
    ["***both***", "<b><i>both</i></b>"],
    ["**bold *italic* tail**", "<b>bold <i>italic</i> tail</b>"],
    ["*italic **bold** tail*", "<i>italic <b>bold</b> tail</i>"],
    ["file_name and foo_bar_baz", "file_name and foo_bar_baz"],
    ["unclosed **bold", "unclosed **bold"],
    ["\\*literal\\*", "*literal*"],
    ["<b>literal</b> &", "&lt;b&gt;literal&lt;/b&gt; &amp;"],
    ["**https://example.com/a_b_c**", "<b>https://example.com/a_b_c</b>"],
    ['[a & b](https://example.com/?a=1&b=2)', '<a href="https://example.com/?a=1&amp;b=2">a &amp; b</a>'],
  ])("formats %s", (input, expected) => expect(formatGoogleChatCardText(input)).toBe(expected));

  it("uses labelled table rows and readable Discord labels, not Discord controls", () => {
    const text = "| Name | Role |\n| --- | --- |\n| Alice | Eng |\n<#123> <@456> <:done:789> ||answer||";
    expect(formatGoogleChatCardText(text)).toBe("- Name: Alice; Role: Eng<br>#channel:123 @user:456 :done: [spoiler: answer]");
  });
});

describe("Google Chat cardsV2 renderer", () => {
  it("renders a status panel with header, body, fields, image, footer and actions", () => {
    const input: StructuredPanel = {
      ...panel, author: "Claude", authorIconURL: "https://example.com/icon.png",
      description: "**Finished**", fields: [{ name: "Model", value: "`model-id`", inline: true }],
      imageUrl: "https://example.com/done.gif", footer: "12s elapsed",
      actions: [[{ customId: "cancel:attempt-id", label: "Cancel", style: "danger", disabled: true }]],
    };
    const before = JSON.stringify(input);
    expect(renderGoogleChatPanel(input, "status-id")).toEqual({ cardsV2: [{
      cardId: "status-id", card: {
        header: { title: "Done", subtitle: "Claude", imageUrl: "https://example.com/icon.png" },
        sections: [{ widgets: [
          { textParagraph: { text: "<b>Finished</b>" } },
          { decoratedText: { topLabel: "Model", text: "<code>model-id</code>", wrapText: true } },
          { image: { imageUrl: "https://example.com/done.gif", altText: "Done" } },
          { textParagraph: { text: "12s elapsed" } },
          { buttonList: { buttons: [{ text: "Cancel", type: "OUTLINED", disabled: true,
            onClick: { action: { function: "seam_component", parameters: [{ key: "customId", value: "cancel:attempt-id" }] } },
          }] } },
        ] }],
      },
    }] });
    expect(JSON.stringify(input)).toBe(before);
  });

  it("supports the simple author-only header and omits empty sections", () => {
    expect(renderGoogleChatPanel({ color: 0, author: "Working", fields: [] }, "simple")).toEqual({
      cardsV2: [{ cardId: "simple", card: { header: { title: "Working" }, sections: [] } }],
    });
    expect(renderGoogleChatPanel({ color: 0, fields: [] }, "empty").cardsV2[0]!.card.header).toBeUndefined();
  });

  it("renders layout text and dividers without Discord containers", () => {
    expect(renderGoogleChatLayout({ blocks: [
      { kind: "text", content: "**First**" }, { kind: "separator", divider: true },
      { kind: "text", content: "Second" }, { kind: "separator", divider: false },
    ], actions: [[], [{ customId: "go", label: "Continue", emoji: "▶", style: "primary" }]] }, "layout")).toEqual({
      cardsV2: [{ cardId: "layout", card: { sections: [{ widgets: [
        { textParagraph: { text: "<b>First</b>" } }, { divider: {} }, { textParagraph: { text: "Second" } },
        { buttonList: { buttons: [{ text: "▶ Continue", type: "FILLED", disabled: undefined,
          onClick: { action: { function: "seam_component", parameters: [{ key: "customId", value: "go" }] } },
        }] } },
      ] }] } }],
    });
  });

  it("carries the choice id and original option index on each prompt button", () => {
    const output = renderGoogleChatChoiceCard({ panel, choiceId: "choice-id", options: [
      { label: "Ship", kind: "prompt" }, { label: "Wait", kind: "prompt" },
    ] });
    expect(output.cardsV2[0]!.card.sections[0]!.widgets).toEqual([{ buttonList: { buttons: [
      { text: "Ship", type: "OUTLINED", disabled: undefined,
        onClick: { action: { function: "seam_choice", parameters: [
          { key: "choiceId", value: "choice-id" }, { key: "optionIndex", value: "0" },
        ] } },
      },
      { text: "Wait", type: "OUTLINED", disabled: undefined,
        onClick: { action: { function: "seam_choice", parameters: [
          { key: "choiceId", value: "choice-id" }, { key: "optionIndex", value: "1" },
        ] } },
      },
    ] } }]);
  });

  it("renders custom choices as inline forms, not unsupported Pub/Sub dialogs", () => {
    const widgets = renderGoogleChatChoiceCard({ panel, choiceId: "pick", options: [
      { label: "Ship", kind: "prompt" }, { label: "Your response", kind: "custom" },
    ] }).cardsV2[0]!.card.sections[0]!.widgets;
    expect(widgets[0]).toEqual({ textInput: { name: "choiceInput_1", label: "Your response", type: "MULTIPLE_LINE" } });
    expect(widgets[1]).toMatchObject({ buttonList: { buttons: [{}, {
      text: "Your response", onClick: { action: { function: "seam_choice", parameters: [
        { key: "choiceId", value: "pick" }, { key: "optionIndex", value: "1" },
        { key: "operation", value: "custom" }, { key: "inputName", value: "choiceInput_1" },
      ] } },
    }] } });
    expect(JSON.stringify(widgets)).not.toContain("OPEN_DIALOG");
  });

  it("preserves multi-select pending indices and the existing select/confirm protocol", () => {
    const widgets = renderGoogleChatChoiceCard({ panel, choiceId: "multi", select: { min: 1, max: 2 },
      pendingSelection: [1], options: [{ label: "A", kind: "prompt" }, { label: "B", kind: "prompt" }],
    }).cardsV2[0]!.card.sections[0]!.widgets;
    expect(widgets).toEqual([
      { selectionInput: { name: "choiceSelection", label: "Choose 1–2 options", type: "CHECK_BOX", items: [
        { text: "A", value: "0", selected: false }, { text: "B", value: "1", selected: true },
      ], onChangeAction: { function: "seam_choice", parameters: [
        { key: "choiceId", value: "multi" }, { key: "operation", value: "select" },
        { key: "inputName", value: "choiceSelection" },
      ] } } },
      { buttonList: { buttons: [{ text: "Confirm", type: "FILLED", disabled: undefined,
        onClick: { action: { function: "seam_choice", parameters: [
          { key: "choiceId", value: "multi" }, { key: "operation", value: "confirm" },
        ] } },
      }] } },
    ]);
  });

  it("removes closed controls and disables buttons without leaving active inputs", () => {
    const card = { panel, choiceId: "closed", options: [{ label: "Other", kind: "custom" as const }] };
    expect(renderGoogleChatChoiceCard({ ...card, hideButtons: true }).cardsV2[0]!.card.sections).toEqual([]);
    const disabled = renderGoogleChatChoiceCard({ ...card, disabled: true }).cardsV2[0]!.card.sections[0]!.widgets;
    expect(disabled).toHaveLength(1);
    expect(disabled[0]).toMatchObject({ buttonList: { buttons: [{ disabled: true }] } });
    const multi = renderGoogleChatChoiceCard({ ...card, select: { min: 1, max: 1 }, disabled: true });
    expect(JSON.stringify(multi)).not.toContain("selectionInput");
  });

  it("renders sign-in links as openLink, with Cancel retaining its original component id", () => {
    const output = renderGoogleChatElicitationCard({ panel: { ...panel, title: "Sign in", description: "**Authentication required**" },
      buttons: [{ label: "Open secure page", style: "link", url: "https://example.com/auth?state=opaque" },
        { label: "Cancel", style: "danger", customId: "elicitation:cancel:row-id" }],
    }, "auth-id");
    expect(output.cardsV2[0]!.card.sections[0]!.widgets[1]).toEqual({ buttonList: { buttons: [
      { text: "Open secure page", type: "OUTLINED", disabled: undefined,
        onClick: { openLink: { url: "https://example.com/auth?state=opaque" } } },
      { text: "Cancel", type: "OUTLINED", disabled: undefined,
        onClick: { action: { function: "seam_component", parameters: [{ key: "customId", value: "elicitation:cancel:row-id" }] } } },
    ] } });
  });

  it("renders enum elicitation as a form without saved answers", () => {
    const card = renderGoogleChatElicitationCard({ panel, select: {
      customId: "elicitation:pick:row", placeholder: "Choose", min: 1, max: 1,
      options: [{ label: "Keep", value: "keep", description: "Preserve files" }],
    } }, "enum");
    expect(card.cardsV2[0]!.card.sections[0]!.widgets[0]).toEqual({ selectionInput: {
      name: "elicitationSelection", label: "Choose", type: "DROPDOWN",
      items: [{ text: "Keep — Preserve files", value: "keep" }],
      onChangeAction: { function: "seam_component", parameters: [
        { key: "customId", value: "elicitation:pick:row" }, { key: "operation", value: "select" },
        { key: "inputName", value: "elicitationSelection" },
      ] },
    } });
  });

  it("does not silently discard malformed link/component buttons", () => {
    expect(() => renderGoogleChatElicitationCard({ panel, buttons: [{ label: "Open", style: "link" }] }, "bad"))
      .toThrow('Link button "Open" has no URL');
    expect(() => renderGoogleChatElicitationCard({ panel, buttons: [{ label: "Continue" }] }, "bad"))
      .toThrow('Button "Continue" has no customId');
  });

  it("records Google's documented limits without importing Discord truncation caps", () => {
    expect(GOOGLE_CHAT_CARD_MAX_WIDGETS).toBe(100);
    expect(GOOGLE_CHAT_SELECTION_MAX_ITEMS).toBe(100);
    const label = "L".repeat(150);
    const card = renderGoogleChatChoiceCard({ panel: { ...panel, description: "x".repeat(4001) }, choiceId: "long",
      options: Array.from({ length: 6 }, () => ({ label, kind: "prompt" })),
    });
    expect(JSON.stringify(card)).toContain("x".repeat(4001));
    expect(JSON.stringify(card)).toContain(label);
    const widgets = card.cardsV2[0]!.card.sections[0]!.widgets;
    expect(widgets[1]).toMatchObject({ buttonList: { buttons: Array.from({ length: 6 }, () => ({ text: label })) } });
    expect(googleChatCardsPayloadBytes(card)).toBe(Buffer.byteLength(JSON.stringify(card), "utf8"));
    expect(googleChatCardsPayloadBytes(renderGoogleChatPanel({ ...panel, description: "🌍" }, "utf8")))
      .toBeGreaterThan(JSON.stringify(renderGoogleChatPanel({ ...panel, description: "🌍" }, "utf8")).length);
  });
});

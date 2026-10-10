# Google Chat cards groundwork

`card-renderer.ts` turns neutral panels, layouts, choices and sign-in/reauth
elicitation cards into `cardsV2` message bodies. It does not send messages or
wire an adapter. The caller supplies a stable card id; choice cards use their
existing choice id. No permission cards are added.

Paragraphs and field values reuse the message formatter's Markdown normalization,
then convert to the card's default HTML syntax. Code bodies remain literal;
HTML escaping changes their JSON representation, not their displayed contents.
Lists and tables stay readable labelled text. Headers, field names and button
labels are plain text. Accent colors, inline field hints and layout spacing have
no direct mapping here. Attachments remain the caller's separate upload concern.

## Actions and click data

- Prompt choices use `seam_choice` with string `choiceId` and `optionIndex`
  action parameters. The parser restores the existing `choice:<id>:<index>` id.
- Custom choices use an inline text input and Submit button. Submission maps to
  the neutral modal-submission data (`choice:<id>:m:<index>`, `fields.payload`),
  without opening a dialog.
- Multi-select changes map to `choice:<id>:s` with `values`; Confirm maps to
  `choice:<id>:c`. Existing core selection bounds and pending-selection handling
  remain responsible for admission. Disabled cards have no editable inputs.
- Panel and elicitation actions use `seam_component` and the original `customId`.
  Sign-in links use `openLink`, not a fabricated component action.

`card-click.ts` accepts the flat non-add-on `CARD_CLICKED` Event: the invoked
function is `action.actionMethodName`, and action parameters are a key/value
array in `action.parameters`. The Event reference also documents
`common.invokedFunction` and a `common.parameters` map; the parser accepts those
representations, with `action` taking precedence. Form input strings are in
`common.formInputs[name].stringInputs.value`. This is **not** an add-on
`chat.buttonClickedPayload` or `commonEventObject` envelope.

The adapter supplies its canonical `ChannelRef` and the Pub/Sub delivery message
id for `ComponentEvent.interactionId`; Event provides no unique click id. The
result contains neutral interaction data only, not fake reply/modal functions.
Reply capabilities, authorization, persistence and redelivery handling stay at
the adapter/core boundary. Missing required fields in a recognized action raise
a specific TypeError rather than inventing identities or option indices.

## Documented limits and integration

- A card allows 100 widgets. Google ignores an entire section that exceeds the
  remaining widget budget, and all subsequent sections. Selection inputs allow
  100 items. A button list is a widget, not one widget per button.
- A complete message, including text and cards, is limited to 32,000 bytes.
  `googleChatCardsPayloadBytes` measures only this rendered JSON body; the caller
  must include any additional transport fields when budgeting the final message.
- The current references do not state separate numeric limits for buttons per
  list, button labels, header titles or rendered paragraph/decorated-text lengths.
  This module does not invent Discord caps or silently truncate content.

Rendering does not split oversized cards, retry API calls, or substitute an
error. Adapter integration must handle the documented widget/message budget and
surface Google's actual API rejection. No real Chat card or click has been
tested by this standalone groundwork; transport/UI proof follows adapter wiring.

## Google references (checked 2026-10-10)

- [Cards v2: widgets, buttons, actions and limits](https://developers.google.com/workspace/chat/api/reference/rest/v1/cards)
- [Card text HTML formatting](https://developers.google.com/workspace/chat/format-messages#format_text_that_appears_in_cards)
- [Non-add-on Event, common parameters and form inputs](https://developers.google.com/workspace/chat/api/reference/rest/v1/Event)
- [Event.action FormAction and its parameters](https://developers.google.com/workspace/chat/api/reference/rest/v1/cards-v1#FormAction)
- [Non-add-on versus add-on interaction fields](https://developers.google.com/workspace/chat/convert#handle_interaction_events)
- [Pub/Sub apps reply asynchronously and cannot open dialogs](https://developers.google.com/workspace/chat/quickstart/pub-sub)
- [Complete message size](https://developers.google.com/workspace/chat/create-messages)

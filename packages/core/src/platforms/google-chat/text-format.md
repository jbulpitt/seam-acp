# Google Chat text formatting

`formatGoogleChatText(markdown)` converts agent/Discord Markdown into original
Chat text syntax. `splitGoogleChatText(formatted, options)` produces complete
messages, closing and reopening oversized code blocks without modifying their
contents. These are pure helpers; the adapter is not wired here.

Send each result as `text` with
`markupSyntax: GOOGLE_CHAT_TEXT_MARKUP_SYNTAX` (`MARKUP_SYNTAX_CHAT`). Do not use
these helpers with `MARKUP_SYNTAX_MARKDOWN`, or use their output as card HTML.

```ts
const text = formatGoogleChatText(agentReply);
const messages = splitGoogleChatText(text, { reservedBytes: envelopeBytes });
```

The [Chat formatting guide](https://developers.google.com/workspace/chat/format-messages)
documents both original Chat syntax and a separate standard-Markdown mode.
Original syntax uses single-star bold, underscore italic, single-tilde strike,
backtick code, triple-backtick blocks, pipe-style links, blockquotes, and bullets
with four spaces per nesting level. Numbered-list styling is unsupported in this
mode; the converter keeps readable literal numbers. Headings and tables are not
documented for this mode, so headings become bold and table rows become labelled
lists. Standard Markdown's double-star bold is converted, not sent verbatim.

Code contents are protected before prose conversion, including whitespace,
line endings, and Discord-looking tokens. Fence language hints are removed.
Longer backtick fences are retained when code contains literal triple backticks;
Google's guide only documents triple fences, so their UI rendering is not
verified. This is a targeted agent-output converter, not a full CommonMark
implementation (for example, reference-style links are not expanded).

Discord mentions become labelled ids, not guessed Google identities; timestamps
become absolute UTC text, spoilers explicitly say `spoiler`, and custom emoji
become shortcodes. These substitutions apply outside code only. Chat's own user
mentions use different identifiers, and custom emoji are unavailable with app
authentication. See the same formatting guide.

The [message creation guide](https://developers.google.com/workspace/chat/create-messages)
sets a **32,000-byte** limit for a message including text and cards. The splitter
counts the UTF-8 bytes of serialized `{text, markupSyntax}`, including JSON escapes
and fence wrappers. `reservedBytes` is the additional serialized size of
adapter-owned fields/cards; the caller must supply it when adding them. `maxBytes`
can lower the budget. No whitespace or Unicode code points are discarded. A
budget too small to fit content raises a `RangeError` rather than dropping text.

Tests reuse prose, table, and fence samples from existing output-pipeline tests,
plus a redacted agent-authored worker handoff. These are not native-provider trace
fixtures. Live Chat rendering remains an adapter integration check.

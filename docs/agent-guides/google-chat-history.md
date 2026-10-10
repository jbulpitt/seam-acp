# Google Chat named-space history

The modules in `core/messages/google-chat-history.ts` and
`core/messages/google-chat-space-history.ts` are standalone: adapter and controller
wiring remain separate. Set `GOOGLE_CHAT_CREDENTIALS_FILE` to the existing
service-account JSON key and load it with `loadGoogleChatHistoryConfig()`.

It uses app authentication with
`https://www.googleapis.com/auth/chat.app.messages.readonly`, without impersonating
a user. This scope needs one-time Workspace admin approval. Message listing with
app auth requires the app to be a member of the space. See the
[app-auth guide](https://developers.google.com/workspace/chat/authenticate-authorize-chat-app).

DM operations return `{ status: "unsupported", cause }` with Google's observed
limitation: "DMs are not supported for methods requiring app authentication with
administrator approval". This applies to this admin-approved history scope;
the separate `chat.bot` scope can get app-accessible DM messages. This reader
does not switch scopes.

```ts
const reader = new GoogleChatHistoryReader(loadGoogleChatHistoryConfig());
const result = await fetchMessagePage(reader, {
  space: "spaces/SPACE",
  thread: "spaces/SPACE/threads/THREAD", // omit for an unthreaded space
  spaceType: "SPACE", // actual space metadata, not inferred from its name
}, { limit: 100 });
if (result.status === "supported") usePage(result.page);
else reportUnsupported(result.cause);
```

`readPage()` returns normalized `MessagePageItem` fields, raw count and oldest raw
message facts, plus `nextPageToken`. `pages()` follows tokens with the same limit,
filter and ordering. A short or content-empty page is not exhaustion: only an
absent token is. Card-only and attachment-only messages remain readable; deleted
messages have no content but still count in raw-page facts if Google returns them.

The standalone `fetchMessagePage(reader, target, request)` accepts the existing
`MessagePageRequest`: exclusive `before`/`after` message IDs or an inclusive
`around` ID. It resolves the anchor with `messages.get`, follows native tokens,
and fills up to the requested raw-row count before returning a neutral page.
Short and empty native pages therefore cannot truncate search or rebuild.
`before`/`after` use a time filter that includes the anchor's whole millisecond,
then scan to its exact ID, preserving timestamp ties. `around` scans newest-first
to center on the anchor and fills available history at either edge. There is no
saved cursor cache, so deep `around` reads can scan earlier native pages.

The low-level `readPage()` still accepts exclusive RFC3339 time bounds. Message
and author IDs are full Google resource names. Items carry a reason for the
missing permalink instead of an invented jump URL.

The [list API](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages/list)
supports `thread.name = spaces/SPACE/threads/THREAD`,
`createTime > "RFC3339"` and `createTime < "RFC3339"`, combined with `AND`.
Ordering is `createTime ASC` or `createTime DESC`. Page-token requests must keep
the other query parameters unchanged. Listing excludes system messages and
messages privately addressed to a specific user.
Formatted text, attachment names and card/widget presence come from the
[Message resource](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages).

Google auth, permission, API and transport errors pass through unchanged,
including response details and nested causes. There is no scope fallback or new
retry policy. An unapproved scope remains Google's actual denial.

`findMessageByNonce(reader, target, nonce)` returns `found`, `absent`, or
`unsupported`. It calls [messages.get](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages/get)
with `spaces/SPACE/messages/client-…`, using the sender's existing nonce hash.
Only a 404 means absent; other errors propagate. Google's
[custom message IDs](https://developers.google.com/workspace/chat/create-messages#name_a_message)
are set at creation, start with `client-`, and can substitute for the message
ID in later requests. Lookup needs no time window or history scan.

## Adapter call sites

- `GoogleChatAdapter.fetchMessagePage(threadId, request)` (new method): resolve
  the space, optional native thread and actual `spaceType`; call the standalone
  function. Return `result.page` on success and surface `result.cause` on
  unsupported. Do not return an empty page for a DM.
- `GoogleChatAdapter.findMessageByNonce(channel, nonce)` (existing unsupported
  stub): call the standalone lookup. Map the canonical message name and native
  thread to `MessageRef`; map unsupported to the existing `indeterminate`
  result with its cause as `reason`. `sinceMs` is unnecessary for an exact ID.
- `GoogleChatAdapter.postMessage` and its 409 lookup: use the exported
  `googleChatClientMessageId` in place of the identical private `clientId`.
- Controller construction in `index.ts`: create one history reader, inject it
  into Chat, and route the MCP `MessageReader` source through the multiplexed
  adapter. It currently uses the Discord adapter directly.
- The existing rebuild source in `Orchestrator.reconstructSessionFromDiscord`
  already calls `this.adapter.fetchMessagePage`; it can use the same Chat source. Its
  Discord-specific notices and metadata still need a separate wiring change.

## Admin setup

Create a Marketplace-compatible OAuth client from the service account's
**Advanced settings**. Configure the Marketplace SDK with **Private** visibility,
**Individual + admin install**, **Chat app** integration and the history scope;
do not put `chat.bot` in its approval scope list. Complete the private store
listing and publish it. The
[Marketplace configuration](https://developers.google.com/workspace/marketplace/enable-configure-sdk)
and [listing requirements](https://developers.google.com/workspace/marketplace/create-listing)
describe these fields.

In Admin console, **Apps → Google Workspace Marketplace apps → Apps list →
Install app**, select the listing, **Admin install → Continue**, review data
access, then **Everyone at your organization → Finish**. App-centric approval is
not per OU. See
[Google's admin instructions](https://knowledge.workspace.google.com/admin/chat/set-up-app-authorization-for-chat).
Deployment values and the opt-in live probe belong in `docs/local/`.

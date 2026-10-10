# Google Chat history reader

`GoogleChatHistoryReader` is standalone groundwork: it has no Chat adapter or
controller wiring. Set `GOOGLE_CHAT_CREDENTIALS_FILE` to the existing service-account
JSON key and load it with `loadGoogleChatHistoryConfig()`.

It uses app authentication with
`https://www.googleapis.com/auth/chat.app.messages.readonly`, without impersonating
a user. This scope needs one-time Workspace admin approval. Message listing with
app auth became GA on March 31, 2026. See the
[app-auth guide](https://developers.google.com/workspace/chat/authenticate-authorize-chat-app)
and [release notes](https://developers.google.com/workspace/chat/release-notes).

```ts
const reader = new GoogleChatHistoryReader(loadGoogleChatHistoryConfig());
const page = await reader.readPage({
  space: "spaces/SPACE",
  thread: "spaces/SPACE/threads/THREAD", // omit for the whole space
  limit: 100,
  order: "newest", // default; "oldest" requests createTime ASC
});
```

`readPage()` returns normalized `MessagePageItem` fields, raw count and oldest raw
message facts, plus `nextPageToken`. `pages()` follows tokens with the same limit,
filter and ordering. A short or content-empty page is not exhaustion: only an
absent token is. Card-only and attachment-only messages remain readable; deleted
messages have no content but still count in raw-page facts if Google returns them.

`before` and `after` are exclusive RFC3339 timestamps, not message IDs. The later
adapter must translate its `MessagePageRequest` message cursors and implement
`around`; this module does not claim to implement `fetchMessagePage` yet. Message
and author IDs remain full Google resource names. The response has no documented
message permalink, so items carry a reason instead of an invented jump URL.

The [list API](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages/list)
supports `thread.name` and time filters, ascending/descending creation order,
page tokens, and up to 1000 messages per page. It excludes system messages and
messages privately addressed to a specific user; "private messages" here does
not mean the entire app DM. The app must be a member of the requested space.
Formatted text, attachment names and card/widget presence come from the
[Message resource](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages).

Google auth, permission, API and transport errors pass through unchanged,
including response details and nested causes. There is no scope fallback or new
retry policy. An unapproved scope remains Google's actual denial.

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

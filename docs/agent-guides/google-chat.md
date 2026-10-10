# Google Chat

Seam's Google Chat integration is an optional MVP alongside Discord. It uses
service-account app authentication and a Cloud Pub/Sub pull subscription, so
the controller does not need a public inbound HTTP endpoint. Discord remains
configured on the same controller.

## Conversations and sessions

Open a DM with the Chat app. Each new top-level message starts a separate Seam
session; replies in that message's thread continue it. Agent replies and text
status updates stay in the same thread. Concurrent threads share the DM's
write budget, so updates can be coalesced rather than sent on every token.

Chat uses the same agent runtimes as Discord. Its MVP permission policy is
`always`: tool requests are approved without permission cards. Configure
allowed users before enabling the integration.

### Shared spaces

Add the app to a named Space and @mention it to start a turn. Workspace Events
subscriptions admit unmentioned replies in existing Seam sessions. Unrelated
threads, bot replies and messages from users outside the allowlist are not
admitted. Direct mentions and Workspace deliveries share one durable message
identity, so receiving both does not start two turns. Human and other-app
mentions remain in the prompt; annotated Seam mentions are stripped.

Subscriptions are created on membership or discovered at startup, renewed
before Google's returned expiry, and deleted on removal. Failed renewals log
Google's cause and retry with backoff; after expiry, they recreate the
subscription. Space metadata and renewal deadlines are stored in Seam's
database; startup reconciles them with Google before rearming timers.
Name-only message events are hydrated through the Chat API, or skipped with
the actual fetch cause logged.

`THREADED_MESSAGES` uses one session per native reply thread.
`GROUPED_MESSAGES` uses one session per native topic thread.
`UNTHREADED_MESSAGES` uses one shared session for the whole space and sends
unthreaded replies. In that mode `/new` explains that no separate thread can
be created and makes no change. With unspecified threading metadata, a
provided thread is used; otherwise the session is space-wide. Users sharing
a thread also share its agent, model and conversation.

The registered `/new`, `/cancel`, `/agent` and `/model` commands work in spaces
without an @mention. The existing user allowlist still applies to prompts,
commands and card clicks. Shared-space permissions remain `always`; this
slice does not add permission cards or change the platform default.

## Configuration

- `GOOGLE_CHAT_PROJECT_ID`: the Google Cloud project ID.
- `GOOGLE_CHAT_SUBSCRIPTION`: the full
  `projects/<project>/subscriptions/<subscription>` resource name.
- `GOOGLE_CHAT_TOPIC`: the matching `projects/<project>/topics/<topic>` resource
  for Workspace Events. Set it to enable unmentioned Space replies; without it
  shared spaces remain mention-only. No additional Pub/Sub metadata-read role
  is needed.
- `GOOGLE_CHAT_CREDENTIALS_FILE`: the service-account JSON key file path.
- `GOOGLE_CHAT_ALLOWED_USER_IDS`: comma-separated Chat user resource names,
  such as `users/<id>`; an empty list admits no users.
- `GOOGLE_CHAT_ALLOWED_SPACE_IDS`: optional comma-separated shared-space
  resources (`spaces/<id>`) or bare ids. Empty permits all shared spaces;
  DMs are unaffected. This applies in addition to the user allowlist.
- `GOOGLE_CHAT_DEFAULT_CWD`: optional working directory; defaults to
  `REPOS_ROOT`.
- `GOOGLE_CHAT_DEFAULT_LOCATION`: bridge id for new sessions; defaults to
  `local`. The cwd is on that host, not the controller. New sessions seed
  these defaults through the normal thread overlay; existing bindings stay
  unchanged. `/agent codex@host` uses the same host selector as Discord.

The adapter starts when the project, subscription and credentials file are
configured. Use one controller consumer per subscription. Apply controller
configuration through the normal [redeploy path](deploying.md).

The standalone Shared Drive uploader also defines
`GOOGLE_CHAT_DRIVE_FOLDER_ID` and `GOOGLE_CHAT_DRIVE_SHARING_POLICY`
(`members-only` or `domain-readable`). The latter additionally requires
`GOOGLE_CHAT_DRIVE_DOMAIN`. These names configure the uploader; they do not
enable file-output wiring in the current adapter.

## Google-side setup

1. Create a Google Cloud project and enable the Google Chat and Pub/Sub APIs.
   Create a Pub/Sub topic and pull subscription. Grant
   `chat-api-push@system.gserviceaccount.com` permission to publish to the topic,
   and give the app's service account permission to consume the subscription.
2. In Google Chat API → Configuration, configure an interactive Chat app
   (not a Workspace add-on), its name/avatar and visibility, and select the
   Cloud Pub/Sub connection with that topic. Enable the app and add it to the
   intended user's Chat.
3. Supply the service-account key and the environment settings above. Chat
   message writes use `https://www.googleapis.com/auth/chat.bot` app auth;
   Pub/Sub consumption uses its own authentication scope.
4. For Drive output, enable the Drive API, add the service account to a Shared
   Drive with upload access, and choose a destination and sharing policy.
   A returned link does not grant access beyond that policy.
5. History requires a separate administrator-approved scope:
   `https://www.googleapis.com/auth/chat.app.messages.readonly`. Attach a
   Marketplace-compatible OAuth client to the service account, configure and
   publish a private Marketplace listing (individual + admin install, Chat app
   integration), then have a Workspace administrator install it for the
   organization and approve the scope. The controller builds the history
   reader from the same credentials file.
6. For unmentioned Space messages, enable the Google Workspace Events API and
   approve the same `chat.app.messages.readonly` scope. Set `GOOGLE_CHAT_TOPIC`
   to the topic configured on the pull subscription; its existing publisher grant
   also covers Workspace message events. Create/renew and message hydration
   use the approved scope; subscription list/delete and operation polling
   use `chat.bot`. No separate topic or controller consumer is required.

Google's [Pub/Sub quickstart](https://developers.google.com/workspace/chat/quickstart/pub-sub)
and [app-auth approval guide](https://developers.google.com/workspace/chat/authenticate-authorize-chat-app)
cover the Cloud and Workspace steps. Keep deployment-specific identifiers,
asset paths and operator commands in `docs/local/`.

## Current limits

The live adapter supports formatted text turns, cardsV2 status and interaction
cards, threaded replies, inbound attachment downloads and `/new`, `/cancel`,
`/agent`, `/model`. Configured Shared Drive output uploads files and posts a
link; without that configuration, file output uses text or a binary placeholder.

Named-space history reads, reconstruction, search and restart-safe output
delivery deduplication use the administrator-approved readonly scope. DM
history and uncertain-delivery lookup remain unsupported with Google's real
cause; see [named-space history](google-chat-history.md). The adapter does not
claim the message is absent and resend it. Durable inbound admission is a
separate mechanism.

Voice/live help, permission cards and cross-platform handoff are outside this
MVP.

## Data flow

Chat messages and attachments enter the configured Seam controller and are
forwarded to the selected agent runtime and provider. Seam stores message
admission, session and turn state locally for recovery; agent runtimes also
retain their own session data. Replies return to the same Chat thread.
Deployments choose their providers, hosts and retention practices. When Drive
output is enabled, uploaded files remain in the configured Shared Drive under
its selected sharing policy. This guide describes the integration, not a
deployment's terms of service or privacy policy.

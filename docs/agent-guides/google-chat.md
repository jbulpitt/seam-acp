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

Add the app to a named Space and @mention it to start a turn. In this slice,
ordinary messages and unmentioned replies are not admitted; hearing those
requires the separate Workspace Events subscription integration. Human
mentions remain in the prompt; annotated app mentions are stripped.

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
   organization and approve the scope. Approval does not itself wire the
   history reader into Seam.

Google's [Pub/Sub quickstart](https://developers.google.com/workspace/chat/quickstart/pub-sub)
and [app-auth approval guide](https://developers.google.com/workspace/chat/authenticate-authorize-chat-app)
cover the Cloud and Workspace steps. Keep deployment-specific identifiers,
asset paths and operator commands in `docs/local/`.

## Current limits

The live adapter supports text turns, text status updates, threaded replies
and inbound attachment downloads. The Markdown formatter, interactive cards,
Shared Drive uploader and `/new`, `/cancel`, `/agent`, `/model` command helpers
exist as standalone modules; adapter wiring is still in progress. Registering
the slash commands alone does not activate those helpers.

History reads, history-based reconstruction and search are not enabled until
the readonly scope is approved and the reader is wired. Restart-safe output
delivery deduplication also depends on that integration. For an uncertain
delivery, the current adapter reports an indeterminate lookup; it does not
claim the message is absent and resend it. Durable inbound admission is a
separate mechanism.

Voice/live help, permission cards and cross-platform handoff are outside this
MVP. Agent file output currently uses text or a binary-placeholder response,
not a Drive upload.

## Data flow

Chat messages and attachments enter the configured Seam controller and are
forwarded to the selected agent runtime and provider. Seam stores message
admission, session and turn state locally for recovery; agent runtimes also
retain their own session data. Replies return to the same Chat thread.
Deployments choose their providers, hosts and retention practices. When Drive
output is enabled, uploaded files remain in the configured Shared Drive under
its selected sharing policy. This guide describes the integration, not a
deployment's terms of service or privacy policy.

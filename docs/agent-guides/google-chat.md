# Google Chat

Seam's Google Chat integration is an optional MVP alongside Discord. It uses
service-account app authentication and a Cloud Pub/Sub pull subscription, so
the controller does not need a public inbound HTTP endpoint. Discord remains
configured on the same controller.

## Conversations and sessions

New sessions live in named Spaces. Use `/new` wherever the app listens, or send
a plain DM / @mention in an externally managed Space: Seam creates a private
session Space, adds the requester as manager, and binds one ACP session to its
root. Automatic launches use that message as the first prompt and title.
`/new` creates an empty session and replies with its Space link.

Every native thread inside that Space shares the same session. A new message
interrupts the running turn, as in Discord; its predecessor's card settles as
cancelled. A top-level prompt gets top-level output; a native-thread prompt gets its status,
text and files in that thread. Each admitted prompt retains its own target
through queuing, controller restart and bridge reattachment. Previously admitted
work that has not been superseded recovers in admission order. Native-thread
prompts include a short root-context header: local delivery metadata for Seam
roots, otherwise one history read. A failed context read logs Google's actual
cause and admits the original prompt without a header.

Existing DM-thread and Space-thread sessions continue until manually moved;
new messages never create another thread-bound session.

Chat uses the same agent runtimes as Discord. Its MVP permission policy is
`always`: tool requests are approved without permission cards. Configure
allowed users before enabling the integration.

The shared `configure_thread(..., { fastMode })` control also applies to Chat
session Spaces. Codex toggles its live `fast-mode` option without replacing the
ACP session; Claude keeps its fresh-session policy. Availability follows the
current live model's advertised option, and Chat status cards show Fast only
from the observed runtime state. This does not add a Chat slash command or
change org launch defaults.

### Shared spaces

Manually added Spaces remain mention-only outside legacy session threads.
Only an exact session row bound to the Space root admits every human message.
The user allowlist still applies. Bot replies and messages from users outside
that allowlist are not admitted. Direct mentions and Workspace deliveries share one durable message
identity, so receiving both does not start two turns. Human and other-app
mentions remain in the prompt; annotated Seam mentions are stripped.

Subscriptions are created on membership or discovered at startup, renewed
before Google's returned expiry, and deleted on removal. Failed renewals log
Google's cause and retry with backoff; after expiry, they recreate the
subscription. Space metadata and renewal deadlines are stored in Seam's
database; startup reconciles them with Google before rearming timers.
Name-only message events are hydrated through the Chat API, or skipped with
the actual fetch cause logged.

Native threads/topics are delivery destinations, not new session bindings.
Unthreaded Spaces send top-level output. `/new` works there too: it creates a
different session Space and leaves the current one alone. Google's permanent
thread-reply limit sends the answer top-level in the same Space, and subsequent
output for that turn stays top-level; the root binding and ACP session do not
change. Legacy thread-bound sessions retain their previous continuation behavior.

The registered `/new`, `/cancel`, `/agent`, `/model`, `/repo` and `/effort` commands work in spaces
without an @mention. The existing user allowlist still applies to prompts,
commands and card clicks. Shared-space permissions remain `always`; this
slice does not add permission cards or change the platform default.

## Configuration

- `GOOGLE_CHAT_PROJECT_ID`: the Google Cloud project ID.
- `GOOGLE_CHAT_SUBSCRIPTION`: the full
  `projects/<project>/subscriptions/<subscription>` resource name.
- `GOOGLE_CHAT_TOPIC`: the matching `projects/<project>/topics/<topic>` resource
  for Workspace Events. Session-Space creation registers its subscription using
  this topic; configure it before creating sessions. No additional Pub/Sub
  metadata-read role is needed.
- `GOOGLE_CHAT_CREDENTIALS_FILE`: the service-account JSON key file path.
- `GOOGLE_CHAT_ALLOWED_USER_IDS`: comma-separated Chat user resource names,
  such as `users/<id>`; an empty list admits no users.
- `GOOGLE_CHAT_ALLOWED_SPACE_IDS`: optional comma-separated shared-space
  resources (`spaces/<id>`) or bare ids. Empty permits all shared spaces;
  DMs and Seam-created session Spaces are unaffected. This applies in addition
  to the user allowlist for externally managed Spaces.
- `GOOGLE_CHAT_DEFAULT_CWD`: optional working directory; defaults to
  `REPOS_ROOT`.
- `GOOGLE_CHAT_DEFAULT_LOCATION`: bridge id for new sessions; defaults to
  `local`. The cwd is on that host, not the controller. New sessions seed
  these defaults through the normal thread overlay; existing bindings stay
  unchanged. `/agent codex@host` uses the same host selector as Discord.

The adapter starts when the project, subscription and credentials file are
configured. Use one controller consumer per subscription. Apply controller
configuration through the normal [redeploy path](deploying.md).

### Session-Space launch foundation

The Space-creation primitive snapshots one deployment/customer default from
`GOOGLE_CHAT_DEFAULT_AGENT`, `GOOGLE_CHAT_DEFAULT_MODEL`,
`GOOGLE_CHAT_DEFAULT_EFFORT` and the existing cwd/location settings. Unset
agent/model/effort use `DEFAULT_AGENT`, `default` and `auto`. An explicit
`agent@location` overrides the location fallback. These are operator settings;
there is no per-person default or user-facing setter.

Its `/new` argument parser accepts name words plus optional `agent=`, `model=`,
`effort=` and `repo=` values. Options override the org snapshot for one Space,
using the existing core agent/catalog/repo validation. Every non-option token
belongs to the title; the default title is `seam`. Setup checkpoints the native
Space, requester manager promotion, managers-only `manageApps`, subscription
and root binding in the command's existing admission receipt. Retries reuse
that snapshot and Google's create requestId.

The adapter uses this foundation for `/new` and automatic launches. Redelivered
commands reuse the setup receipt rather than creating another Space. Launcher
sessions and per-person settings never replace the org snapshot. Naming polish,
archive and migration are separate slices.

### Session repo and effort

Register these slash commands in the Chat API configuration alongside ids 1–4:

- `/repo`, id **5**, description `Set this session's repo: /repo <path>`.
- `/effort`, id **6**, description `Set this session's effort: /effort <level>`.

`/repo <path>` uses the same thread `cwd` overlay as Discord's repo picker.
Relative paths resolve under the bound bridge's workspace root (`REPOS_ROOT`
on that host); absolute paths use that host's filesystem too. The host validates
the directory and returns its real cause when it cannot use it. Bare `/repo`
shows usage, the current cwd and the existing host workspace list.

A changed cwd starts a fresh session. If a turn is running, it finishes in the
old cwd before the next turn starts in the new repo. The confirmation states
whether the session reset now, a reset is pending, or no reset was needed.

`/effort <level>` uses the same configuration operation as `configure_thread`.
Bare `/effort` shows the current effort and the current agent/model's catalog
levels. `auto` selects the default; invalid levels return the catalog or live
provider's actual reason. Effort never resets conversation context, although
some agents reload their runtime to apply it.

Both commands reply privately: top-level replies are unthreaded, and in-thread
replies stay in that thread. In unthreaded Spaces they change the shared Space
session. Durable receipts prevent redelivery from applying a command twice.

### Private schedule editor

Register `/schedules` as a slash command with id **7**, description
`Manage this Space's schedules privately`, with dialogs disabled.

The list includes schedules in the current Space and its native reply threads.
Each row shows its name, cadence, next run, and On/Off state. Prev/Next pages
through four schedules at a time. Run now uses the same scheduler as Discord
and is available to everyone admitted by the existing Chat access rules.

`GOOGLE_CHAT_ADMIN_USER_IDS` contains comma-separated Chat user resource names
such as `users/123456789`. Only these users can Add, Edit, Pause, Resume, or
Delete a schedule. An empty set means no mutation admins. Delete first replaces
that row's controls with Confirm/Cancel.

Add schedule and each row's Edit button replace the same private message with
an inline form. Name, prompt, cadence preset or custom cron, timezone, and
isolated/live mode follow the Discord builder's shared rules. Isolated mode
also offers model, working directory, output format, and target Space/thread.
A blank model or working directory inherits the bound conversation's defaults;
a blank target posts there. Targets accept `SPACE.THREAD` or
`spaces/SPACE/threads/THREAD` (omit the thread to target a Space). Save validates
on the server and returns to the same list page. Errors preserve the entered
values; Cancel returns without saving. Live schedules discard isolated-only
overrides. Forms use native card inputs, not dialogs.

The list uses `privateMessageViewer`, so only its requesting user and the app
can see it. Every click replaces the whole card message with a PATCH; the
message's private viewer stays unchanged. Click effects and pending card
updates use the existing command receipt, so Pub/Sub redelivery does not
repeat Run now, create a schedule twice on a redelivered Save, or undo a Pause/Resume action.

The standalone Shared Drive uploader also defines
`GOOGLE_CHAT_DRIVE_FOLDER_ID` and `GOOGLE_CHAT_DRIVE_SHARING_POLICY`
(`members-only` or `domain-readable`). The latter additionally requires
`GOOGLE_CHAT_DRIVE_DOMAIN`. The adapter uses these settings for Drive output.

### Native images

Set `GOOGLE_CHAT_MEDIA_TOKEN_FILE` to an OAuth `authorized_user` JSON file
containing `type`, `client_id`, `client_secret` and `refresh_token`. Obtain offline
user consent for `https://www.googleapis.com/auth/chat.messages.create` and
`https://www.googleapis.com/auth/chat.messages.readonly`;
this is separate from the bot service-account key. Set `GOOGLE_CHAT_MEDIA_USER`
to that user's canonical `users/<id>` resource. Using the canonical id lets Space
creation recognize when the requester and upload user are the same person.

With both settings, images upload as native Chat attachments in named Spaces
where the upload user is a joined member. They follow the triggering prompt's
thread or top-level target, sharing the app's per-space write queue and reply-cap
continuation. New session Spaces add the upload user as a member; when they are
the requester, their existing manager membership is reused. A creation receipt
retains that setup effect across restart.

DMs, Spaces without that member, non-images and deployments without native media
configuration retain Drive-link delivery under the configured sharing policy.
A configured native upload or create failure reports Google's real cause; it
does not silently switch delivery methods. Google's
[attachment upload guide](https://developers.google.com/workspace/chat/upload-media-attachments)
describes the user-auth upload and message-create operations.

Messages appear as the OAuth user, not the bot. Before create, Seam durably
reserves a `client-seam-…` alias, then records Google's canonical message name.
Only those exact recorded identities are dropped on both inbound event paths;
the user's other messages remain prompts. History and reconstruction mark the
recorded posts as Seam output without changing their real sender identity.
The readonly app history scope still handles uncertain-delivery lookup.

Images remain in Chat's native Space storage and use its membership access;
there is no public image URL, proxy route, or new public origin configuration.
The chosen upload user can access every new session Space they are added to.

### Inbound attachments

App-mentioned uploads and app DMs keep `chat.bot` downloads. Unmentioned
`UPLOADED_CONTENT` in a Space uses the configured media user's token only when
the membership lookup reports `JOINED`. That check uses the attachment's
original Space, not the session's reply destination. The native download context
stays in the existing admission JSON so queued/recovered prompts use the same
route. Missing membership leaves the app-auth path; permission failures retain
Google's cause rather than authorizing a user download.

The user token needs the readonly scope for these downloads; the admin-approved
`chat.app.messages.readonly` history scope is not a media-download scope. An
existing create-only user token needs renewed user consent, not a new app
Marketplace installation. Google's [download guide](https://developers.google.com/workspace/chat/download-media-attachments)
describes the app and user scopes.

`DRIVE_FILE` attachments keep their Drive file reference and download through the
configured Drive identity, not through Chat media or the media user's token.
Download failures are included in the sender's rejected-attachment notice with
Google's real cause; the original error/response is retained.

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
`/agent`, `/model`, `/repo`, `/effort`, and private `/schedules` lists. Configured native images post as Chat
attachments in named Spaces. Other files and image fallback use Shared Drive
links; without Drive configuration, fallback uses text or a binary placeholder.

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
retain their own session data. Replies return to the triggering prompt's native
thread or to the session Space root for top-level prompts.
Deployments choose their providers, hosts and retention practices. When Drive
output is enabled, uploaded files remain in the configured Shared Drive under
its selected sharing policy. Native images instead remain in Chat under the
Space's membership and retention policies. This guide describes the integration, not a
deployment's terms of service or privacy policy.

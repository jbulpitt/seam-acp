# Google Chat Integration Plan

## Overview

Google Chat (Workspace) organises conversations into **Spaces**, which support
threads. This maps well onto seam-acp's Discord model: Spaces ≈ channels,
threads ≈ threads. Roughly 60–70 % of the existing codebase is reusable
without modification.

---

## What Can Be Reused

| Layer | Status |
|---|---|
| ACP agent runtime (`src/agents/`, `src/core/acp.ts`) | ✅ Unchanged |
| Session store (`src/core/session-store.ts`) | ✅ Unchanged |
| Session router (`src/core/session-router.ts`) | ✅ Unchanged |
| FenceStream / stream-flush | ✅ Unchanged |
| Channel presets (`src/config.ts`) | ✅ Unchanged |
| `ChatAdapter` interface | ✅ Implement new concrete class |
| Orchestrator (`src/platforms/discord/orchestrator.ts`) | ⚠️ Needs adapter-aware refactor (see below) |

---

## Key Differences from Discord

### 1. No Persistent WebSocket — HTTP Push/Pull

Google Chat delivers events via one of two mechanisms:

- **HTTP endpoint** (recommended for production): Google POSTs a JSON payload
  to a public URL you register in Google Cloud Console. Your app must run an
  HTTP server.
- **Cloud Pub/Sub**: Events are published to a GCP topic; your app polls or
  subscribes.

seam-acp currently uses Discord's persistent Gateway WebSocket. A Google Chat
adapter would instead spin up an Express (or similar) HTTP server and handle
incoming `POST /google-chat/events` requests.

**Impact:** The `start()` method on `GoogleChatAdapter` launches an HTTP
listener instead of a WS client. The rest of the pipeline (routing events into
`handleIncomingMessage`) stays identical.

### 2. No Native Slash-Command Registration

Discord slash commands are registered at runtime via the REST API and
delivered as `INTERACTION_CREATE` gateway events. Google Chat has no
equivalent. Instead:

- **Slash commands** are simulated by prefixing text with `/seam …`. The
  adapter parses this prefix before passing the message to the orchestrator.
- App commands can also be triggered via **Google Chat App menus** (registered
  statically in the app manifest), but these deliver a `CARD_CLICKED` event
  rather than a text slash command.
- For the initial port, prefix-based commands (`/seam init`, `/seam repo`,
  etc.) are sufficient.

### 3. `sendChoicePicker` → Card JSON

The Discord adapter renders choice pickers as interactive select menus
(component rows). Google Chat uses **Card v2** JSON with `SelectionInput`
widgets. The `sendChoicePicker` method on the adapter interface needs a
Google Chat-specific implementation that POSTs a card payload back to the
reply URL provided in the incoming event.

### 4. File Uploads → Google Drive

Discord inline file attachments are not available. Options:

- Upload the file to a Google Drive folder (service-account-owned) and post
  a shareable link in the Chat message.
- Alternatively, paste file content inline as a code block (already done for
  small files in the Discord path via fence rendering).

A `GoogleDriveUploader` helper would wrap the Drive API `files.create` call.

### 5. Responding to Events

Google Chat events carry a `replyToken` / synchronous reply URL. For simple
responses the adapter can return JSON directly in the HTTP response (200 OK
with a `{ text }` or card body). For longer streaming responses it must use
the Chat REST API (`spaces.messages.create` / `spaces.messages.patch`) with a
service account or OAuth token.

---

## Architecture Sketch

```
Google Cloud Console
  └── App registration (HTTP endpoint or Pub/Sub)
        │
        ▼
GoogleChatAdapter (src/platforms/google-chat/)
  ├── server.ts          Express HTTP listener
  ├── adapter.ts         Implements ChatAdapter interface
  │     ├── start()      Starts HTTP server
  │     ├── sendMessage()  → Chat REST API (spaces.messages.create/patch)
  │     ├── sendChoicePicker() → Card v2 JSON
  │     └── uploadFile() → Google Drive + share link
  └── orchestrator.ts    Thin wrapper (or reuse shared orchestrator)
```

---

## New Dependencies

| Package | Purpose |
|---|---|
| `express` (or `@hapi/hapi`) | HTTP server for event ingress |
| `googleapis` | Chat REST API + Drive upload |
| `google-auth-library` | Service account / OAuth token management |

---

## Environment Variables Required

```
GOOGLE_CHAT_CREDENTIALS_FILE   # Path to service account JSON key
GOOGLE_CHAT_PORT               # Port for the HTTP event endpoint (default 3001)
GOOGLE_CHAT_SIGNING_SECRET     # Request verification token from Cloud Console
```

---

## Effort Estimate

| Area | Relative effort |
|---|---|
| HTTP event server + request verification | Medium |
| `GoogleChatAdapter` (sendMessage, threading) | Medium |
| Card v2 choice picker | Medium |
| Google Drive file upload | Small |
| Slash-command prefix parser | Small |
| Auth / credential wiring | Small |
| Shared orchestrator refactor (extract Discord-isms) | Medium |

**Overall:** Larger than a Slack port due to the Card v2 requirement and GCP
auth complexity, but structurally straightforward.

---

## Open Questions

- **Threading model:** Google Chat threads within a Space are identified by a
  `threadKey`. The session store keying (platform + channel ID) maps cleanly,
  but the initial thread-creation reply must include the `threadKey` so
  subsequent messages land in the correct thread.
- **Streaming:** The Chat REST API supports `patch` to update an existing
  message in-place, which would enable the same "edit-in-place" streaming
  effect as Discord's message edits.
- **Workspace domain restriction:** Apps can be restricted to a specific
  Workspace domain — equivalent to Discord's `DISCORD_ALLOWED_USER_IDS`.

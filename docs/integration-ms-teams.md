# Microsoft Teams Integration Plan

## Overview

Microsoft Teams supports bots via the **Azure Bot Framework** and delivers
messages through HTTP webhooks (no persistent WebSocket in the traditional
sense, though a direct-line channel can approximate one). Teams has threads,
channels, and personal chats — all mappable to seam-acp's session model.
The integration is the most complex of the three platforms due to Azure
infrastructure requirements and Adaptive Cards, but roughly 55–65 % of the
codebase is still reusable.

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
| Orchestrator logic | ⚠️ Needs adaptation (commands via message text or app commands) |

---

## Key Differences from Discord

### 1. Azure Bot Framework — HTTP Activity Endpoint

Teams bots receive events as HTTP POST requests to an `/api/messages` endpoint.
The payload is an **Activity** object (Bot Framework schema). There is no
persistent WebSocket connection from the bot's side; instead:

- The bot must expose a publicly-reachable HTTPS URL (or use the Bot Framework
  Direct Line channel tunnelled via `ngrok` / `dev tunnels` for development).
- Every incoming message, command, or card action is a separate HTTP POST.
- Outgoing messages use the Bot Framework REST API (`replyToActivity`).

**Impact:** `TeamsAdapter.start()` launches an Express HTTP server. The
`botbuilder` SDK handles signature verification and Activity parsing.

### 2. Slash Commands → Message-Based or App Commands

Teams does not support freeform slash commands typed in the message box in the
same way Discord does. Options:

- **Message text prefix parsing** (`/seam init`, etc.) — works in personal
  chats and channels; simple but not "official" slash commands.
- **Messaging Extensions** — registered in the Teams App Manifest; appear as
  a command palette triggered by the `…` menu or `/`. These deliver a proper
  command event to the bot but require manifest configuration per command.
- **App Commands (Bot Commands)** — similar to messaging extensions; declared
  in the manifest under `commandLists`.

For an initial port, prefix-based text parsing is the lowest-friction path.
Full Messaging Extension support would be a follow-up.

### 3. `sendChoicePicker` → Adaptive Cards

Teams uses **Adaptive Cards** (a cross-platform card schema) for interactive
UI. A choice picker renders as an `Input.ChoiceSet` element inside an Adaptive
Card. The user's selection triggers an `invoke` activity back to the bot
endpoint.

Adaptive Cards are more verbose than Discord components or Slack Block Kit but
are well-documented and have a schema playground at
`adaptivecards.io`.

### 4. File Uploads → SharePoint / OneDrive

Teams does not support inline binary file attachments in bot messages the way
Discord and Slack do. Options:

- **SharePoint upload**: Upload the file to the team's SharePoint document
  library and post a link. Requires the bot to have `Files.ReadWrite` scope via
  Microsoft Graph.
- **Inline code block**: For small files, paste content as a markdown code
  fence (already done by the fence-emit pipeline).
- **Bot attachment API**: For personal (1:1) chats, Teams does support
  attaching files directly to a bot message via the Connector file attachment
  API, but this is limited to personal scope.

### 5. Threading

Teams supports conversation replies (threads) via `activityId` — replying to a
specific activity threads the response under it. The session store's
`channelId` maps to `conversationId + activityId` (the root activity of a
thread). The adapter must track the root `activityId` per session and pass it
as `replyToId` on all subsequent messages.

### 6. Authentication — Azure App Registration

The bot requires an Azure App Registration with a `MicrosoftAppId` and
`MicrosoftAppPassword` (client secret). These are used by the Bot Framework SDK
to verify incoming request signatures and to acquire tokens for outgoing API
calls.

---

## Architecture Sketch

```
Azure Bot Service
  └── Teams channel → HTTP POST → /api/messages
                                       │
                                       ▼
TeamsAdapter (src/platforms/teams/)
  ├── server.ts           Express HTTP listener + Bot Framework middleware
  ├── adapter.ts          Implements ChatAdapter interface
  │     ├── start()       Starts HTTP server; registers BotFrameworkAdapter
  │     ├── sendMessage() → replyToActivity / sendActivity (REST)
  │     ├── sendChoicePicker() → Adaptive Card with Input.ChoiceSet
  │     └── uploadFile()  → Microsoft Graph (SharePoint) + link post
  └── orchestrator.ts     Thin wrapper or shared with other platforms
```

---

## New Dependencies

| Package | Purpose |
|---|---|
| `botbuilder` | Bot Framework SDK (Activity parsing, adapter, middleware) |
| `botframework-connector` | REST channel connector for outgoing activities |
| `@microsoft/adaptivecards` | Adaptive Card schema builder (optional; can use plain JSON) |
| `@microsoft/microsoft-graph-client` | File upload to SharePoint/OneDrive |
| `express` | HTTP server for `/api/messages` endpoint |

---

## Environment Variables Required

```
TEAMS_APP_ID               # Azure App Registration Application (client) ID
TEAMS_APP_PASSWORD         # Azure App Registration client secret
TEAMS_PORT                 # Port for the HTTP endpoint (default 3002)
TEAMS_ALLOWED_USER_IDS     # Comma-separated Teams user AAD object IDs
TEAMS_ALLOWED_TENANT_ID    # Optional: restrict to a specific Azure AD tenant
```

---

## Teams App Manifest (excerpt)

```json
{
  "manifestVersion": "1.17",
  "id": "<your-bot-app-id>",
  "bots": [{
    "botId": "<your-bot-app-id>",
    "scopes": ["personal", "team", "groupchat"],
    "commandLists": [{
      "scopes": ["personal", "team"],
      "commands": [
        { "title": "init",   "description": "Start a new session" },
        { "title": "repo",   "description": "Set working directory" },
        { "title": "model",  "description": "Switch model" },
        { "title": "agent",  "description": "Switch agent" },
        { "title": "status", "description": "Show session info" }
      ]
    }]
  }]
}
```

---

## Effort Estimate

| Area | Relative effort |
|---|---|
| Express server + Bot Framework middleware | Small |
| `TeamsAdapter` (sendMessage, threading via replyToId) | Medium |
| Adaptive Card choice picker + invoke handler | Medium |
| Azure App Registration + Bot Service setup | Medium |
| SharePoint file upload via Microsoft Graph | Medium |
| App Manifest + Teams app packaging (`.zip`) | Small |
| Text-prefix slash command parsing | Small |

**Overall:** The highest-effort port of the three, primarily due to Azure
infrastructure setup and Adaptive Cards complexity. Functionally complete and
production-grade, but not a weekend project.

---

## Open Questions

- **Proactive messaging:** Teams bots can send proactive messages (not in
  response to a user activity) but this requires storing the `ConversationReference`
  and using `BotFrameworkAdapter.continueConversation`. Useful for the
  notification channel feature (equivalent to `DISCORD_NOTIFICATIONS_CHANNEL_ID`).
- **Tenant restriction:** The `TEAMS_ALLOWED_TENANT_ID` env var can restrict
  the bot to a single Azure AD tenant, which is the recommended security
  posture for internal tooling.
- **Dev tunnels:** Microsoft ships `devtunnel` (replaces `ngrok` for Teams
  development) to forward the local HTTP endpoint during development without
  deploying to Azure.
- **Shared orchestrator refactor:** If Slack is also implemented, this is the
  point where extracting a shared `BaseOrchestrator` pays off clearly — all
  three platforms share the same command dispatch and session lifecycle logic.

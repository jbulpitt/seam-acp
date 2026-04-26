# Slack Integration Plan

## Overview

Slack is the closest structural match to Discord of the three platforms
considered. It supports persistent WebSocket connections (Socket Mode),
first-class slash commands, threads, and inline file uploads. Roughly
70–80 % of the existing codebase is reusable without modification, making
this the lowest-friction port.

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
| Orchestrator logic | ✅ Largely reusable; slash commands map 1:1 |

---

## Key Differences from Discord

### 1. Socket Mode vs Gateway WebSocket

Slack offers **Socket Mode**: a WebSocket connection that delivers all events
(messages, slash commands, interactions) without exposing a public HTTP
endpoint. This is the preferred approach for non-SaaS deployments (e.g. a
self-hosted server like this one).

The alternative is HTTP event subscriptions (similar to Google Chat), but
Socket Mode is simpler for the same deployment model Discord uses today.

**Impact:** `SlackAdapter.start()` opens a Socket Mode WebSocket using
`@slack/socket-mode`. The event loop is nearly identical to the Discord
Gateway loop.

### 2. Slash Commands Map Directly

Slack slash commands (`/seam init`, `/seam repo`, etc.) are registered in the
**App Manifest** (a YAML/JSON file checked into source). When a user runs a
slash command, Slack delivers a `slash_commands` event over Socket Mode with
the command name and arguments — a near-identical structure to Discord's
`INTERACTION_CREATE`.

**Impact:** The orchestrator's slash-command dispatch table maps with minimal
changes. Argument parsing is essentially the same.

### 3. `sendChoicePicker` → Block Kit

Discord renders choice pickers as interactive select menus (component rows).
Slack uses **Block Kit** — a JSON schema for structured messages. A select
menu in Block Kit is a `static_select` element inside an `actions` block.

The adapter's `sendChoicePicker` method posts a Block Kit payload via
`chat.postMessage`. The user's selection delivers an `interactive` / `block_actions`
event; the adapter translates this back into the generic `ChoiceSelected`
event the orchestrator expects.

### 4. File Uploads → `files.uploadV2`

Slack's `files.uploadV2` API uploads a file and can share it directly in a
channel/thread. This is equivalent to Discord's attachment upload and requires
no external storage.

**Impact:** Minimal. The upload helper swaps `FormData` for Slack's upload API;
the rest of the fence-emit pipeline is unchanged.

### 5. Threading

Slack threads are identified by `thread_ts` — the timestamp of the parent
message. The session store's `channelId` field maps naturally to
`channel + thread_ts`. The orchestrator creates a thread on the first reply
(by saving the parent message's `ts`) and threads all subsequent messages.

---

## Architecture Sketch

```
Slack App (App Manifest + Socket Mode enabled)
  │
  ▼
SlackAdapter (src/platforms/slack/)
  ├── adapter.ts          Implements ChatAdapter interface
  │     ├── start()       Opens Socket Mode WS via @slack/socket-mode
  │     ├── sendMessage() → chat.postMessage / chat.update (streaming edit)
  │     ├── sendChoicePicker() → Block Kit static_select
  │     └── uploadFile()  → files.uploadV2
  └── orchestrator.ts     Thin wrapper or shared with Discord
```

---

## New Dependencies

| Package | Purpose |
|---|---|
| `@slack/socket-mode` | Socket Mode WebSocket client |
| `@slack/web-api` | Slack REST API (postMessage, update, upload) |
| `@slack/bolt` | Optional: higher-level app framework (alternative to raw socket-mode) |

> `@slack/bolt` wraps both Socket Mode and HTTP modes and handles request
> verification automatically. It may be the easiest path for a first port.

---

## Environment Variables Required

```
SLACK_BOT_TOKEN          # xoxb-… OAuth token (Bot Token Scopes)
SLACK_APP_TOKEN          # xapp-… App-Level Token (for Socket Mode)
SLACK_ALLOWED_USER_IDS   # Comma-separated Slack user IDs (mirrors Discord equivalent)
SLACK_ALLOWED_CHANNEL_IDS  # Optional: restrict to specific channels/workspaces
```

---

## App Manifest (excerpt)

```yaml
display_information:
  name: Seam
features:
  slash_commands:
    - command: /seam
      description: Seam ACP bot commands
      usage_hint: "init | repo | model | agent | attach | status"
      should_escape: false
oauth_config:
  scopes:
    bot:
      - channels:history
      - channels:read
      - chat:write
      - commands
      - files:write
      - groups:history
      - im:history
      - mpim:history
settings:
  socket_mode_enabled: true
  event_subscriptions:
    bot_events:
      - message.channels
      - message.groups
      - message.im
      - message.mpim
```

---

## Effort Estimate

| Area | Relative effort |
|---|---|
| `SlackAdapter` (Socket Mode + sendMessage) | Small |
| Slash-command dispatch (maps 1:1 with Discord) | Small |
| Block Kit choice picker + selection handler | Medium |
| Thread management (`thread_ts` keying) | Small |
| File upload (`files.uploadV2`) | Small |
| App manifest + Slack app registration | Small |
| Streaming edit-in-place (`chat.update`) | Small |

**Overall:** The smallest effort of the three platforms. The Discord and Slack
models are close enough that the orchestrator could be shared with minimal
platform-specific branching.

---

## Open Questions

- **Shared orchestrator:** It may be worth extracting a
  `src/core/platform-orchestrator.ts` that both `DiscordOrchestrator` and
  `SlackOrchestrator` extend, since the command dispatch logic is nearly
  identical. This refactor pays off most if both platforms are active
  simultaneously.
- **Workspace restriction:** Slack apps are scoped to a single workspace by
  default. Multi-workspace support requires a more complex OAuth flow and is
  out of scope for an initial port.
- **Rate limits:** Slack's Tier 1 rate limit is 1 message/second per channel.
  The existing `sendMessage` batching logic may need a small delay for
  high-throughput turns.

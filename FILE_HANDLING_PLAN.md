# File / Attachment Handling Plan

## Overview

Allow users to attach files (images, text, binaries) to Discord messages and have
them forwarded to the ACP agent as structured content blocks. Allow the agent to
send files back to the user. The ACP protocol already supports both directions via
`ContentBlock` variants — no workarounds needed.

---

## ACP Content Blocks (already in the SDK)

`PromptRequest.prompt` is `Array<ContentBlock>`, where `ContentBlock` is:

| Variant | Type tag | Gate |
|---|---|---|
| Text | `"text"` | Always supported (baseline) |
| Image | `"image"` | `PromptCapabilities.image` |
| Audio | `"audio"` | `PromptCapabilities.audio` |
| Embedded resource | `"resource"` | `PromptCapabilities.embeddedContext` |
| Resource link | `"resource_link"` | Always supported (baseline) |

**Strategy per Discord attachment type:**
- **Image** (`image/*`) → `ImageContent` (base64 `data` + `mimeType`) if capability present; fall back to `ResourceLink` (Discord CDN URL) otherwise.
- **Text-ish** (`text/*`, source code, JSON, CSV, markdown, logs) → `EmbeddedResource` with `TextResourceContents` (inline text) if `embeddedContext` capability present; fall back to `ResourceLink`.
- **Audio** (`audio/*`) → `AudioContent` if `audio` capability present; otherwise reject with a clear user-facing message (Copilot does **not** advertise audio today).
- **Other binary** → `ResourceLink` (Discord CDN URL + filename). Always supported — agent sees the URL and can decide what to do.

### Where capabilities actually live (research correction)

`PromptCapabilities` are returned **once per agent process** on
`InitializeResponse.agentCapabilities.promptCapabilities` — **not** on
`NewSessionResponse` / `LoadSessionResponse`. Capture them in
`AgentRuntime.start()` and reuse for every session that runtime owns. No DB
column needed.

### Live probe of `copilot --acp` v1.0.34

```json
"agentCapabilities": {
  "loadSession": true,
  "promptCapabilities": { "image": true, "audio": false, "embeddedContext": true },
  "mcpCapabilities": { "http": true, "sse": true },
  "sessionCapabilities": { "list": {} }
}
```

So today, against Copilot: images and embedded text resources work; audio does
not. Resource links and plain text always work.

---

## Phase 1 — Inbound: Discord → Agent

### 1. `src/platforms/chat-adapter.ts` — extend `IncomingMessage`

```ts
export interface MessageAttachment {
  url: string;        // Discord CDN URL (stable for the message lifetime)
  filename: string;
  contentType: string | null;
  size: number;
}

export interface IncomingMessage {
  // ... existing fields ...
  attachments?: MessageAttachment[];
}
```

### 2. `src/platforms/discord/adapter.ts` — extract attachments

In `handleMessage`, read `msg.attachments` (a `Collection<string, Attachment>`)
and map to `MessageAttachment[]`.

### 3. `src/agents/agent-runtime.ts` — capture `PromptCapabilities`, extend `prompt()`

**3a.** Currently `connection.initialize(...)` is awaited and the response is
discarded. Capture it instead and store
`response.agentCapabilities?.promptCapabilities` on the runtime instance (one
copy, shared across all sessions on this runtime).

**3b.** Change `prompt(text, attachments?)` signature:

```ts
async prompt(text: string, attachments?: MessageAttachment[]): Promise<PromptOutcome>
```

Build `ContentBlock[]` from text + attachments using a small mapper that:
1. Selects the richest content block the agent supports.
2. Falls back to `ResourceLink` (always supported) when a richer variant isn't
   available.
3. Rejects unsupported audio with a user-facing reason returned in
   `PromptOutcome` (orchestrator surfaces it).

### 4. `src/platforms/discord/orchestrator.ts` — pass attachments through

Pass `msg.attachments` to `runtime.prompt()`. If the runtime returns a
"rejected attachment" reason, post a single human-readable note to the thread
before sending the prompt (or instead of, if that's the only content).

### 5. Guards & limits

| Guard | Default | Why |
|---|---|---|
| Max attachments per message | 8 | Discord caps at 10; leave headroom |
| Max bytes per attachment (downloaded) | 5 MB | Stays well under Discord's free-tier 25 MB and avoids huge base64 payloads |
| Max inlined text bytes | 256 KB | Anything bigger goes as `ResourceLink` |
| Total per-prompt payload | 16 MB base64 | Soft cap to keep ACP requests sane |
| Discord CDN download timeout | 10 s | Don't hang turns on flaky CDN |

Sizes ship as constants in `agent-runtime.ts` (or a sibling `attachments.ts`),
not env vars, until a user asks.

**Phase 1 touch list:**

| File | Change |
|---|---|
| `src/platforms/chat-adapter.ts` | Add `MessageAttachment`, extend `IncomingMessage` |
| `src/platforms/discord/adapter.ts` | Extract `msg.attachments` in `handleMessage` |
| `src/agents/agent-runtime.ts` | Capture `promptCapabilities`, extend `prompt()`, attachment → `ContentBlock` mapper, size guards |
| `src/platforms/discord/orchestrator.ts` | Pass attachments to `prompt()`; surface rejection reasons |
| `test/` | Unit tests for the attachment → `ContentBlock` mapper (capability matrix + fallback behaviour) |

---

## Phase 2 — Outbound: Agent → Discord

Allow the agent to send files back to the user in Discord.

### Background (with research correction)

ACP `session/update` streams `SessionUpdate` events. At the SDK level, the
following can carry non-text content blocks:

- `agent_message_chunk` — wraps a single `ContentBlock` (any variant)
- `tool_call` / `tool_call_update` — `content` is `Array<ToolCallContent>`
  where `ToolCallContent` is one of:
  - `{ type: "content", content: ContentBlock }` ← can be image / resource / etc.
  - `{ type: "diff", ... }`
  - `{ type: "terminal", ... }`

So **the SDK fully supports agents emitting images, audio, and embedded
resources mid-stream or as tool output**. The remaining unknown is whether
Copilot itself ever does. We won't know until we instrument and observe.

### Approach: instrument first, ship second

1. **Instrumentation pass (cheap, ship now alongside Phase 1):** add a debug
   log in `handleSessionUpdate` for every non-`text` `ContentBlock` we see in
   `agent_message_chunk` or `tool_call*.content`. Run normal sessions and see
   whether Copilot ever produces one.
2. **Build the upload path** only once (a) we observe Copilot emitting one of
   these in practice, or (b) a different ACP agent that does (e.g. Claude Code)
   is added.

### Changes Required (when we build it)

**`src/agents/agent-runtime.ts`** — emit a new `AgentEvent` kind:

```ts
| {
    kind: "agent-file";
    filename: string;            // synthesised if the block has none
    mimeType: string;
    data: string;                // base64 for binary, plain text for text resources
    source: "message" | "tool";  // for logging / future routing
  }
```

Detect non-text content blocks in `agent_message_chunk` and the `content`
variant of `tool_call*` and emit this new event. `tool_call_update` currently
ignores `update.content` (line ~376 of `agent-runtime.ts`); that's where the
hook goes.

**`src/platforms/chat-adapter.ts`** — extend `ChatAdapter` interface:

```ts
sendFile?(channel: ChannelRef, file: {
  data: Buffer;
  filename: string;
  mimeType: string;
  description?: string;
}): Promise<MessageRef>;
```

**`src/platforms/discord/adapter.ts`** — implement `sendFile` using discord.js
(`{ files: [{ attachment: buffer, name: filename }] }`). Discord limits:
25 MB on free tier, 10 attachments per message.

**`src/platforms/discord/orchestrator.ts`** — handle the new `agent-file` event
and call `adapter.sendFile()`. Coalesce multiple files within a turn into a
single Discord message when possible.

**Phase 2 touch list:**

| File | Change |
|---|---|
| `src/agents/agent-runtime.ts` | Instrumentation log (Phase 2a); detect + emit `agent-file` events (Phase 2b) |
| `src/platforms/chat-adapter.ts` | Add optional `sendFile` to `ChatAdapter` |
| `src/platforms/discord/adapter.ts` | Implement `sendFile` |
| `src/platforms/discord/orchestrator.ts` | Handle `agent-file` event |
| `test/` | Unit tests for outbound file event handling |

---

## Out of Scope (both phases)

- **Audio in either direction against Copilot** — `PromptCapabilities.audio`
  exists in the SDK, the runtime should support it generically, but Copilot
  does not advertise it. Reject inbound audio politely; don't build outbound
  audio handling until an agent emits it.
- **Persisting attachments across restarts.** Discord CDN URLs expire; we
  don't re-fetch on session resume.
- **Re-uploading inbound attachments back to the agent on resume.** Each
  message's attachments are sent once at prompt time.

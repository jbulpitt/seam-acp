# Codex asynchronous user input

Codex has two different user-input transports. They are not interchangeable:

- `item/tool/requestUserInput` is a blocking app-server JSON-RPC request. `codex-acp` maps it to ACP `elicitation/create`, and Seam returns the form response on that same request.
- `request_user_input_async` returns `{"accepted":true}` immediately. The app server then emits an `agentMessage` item with `delivery:"async"` and structured `questions`. Its answer is a later ordinary user message on the same Codex thread; there is no outstanding request to answer.

## Adapter contract

Seam consumes the reviewed `codex-acp` extension introduced by
[agentclientprotocol/codex-acp#496](https://github.com/agentclientprotocol/codex-acp/pull/496):

```json
{
  "sessionUpdate": "agent_message_chunk",
  "messageId": "<item id>",
  "_meta": {
    "codex": {
      "asyncUserInput": {
        "delivery": "async",
        "threadId": "<Codex thread id>",
        "turnId": "<originating turn id>",
        "itemId": "<same item id>",
        "questions": [
          { "title": "Proceed?", "options": ["Yes", "No"] }
        ]
      }
    }
  }
}
```

The adapter emits this metadata only for the completed async item. When the
same item already streamed text deltas, its completed metadata update has an
empty text block; otherwise it retains the completed item text. This prevents
delta/completion duplication while preserving completed-only messages for
other ACP clients.

Seam requires the exact shape above. Unknown fields, mismatched message/item
ids, controls, duplicate/invalid options, and credential-shaped form fields
are refused. Opaque ACP metadata is never persisted.

## Delivery and recovery

The Discord card is durable and bound to the user, Discord message, Seam
session row, Codex thread, turn, and item. A completed answer is admitted as a
normal durable inbound user turn with the Discord interaction snowflake as its
idempotency key. It waits behind a turn still in progress rather than
interrupting it.

The admission also records the exact originating ACP session. Seam checks that
binding before admission and again immediately before provider execution. A
replacement/reset session therefore cannot receive an old card's answer.
Duplicate, stale, or unauthorized interactions do not create provider turns.

Unanswered async cards remain open across a Seam restart because no blocking
RPC waiter was lost. Answers claimed immediately before a crash retain their
interaction id and values and are re-admitted idempotently on recovery. By
contrast, existing blocking ACP elicitations are still interrupted on restart.

## Deployment prerequisite

Do not patch an installed `codex-acp` bundle. Before enabling this path in
production, install and pin a published `@agentclientprotocol/codex-acp`
release containing upstream PR #496 (or a separately reviewed immutable build
of that exact adapter commit), then verify its version/checksum through the
normal deployment review. The Seam consumer alone cannot recover question
semantics that `codex-acp` 1.10.0 discards before the ACP boundary.

# Native async questions on human and dispatched turns (#347)

Native `request_user_input_async` is an adapter event, not Seam's `create_choice`
tool. A decoded question must reach elicitation routing even when dispatch
streaming and status panels are disabled. An adapter accepting the native tool
call does not prove that a card was posted.

## Responder authority

Exactly **one explicitly recorded human** may answer. On a human turn this is
the authenticated Discord author, as before. MCP `handoff`, `forward`, and
`steer` snapshot that requesting turn's responder into `DispatchSpec.responderUserId`.
A live dispatch can pass its frozen responder to a subsequent MCP dispatch;
the identity is read from the current attempt, not from channel membership.
The field is retained in parsed specs and SQL attempt snapshots across restart.

The model cannot supply this authority as a tool argument. The trusted spool
operator may explicitly record a Discord user id, consistent with the spool's
existing filesystem authorization boundary. This grants permission to answer
that dispatch's questions only, not configuration/admin permissions. The card
appears in the target thread; ordinary Discord visibility still applies.

The dispatch requester is narrower than all origin-thread participants. Inferring
an owner from the target thread, `returnTo`, a bot id, prompt text, or whoever
last spoke there would silently enlarge or change authority. Those alternatives
are not used. Historical ownerless specs and automation that does not snapshot
a responder remain ownerless; they are not retroactively attributed. Such turns
still execute, but questions get a visible `missing_responder` refusal. Start a
new human-requested handoff or have the trusted operator record ownership for
new work; do not replay completed work to supply an owner.

## Refusal contract

`createCodexAsync` returns a discriminated result, never a bare boolean:
`{ok:true,status:"created"|"duplicate"}` or `{ok:false,reason}`. Each refusal
logs `async elicitation refused` with the reason and session-record id, and sends
a text notice to the question's target thread (preserving the existing refusal
card for invalid forms, with the named reason added). Question/answer bodies and raw
transport errors are not logged. If the notice itself fails, the named reason
remains in `async elicitation refusal notice failed`.

- `missing_responder`: no explicit trusted human.
- `invalid_responder`: invalid recorded Discord user id.
- `missing_acp_session`: no originating ACP binding.
- `card_send_unsupported`: no card-post capability.
- `card_edit_unsupported`: no card-update capability.
- `session_mismatch`: question and bound ACP identities disagree.
- `isolated_session`: a disposable worker cannot promise a persistent later answer.
- `invalid_form`: question cannot be represented as a safe supported form.
- `card_post_failed`: posting/updating the initial card failed.

Each refuses **only that question**. The turn, other questions with valid
authority, and other bindings remain usable. An isolated worker is not upgraded
to a persistent session implicitly. Regular ACP request-based elicitation has
its own contract; this change concerns the native Codex async event path.

## Answer timing and identity

Answers are durable, deduplicated, **non-preemptive inbound turns** pinned to the
original ACP id. An answer accepted while work runs is labelled “queued behind
the running turn”; it does not interrupt, steer, or become a synchronous tool
response. After that turn finishes, the answer runs in the same conversation.
An answer accepted when idle is labelled “queued for delivery”. Neither label
claims that the provider has already consumed it.

A changed/replaced conversation rejects the answer rather than creating a new
one. Restart recovery loads the recorded conversation. A model waiting for an
answer must eventually end its current turn: polling its inbox indefinitely
does not allow a queued next turn to run.

## Verification boundary

Non-live tests exercise actual ACP NDJSON transport, AgentRuntime, SessionRouter,
Orchestrator dispatch, SQLite elicitation/inbound records and recording Discord
card sinks. They assert actual prompt session ids and new/load calls, not merely
the intended id. Routing, ownership and silent-refusal mutations must fail.
This does not certify the upstream live provider. Keep the rolled-back adapter
unchanged for this PR; the operator sequences candidate installation and the
fresh-session live canary separately after the Seam fix lands.

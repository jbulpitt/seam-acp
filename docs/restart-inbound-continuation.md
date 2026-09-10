# #250 part 2: durable inbound continuation

Stack: this change depends on #268 (`6465dabef97d1f9ec3c3b83d4db119fcff89e23b`).
It extends its attempt winner to durable human-message admissions. Scheduling
occurrences remain #252; isolated HTTP ingest adoption remains the ingest lane.

## Contract

- `inbound-<message id>` is the stable logical execution identity. The existing
  admission retains text/attachments; its attempt freezes selection identity,
  provider/account scope, ACP binding, owner/generation, and submission phase.
- The prompt-start phase commits before the ACP prompt call. A crash in that
  gap is intentionally ambiguous: never replay the original input. Resume sends
  only `continue`, never old attachments or another transcription request.
- A running legacy admission or existing marker without frozen attempt identity
  is retained. Boot does not reset its phase or consume its only marker.
  Never-started pending admissions still run normally even with auto-resume off.
- Submitted automatic continuation is limited to local Codex, with #268's
  strict ACP, capability, provider/store/account and proven-dead-owner guards.
  A different nonempty thread ACP fails closed before a new claim. Other
  adapters/remote hosts are retained, not represented as certified resumable.
- Original human input is not transparently replayed for transport, missing
  session, or rate-limit errors. A genuine living-attempt failure remains a
  failure; teardown after restart cutoff cannot win terminal completion.
- A captured completion wins against later restart/cancellation. Output recovery
  uses the saved result and original channel, not a provider turn. It does not
  interpret action fences or open agent-named filesystem paths. Long output is
  an in-memory attachment. Deleted/locked/archived/unreachable targets defer.
- Discord send and SQLite acknowledgment are not atomic: the delivery crash gap
  is **at-least-once** and can duplicate already streamed output. This is not an
  exactly-once Discord or external-tool guarantee. A failed send retains output.
- Replacement input commits cancellation in the same transaction as admission.
  Explicit cancel/abandon cannot later revive the old execution. Localized queue
  recovery suspends only that owner's attempt before retiring its runtime and
  continues subject to the same guards; legacy running input is refused.

## Evidence and gates

The pre-change production recovery test admitted and claimed a synthetic human
message, wrote its ACP marker, then called `recoverInterruptedTurns`. It observed
the original prompt re-enqueued and marker consumed. The test now retains both.
`test/restart-inbound-lifecycle.test.ts` runs the actual human-message pipeline
against SQLite and a held synthetic transport (not a mock of the lifecycle).
It covers cutoff, same-ACP continuation, different-thread-ACP refusal, genuine
failure without retry, replacement cancellation, completion-before-delivery,
saved-output recovery, initial-panel failure, and failed completion persistence.

The provider/session-reload and supervisor signal-order gates in
`restart-attempt-ownership.md` still apply. No real provider prompt, historical
session attachment, service restart, deployment, or independent QA was performed.
No #252 cron/drain policy or #253 busy semantics are changed here.

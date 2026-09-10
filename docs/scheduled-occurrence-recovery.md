# #252: scheduled occurrence identity and recovery

Stack: #268 (`6465dabef97d1f9ec3c3b83d4db119fcff89e23b`) → #269
(`2db7e8ded25078f6456fa0015f60db37a7bdd912`) → this change. #253 adds live
attribution separately. This document does not certify real provider reload.

## Durable contract

`scheduled_occurrences` is admission metadata, not another scheduler/queue.
It freezes the schedule snapshot, resolved agent/location/model/effort/cwd and
private execution fingerprint. Its id is the shared `turn_attempts` key.
Both records exist before asynchronous preconditions and runnable publication.
ACP binding and prompt-start commit before prompt submission via #250's lifecycle.

- Cron identities derive from schedule id + the armed scheduled-for timestamp.
  Boot catch-up uses the same persisted due timestamp. Manual runs get distinct
  UUID identities and cannot consume an armed cron slot.
- Pending occurrence recovery is admitted before catch-up. Same-slot repeats
  dedupe; distinct later slots run after the preceding occurrence settles.
  The existing skip-not-stack overlap guard is also durable across suspension.
- A never-submitted occurrence gets its original first prompt. A submitted one
  gets only `continue` with its recorded ACP, not an original-task replay.
  Live mode retains the human-turn streaming pipeline; isolated mode retains
  its separate runtime, authoring-session MCP token and card/message output.
- Only local Codex is eligible for guarded submitted-turn continuation. #250's
  process-owner, provider identity, capability and strict-load guards apply.
  Changed execution identity, unsupported provider/host, missing material or
  unproven old-owner retirement retains the occurrence; no fallback new session.
- Cutoff fences callbacks and prevents failed/completed schedule output. Isolated
  provider material is deleted only after a terminal winner, never suspension.
  Captured outcomes are delivered from SQLite after boot without provider work.
  External delivery is at-least-once across the send/ack crash gap, not an
  exactly-once Discord/external-tool guarantee.
- Disable/delete prevents future cron admission. It **does not cancel an already
  admitted occurrence**, including its frozen snapshot or captured output.
  Intentional cancellation is a durable attempt terminal state and cannot resume.
  New human input replaces the current live schedule, not isolated work or a
  schedule still waiting in the live queue. No `busy` semantics are changed.
- Cron remains open during restart drain, as before. One missed-slot catch-up,
  disabled manual-run behavior and legacy attachment quarantine remain in force.
  This is not a backfill/replay or proof of recovery for pre-linkage historical
  occurrences whose session identity was never recorded.

## Reproduction / acceptance

Baseline #269's actual `runScheduledPrompt` → `runIsolatedScheduledJob` →
`injectTurn` reached a held synthetic ACP prompt with an empty attempt inventory;
teardown also deleted the isolated material. The regression now observes the
occurrence, ACP and submission phase before the held prompt can be released.

`test/restart-scheduled-lifecycle.test.ts` covers live and isolated repeated
cutoffs, same-session continuation, pending-before-prompt, strict-load refusal,
same-slot dedupe, later/manual independence, durable overlap, identity drift,
captured-output recovery, disable/delete versus cancellation, and boot catch-up.
`test/scheduled-manager.test.ts` uses synthetic time to check armed cron keys.
The changed shutdown/quarantine tests retain their runtime assertions; existing
test-double typings were updated so they participate in strict typechecking.

Real provider session reload, store persistence and supervisor signal order
remain the separately approved disposable canary gates in
`restart-attempt-ownership.md`. No historical sessions, real provider prompts,
production schedules, runtime state, service signals or deployment were used.

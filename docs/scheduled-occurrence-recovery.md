# #252: scheduled occurrence identity and recovery

Stack: #268 (`6465dabef97d1f9ec3c3b83d4db119fcff89e23b`) → #269
(`2db7e8ded25078f6456fa0015f60db37a7bdd912`) → this change. #253 adds live
attribution separately. This document does not certify real provider reload.

## Durable contract

`scheduled_occurrences` is admission metadata, not another scheduler/queue.
Admission first commits the exact cron/manual key and schedule snapshot, before
fallible session/config/profile resolution. `execution_json` containing JSON
`null` explicitly denotes unresolved, non-runnable intent (the SQL column remains
NOT NULL; no schema rewrite is needed). Resolution then freezes the effective
agent/location/model/effort/cwd and private fingerprint before manager `onFire`
publication. The occurrence id is the shared `turn_attempts` key; the attempt is
claimed before asynchronous execution preconditions, and ACP binding/prompt-start
commit before submission via #250's lifecycle. A ready snapshot is immutable.

Setup failure before publication retains unresolved intent with an error status;
failure after publication retains the ready snapshot. Both survive restart and
schedule disable/delete. Recovery resolves an unresolved identity only when no
attempt exists; any existing owner with missing identity is retained, not guessed.
No immediate retry loop or failure report-back is emitted for this setup gap.
Cron advances only after committed intent or a deliberate overlap/quarantine
skip. If admission itself cannot commit, the due timestamp remains for recovery.
Direct orchestrator calls use the same admission/prepare primitive, including
local activity-registration failure. This corrects the #271/#275 QA finding:
publishing a key before the first durable insert was not durable admission.

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
  Discord terminal-result creates carry a persisted, enforced nonce. Recovery
  first asks Discord for that nonce, then either records the observed message or
  replays the exact payload with the same nonce; an incomplete history search is
  explicitly abandoned with a durable reason instead of guessed or retried
  forever. This does not claim exactly-once semantics for non-Discord tools.
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

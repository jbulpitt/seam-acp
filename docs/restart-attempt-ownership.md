# Restart attempt ownership — #250 dispatch slice

This fixes the generic programmatic dispatch path; it does not close all of
#250. Human inbound admission/marker linkage is a separate stacked slice.
Isolated HTTP result ownership is coordinated with #246. Scheduled occurrences
and attribution follow in #252 and #253. Compaction, Thread Voice, migration
recovery, remote-slot reconciliation, and AGY continuation are not certified.
No production restart or provider canary was run.

## Contract

`SessionStore.turnAttempts` augments the existing logical dispatch ID, not a
second queue/outbox. Its private row holds the full spec, execution fingerprint,
process owner, generation, ACP binding, submission phase, and completion/routing
plan. Never expose these rows in status output: specs/output may be private.
Credential/environment inputs are hashed, never persisted verbatim.

- Claim, ACP binding and pre-submit phase must persist before a prompt. An
  uncertain crash gap is continuation-only, never permission to replay the brief.
  Never-submitted work still receives its original first execution, loading its
  already-created session when present.
- Completion and suspension compete on the same SQL row. Cancellation may win
  against active/suspended work, not already captured completion.
- `suspendForRestart()` is the final cutoff before runtime/MCP/voice teardown,
  not ordinary drain/admission. Drain may finish work. Cron policy is unchanged.
- `DispatchSuspendedError` means retain the running spec: no failed done file,
  result settlement, onward report, or isolated-history deletion. Obsolete
  callbacks are generation-fenced.
- Completion captures output and onward routing before result callbacks,
  history deletion, report/chain claims, or terminal ledger writes. Startup
  projects SQL-winning output to done files before the existing completion
  reconciler and watcher intake. Existing correlation claims and deterministic
  chain children still own delivery. Captured output never reruns a provider.

## Strict recovery

Initial automatic recovery scope is local Codex. This is source/offline coverage,
not empirical certification of installed-provider context reload. Other
providers, remote slots and legacy ACP-only records without frozen identity are
retained instead of replayed under guessed settings.

Owner identity includes host, kernel boot, PID and start ticks. Reopening SQLite
does not prove its owner died. A recorded local runtime process must also be
gone before replacement. Unknown host/process identity fails closed; Linux
metadata is read without signals. Other operating systems need a separate
ownership implementation.

Suspended recovery requires a present, structurally valid prior owner row, even
for same-boot operator recovery. Missing/null/malformed proof yields the typed
suspension signal without advancing the generation or entering completion.
Cross-boot recovery additionally proves the prior owner dead. Same-boot recovery
still checks any recorded runtime process. Startup retirement skips malformed
owner rows, retaining their work for operator investigation. Tests model an
explicit synthetic PID-reuse boundary while preserving real owner registration;
they do not establish actual provider reload or supervisor stop ordering.

The execution fingerprint covers host/agent/mode/model/effort/cwd, thread/preset
configuration, declared runtime provenance and conservative account/store/config
fingerprints. Provider initialize identity is retained and checked. Credential
refresh/configuration changes can require explicit operator reconciliation.
Never include raw credentials, environments or token URLs in logs.

Strict live acquisition checks thread and cached/in-flight runtime ACP IDs.
A different nonempty thread ID is refused, not overwritten. Cold acquisition
requires advertised session/load and never falls back to newSession after load
failure. Isolated recovery retains history until a terminal winner allows
cleanup. Advertising load support and echoing an ACP ID do not prove underlying
provider continuity.

`InjectTurnOptions.lifecycle` is the integration seam: `isCurrent`, `onRuntime`,
`beforePrompt`, `onOutcome`, `mayDeleteSession`. `onSession` becomes fail-closed
with ownership enabled. HTTP callers must consume typed suspension without
turnEnded, token revocation or replacement of an accepted declared result.

## Offline evidence and commands

The held-dispatch test uses the production orchestrator, SQLite, watcher and
queue files with synthetic transport. Baseline admission-only shutdown emitted
one premature failure report, terminalized the ledger and consumed the marker.
Tests cover both winner orderings, ordinary-error control, same-ID handoff and
genuinely in-flight wake continuation, missing-file projection, cancellation,
owner/PID/identity checks, strict cached/cold acquisition and isolated retention.
These are not independent QA or real provider proof.

```sh
npx vitest run --configLoader runner --exclude test/acp.int.test.ts --maxWorkers 4
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.restart-tests.json
npm run build
git diff --check
```

The excluded test automatically invokes an installed paid provider. Synthetic
HTTP tests require disposable local listeners. The runner config loader avoids
writing Vite's temporary bundle into shared dependencies. Build only isolated
worktree dist, never the running checkout for these tests.

## Remaining live gate and exact approval

Request permission for at most **three new disposable local Codex sessions,
eight short prompts, 4,096 total generated tokens and a $5 spend ceiling**.
Stop at any ceiling; do not start without an enforceable cost ceiling. Use a
scratch cwd and separate synthetic Seam database/dispatch tree. No historical
session, founder prompt, handled job, real endpoint or existing thread.

1. Create a fresh nonce-bearing task demonstrably in flight after durable ACP
   binding/pre-submit persistence.
2. For live and isolated handoffs, persist cutoff and terminate only harness-
   owned processes. Start a new harness owner; load the exact ACP ID; submit
   continuation only. Verify nonce/context, no newSession fallback, original
   logical ID, zero early reports and one final report after work ends.
3. Use the remaining session for intentional cancel: no recovery/onward report.
   Repeated recovery must not rerun completed work. Preserve only redacted IDs,
   phases, timestamps and outcome assertions.
4. After processes settle, delete only harness-created provider sessions and
   named disposable directories. Preserve minimal redacted evidence; disclose
   uncertain cleanup. Never copy credentials into artifacts.

Supervisor stop needs another gate: systemd KillMode=control-group can signal
children before parent cutoff. Application changes alone do not close that
window. Main-first shutdown (KillMode=mixed plus final group KILL, or acknowledged
pre-stop) needs a separately reviewed unit change and disposable-unit test.
This worker does not signal/reconfigure production. Lead owns operational
integration, independent QA, merge and deployment.

There is no exactly-once guarantee for arbitrary external tools or Discord.
The durable winner prevents original-task replay and reuses existing onward
planning within its documented external-delivery crash windows.

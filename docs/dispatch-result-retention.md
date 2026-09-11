# Dispatch result retention (#306)

## Deletion authority

`dispatch/done/` is a delivery-recovery buffer, not a completion index. A
regular, valid artifact expires only when the corrected #305 canonical
`isDoneArtifactDeletable` predicate authorizes it. Retention binds that function
directly; it does not reinterpret ledger status or maintain another delivery
definition.

Positive delivery evidence is a recorded successful transport receipt or an
exactly completed onward child. Failed, timed-out, automatically abandoned,
search-indeterminate, and terminal/no-onward work **remain retained** unless
positive evidence subsequently arrives. A terminal reason is not proof.
Unknown ownership, malformed artifacts, and non-regular entries also remain.

The sole exception for unproven legacy output is #305's separate immutable
`done_artifact_expirations` authorization: exact dispatch id, operator id,
reason, and timestamp. Identical repeat authorization is idempotent; conflicting
authorization is refused. Neither retention, recovery, nor the maintenance CLI
creates authorization rows. This PR adds no bulk authorization or unauthenticated
operator endpoint. Having a backup is not authorization and does not weaken proof.

There is no age threshold for proven or explicitly authorized output, and no
age-based expiration of unresolved output. Deletion preserves SQLite outcomes,
ledger entries, and authorization evidence. Many legacy files have no SQL
outcome; expiring one without proof intentionally destroys a last local full
copy and therefore requires the separate explicit operator decision.

## Runtime and bulk bounds

The post-publication fast path handles an individual already-proven result.
The background sweep starts only after `dispatchWatcher.start()` plus awaited
`admissionReleased()` releases #303's recovery barrier. The existing
`waitForInitialDispatches: false` option returns before that barrier, so an
await on `start()` alone is insufficient. The separate promise avoids waiting
for paid work in `initialDispatchesSettled()`. Later sweeps run once per
minute, single-flight, stream filenames, and yield every 64 entries. Shutdown
stops and drains retention before closing SQLite.

**Bulk expiration needs a destructive-work bound.** Each mutating sweep
unlinks at most **1,000 artifacts**, including operator-authorized legacy
expirations, then returns `limitReached: true`. Later sweeps continue from
remaining files; unresolved prefixes do not consume the unlink budget and
cannot permanently starve later eligible files. This replaces an unbounded
bulk delete with incremental passes. The single-result publication path is
unchanged. A narrow test may lower the cap; zero, non-integer, or values above
1,000 are rejected before any deletion.

This is an **item bound on unlinks**, not a whole-sweep wall-clock or read-count
bound. Scanning an unresolved backlog still requires cooperative enumeration.
A whole-sweep deadline without a resumable cursor would repeatedly stop at the
same retained prefix. No such deadline is claimed. Dry runs count the entire
buffer, without the destructive cap, so the reported eligible count is not a
truncated page. A 5,040-eligible-file synthetic backlog drains in six passes.

SQL completion checks keep pruned work completed across queue recovery and
admission. Legacy files without SQL completion remain recovery authority.
`seam-dispatch --wait` reads the durable SQL outcome if the file disappears
before its next poll. None of these paths re-executes the original task.

## Existing backlog and rollout

Deploy compatible SQL-aware readers and the corrected proof foundation before
enabling retention. Automatic cleanup begins after the admission barrier on
the first compatible boot; no extra operator action is required for **proven**
artifacts. This PR does not authorize deployment or production deletion.

Read-only audit invocation, after building this worktree:

```sh
node scripts/prune-dispatch-done.mjs --data-dir <DATA_DIR> --dry-run
```

The CLI defaults to dry-run and opens SQLite read-only, without migration or
environment loading. Missing legacy proof/authorization tables cannot grant
permission. Its explicit apply mode is only for an independently authorized
operator after compatible deployment; it has the same 1,000-unlink cap.
No apply command is part of this PR's validation.

Summary fields are `scanned`, `pruned`, `retained`, `failed`, `bytes`,
`dryRun`, and `limitReached`. In dry-run, `pruned` and `bytes` mean eligible,
not removed. Bodies and parser snippets are not logged. SQLite, provider
sessions, logs, backups, and pre-existing quarantine have separate retention.

The superseded a578fc6 dry run reported 3,618 eligible / 1,451 retained from
5,069 artifacts. Independent QA later reported 3,634 eligible, only about 666
with positive evidence. Those unsafe counts included lifecycle-only inference
and failed onward children; they are **not** valid cleanup targets. The corrected
PR report records a new command and count, with same-input comparison when
available. A growing spool means historical snapshots must not be conflated.

## Necessity and validation (#307)

- Canonical positive proof: removing it deletes output after failed, timed-out,
  uncertain, or automatic-abandoned delivery; each has a retention regression.
- Completed-child/nonce proof: removing either strands positively delivered
  output; regressions use real SQLite and the shipped no-network nonce lookup.
- Separate immutable authorization: removing it confuses disposition with
  destructive operator consent; idempotence/conflict tests preserve the audit.
- Admission barrier: removing the await lets cleanup race recovery; the test
  holds the real watcher barrier and checks production composition ordering.
- Bulk unlink cap: removing it lets one bulk authorization erase the whole
  backlog in one pass; lower-budget and 5,040-file regressions discriminate.
- SQL completion: removing it permits stale queue markers to replay pruned
  work; both resume modes are covered.
- Post-publication pruning: removing it recreates already-delivered files.
- Periodic sweep: removing it strands later receipts and old eligible files.
- Dry-run separation: removing it makes an audit destructive.
- Exact basename/regular-file checks: removing them permits out-of-buffer
  unlink or loss of malformed evidence.
- Stop/single-flight/drain: removing them overlaps scans or uses a closed DB.
- CLI SQL fallback: removing it turns successful work into a waiting timeout.
- SIGKILL recovery: a real disposable process dies after publication, then a
  fresh process delivers captured output to a recording sink without task replay.
  This tests shipped components, not live Discord/provider delivery.

Explicit gates:

```sh
npm test -- --maxWorkers=2
./node_modules/.bin/tsc --noEmit -p tsconfig.restart-tests.json
./node_modules/.bin/tsc --noEmit -p tsconfig.done-retention-tests.json
./node_modules/.bin/tsc --noEmit -p tsconfig.agy-tests.json
npm run typecheck
npm run build
SEAM_306_COMPILED=1 npm test -- test/dispatch-retention-crash.test.ts --maxWorkers=1
```

#289 makes `npm test` non-live by default and prints its selected file scope.
The live test requires a separate command and opt-in; it is not run here.

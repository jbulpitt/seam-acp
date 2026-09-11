# Dispatch result retention (#306)

## Policy

`dispatch/done/` is a delivery-recovery buffer, not an archive or a completion
index. There is **no age-based grace period** for delivery-resolved results:
their redundant JSON artifacts are removed after publication or by the next
background sweep. The sweep runs on startup in the background, then every
minute. It streams filenames and yields every 64 entries. Resolution reads one
artifact at a time for routing; prompt/output bodies are never logged, and the
lifetime directory scan does not hold startup readiness.

Deletion consumes the delivery resolver's canonical durable decision (#305).
Worker success, a terminal parent ledger row, file age, and an enqueued but
unfinished report-back are not substitute proof. Explicit disposition belongs
to that resolver; retention never invents abandonment or a second delivery
status. Unknown, undelivered, and unresolved legacy artifacts stay in `done/`,
including malformed files. Retention neither executes a provider nor replays
an original prompt. Non-regular entries are retained for operator inspection.

Completed work remains completed after unlink: SQL (`delegation_log` and
terminal dispatch `turn_attempts`) supplies the boolean used by the watcher
and Voice Console. Legacy files without SQL completion remain recovery
authority. Queue leftovers cannot turn a pruned result into a new turn.

Modern durable outcomes remain in `turn_attempts.outcome_json`; delegation and
delivery records remain in SQLite. `seam-dispatch --wait` falls back to that
SQL outcome when its file has already disappeared. **Legacy exception:** a
read-only metadata audit on 2026-09-11 found 5,060 result files but only 182
matching SQL outcomes. The other 4,878 are not promised an SQL output archive.
Pruning a delivery-resolved legacy file can remove its last full local result
copy; that is intentional expiration, not lossless migration. Confirm this
legacy disposition at rollout. Unknown/unresolved files are retained.

This policy does **not remove all copies of prompts/outputs**. SQLite,
provider session storage, logs, backups, and pre-existing `done-quarantine/`
have separate lifetimes and are not silently deleted by this change.

## Existing backlog and rollout

The same resolver-gated sweep handles the measured 5,040-file backlog; it does
not require 30 days of age or repeated service restarts. Unknown or unresolved
rows stay put until #305 establishes delivery or records an explicit terminal
disposition. Repeating cleanup after a crash is harmless: missing files are
already pruned, while surviving files are checked against current proof again.

Deploy the SQL-aware consumers, SQL-capable operator CLI, and #305 delivery
resolver **before** applying cleanup to production. Do not run the new pruner
against an older running watcher: old filesystem-only readers can interpret a
removed file as permission to replay. The implementation PR does not itself
authorize a merge or restart. Production deletion is a rollout step, not an
implicit side effect of tests or a dry run.

After building the integrated #305/#306 head, inspect without writes:

```sh
node scripts/prune-dispatch-done.mjs --data-dir <DATA_DIR> --dry-run
```

After compatible consumers are deployed, the automatic sweep handles the
backlog. An operator may instead explicitly run the same command with `--apply`.
The command opens SQLite read-only and never migrates schema; `--apply` only
unlinks resolver-approved regular files under that data directory's `dispatch/done/`.
It reports counts/bytes, not bodies. `dryRun: true` means `pruned`/`bytes` are
eligible counts, **not files actually removed**. A missing #305 resolver refuses
the operation. No production cleanup is performed by the PR's test commands.

The automatic sweep emits counts (`scanned`, `pruned`, `retained`, `failed`,
`bytes`) without result bodies. In steady state, regular JSON files remaining
in `done/` mean unresolved delivery (or a logged unlink/lookup failure awaiting
retry), not an operator evidence archive. There is no time-based expiry for
unresolved output: that would silently lose work.

## Necessity and non-live checks (#307)

- SQL completion lookup: removing it makes completed queue leftovers runnable
  after pruning; the regression exercises both resume modes.
- Canonical delivery predicate: removing it deletes captured output before its
  destination is established; the regression retains a completed but unacked
  result, then deletes only after the resolver changes its decision.
- Post-publication hook: removing it recreates already-delivered artifacts
  because delivery commonly finishes before the watcher writes `done/`.
- Periodic sweep: removing it strands backlog and parents acknowledged after
  their own result writer has returned; the regression changes proof later.
- Dry-run mode: removing its write separation makes an audit delete records.
- Exact basename and regular-file checks: removing them lets malformed ids
  unlink outside the buffer or silently discard non-file operator evidence.
- Stop flag and single-flight sweep: removing them lets overlapping intervals
  duplicate scans or continue reaching SQLite after shutdown.
- CLI SQL fallback: removing it makes a successful dispatch's `--wait` time out
  if the next poll happens after its artifact was pruned.
- Actual process-death test: a disposable child imports the real watcher,
  attempt store/projection, and done reconciler. SIGKILL lands after durable
  result publication and before delivery. A fresh process recovers output to a
  recording sink, proves one execution, and prunes only after acknowledgement.
  No Discord or provider calls are made; this is not a live delivery certificate.

Focused checks:

```sh
npm run build
SEAM_306_COMPILED=1 ./node_modules/.bin/vitest run \
  test/dispatch-retention-crash.test.ts --exclude test/acp.int.test.ts
./node_modules/.bin/tsc --noEmit -p tsconfig.done-retention-tests.json
./node_modules/.bin/vitest run --exclude test/acp.int.test.ts --maxWorkers=2
```

Without `SEAM_306_COMPILED=1`, the child-process regression imports the same
source components through `tsx`, so the ordinary non-live suite needs no
pre-existing build. Compiled validation must use the freshly built PR head.

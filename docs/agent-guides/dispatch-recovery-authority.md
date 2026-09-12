# Dispatch recovery authority

`turn_attempts` is the authority for admitted dispatches. Recovery must work
without `dispatch/running/`, `dispatch/pending/`, or live-turn marker files.
SQL provides the atomic spec admission, generation, process-owner evidence,
prompt-submission bit, recorded ACP session, and captured outcome needed to
choose a safe next action. A filesystem spec alone cannot supply that evidence.

## Ownership of each question

- `pending/`: external ingress that has not yet been acknowledged. Producers
  keep the existing atomic-file contract and stable dispatch id.
- `turn_attempts`, state `pending`: ingress committed, no execution owner yet.
  Generation zero has no execution identity; the first execution claim freezes
  it using the normal provider/configuration checks. The ingress file is removed
  only after the SQL commit. A failed unlink is a harmless duplicate.
- `turn_attempts`, state `active` or `suspended`: execution and recovery. Only a
  proven-dead process is retired. Runtime recovery applies host/thread/opt-in
  preconditions to SQL inventory. Local queue repair fences the old callbacks
  and authorizes the existing row; it never copies a file back into ingress.
- `turn_attempts`, state `completed` or `cancelled`: terminal execution. Outcome
  delivery and its proof retain their existing SQL contracts.
- `running/`: best-effort compatibility/inspection projection only. No dispatch
  recovery or cancellation path enumerates or reads it. Old files are retained
  as evidence; they cannot authorize work. Projection creation failure is logged
  and cannot prevent execution.
- `done/`: external result contract, derived from SQL for modern executions.
  Legacy results without an attempt row keep their existing completion-reader
  and delivery-proof rules. Removing a delivered result never makes its SQL
  execution runnable. One failed result projection is reported without stopping
  unrelated projection or admission.
- Modern live-turn markers: inspection projections. Boot and operator inventory
  derive inbound/scheduled entries from SQL. Only unlinked legacy/synthetic live
  markers keep their separate contract. Markers carrying inbound/schedule linkage are never
  treated as legacy when their SQL row is missing.

There is no third durable queue: the watcher's in-memory readiness set only
records that this boot's preconditions authorized a suspended SQL row. A new boot
recomputes that permission. A retained error is deferred for the remainder of
the boot, preventing a hot retry loop; shutdown and superseded remain silent,
while a defect retains its specific reason and operator workflow.

Stall evidence is not itself a refusal to continue (#355). Boot and operator
dispatch continuation share admission checks. A stalled, prompted attempt with
a recorded ACP session proceeds automatically through the normal execution
identity, ownership, and strict session/load checks, without a confirmation
notice. A stalled never-prompted attempt or a prompted attempt with no session
remains quarantined; continuation cannot safely be inferred from that evidence.
Real identity/integrity failures still refuse before any prompt, and notices
name the unresolved cause rather than presenting a blind Resume confirmation.
An explicit auto-resume opt-out remains respected at boot.

Only successful fenced reclaim clears `stalledUtc` and its reason/notice fields,
atomically with the new generation. Merely considering recovery does not erase
diagnostic evidence. A changed refusal updates the reason and permits a fresh
notice; repeating the same refusal does not repeatedly notify.

## Disagreement and loss

If ingress or a completion projection disagrees with a nonterminal SQL attempt,
the watcher logs the dispatch id and SQL authority and proceeds using SQL's
spec and phase. It neither quarantines the job for disagreement nor substitutes
the file's prompt/target. A started prompt continues against its recorded ACP
session; the original input is never replayed. Terminal SQL wins over a duplicate
ingress even when the result file has been pruned. Cancellation and generation
fences still decide whether a particular execution owns the work.

Losing projection files does not lose admitted work. Losing `pending/` before
its SQL commit loses unacknowledged input; its producer must resend it. Losing
SQL loses the ownership and prompt-submission evidence for admitted work: a
`running/` file is not sufficient to safely reconstruct it. Recover the database
and provider history or reconcile those specific jobs explicitly; never turn
database loss into automatic original-input replay. Unowned legacy dispatch
files are forensic material, not a second recovery authority.

The ACP-session index already exists from #302 and remains in use. The old
`retainForRecovery` bypass, `recoverStale`, `markStaleInPlace`, and filesystem
requeue/restore paths are removed. `observeRetainedDispatch` remains for genuine
classified defects, and `hasCompleted`/`isDispatchCompleted` remain completion
readers for SQL outcomes and legacy result consumers, not filesystem recovery
workarounds.

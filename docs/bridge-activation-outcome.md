# Activation outcome reporting (#370)

An activation-command failure is an operation result, not evidence that the
requested release failed to become active. The local CLI now makes one bounded,
read-only `runPreflight` observation after an activation error. That existing
reader uses the remote `readLiveIdentity` and `validateRelease` evidence; it
does not acquire/recover a target lock, swap an entrypoint, signal a process,
retry activation, or roll back.

The requested SHA/checksum are compared to the validated managed-release
identity, the same release identity behind `requested_release_already_active`.
A changed entrypoint alone is insufficient: the observed bound PID must differ
from the initial PID, or the initial observation must already identify the
requested release (an interrupted earlier run may have activated it).

- `activation=active_post_step_failed`, `release_active=yes`: name the failed
  step and recommend inspecting it, not retrying activation. Emit **no**
  `rollback_command`. This observation does not claim receipt verification.
- `activation=not_activated`, `release_active=no`: the currently observed
  release does not match. Recommend fixing the failed step and retrying.
  The explicitly requested negative regression retains the version-bound
  recovery command, but labels it `rollback_applicability=not_needed_before_swap`
  rather than recommending it. No recovery action is automatic.
- `activation=failed_or_incomplete`, `release_active=unknown`: the read failed,
  or a swapped link lacks replacement-process evidence. Preserve both the
  original failure and any observation error; require inspection before
  considering recovery. Do not manufacture either success or non-activation.

Lock errors additionally report `coordination=lock_blocked` and
`lock_note=concurrency_refusal_not_activation_evidence`. The same lock error
can accompany an active release or an unchanged baseline. Reporting does not
remove a stale lock or infer that it is safe to steal one.

All failure outcomes retain exit code 1 for automation. Successful activation
output is unchanged and triggers no extra observation. The existing #328
remote deployed-but-unconfirmed receipt reporting remains intact.

## Mutation evidence

Only injected command runners and synthetic reports in
`test/bridge-rollout.test.ts` were used. No real rollout phase ran, and the
unmanaged-host guard stays independent of the live fleet configuration.

Each mutation ran with this prefix and the selector below:

```sh
npx vitest run test/bridge-rollout.test.ts --maxWorkers=2
```

- Force `active=false`; `-t 'reports ACTIVE'`: **2 failed, 26 skipped**.
  Active outcomes became `failed_or_incomplete` and acquired rollback advice.
- Remove failure-path rollback; `-t 'retains failure and optional rollback'`:
  **1 failed, 27 skipped**. Expected the version-bound command, got undefined.
- Remove lock-specific reporting; `-t 'stale-lock retry'`: **1 failed,
  27 skipped**. The expected concurrency fields disappeared.
- Remove recognition of an initially active release; `-t 'stale-lock retry'`:
  **1 failed, 27 skipped**. An already-active interrupted run became unknown.
- Treat a matching link as enough; `-t 'swapped link alone'`: **3 failed,
  25 skipped**. Unchanged, missing, and invalid PIDs falsely reported active.
- Replace the failure reason with `unknown_failure`; `-t 'reports ACTIVE'`:
  **2 failed, 26 skipped**. Receipt and lock failure names were lost.
- Reuse the initial observation instead of re-reading; `-t 'reports ACTIVE'`:
  **2 failed, 26 skipped**. Expected two injected commands, received one.
- Ignore checksum; `-t 'requires the exact checksum'`: **1 failed, 27 skipped**.
  Wrong artifact with the same source SHA falsely reported active.

All eight runs exited 1 at the matching assertion. **8 killed; 0 survivors.**
Every mutation was restored before final verification. The unmutated targeted
invocation `npx vitest run test/bridge-rollout.test.ts --maxWorkers=2` passed
all **28 tests**.

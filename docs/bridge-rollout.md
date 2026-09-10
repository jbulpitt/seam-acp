# Remote bridge rollout runbook

This is the reviewed update mechanism for receipt-capable, PM2-managed Seam
bridges. It ships an exact committed artifact without remote Git, drains only
with `SIGUSR2`, proves the replacement on its exact controller connection, and
keeps rollback explicit and version-bound. It never restarts the controller.

A bare invocation is read-only. Every mutation requires `--apply`, one exact
target, and one phase. There is no host loop, implicit rollback, PM2 restart or
reload fallback, environment dump, provider authentication, or provider catalog
parsing.

## Fixed deployment identities

[`ops/bridge/targets.json`](../ops/bridge/targets.json) is the only target map.
For each enabled bridge it pins the bridge ID, SSH alias, PM2 app, verification
agent, UID, checkout/cwd, stable PM2 entrypoint, exact PID file, Node executable,
PM2 module, optional workspace argument, and rollout root. None is overridable
on the command line.

- `media-server` maps to SSH `media-server`, PM2 `remote-agent-bridge`, UID 501,
  checkout `/Users/jesse/seam-acp`, and rollout root
  `/Users/jesse/.seam/bridge-rollouts`.
- `macbook-air` maps to SSH `macbook-air`, PM2 `seam-bridge`, UID 501, checkout
  `/Users/jessebulpitt/.seam/seam-acp`, and rollout root
  `/Users/jessebulpitt/.seam/bridge-rollouts`.
- Three AGY-only hosts retain SSH aliases but deliberately have no rollout
  identity and remain disabled. `macbook-pro` is explicitly unmanaged: the
  previously recorded `home-hub` alias reaches a simultaneously connected,
  distinct `home-hub` bridge, and no verified SSH management path for
  `macbook-pro` is known. Every rollout phase therefore refuses that target.
  Do not restore an alias until a read-only preflight proves that the remote
  process reports `bridge_id=macbook-pro`.

Before any mutation, the remote program requires one PM2 record and proves that
its PID equals the exact owned PID file; the process is alive, owned by the
configured UID, running the exact Node executable, and has the exact checkout
cwd; PM2 names the exact stable entrypoint, interpreter, bridge ID, and expected
workspace argument; and all configured paths and owners are canonical. PM2
arguments must match a supported bridge grammar. Secret argument values are
compared in memory and never printed. Ambiguity, symlink escape, wrong owner,
unexpected flags, or any mismatch refuses the phase.

An SSH alias is not identity evidence by itself. The preflight response must
report the same bridge ID as the selected inventory key; a response such as
`bridge_id=home-hub` for target `macbook-pro` refuses before build, upload,
staging, signaling, or activation.

## State machine

### 1. PREFLIGHT (read-only)

```bash
npm run bridge:rollout -- --target media-server
npm run bridge:rollout -- --target macbook-air
```

This performs only the identity proof above and reports `remote_mutation=no`.
It fails closed unless it can read and report the deployed platform,
checkout or managed-release source SHA, managed artifact checksum when present,
entrypoint SHA-256, bridge package version, protocol version 1, configured Node
and adjacent npm versions, available bytes on the rollout filesystem,
`SIGUSR2` drain handler, and both `describeModelCatalog` and `fetchModelCatalog`
RPC capabilities from the exact resolved deployment tree. Capability values are
reported as `yes` or `no`, with their conjunction in `rollout_ready`; this keeps
an old bridge inspectable while ACTIVATE and ROLLBACK refuse unless readiness is
`yes`. STAGE remains available because it does not change the running process.
Legacy checkout identity is read directly from Git metadata without invoking
remote Git; a
managed release is fully revalidated before its receipt is reported. Run the
preflight separately for each host. The canary remains `media-server`; observe
and obtain separate authorization before doing anything to `macbook-air`.

### 1a. ENROLL (legacy → managed baseline)

```bash
npm run bridge:rollout -- --target media-server --enroll --apply
```

Every remote bridge is an unmanaged legacy checkout, and ACTIVATE refuses from
that state because it cannot prove a version-bound rollback. Enrollment is the
entrance to the safe path: it records a baseline, and nothing else.

It proves the same deployment identity every other phase does, then captures —
from live state — the checkout revision (read from Git metadata, never by
invoking remote Git), a digest of the **whole declared runtime scope**, the
entrypoint's own bytes and mode, the PM2 identity (app, cwd, exec path,
interpreter, argv), and the runtime (Node path and version, platform, UID).
Anything unreadable fails closed: a baseline that cannot be restored to is worse
than none, because it looks like one. The capture is then re-taken and compared,
and enrollment refuses `enrollment_live_state_drift` if the host moved while it
was being read.

The runtime scope is `packages/adapters/dist`, `packages/bridge/dist`,
`node_modules`, and the package manifests, recorded in the baseline itself. It
is deliberately a whole-tree digest rather than a walk of the entrypoint's
import graph: closure tracking is more precise, but its failure mode is silent —
a dynamic `import()`, a bare specifier resolved through conditional exports, a
`require` inside a dependency or a native addon the walker does not model is
simply absent, and an absent file is exactly the defect this guards against.
Hashing everything in scope can only over-capture, which fails loudly. The
stable entrypoint is excluded from that digest because during managed operation
it is a symlink into a release; its bytes are held and verified separately as
the preserved baseline copy.

Symlinks are followed and their targets hashed, not recorded as link text. A
reference recorded only by name is a hole: the bytes it resolves to are what the
process loads, so a dependency linked out of `node_modules` could drift while
the link text stayed identical. Refusing escaping links instead is not an
option — a real checkout's `node_modules` contains workspace links
(`@seam/adapters`, `@seam/bridge`, `@seam/core` resolve into `packages/`) and
`.bin` shims that link across packages, so that rule would refuse every real
host. Following is bounded rather than trusted: targets are canonicalized
first, a target already hashed is referenced instead of re-hashed (which also
terminates cycles), targets outside the checkout are recorded in the baseline as
`runtimeExternalRoots` so the inclusion is explicit, and the file/byte limits
apply to the whole traversal. A link pointing at the stable entrypoint (the
`.bin` launcher shims do) is recorded as such rather than followed, so the
digest does not change merely because the host is currently activated. Special
files are refused outright; a hardlink is an ordinary file and its content is
hashed.

The traversal ceiling charges **every entry** — regular file, directory,
symlink, duplicate/cycle reference, and absent scope root — because each costs
an `lstat`, a sort position and a digest line. Charging regular files alone left
a symlink- or reference-heavy tree free to walk past the advertised limit. The
byte bound is separate and bounds content, so work that carries no bytes (an
empty file, a directory, a reference) is bounded by the entry ceiling instead of
escaping both. Measured on this checkout with links followed: 16,421 entries
(14,396 files, 1,969 directories, 28 symlinks, 28 references) and 247.06 MiB,
against the 120,000-entry / 1-GiB bounds. A declared scope root that does not
exist — a host whose bridge has not been built yet — is recorded as absent
rather than skipped, so its later appearance is drift.

Enrollment preserves the one artifact a later activation would replace — the
stable entrypoint file — inside the baseline directory, verified against its
recorded hash. That is what makes the baseline a restore target rather than a
description of one.

`--restore-baseline --enrollment-id <64-hex>` **verifies before it changes
anything**: the recorded revision and every recorded non-entrypoint runtime file
must still match. Only then does it put the preserved bytes back at the exact
path and mode, re-prove the result, and withdraw the enrollment pointer; the
immutable record and preserved copy remain for audit. If the surrounding tree
drifted, restore refuses and leaves both the current entrypoint and the
enrollment pointer exactly as it found them. Restoring only the entrypoint onto
a drifted checkout would report success while leaving the host to start a
combination that never existed, so it is not treated as a restore at all.

Enrollment **does not alter or signal the runnable deployment**: no entrypoint
switch, no install, no signal other than `kill(pid, 0)` for liveness. It is not
a filesystem no-op — it creates and chmods rollout metadata under the release
root and takes and releases the target lock — but the running process and the
bytes it would run after any restart are untouched, so enrollment can never
silently upgrade a host. Activation stays a separate, later, explicitly invoked
phase.

Re-running is idempotent in durable state: an unchanged host re-reports its
existing baseline and every recorded artifact stays byte-identical. The rerun
does still take and release the target lock and re-apply 0700 to the metadata
directories. A host whose runtime tree changed since enrollment refuses with
`enrollment_baseline_drift` rather than overwriting the evidence, and a pointer
with no record behind it refuses with `enrollment_record_missing`.

PREFLIGHT reports `enrolled` (`yes`, `no`, or `drifted`), the enrollment ID, the
baseline digest, and `baseline_receipt_capable`. `drifted` is re-derived from
live state, never trusted from the file.

A target that is explicitly unmanaged (`sshAlias: null` with an
`unmanagedReason`, #282) is refused before any command is constructed, for
enrollment exactly as for every other phase: recording a baseline for a host
with no verified management path would produce a rollback target nobody could
restore to.

**Enrollment is not permission to activate.** A rollback onto bytes that cannot
emit the nonce/PID/instance/two-RPC receipt still cannot be proven, so ACTIVATE
continues to refuse for every legacy host — now naming the actual situation,
both in the remote program and in the local capability gate that runs first:
`legacy_previous_release_not_receipt_capable` when nothing is enrolled,
`enrolled_baseline_state_drift` when the recorded baseline no longer matches the
host, `enrolled_baseline_not_receipt_capable` when the recorded baseline could
not emit that receipt, and `enrolled_baseline_activation_not_enabled` when it
could — consuming an enrolled baseline as an activation's previous release is a
separate reviewed change, not something enrollment grants itself.

The baseline record is `formatVersion: 1`, `kind: "enrolled-baseline"`. Version 1
hardwires PM2, a Node runtime, a JavaScript checkout entrypoint and this exact
runtime scope. A host that does not fit that shape — native artifacts, a
different process manager — needs a genuinely separate version-2 capture and
restore path, not extra fields bolted onto version 1.

Enrollment changes nothing about drain semantics and makes no claim about
mid-turn safety. `SIGUSR2` still exits after ten seconds without output or a
five-minute hard limit, and silence is still not proof that a provider turn
reached a terminal event, so a host must not be activated mid-turn.

### 2. PREPARE + UPLOAD + STAGE

```bash
npm run bridge:rollout -- --target media-server --stage --apply
```

The local side refuses a dirty worktree, resolves `git rev-parse HEAD`, builds
only adapters and bridge, creates a deterministic USTAR/gzip artifact, and
records every member's path, size, and SHA-256 in its manifest. The upload uses
an operation-random temporary name. No remote Git command runs.

After re-proving identity, PREPARE creates only the allowlisted rollout
directories with mode 0700 and checks their canonical paths and owners. STAGE
holds the target's exclusive lock while it consumes the upload. Before writing
any archive member it checks the compressed/expanded/member/count limits and
every tar header. Absolute, traversing, empty, ambiguous, control-bearing,
duplicate, prefix-conflicting, unexpected, linked, device, FIFO, and other
special members are refused.

Extraction writes regular files one by one with exclusive create into a fresh
private `.stage-*` directory. The manifest, all file hashes, package names, and
lockfile workspace identities are checked again. `npm ci` receives a minimal
secret-free environment and the committed lockfile. Links produced by npm are
materialized only when their canonical targets remain inside the stage; links
and special files are forbidden in the final release. A full-tree digest and
random stage ID are placed in `release-receipt.json`, after which the directory
is atomically published as `releases/<sha>-<archive-checksum>`.

An existing release is never trusted by pathname or one state file. Reuse walks
the entire tree, rechecks types, owners, exact top-level/package layout, source
manifest hashes, stage receipt, and whole-tree digest. Interrupted/failed stage
directories remain versioned under `failed-staging/` for audit.

STAGE prints an exact activation command containing SHA, artifact checksum, and
stage ID. Do not substitute a branch, tag, or different stage ID.

### 3. ACTIVATE + VERIFY

Use the exact command printed by STAGE. Shape:

```bash
npm run bridge:rollout -- --target media-server --activate \
  --sha 0123456789abcdef0123456789abcdef01234567 \
  --checksum 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --stage-id 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --apply
```

ACTIVATE first proves the active deployment, lock roots, current managed release,
and requested release, then takes the target lock and proves them again. It
writes an immutable activation intent and a fresh random activation envelope
bound to target, app, source SHA, checksum, stage ID, old PID, start time, and
deadline. It atomically switches only the stable entrypoint and sends only
`SIGUSR2` to the proven old PID.

Within the bounded timeout, success requires positive observation that the old
PID exited; a distinct, owned PID appeared in the exact PID file; PM2 still maps
that PID to the exact app/interpreter/cwd/stable entrypoint/argv; the stable
entrypoint resolves to the requested release; and that process presents the
exact activation nonce and PID in its hello. The controller must accept that
exact bridge ID and instance, call `describeModelCatalog` and `fetchModelCatalog`
successfully on that same connection, and echo the nonce, bridge ID, instance ID,
and PID, plus the exact source SHA and artifact checksum it received from that
connection. The bridge rejects an acknowledgement whose artifact identity does
not exactly equal its activation envelope. It writes the ordered, in-window
receipt. Only then is an
immutable `.verified.json` activation record written. The activation ID and its
exact rollback command are printed before signaling so they remain available if
verification later fails. Once the replacement PID and entrypoint are proven, an
immutable `.observed.json` is also written; it permits an explicit rollback of a
replacement whose catalog/receipt verification timed out without guessing a PID.

A stale/shared receipt, different process, different connection, missing RPC,
old PID still alive, or timeout cannot satisfy the gate. The runner also bounds
wall time and stdout/stderr bytes, kills and awaits an over-limit subprocess,
cleans listeners/timers, and returns symbolic/redacted diagnostics.

### 4. ROLLBACK (explicit, never fleet-wide)

Use only the exact activation ID printed by the failed canary activation:

```bash
npm run bridge:rollout -- --target media-server --rollback \
  --activation-id 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --apply
```

ROLLBACK takes the same target lock and selects that activation's immutable
verified, observed, or pre-switch intent record, in that order. It refuses
unless the stable entrypoint still resolves to the exact failed SHA/checksum
release and the current PM2 identity is consistent with that record. For an
intent-only interruption, the original PID may still be live; if a different
PID appeared before observation, its exact activation envelope and receipt PID
must bind it to the same failed activation. The current failed release, its
activation envelope, and the exact previous release receipt/tree are fully
revalidated before any switch. ROLLBACK then writes an immutable rollback
intent, atomically restores the exact previous entrypoint, and sends only
`SIGUSR2` to the currently proven PID. It applies the same old-exit/new-PID/PM2/
entrypoint/fresh-handshake/two-RPC proof to the previous SHA, checksum, stage ID,
and a new rollback nonce. Success produces an immutable versioned rollback
outcome; mutable target-only state is never used.

## Locks and recovery boundaries

One atomic lock directory per target spans each STAGE/reuse, ACTIVATE, or
ROLLBACK transaction. A live owner or a lock younger than 15 minutes refuses
with `target_lock_busy`. A dead lock older than 15 minutes is atomically moved to
`stale-locks/` with its operation ID and timestamp before retry; malformed or
racing lock state refuses. Never delete a lock by hand while its owner is live.

- Failure before the entrypoint switch: the active process is untouched. Inspect
  the symbolic refusal and immutable stage/intent records; retry only after the
  cause is understood.
- Failure after the switch or `SIGUSR2`: there is no automatic rollback. Use the
  exact activation ID. Rollback itself refuses if live state drifted.
- An activation with `.observed.json` but no verified outcome may be rolled back
  explicitly by its printed activation ID; rollback first requires that exact
  observed PID and release still be active. If interruption occurred after the
  stable pointer switch but before `.observed.json`, the immutable intent is the
  recovery boundary: rollback requires the pointer at the exact intended failed
  release, the exact activation envelope, the fully valid failed and previous
  release trees, and either the unchanged recorded old PID or a receipt-bound
  replacement PID. If the pointer never switched, drifted elsewhere, or any
  identity is ambiguous, rollback refuses. No record permits guessing.
- Legacy code cannot emit a nonce/PID/instance/two-RPC rollback receipt. Therefore
  ACTIVATE fails closed until the host has been explicitly enrolled with a
  reviewed receipt-capable managed baseline, and still refuses when the enrolled
  baseline is not itself receipt-capable. Enrollment (§1a) establishes and
  preserves that baseline; it does not weaken rollback proof, and it does not
  authorize activation.
- Never replace a refusal with `pm2 restart`, `pm2 reload`, a provider login, or
  an environment/PM2 dump. Emergency/manual recovery is outside this automated
  transaction and requires a separate operator plan.

No command in this runbook deploys to both hosts. Independent QA is required for
every exact PR head before any production use.

# Remote bridge rollout runbook

This runbook is the only supported update path for PM2-managed Seam bridges.
It stages committed artifacts without remote Git, drains with `SIGUSR2`, verifies
the replacement through the bridge/controller protocol, and retains an explicit
previous-good rollback. It does not apply to the systemd-managed Seam controller.

Actual host mutation is a separate operator decision. A bare command is always a
read-only preflight. Every mutating phase requires both one exact target and
`--apply`; there is no all-host mode.

## Operator-owned targets

[`ops/bridge/targets.json`](../ops/bridge/targets.json) is the reviewed source of
truth. Callers cannot override SSH aliases, PM2 app names, or the verification
agent from the command line.

- `media-server`: SSH `media-server`, PM2 `remote-agent-bridge`, verification agent `grok`
- `macbook-air`: SSH `macbook-air`, PM2 `seam-bridge`, verification agent `grok`
- `jennifer-laptop`: SSH `macbook-air-j`, rollout disabled
- `macbook-pro`: SSH `home-hub`, rollout disabled
- `alaina-laptop`: SSH `laptop-alaina`, rollout disabled
- `allie-laptop`: SSH `laptop-allie`, rollout disabled

The disabled hosts currently advertise AGY only. Their SSH identities are recorded
without guessing a PM2 app identity; AGY rollout remains outside issue #241.
Names are restricted to lowercase letters, digits, dot, underscore, and hyphen.
Unknown targets, mapping fields, command-line overrides, and shell metacharacters
are rejected before SSH runs.

## Read-only preflight and dry run

Run exactly one of:

```bash
npm run bridge:rollout -- --target media-server
npm run bridge:rollout -- --target macbook-air
```

The preflight streams a fixed checked-in shell program over SSH. It reports SSH
reachability, platform details, Node and npm versions, available disk, the
allowlisted PM2 app and live PID, the process working directory, deployed Git SHA
or release SHA/checksum, bridge package/protocol versions, `SIGUSR2` support, and
whether the installed bridge contains both catalog RPC method names.

It reads PM2's app-specific PID file and the process cwd. It never reads process
arguments, environment variables, pairing files, credentials, or provider state,
and never invokes secret-bearing PM2 inspection commands.

## Stage one exact committed artifact

Staging is remote mutation but does not activate or signal the bridge:

```bash
npm run bridge:rollout -- --target media-server --stage --apply
```

The command refuses any tracked or untracked source change, records `git rev-parse
HEAD`, builds only `@seam/adapters` and `@seam/bridge`, and packages their emitted
code with the committed workspace manifests and lockfile. It uploads a tarball to
`~/.seam/bridge-rollouts/incoming/`, verifies its SHA-256 on the host, and expands
it into a new `releases/<source-sha>-<archive-checksum>/` directory. It never uses
remote Git and never writes into the active artifact.

The remote host then runs the lockfile-bound command below inside that versioned
release:

```bash
npm ci --omit=dev --workspace=@seam/adapters --workspace=@seam/bridge --no-audit --no-fund
```

Assumptions: the host has Node 22 or newer with its matching npm, can reach the npm
registry, and can use an audited prebuilt dependency or local compiler toolchain
for any dependency install script. The committed lockfile fixes package versions
and integrity; the archive checksum fixes the shipped Seam code. Dependency or
checksum failure leaves the active process untouched and preserves the failed
staging directory for audit rather than recursively deleting it.

On success, the tool prints the exact `--activate --sha ... --checksum ... --apply`
command. Copy that command; do not substitute a branch or moving tag.

## Graceful activation and verification

Example shape (use the exact values printed by staging):

```bash
npm run bridge:rollout -- --target media-server --activate \
  --sha 0123456789abcdef0123456789abcdef01234567 \
  --checksum 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --apply
```

Before signaling anything, activation rechecks the staged archive checksum,
retains the current entrypoint as previous-good, and writes a mode-0600 state file
containing the old/new targets and exact rollback command. It atomically switches
the PM2 entrypoint pathname to the versioned release, then sends only `SIGUSR2` to
the validated live PID. The old process drains active slots and exits; PM2 follows
the new symlink on its normal restart. There is no immediate restart or reload
fallback.

Success requires all of the following before the bounded timeout (420 seconds by
default, configurable from 10 through 900):

- PM2's allowlisted app records a live PID different from the old PID.
- The new process writes a receipt for the exact committed SHA and archive checksum.
- The controller accepts a fresh protocol-version handshake from that PID.
- The controller directly and successfully calls both `describeModelCatalog` and
  `fetchModelCatalog` on the new bridge for the mapped verification agent.
- The bridge records the controller's acknowledgement after both RPC replies arrive.

The receipt records only release/protocol identifiers and timestamps. It contains
no catalog payload, provider parsing, model prompt, token, or environment data.

Canary order is `media-server` first, then `macbook-air`, with an observation and
independent authorization between hosts. Never stage or activate both as a loop.

## Failure containment and rollback

Any checksum, PID, handshake, or RPC failure stops the rollout. The tool does not
automatically roll back and does not remove a release recursively. Inspect the
reported state and obtain explicit rollback authorization before running the exact
recorded command, for example:

```bash
npm run bridge:rollout -- --target media-server --rollback --apply
```

Rollback validates that the recorded previous-good entry is either a managed
versioned release or the preserved legacy bridge entrypoint, atomically restores
that target, sends `SIGUSR2` to drain, and bounds the wait for a different live
PID. A first rollback to a legacy artifact can prove the replacement PID but cannot
produce the new release receipt; confirm the bridge is connected before further
work. Never replace this with an immediate PM2 restart.

The installer remains a bootstrap/pairing tool, not an updater. Do not authenticate
or modify any provider CLI as part of this runbook. Provider-specific catalog
correctness belongs to issues #231–#234, and production rollout remains gated by
#236 and independent QA of each exact PR head.

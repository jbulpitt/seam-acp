# Native AGY runtime identity and upgrades

Native Seam `agy` is the primary implementation. The separately named
`agy-package` profile remains optional. Both use the same managed AGY CLI
artifact, but native `agy` exposes a virtual ACP server in-process and therefore
must advertise that topology rather than inventing an ACP executable.

## Managed runtime layout

`AGY_RUNTIME_ROOT` is an absolute, real (non-symlink) directory outside the
location managed by Google's background updater. The configured executable is:

```text
<AGY_RUNTIME_ROOT>/<AGY_SHA256>/agy
```

(`agy.exe` on Windows.) The root, digest directory, and executable must not be
writable by the Seam service user. On macOS, every ancestor of the runtime root
through `/` must also be non-writable by that user because the native binary is
executed by name. The refusal names the first writable component so an operator
can migrate that one AGY binding without taking the host's other adapters down.
The executable must be a regular, non-symlink file.

For the first use of an artifact digest in a process, Seam reads the candidate
into a fresh mode-0700 private directory, writes a mode-0500 snapshot, opens it
read-only, hashes the bytes from that descriptor, and unlinks the snapshot
before any child can run. A bounded cache retains that anonymous master
descriptor by digest. Each launch first revalidates the configured artifact
identity, then opens the master descriptor through the platform fd namespace to
obtain an independent file description. Concurrent children therefore cannot
share or advance one another's offset.

The bounded `--version` probe and real child both receive the launch duplicate
as fd 3. Linux executes `/proc/self/fd/3`, so the verified inode is the executed
inode and pathname ancestry is defense in depth. macOS cannot execute its
code-signed native binary through `/dev/fd/3`; it uses the verified immutable
path instead, after proving the complete ancestor chain cannot be renamed by
the service user. Unsupported launch platforms fail closed.

## macOS ancestor-immutability rollout (#332)

Do not deploy the ancestor check hot onto the existing `$HOME/.seam` staging.
`$HOME` and `$HOME/.seam` are service-user writable, so the check correctly
refuses those AGY bindings. Removing three recently restored Mac bindings at
once would turn a precise provenance refusal into a fleet capability outage.

Stage the migration before enforcement:

1. Inventory each Mac's active five-value runtime tuple and retain its audited
   rollback record.
2. As an operator, create `/opt/seam/agy-runtime` with `/`, `/opt`, `/opt/seam`,
   and the runtime root owned by `root` and not writable by the service user.
3. Copy the already-verified executable to
   `/opt/seam/agy-runtime/<AGY_SHA256>/agy`; make the digest directory and
   executable root-owned and non-writable by the service user.
4. Recompute the digest and exact version from the staged file, then update
   `AGY_RUNTIME_ROOT`, `AGY_CLI_PATH`, `AGY_BIN`, `AGY_VERSION`, and
   `AGY_SHA256` together through the audited host rollout path.
5. Validate one host at a time. Only after every Mac is compliant should the
   enforcement commit deploy fleet-wide.

A bypass flag is not recommended: while disabled it would advertise verified
provenance for a path that remains replaceable. The safe staging boundary is
operational sequencing, not a weaker attestation. If a host is missed, #330's
adapter-isolated admission refuses AGY with the named writable ancestor while
the host's other adapters keep serving; operators must ensure an AGY-only host
has a working alternative before rollout.

The descriptor cache holds at most four digests and closes an evicted master;
prepared launches keep independent duplicates and are unaffected by eviction.
The normal deployment has one configured digest, so it pins one 192.5 MiB
unlinked inode for the process lifetime. The measured ~500 ms copy, 192.5 MiB
write, and ~385 MiB peak RSS occur once per admitted digest instead of on every
turn, catalog probe, and quota probe. The separate 32-entry evidence cache may
skip a repeat version probe only after current path identity revalidation. No
cache entry turns a pathname into launch authority.

`AGY_VERSION` is the exact bounded first line of `agy --version`, and
`AGY_SHA256` is the exact artifact digest. They are one release identity. A
digest-only edit merely gets past the hash gate and then fails the version gate;
a version-only edit fails the hash gate. Both pins and `AGY_CLI_PATH`/`AGY_BIN`
must move together to the newly staged content-addressed artifact.

## Deliberate upgrade boundary

Staging and installing host artifacts remains an operator/deployment concern
(R9, issue #265); Seam does not download or promote a runtime. Before changing
the active tuple, the operator must independently verify the official archive,
copy the exact executable to the digest directory with non-writable ownership
and permissions, and verify its exact version output. Then update these values
as one reviewed change:

- `AGY_RUNTIME_ROOT`
- `AGY_CLI_PATH` and, when `agy-package` is enabled, identical `AGY_BIN`
- `AGY_VERSION`
- `AGY_SHA256`

Do not point any of them at `~/.local/bin/agy`, a package runner, a symlink, or
another updater-controlled path.

## Launch and environment contract

One native runtime supplies the verified descriptor, arguments, workspace cwd,
semantic credential scope, and environment for catalog discovery, quota,
normal turns, and native helpers. Runtime identity includes executable,
version, digest, credential scope, and a digest of the allowlisted environment,
so
another executable or account scope cannot reuse its cached evidence.

Only the portable process keys `HOME`, `USERPROFILE`, `PATH`, temporary-directory
keys, locale keys, timezone, and required Windows process keys are inherited.
An embedding caller may explicitly approve additional non-secret keys;
credential-shaped key names are refused. Environment values are never included
in bridge inventory or runtime provenance. Inventory carries only an opaque
launch-identity digest, topology, cwd policy, approved environment key names,
and artifact source/version/digest. Per-session MCP configuration still
uses a private mode-0700 HOME with a mode-0600 MCP file, while the authenticated
Antigravity configuration remains linked from the real Gemini home.

## Audit and provenance

Host runtime pins remain outside `config_propose`: allowing a conversation to
change executable identity would combine proposal authority with code-execution
authority. Instead, once the exact tuple has passed construction-time artifact
verification, local startup appends a `runtime-provenance` row to the existing
immutable `config_audit` ledger. A bridge hello does the same for its location.
The row records the opaque launch-identity digest, topology, cwd policy,
artifact source/version/digest, and approved environment key names. It records
no executable path, cwd, managed root, credential scope, environment
fingerprint, or environment value. Bridge hello validates that reduced shape
before accepting or persisting it.

This gives pin changes a durable before/after chronology without treating bare
environment edits as sanctioned conversational mutations. Artifact staging,
promotion, and rollback remain R9 work.

## Pre-deployment migration for the current 1.2.0 host

This is a prerequisite, not an action performed by R2. Run it from the checkout
in the deployment window before starting a build containing this contract. It
stages the already validated installed bytes under a root-owned
content-addressed location and keeps a complete `.env` rollback copy without
printing it:

```bash
set -euo pipefail
agy_source=/home/ubuntu/.local/bin/agy
agy_root=/opt/seam/agy-runtime
agy_version=1.2.0
agy_sha=77dc197a05ca2a47d143ad135a4679b28ef85976cfd268569233d2f3d08ce999
agy_release="$agy_root/$agy_sha"
agy_target="$agy_release/agy"
env_backup=".env.pre-agy-r2.$(date -u +%Y%m%dT%H%M%SZ)"

test "$(sha256sum "$agy_source" | awk '{print $1}')" = "$agy_sha"
test "$($agy_source --version | head -n 1)" = "$agy_version"
sudo install -d -o root -g root -m 0755 /opt/seam "$agy_root" "$agy_release"
sudo install -o root -g root -m 0555 "$agy_source" "$agy_target"
test "$(sha256sum "$agy_target" | awk '{print $1}')" = "$agy_sha"
test "$($agy_target --version | head -n 1)" = "$agy_version"
cp -p .env "$env_backup"
printf 'Exact rollback: cp -p %q .env && npm run redeploy\n' "$env_backup"
env_next="$(mktemp .env.agy-r2.XXXXXX)"
awk -v root="$agy_root" -v bin="$agy_target" -v version="$agy_version" -v sha="$agy_sha" '
BEGIN { value["AGY_RUNTIME_ROOT"]=root; value["AGY_CLI_PATH"]=bin; value["AGY_BIN"]=bin; value["AGY_VERSION"]=version; value["AGY_SHA256"]=sha }
{ key=$0; sub(/=.*/, "", key); if (key in value) { print key "=" value[key]; seen[key]=1 } else print }
END { for (key in value) if (!(key in seen)) print key "=" value[key] }
' .env > "$env_next"
chmod --reference=.env "$env_next"
mv "$env_next" .env
npm run typecheck
npm run build
```

If validation or service admission fails, restore all five pins together by
restoring the complete pre-migration environment, then use the normal
drain-style deployment path; do not partially edit individual pins:

```bash
set -euo pipefail
env_backup="${env_backup:-$(find . -maxdepth 1 -type f -name '.env.pre-agy-r2.*' -printf '%T@ %f\n' | sort -nr | sed -n '1s/^[^ ]* //p')}"
test -n "${env_backup:-}"
test -f "$env_backup"
cp -p "$env_backup" .env
npm run redeploy
```

The staged root may remain for inspection; it is inactive after rollback. R2
deliberately keeps this host mutation outside conversational `config_propose`.
The accepted reduced runtime identity is recorded by the immutable runtime
provenance audit at startup; artifact promotion/rollback automation remains R9.

## Deliberate exclusions

This contract does not change native catalog extraction (R4, #260), bound and
redact AGY's existing language-server subprocesses (R5, #261), change MCP or
helper routing (R8, #264), or deploy/runtime-promote artifacts (R9, #265). It
does not alter R0's identity restoration ledger or pending next-turn rebuilds.

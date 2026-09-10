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
writable by the Seam service user. The executable must be a regular,
non-symlink file. This makes an updater replacing `~/.local/bin/agy` irrelevant
to an admitted Seam runtime.

Every launch hashes the managed executable before it can execute. A bounded
cache is keyed by device, inode, size, modification time, and change time, so a
replacement invalidates the cached verification. Only after the digest matches
does Seam run the bounded `--version` verification. A changed binary therefore
cannot run even as a version probe.

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

One native resolver supplies the executable, arguments, workspace cwd,
semantic credential scope, and environment for catalog discovery, quota,
normal turns, and native helpers. Runtime identity includes executable,
version, digest, credential scope, and a digest of the allowlisted environment,
so
another executable or account scope cannot reuse its cached evidence.

Only the portable process keys `HOME`, `USERPROFILE`, `PATH`, temporary-directory
keys, locale keys, timezone, and required Windows process keys are inherited.
An embedding caller may explicitly approve additional non-secret keys;
credential-shaped key names are refused. Environment values are never included
in bridge inventory or runtime provenance; only their names and a one-way tuple
fingerprint travel. Per-session MCP configuration still
uses a private mode-0700 HOME with a mode-0600 MCP file, while the authenticated
Antigravity configuration remains linked from the real Gemini home.

## Audit and provenance

Host runtime pins remain outside `config_propose`: allowing a conversation to
change executable identity would combine proposal authority with code-execution
authority. Instead, once the exact tuple has passed construction-time artifact
verification, local startup appends a `runtime-provenance` row to the existing
immutable `config_audit` ledger. A bridge hello does the same for its location.
The row records the exact executable, managed root, topology, version, digest,
credential scope, and environment key names, but no environment values.

This gives pin changes a durable before/after chronology without treating bare
environment edits as sanctioned conversational mutations. Artifact staging,
promotion, and rollback remain R9 work.

## Deliberate exclusions

This contract does not change native catalog extraction (R4, #260), bound and
redact AGY's existing language-server subprocesses (R5, #261), change MCP or
helper routing (R8, #264), or deploy/runtime-promote artifacts (R9, #265). It
does not alter R0's identity restoration ledger or pending next-turn rebuilds.

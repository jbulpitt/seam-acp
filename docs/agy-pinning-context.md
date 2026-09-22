# Why we pin agy — handoff context

*Prepared 2026-09-21. Sources: issues #415, #414, #371, #266, #256; `docs/agy-upgrade-gate.md`; live host inspection.*

---

## Short version

Two independent incidents forced it, and they justify two different halves of the design:

1. **Agent CLIs silently self-update out from under a pin** — so the binary must live somewhere the agent's user cannot write.
2. **A binary with valid identity can still be unable to serve Seam** — so a digest check alone is not sufficient evidence to upgrade.

---

## Reason 1 — self-update defeats version control (#415, 2026-09-14)

During the #414 repin on `plex-server`:

- A linux-x64 **1.1.27** build was downloaded to `/tmp` and verified: sha256 `93eb2118…`, 210,551,040 bytes, `--version` reporting 1.1.27.
- By the time it was copied into staging, the file on disk had become **1.2.3** — different size (215,384,320), different digest (`c4c8a672…`), different reported version.
- **Executing it from a writable path was enough for it to replace itself with the newest release.** A post-copy digest check caught it before anything was pinned.

The same night, hours apart, **grok did the same thing** on this server: a symlink repointed to a verified-good 1.0.25 (because 1.0.30 SIGILLs on Neoverse-N1 — upstream `xai-org/plugin-marketplace#700`) was undone within about six minutes.

**This is one failure mode, not two incidents.**

### Still observable today

`allie-laptop` has `agy.1788809746068476000.old` dated **Aug 20** sitting beside an `agy` dated **Sep 7**, in a user-writable `~/.local/bin`. That host self-updated with nobody asking it to. The receipt is still on disk.

---

## Reason 2 — valid identity is not working software (#371, macbook-pro)

AGY **1.2.2** had:

- a valid digest
- immutable provenance
- a working `--version`

…and its language server still rejected `StreamAgentStateUpdates` as **unauthenticated**, because the new CSRF token was only available to its IDE sidecar.

> Identity checks described the binary correctly; they did not prove it could serve Seam.

This is why the upgrade gate (#266, under native-AGY tracker #256) requires **two independent kinds of evidence** before pins move:

1. The prompt-free `agy --log-file <temp> models` check — proves this exact binary starts its language server and enumerates models.
2. A sanitized report from a separately approved **canary** — proves the real Seam turn contract: stream subscription, thinking, MCP, usage, structured output, session continuity, complete cleanup.

The gate runs inside `applyAgyStaging`, before the five AGY pins move.

---

## How the pin works

- Binary at `/opt/seam/agy-runtime/<sha256>/agy` — **root-owned, mode `r-xr-xr-x`, content-addressed**.
- The agent's user physically cannot overwrite it, so self-update **fails** instead of succeeding silently.
- Configured by `AGY_RUNTIME_ROOT`, `AGY_SHA256`, `AGY_VERSION` (plus `AGY_CLI_PATH`).
- `agyManagedExecutablePath(runtimeRoot, sha256)` builds the path *from the digest*, and the runtime re-hashes at spawn:

  > `AGY executable sha256 does not match the configured immutable artifact`

### No version allowlist

The gate binds evidence to the **exact candidate version and digest**. The labels 1.1.27, 1.1.28 and 1.2.0 are retained as known-good regression shapes and 1.2.2 as the known-bad incident shape — **none is runtime policy**.

---

## Two points worth stressing

**The root-owned read-only path is what defeats self-update. The sha check is defence in depth.**
You could pin effectively by making *any* install location root-owned and non-writable. The content-addressed directory additionally buys provenance (which exact build is running) and lets versions coexist for rollback.

**Pinning and authentication are orthogonal.**
Root-owning the *binary* is write protection. *Whose credentials* it reads is determined by the spawning uid and that user's `HOME`. Pinning does not require authenticating as root, and authenticating as root does not achieve pinning — it would break things, since the bridge runs as `ubuntu` / `jessebulpitt` / `mediaserver` and those users cannot read `/root`.

---

## Current fleet state (2026-09-21)

- Hosts with the managed artifact: agy under `/opt/seam/agy-runtime/<sha>/` — e.g. `rhc-server` at `77dc197a…`, v1.2.0, root:root, `r-xr-xr-x`.
- `jennifer-laptop` stages agy under `~/.seam/agy-runtime` instead of `/opt/seam`, has no passwordless sudo, and runs an Aug 21 bridge that does not read the pins at all (#388). It is the one host that can reach **zero agents**, so a careless update takes it dark.
- `allie-laptop` / `alaina-laptop` run agy from user-writable `~/.local/bin` — unpinned, and demonstrably self-updating.

## Related issues

- **#415** — CLIs self-update from writable paths and undo pins (the pattern)
- **#414** — plex-server on agy 1.2.2 degrading every turn to stdout-only
- **#371** — the macbook-pro 1.2.2 incident (valid identity, broken service)
- **#266 / #256** — the upgrade compatibility gate and the native AGY tracker
- **#388** — jennifer-laptop cannot be pinned or safely updated

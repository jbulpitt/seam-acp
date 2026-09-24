# Slash command tree (`/seam` + `/seamadmin`)

Moved from `AGENTS.md`. Read this before adding or changing a slash command or option.


Discord caps a **single** application command at 8,000 characters — the sum of
every name, description and choice value in the tree — and at 25 top-level
options. Blowing either makes Discord reject registration of the **entire
command at boot**, not just the new option. `/seam` reached 7,885/8,000, which
is why #150 could only add `role-name` by deleting help text.

The budget is **per command**, so #151 split the tree in two. Hard cutover —
Discord has no aliases; old invocations simply disappear.

## `/seam` — everyday user + agent surface (8 slots)

**Top-level (5):** `cancel`, `steer`, `new`, `workflows`, `queue`

**Groups (3):**
- `config` (18): `model` `effort` `agent` `role` `mode` `repo` `tools` `card`
  `gif` `approve` `reset` `init` `detach` `tts` `show` `edit` `set` `audit`
  - `role` sets a thread's naming role. `rename` / `namer` are **no longer
    here** — they live under `/seamadmin naming`.
  - `edit` is the visual configuration surface (#157): `/seam new` with no
    config arguments and `/seam config init` both post this card instead of
    running a setup wizard. `/seam new` may instead take the same JSON or named
    fields as `config set` and creates the thread already configured (#294).
    There is no host selector on it — an agent id is `agentId@location`, so
    the **Agent** picker binds the host too and Host is shown read-only (#156).
    To pre-bind a host that is currently offline (it lists no agents), use
    `/seam config agent id:<agentId>@<host>`.
- `info` (6): `whoami` `usage` `avatar` `help` `sessions` `repos`
- `preset` (7): `list` `create` `apply` `delete` `show` `edit` `thread`

## `/seamadmin` — operator surface (12 slots)

Registered with `default_member_permissions = ManageGuild` and
`contexts = [Guild]` (via `setContexts`, not the deprecated `setDMPermission`),
so it does not appear in the command picker for non-admins and is unavailable
in DMs.

That permission is **visibility, not authorization** — a guild admin can grant
the command to anyone, so every runtime refusal stays exactly where it was:
`SEAM_CONFIG_ADMIN_USER_IDS` for `upload` / `rebuild` / `compact-thread` / `naming`, plus
`BRIDGE_ADMIN_REFUSAL` and `THREAD_VOICE_ADMIN_REFUSAL`.

**Top-level (3):** `rebuild` `compact-thread` `recover`

`/seamadmin rebuild` is deterministic Discord reconstruction (no summarizer; one destination seed turn that may consume up to 60% of the destination context window). `/seamadmin compact-thread` is the former model-assisted rebuild. `Premium Compact (Discord)` remains the AGY fan-out pipeline. `/seam config reset` starts a blank session with no history.

**Groups (9):**
- `catalog` (1): `refresh` — refresh one `agent@location` catalog or all
  catalogs. Reads remain cache-only; the durable response reports generation,
  source/provenance, diff, scope, and any retained/quarantined failure.
- `restrictions` (3): `set` `list` `clear` — immediate, audited per-agent
  Discord-channel allowlists. An absent rule allows existing routing unchanged.
- `schedule` (5): `add` `list` `remove` `toggle` `edit` — **no attachments**
  (#158). A scheduled prompt carries no files on any surface; when a job needs
  substantial instructions, commit a runbook and make the prompt a short request
  to follow it. A pre-#158 row that still records files is **quarantined** (never
  armed, never fired); editing the schedule clears that record and re-arms it.
  Stored bytes under `data/scheduled-attachments/` are never deleted by Seam.
- `project` (3): `new` `list` `remove`
- `upload` (3): `pull` `push` `secret`
- `bridge` (6), `debug` (6) — pairing / host config / safe restart / debug (`voice-ping` /
  `voice-capture` / `voice-live` are the live-help spike)
- `voice` (7): `start` `add` `remove` `configure` `console` `status` `stop` —
  Shared Voice Console V2
- `naming` (2): `rename` `namer` — lifted out of `config` by #151. `rename`
  refreshes/migrates thread names (`migrate-legacy:true` for old hand-typed
  prefixes, `role-name:true` to rebuild from the role); `namer` edits the
  agent/model/role symbol tables. **Do not hand-rename a thread to fix its
  prefix** — set the identity and the name follows.

**Moved by #151:** `/seam rebuild|schedule|project|upload|bridge|debug|voice`
→ `/seamadmin …`, and `/seam config rename|namer` → `/seamadmin naming …`.

**Queue:** `/seam queue prompt:…` parks the next live turn (does not abort).
Idle + host ready runs now. A later bare message still interrupts and
cancels the queued prompt. Shares the `#88` parked row.

**Cancel options** (not new keywords):
- `/seam cancel` — this thread, graceful
- `/seam cancel force:true` — this thread, escalate (old `abort`)
- `/seam cancel scope:all` — kill every active session bot-wide (old `kill`). Privileged: **not** lock-exempt, **not** participant-allowed.

**Removed:** `/seam image`.


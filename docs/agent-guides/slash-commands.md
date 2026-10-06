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

Every leaf in `commands.ts` declares read-only or mutating access. Participant
and channel-lock gates apply to mutations, with explicit local-turn exceptions;
admin-only handlers still require a listed Discord user id. Prompt stamping
(`SPEAKER_IDENTITY_ENABLED`) does not authorize slash commands. Option-dependent
leaves resolve access before dispatch (for example, workflow cancellation and
`cancel scope:all`). Editors and pickers are mutating surfaces.

Every leaf also declares an acknowledgement mode: `ephemeral` (the default),
`public`, or `modal` for a form shown as the first response. Dispatch defers
before handler work, including plugin preparation. Handlers use
`replyToInteraction` (plugin invocations use `reply`) to fill the deferred reply
and report the actual result or underlying error; do not add handler-local
defers. Autocomplete keeps its separate three-second response budget.

### Channel defaults and thread overrides

`agent`, `model`, `effort`, `repo`, `role`, `card`, `gif`, `set` and `edit`
offer `scope:thread` (this thread) and `scope:channel` (channel default).
In a parent channel they always target that channel's defaults, not its category,
and do not create a session. Session JSON, permissions and rebuild are not
channel-default settings. Resolution is the router's existing thread override →
channel default → global default, with provenance shown in the editor and replies.

Agent/model/effort pickers offer **Use channel default**. `inherit` clears a
named thread override; bulk `effort:default`, `role:auto`, `card:default` and
`gif:default` do the same. Clearing also removes its legacy session mirror.
Channel-default edits report counts of overrides on bound threads. Existing
overrides remain untouched unless the user confirms **Use channel defaults**;
that action clears only the edited fields and transitions at the next acquisition.

`/seamadmin config-cleanup` is an explicit dry-run of misfiled parent session
rows and `threads` entries. It lists their guild/channel, fields to move,
existing channel fields to preserve and override counts. **Leave unchanged**
does nothing; **Confirm: apply this preview** moves only missing channel fields
and removes the listed misfiled rows/entries, with an audit before-image.
A changed preview requires a new confirmation. Re-running after cleanup reports
zero affected rows. Nothing runs at boot, and ordinary thread overrides are
never removed by cleanup.

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

**Workflows:** `/seam workflows` acknowledges before reading the inventory or
cancelling an item. The default inventory is this thread, newest first;
`scope:all` explicitly selects the admin all-threads view. Resume is offered
only for a recorded continuation that passes the existing admission checks.
Completed output can be abandoned, not rerun; consumed records remain visible
as history with no action available.
The bare command opens one category picker with counts for parked turns,
wakes, watches, choices, ingests, live help and schedules. Parked controls carry
their attempt's short id (and age for Resume); **Categories** returns to the
picker. Existing `cancel-*` options still act directly.
`resume:<id>` autocompletes this thread's currently resumable parked turns.
Parked notices carry durable Resume/Abandon choices bound to the attempt id;
the click repeats the inventory's admission checks. Authentication notices use
their existing **Authentication is done — continue** route plus Abandon, not a
second generic Resume button.
Inert history older than seven days is hidden by default, not deleted;
`history:true` includes it. Actionable parked work remains visible at any age.
Admins can explicitly clear old parked work and retained output with
`abandon-older-than:7` (a positive whole number of days). It defaults to this
thread; add `scope:all` for all threads. Records stay in the database, and the
reply reports how many were abandoned and any real failures.

**Cancel options** (not new keywords):
- `/seam cancel` — this thread, graceful
- `/seam cancel force:true` — this thread, escalate (old `abort`)
- `/seam cancel scope:all` — kill every active session bot-wide (old `kill`). Privileged: **not** lock-exempt, **not** participant-allowed.

**Removed:** `/seam image`.

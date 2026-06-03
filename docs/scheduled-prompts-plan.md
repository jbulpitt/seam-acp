# Scheduled prompts — build plan

**Status:** draft / proposal
**Purpose:** let a user create one or more **cron-style scheduled prompts** tied to
a Discord thread. When one fires, a card announces it, the prompt runs as a
**self-contained job in its own isolated session**, and the output is posted back
to the thread as cards. Each job runs with no memory of prior conversation, so it
must carry its own instructions + context (text and/or attached files).

---

## 1. Locked decisions (from design discussion)

1. **Self-contained jobs (B), not pinned sessions.** Each fire runs fresh. No
   session pinning, no drift guard. Matches the "cron job" mental model, far
   simpler, and avoids the context-bloat / many-image / forced-compaction problems
   a long-lived pinned session would accumulate. (An optional `--pin` mode is a
   *future* add, not v1.)
2. **Bound to the thread id (`channelRef`), never the `acpSessionId`.**
   `SessionRecord.id = "discord:${channelRef}"` is immutable; `acpSessionId`
   mutates on reset/attach/agent-switch. Keying on `channelRef` survives all of
   them.
3. **Isolated execution + captured output (NOT injection into the live session).**
   A fire runs in its **own throwaway session** (the thread's repo + configured
   model, fresh conversation), and the output is **posted to the thread as cards**,
   not streamed into the live conversation. Consequence: the job is fully
   independent of any in-flight user turn — **the concurrency problem disappears**
   (no "polite enqueue", no aborting the user's turn). Streaming is not needed.
4. **Runtime lifecycle checks, not stored archive/lock state.** At fire time:
   deleted thread → drop the schedule; **locked** thread → skip (record why);
   merely archived → run (the announce card auto-reopens it). Only *locked* or
   *deleted* auto-stops a schedule. Manual pause is an explicit `enabled` toggle.
5. **Files via slash attachment options → an ephemeral builder card.** No
   message-window capture (the `/seam image` flow we want to avoid). Bytes are
   downloaded and **persisted locally**, then re-attached every run (Discord URLs
   expire ~24h).
6. **Catch-up window for missed fires.** Per-schedule `catchup_seconds` (default
   **900** / 15 min, `0` = never). On boot/re-arm, if a fire was missed but within
   the window, run it **once**; otherwise roll forward. Never burst-fire multiple
   missed windows.
7. **Cron shown in plain English via `cronstrue`** everywhere (cards, list). The
   builder offers a **picker** for common cadences and a **Custom** raw-cron box
   for everything the picker can't express, with a live English echo to confirm.

---

## 2. Execution model (reuses already-shipped code)

A fire does **not** construct a synthetic user message or touch the per-channel
turn queue. It reuses the **`makeCompactionRunAgent` pattern** built for premium
compaction (`orchestrator.ts`): spawn a throwaway `AgentRuntime`, run one prompt,
collect the reply, tear down.

```
runScheduled(row):
  rt = new AgentRuntime({ profile, … })
  rt.start()
  rt.newSession({ cwd: row.repoPath ?? REPOS_ROOT,
                  model: cfg.model, effort: cfg.effort })   // thread's config
  collect:  agent-text  → output buffer
            agent-file  → forward to the thread (reuse sendFile)
  rt.prompt(row.prompt_text, <attachments rehydrated from stored bytes>)
  rt.dispose();  manager.deleteSession(cwd, tempSessionId)   // don't clutter /seam sessions
```

- **Model/cwd:** the thread's configured model + effort and `repoPath`, so the job
  runs with the capabilities the user set up, against the live repo files.
- **Output → blue cards.** Buffered `agent-text` is chunked into **embed
  descriptions at ~3,500–4,000 chars** (limits: content 2000, embed desc 4096,
  whole embed 6000, ≤10 embeds/msg ≤6000 combined), colored the "cron blue", each
  headed `⏰ Scheduled: <name>`. If output is large (≳3 cards / ~12k chars): post a
  short summary card + the **full output as a `.txt`/`.md` attachment** — reusing
  the renderer's existing inline-vs-attachment logic. Files the agent produced are
  posted too.
- **Announce + result card.** At fire, post a blue **"⏰ Running '<name>'…"** card;
  edit it to the result on completion, or to an error card on failure.
- **Independent of user turns.** Because it's a separate session/runtime, cards
  just post to the thread whenever the job finishes — they interleave harmlessly
  with anything the user is doing, disambiguated by color + header.
- **Diverges from `durable-jobs-plan.md`** (which *does* re-enter the live session
  with a resume prompt). They no longer share a seam — no `injectBridgeTurn`
  needed for this feature.
- **Caution surfaced at creation:** a job that *writes* to the repo runs
  independently of your live session, so write-jobs in a repo you're actively
  editing can collide. Fine for read/report jobs; be deliberate with write jobs.

---

## 3. Data model

### `scheduled_prompts` table (add to `session-store.ts` SCHEMA — single
`CREATE TABLE IF NOT EXISTS`, no migration system needed)

| column | type | notes |
|---|---|---|
| `id` | TEXT PK | uuid |
| `platform` | TEXT | "discord" |
| `channel_ref` | TEXT | **thread id — the binding anchor** |
| `parent_ref` | TEXT | parent channel id (for fetch/auto-reopen) |
| `name` | TEXT | friendly label |
| `prompt_text` | TEXT | the self-contained instruction |
| `cron` | TEXT | cron expression |
| `timezone` | TEXT | IANA tz (e.g. America/Chicago) |
| `catchup_seconds` | INTEGER | missed-fire window; default 900, 0 = never |
| `enabled` | INTEGER | 0/1 — the manual pause flag |
| `attachments_json` | TEXT | manifest `[{filename, mime, size}]` |
| `created_by` | TEXT | creator user id (auth stamp) |
| `created_utc` / `updated_utc` | TEXT | ISO |
| `last_run_utc` | TEXT | last fire time |
| `last_status` | TEXT | `ok` / `skipped: locked` / `error: …` |
| `next_run_utc` | TEXT | computed, for display + catch-up check |
| `pinned_session_id` | TEXT NULL | reserved for future A-mode; null in v1 |

Index on `(platform, channel_ref)` and on `enabled` (rehydration).

### Attachment storage
- `data/scheduled-attachments/<id>/<filename>` — bytes downloaded at **Create**
  time (URL still valid within the builder session). Manifest mirrored in
  `attachments_json`. Cleaned up on schedule delete and on thread-delete.

---

## 4. Components

### `src/core/scheduled-prompts/` (new)
- **`types.ts`** — `ScheduledPrompt` row type, `FireDecision`.
- **`manager.ts` — `ScheduledPromptManager`:**
  - `start()` — load `enabled` rows, arm one `croner` job each (cron + tz); run the
    **catch-up** pass (fire once if `next_run_utc` is in the past but within
    `catchup_seconds`, then roll forward; `0` or past-window → roll forward only;
    at most one catch-up per schedule).
  - `arm` / `disarm` / `reschedule` — on create/edit/delete/toggle.
  - on tick → `onFire(row)` (injected callback; orchestrator supplies the runner).
  - `nextRun(row)` for display; persist `next_run_utc`.
  - `stop()` — clear all jobs (from shutdown).
  - Timers are in-memory, **rehydrated from the DB on boot**.

### Dependencies
- **`croner`** — tiny, zero-dep cron with timezone + DST + prev/next-run.
- **`cronstrue`** — cron → English for cards/list and the Custom-cron live echo.

### Lifecycle wiring (`src/index.ts`)
- Instantiate after store/router/orchestrator; `manager.start()` after Discord is
  connected; `manager.stop()` in `shutdown()` (next to `stopSentinelWatcher`).

---

## 5. Fire-time decision flow (`onFire(row)` in the orchestrator)

```
1. Resolve thread by channel_ref.
   └─ not found (404) ........ delete row + attachment dir → done
2. thread.locked? ............ last_status = "skipped: locked" → done (can't post)
3. Post blue "⏰ Running '<name>'…" card  (also auto-reopens an archived thread).
4. Run isolated job (§2): own session, thread's repo + model, attachments.
5. Post output as blue cards (chunked; overflow → file); forward any agent files.
6. last_run_utc = now; last_status = ok | error: <msg>; edit the run card to result.
```

No queue/abort logic and no reaction to archive/unlock events — it's all decided
here. (Optional `Events.ThreadDelete` handler gives *instant* cleanup; the
fire-time 404 is the lazy fallback if the bot was offline for the delete.)

---

## 6. UX

### Command home
`/seam schedule …` as a **subcommand group** (21 subcommands today → 22/25, fits).

- `add` — options: `cron?`, `timezone?`, `file?`, `file2?`, `file3?` (all optional,
  incl. 3 attachment slots). Kicking it off with *just files* (or nothing) is fine
  — the rest is set on the card.
- `list` · `remove <id>` · `toggle <id>` · `addfile <id> <attachment>` ·
  `removefile <id> <name>` · `edit <id>` (reopens the builder).

### Builder card (ephemeral; mirrors `ImagePickerState` + `renderImagePicker` +
button-collector, `orchestrator.ts:2025`)
- 📎 **Files:** chips with ✖ remove
- ✏️ **Prompt** → multi-line **modal** (why text comes via the card, not a slash
  string option)
- 🕐 **Runs** → cadence **picker** (Daily / Weekdays / Weekly / Hourly / Every N
  hours / **Custom…**); Custom opens a cron modal showing the **live `cronstrue`
  English** so you can confirm. Picker handles common cases; Custom covers the rest.
- 🌍 **Timezone** → select (defaults to a configured tz)
- 🏷️ **Name** (in the prompt modal)
- **✅ Create** (enabled once prompt + schedule set) · **Cancel**
- On **Create** → download file bytes, write row, `manager.arm(row)`, post
  confirmation. Cancel/timeout discards; nothing persisted (no orphan files).

### Friendly messaging (the "self-contained" expectation, set at creation)
- **Prompt modal placeholder:** *"Write this so it stands on its own — it runs
  later with no memory of this conversation. Include everything it needs. e.g.
  'Run `npm test`, then post any failures as file:line with a one-line fix.'"*
- **Confirmation card:** runs on a clean session; attach reference files (re-sent
  every run); plain-English cadence + tz; next run time; the write-job caution.

---

## 7. Edge cases (recap)

| situation | behavior |
|---|---|
| `/seam reset`, attach, agent-switch | irrelevant — the job runs in its own session |
| thread **locked** | skip + `last_status` (visible in `list`) |
| thread archived / auto-archived | runs; announce card auto-reopens it |
| thread **deleted** | ThreadDelete handler (or fire-time 404) → delete schedule + files |
| **active user turn** at fire time | runs in its own session; output posts as cards — no conflict |
| bot restart / redeploy | rehydrate enabled rows on boot; catch-up if within `catchup_seconds`, else skip |
| attachment URL expiry | bytes persisted locally; re-attached each run |
| job writes to the repo | runs independently of the live session — flagged at creation |
| auth | `created_by` stamped; only allow-listed users can create |

---

## 8. Build phases & effort (~4.5–5 focused days)

| phase | scope | effort |
|---|---|---|
| 0 | deps (`croner`, `cronstrue`), `scheduled-prompts/` scaffold | 0.25d |
| 1 | `scheduled_prompts` table + SessionStore CRUD + attachment store/cleanup | 0.75d |
| 2 | `ScheduledPromptManager` (arm/disarm/rehydrate/tick + catch-up) + index.ts lifecycle | 1–1.25d |
| 3 | isolated fire runner (reuse runAgent pattern + attachments) + blue-card output renderer | 0.75d |
| 4 | `/seam schedule` group + builder card + modals + list/remove/toggle/addfile | 1.5d |
| 5 | `Events.ThreadDelete` cleanup (Guilds intent already delivers it) | 0.25d |
| 6 | friendly copy, `cronstrue` echo, list/confirmation card polish | 0.5d |
| — | unit tests (cron calc, catch-up, decision flow); live shake-out by user | 0.5d |

Difficulty: **medium-low.** The expensive run+capture is reused from the compaction
runner; the only genuinely new infra is the cron manager (with rehydration +
catch-up). No surgery on the core turn path.

---

## 9. Open decisions (minor — confirm before/at build)

1. **Output overflow threshold** — cards vs. file at ~3 cards / ~12k chars (tune).
2. **Throwaway session cleanup** — delete after each run (default) vs. keep the
   last run for audit via `/seam sessions`.
3. **Runner model** — use the thread's configured model/effort (default) vs. a
   dedicated scheduled-job model.
